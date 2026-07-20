import assert from 'node:assert/strict';
import { afterEach, test } from '@jest/globals';
import {
  clearSpotTradingViewBootstrapMetadataCache,
  getSpotTradingViewBootstrapMetadata,
  rememberSpotTradingViewBootstrapMetadata,
  resolveSpotTradingViewBootstrapMetadata,
} from './spotTradingViewBootstrap';

afterEach(() => clearSpotTradingViewBootstrapMetadataCache());

test('waits for complete symbol metadata instead of creating a fallback precision widget', () => {
  assert.equal(resolveSpotTradingViewBootstrapMetadata({
    symbol: 'BTCUSDT',
    pair: { symbol: 'BTCUSDT', pricePrecision: 1 },
    fallbackDisplaySymbol: 'BTC/USDT',
  }), null);

  assert.deepEqual(resolveSpotTradingViewBootstrapMetadata({
    symbol: 'BTCUSDT',
    pair: {
      symbol: 'BTCUSDT',
      displaySymbol: 'BTC/USDT',
      pricePrecision: 1,
      amountPrecision: 6,
    },
    fallbackDisplaySymbol: 'BTC/USDT',
  }), {
    symbol: 'BTCUSDT',
    displaySymbol: 'BTC/USDT',
    pricePrecision: 1,
    amountPrecision: 6,
  });
});

test('uses the configured tick/display authority before freezing widget metadata', () => {
  assert.deepEqual(resolveSpotTradingViewBootstrapMetadata({
    symbol: 'BON-2USDT',
    pair: {
      symbol: 'BON-2USDT',
      label: 'BON-2/USDT',
      displayPricePrecision: 8,
      pricePrecision: 2,
      priceTickSize: '0.00000001',
      amountPrecision: 4,
    },
    fallbackDisplaySymbol: 'BON-2/USDT',
  }), {
    symbol: 'BON-2USDT',
    displaySymbol: 'BON-2/USDT',
    pricePrecision: 8,
    amountPrecision: 4,
  });
});

test('reuses a settled metadata snapshot for repeat navigation', () => {
  const metadata = {
    symbol: 'ETHUSDT',
    displaySymbol: 'ETH/USDT',
    pricePrecision: 2,
    amountPrecision: 5,
  };
  rememberSpotTradingViewBootstrapMetadata(metadata);

  assert.deepEqual(getSpotTradingViewBootstrapMetadata('ethusdt'), metadata);
});
