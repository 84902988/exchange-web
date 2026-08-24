import type { ContractPositionItem } from '../src/api/contract';
import {
  applyLiveContractPositionValuations,
  buildContractPositionPriceLines,
  resolveLiveContractPositionPrice,
} from '../src/components/contract/contractPositionPresentation';

function position(
  overrides: Partial<ContractPositionItem> = {},
): ContractPositionItem {
  return {
    id: '7',
    symbol: 'XAUUSDT_PERP',
    side: 'LONG',
    leverage: 20,
    quantity: '1',
    entryPrice: '4095.45',
    markPrice: '4467.49',
    marginAmount: '20.48',
    unrealizedPnl: '372.04',
    liquidationPrice: '0',
    takeProfitPrice: '4475',
    stopLossPrice: '4465',
    status: 'OPEN',
    ...overrides,
  };
}

describe('contract position presentation', () => {
  it('uses only a complete, non-crossed current-symbol live BBO midpoint', () => {
    expect(
      resolveLiveContractPositionPrice({
        currentSymbol: 'XAUUSDT_PERP',
        marketSymbol: 'XAUUSDT',
        liveBestBid: 4466.9,
        liveBestAsk: 4467.1,
        liveMarketUsable: true,
      }),
    ).toBe(4467);
    expect(
      resolveLiveContractPositionPrice({
        currentSymbol: 'XAUUSDT_PERP',
        marketSymbol: 'BTCUSDT_PERP',
        liveBestBid: 4466.9,
        liveBestAsk: 4467.1,
        liveMarketUsable: true,
      }),
    ).toBeNull();
    expect(
      resolveLiveContractPositionPrice({
        currentSymbol: 'XAUUSDT_PERP',
        marketSymbol: 'XAUUSDT_PERP',
        liveBestBid: 4467.2,
        liveBestAsk: 4467.1,
        liveMarketUsable: true,
      }),
    ).toBeNull();
  });

  it('revalues long and short positions on every usable live price update', () => {
    const valued = applyLiveContractPositionValuations(
      [position(), position({id: '8', side: 'SHORT', entryPrice: '4500'})],
      'XAUUSDT_PERP',
      4466.96,
    );

    expect(Number(valued[0].markPrice)).toBeCloseTo(4466.96);
    expect(Number(valued[0].unrealizedPnl)).toBeCloseTo(371.51);
    expect(Number(valued[1].unrealizedPnl)).toBeCloseTo(33.04);
  });

  it('builds entry, take-profit and stop-loss markers only for the active symbol', () => {
    const lines = buildContractPositionPriceLines(
      [position(), position({id: '9', symbol: 'BTCUSDT_PERP'})],
      'XAUUSDT_PERP',
      {entry: '开仓均价', takeProfit: '止盈价', stopLoss: '止损价'},
    );

    expect(lines.map(line => [line.kind, line.price])).toEqual([
      ['ENTRY', 4095.45],
      ['TAKE_PROFIT', 4475],
      ['STOP_LOSS', 4465],
    ]);
  });
});
