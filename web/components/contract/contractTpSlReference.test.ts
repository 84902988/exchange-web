import { describe, expect, it } from '@jest/globals';

import { resolveContractTpSlEditorReference } from './contractTpSlReference';

const position = {
  id: 9,
  symbol: 'BTCUSDT_PERP',
  side: 'LONG',
  leverage: 10,
  quantity: '1',
  entry_price: '90',
  mark_price: '101',
  margin_amount: '9',
  open_fee: '0',
  unrealized_pnl: '11',
  realized_pnl: '0',
  warning_price: '50',
  status: 'OPEN',
};

describe('resolveContractTpSlEditorReference', () => {
  it('uses the latest current-symbol quote instead of the modal-open snapshot', () => {
    expect(resolveContractTpSlEditorReference({
      draftSymbol: 'BTCUSDT_PERP',
      positionIds: [9],
      currentSymbol: 'BTCUSDT_PERP',
      positions: [position],
      quote: { mark_price: '105', last_price: '106' },
      triggerPriceType: 'MARK_PRICE',
      fallback: '95',
    })).toBe('105');
  });

  it('uses latest price when the configured trigger authority is LAST_PRICE', () => {
    expect(resolveContractTpSlEditorReference({
      draftSymbol: 'BTCUSDT_PERP',
      positionIds: [9],
      currentSymbol: 'BTCUSDT_PERP',
      positions: [position],
      quote: { mark_price: '105', last_price: '106' },
      triggerPriceType: 'LAST_PRICE',
      fallback: '95',
    })).toBe('106');
  });

  it('uses the live BBO midpoint for a current TradFi position', () => {
    expect(resolveContractTpSlEditorReference({
      draftSymbol: 'XAUUSDT_PERP',
      positionIds: [9],
      currentSymbol: 'XAUUSDT_PERP',
      positions: [{ ...position, symbol: 'XAUUSDT_PERP' }],
      quote: { mark_price: '4017.32', last_price: '4017.32' },
      triggerPriceType: 'LAST_PRICE',
      fallback: '4017.32',
      liveBestBid: '4011.63',
      liveBestAsk: '4012.35',
      liveMarketUsable: true,
      preferLiveBbo: true,
    })).toBe(4011.99);
  });

  it('does not use BBO when the live market is not usable', () => {
    expect(resolveContractTpSlEditorReference({
      draftSymbol: 'XAUUSDT_PERP',
      positionIds: [9],
      currentSymbol: 'XAUUSDT_PERP',
      positions: [{ ...position, symbol: 'XAUUSDT_PERP' }],
      quote: { mark_price: '4017.32', last_price: '4017.32' },
      triggerPriceType: 'LAST_PRICE',
      fallback: '4017.32',
      liveBestBid: '4011.63',
      liveBestAsk: '4012.35',
      liveMarketUsable: false,
      preferLiveBbo: true,
    })).toBe('4017.32');
  });

  it('does not apply the active-symbol quote to a different symbol', () => {
    expect(resolveContractTpSlEditorReference({
      draftSymbol: 'ETHUSDT_PERP',
      positionIds: [10],
      currentSymbol: 'BTCUSDT_PERP',
      positions: [{ ...position, id: 10, symbol: 'ETHUSDT_PERP', mark_price: '51' }],
      quote: { mark_price: '105', last_price: '106' },
      triggerPriceType: 'MARK_PRICE',
      fallback: '50',
    })).toBe('51');
  });
});
