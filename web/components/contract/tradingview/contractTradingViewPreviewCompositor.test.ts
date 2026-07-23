import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import type {
  ContractPreviewInput,
  ContractPreviewNativeInput,
} from './contractTradingViewPreviewCompositor'

const modulePath = fileURLToPath(
  new URL('./contractTradingViewPreviewCompositor.ts', import.meta.url),
)
const source = readFileSync(modulePath, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: modulePath,
}).outputText
const loadedModule: { exports: Record<string, unknown> } = { exports: {} }
new Function('require', 'module', 'exports', output)(
  () => undefined,
  loadedModule,
  loadedModule.exports,
)
const ContractTradingViewPreviewCompositor = loadedModule.exports
  .ContractTradingViewPreviewCompositor as typeof import('./contractTradingViewPreviewCompositor')
    .ContractTradingViewPreviewCompositor

const OPEN_TIME = 1_720_000_020_000

function native(
  overrides: Partial<ContractPreviewNativeInput> = {},
): ContractPreviewNativeInput {
  return {
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    openTime: OPEN_TIME,
    generation: 3,
    receivedAtMs: 1_000,
    revision: { epoch: 3, sequence: 8 },
    isClosed: false,
    bar: {
      time: OPEN_TIME,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 50,
    },
    ...overrides,
  }
}

function preview(
  overrides: Partial<ContractPreviewInput> = {},
): ContractPreviewInput {
  return {
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    openTime: OPEN_TIME,
    generation: 3,
    receivedAtMs: 2_000,
    previewSequence: 1,
    baseNativeRevision: { epoch: 3, sequence: 8 },
    baselineSource: 'NATIVE',
    baselineAnchorOpenTime: null,
    bar: {
      time: OPEN_TIME,
      open: 100,
      high: 103,
      low: 99,
      close: 103,
      volume: 52,
    },
    ...overrides,
  }
}

test('complete preview replaces only its matching Native OPEN baseline', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  assert.equal(compositor.acceptNative(native()).source, 'native')

  const result = compositor.acceptPreview(preview())

  assert.equal(result.accepted, true)
  assert.equal(result.source, 'preview')
  assert.deepEqual(result.bar, preview().bar)
})

test('validated iTick preview bootstraps before the first versioned Native frame', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'EURUSD_PERP',
    interval: '1m',
  })
  const first = compositor.acceptPreview(preview({
    symbol: 'EURUSD_PERP',
    bar: { ...preview().bar, close: 101.5 },
  }))
  const next = compositor.acceptPreview(preview({
    symbol: 'EURUSD_PERP',
    receivedAtMs: 2_100,
    previewSequence: 2,
    bar: { ...preview().bar, close: 102.5, volume: 53 },
  }))

  assert.equal(first.reason, 'PREVIEW_BOOTSTRAP_ACCEPTED')
  assert.equal(first.source, 'preview')
  assert.equal(first.bar?.close, 101.5)
  assert.equal(next.reason, 'PREVIEW_BOOTSTRAP_ACCEPTED')
  assert.equal(next.bar?.close, 102.5)
})

test('all iTick CFD categories open the contiguous next candle from a real trade rollover', () => {
  const symbols = [
    'EURUSD_PERP',
    'XAUUSDT_PERP',
    'BRENTUSDT_PERP',
    'NAS100USDT_PERP',
    'AAPLUSDT_PERP',
  ];

  for (const symbol of symbols) {
    const compositor = new ContractTradingViewPreviewCompositor({ symbol, interval: '1m' });
    compositor.acceptNative(native({ symbol }));
    const result = compositor.acceptPreview(preview({
      symbol,
      openTime: OPEN_TIME + 60_000,
      baselineSource: 'TRADE_ROLLOVER',
      baselineAnchorOpenTime: OPEN_TIME,
      bar: {
        time: OPEN_TIME + 60_000,
        open: 103,
        high: 103,
        low: 103,
        close: 103,
        volume: 2,
      },
    }));

    assert.equal(result.reason, 'TRADE_ROLLOVER_ACCEPTED', symbol);
    assert.equal(result.bar?.time, OPEN_TIME + 60_000, symbol);
    assert.equal(result.bar?.close, 103, symbol);
  }
})

test('trade rollover preview fails closed without an exact adjacent native anchor', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BRENTUSDT_PERP',
    interval: '1m',
  });
  compositor.acceptNative(native({ symbol: 'BRENTUSDT_PERP' }));

  const rollover = {
    symbol: 'BRENTUSDT_PERP',
    openTime: OPEN_TIME + 60_000,
    baselineSource: 'TRADE_ROLLOVER' as const,
    baselineAnchorOpenTime: OPEN_TIME,
    bar: {
      time: OPEN_TIME + 60_000,
      open: 103,
      high: 103,
      low: 103,
      close: 103,
      volume: 2,
    },
  };

  assert.equal(
    compositor.acceptPreview(preview({
      ...rollover,
      baselineAnchorOpenTime: OPEN_TIME - 60_000,
    })).reason,
    'OPEN_TIME_MISMATCH',
  );
  assert.equal(
    compositor.acceptPreview(preview({
      ...rollover,
      generation: 4,
    })).reason,
    'GENERATION_MISMATCH',
  );
});

test('first Native OPEN rebases a trade-seeded rollover without losing the settled trade', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BRENTUSDT_PERP',
    interval: '1m',
  });
  compositor.acceptNative(native({
    symbol: 'BRENTUSDT_PERP',
    bar: { ...native().bar, close: 100 },
  }));
  const rollover = compositor.acceptPreview(preview({
    symbol: 'BRENTUSDT_PERP',
    openTime: OPEN_TIME + 60_000,
    baselineSource: 'TRADE_ROLLOVER',
    baselineAnchorOpenTime: OPEN_TIME,
    bar: {
      time: OPEN_TIME + 60_000,
      open: 104,
      high: 105,
      low: 104,
      close: 105,
      volume: 3,
    },
  }));

  const rebased = compositor.acceptNative(native({
    symbol: 'BRENTUSDT_PERP',
    openTime: OPEN_TIME + 60_000,
    revision: { epoch: 1, sequence: 1 },
    bar: {
      time: OPEN_TIME + 60_000,
      open: 101,
      high: 103,
      low: 100,
      close: 102,
      volume: 2,
    },
  }));

  assert.equal(rollover.reason, 'TRADE_ROLLOVER_ACCEPTED');
  assert.equal(rebased.reason, 'NATIVE_OPEN_REBASED_PREVIEW');
  assert.equal(rebased.source, 'preview');
  assert.deepEqual(rebased.bar, {
    time: OPEN_TIME + 60_000,
    open: 101,
    high: 105,
    low: 100,
    close: 105,
    volume: 3,
  });

  const nextPreview = compositor.acceptPreview(preview({
    symbol: 'BRENTUSDT_PERP',
    openTime: OPEN_TIME + 60_000,
    baseNativeRevision: { epoch: 1, sequence: 1 },
    previewSequence: 1,
    baselineSource: 'NATIVE',
    baselineAnchorOpenTime: null,
    bar: {
      time: OPEN_TIME + 60_000,
      open: 101,
      high: 106,
      low: 100,
      close: 106,
      volume: 4,
    },
  }));

  assert.equal(nextPreview.reason, 'PREVIEW_ACCEPTED');
  assert.equal(nextPreview.source, 'preview');
  assert.equal(nextPreview.bar?.close, 106);
});

for (const symbol of [
  'BRENTUSDT_PERP',
  'EURUSD_PERP',
  'XAUUSDT_PERP',
  'NAS100USDT_PERP',
  'BTCUSDT_PERP',
  'ETHUSDT_PERP',
]) {
  for (const interval of ['1m', '5m'] as const) {
    test(`${symbol} ${interval} shares Native rollover correction without forcing continuity`, () => {
      const intervalMs = interval === '1m' ? 60_000 : 300_000;
      const anchorTime = Math.floor(OPEN_TIME / intervalMs) * intervalMs;
      const nextTime = anchorTime + intervalMs;
      const compositor = new ContractTradingViewPreviewCompositor({ symbol, interval });
      compositor.acceptNative(native({
        symbol,
        interval,
        openTime: anchorTime,
        bar: {
          time: anchorTime,
          open: 99,
          high: 101,
          low: 98,
          close: 100,
          volume: 10,
        },
      }));
      compositor.acceptPreview(preview({
        symbol,
        interval,
        openTime: nextTime,
        baselineSource: 'TRADE_ROLLOVER',
        baselineAnchorOpenTime: anchorTime,
        bar: {
          time: nextTime,
          open: 112,
          high: 113,
          low: 111,
          close: 113,
          volume: 2,
        },
      }));

      const result = compositor.acceptNative(native({
        symbol,
        interval,
        openTime: nextTime,
        revision: { epoch: 3, sequence: 1 },
        bar: {
          time: nextTime,
          open: 110,
          high: 112,
          low: 109,
          close: 111,
          volume: 1,
        },
      }));

      assert.equal(result.reason, 'NATIVE_OPEN_REBASED_PREVIEW');
      assert.equal(result.bar?.open, 110);
      assert.equal(result.bar?.close, 113);
      assert.equal(result.bar?.high, 113);
      assert.equal(result.bar?.low, 109);
      assert.notEqual(result.bar?.open, 100, 'a real Native gap must remain visible');
    });
  }
}

test('bootstrap preview rejects rollback before Native authority arrives', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'EURUSD_PERP',
    interval: '1m',
  })
  compositor.acceptPreview(preview({
    symbol: 'EURUSD_PERP',
    previewSequence: 2,
    bar: { ...preview().bar, volume: 53 },
  }))

  assert.equal(
    compositor.acceptPreview(preview({
      symbol: 'EURUSD_PERP',
      previewSequence: 1,
      bar: { ...preview().bar, volume: 54 },
    })).reason,
    'PREVIEW_SEQUENCE_STALE',
  )
  assert.equal(
    compositor.acceptPreview(preview({
      symbol: 'EURUSD_PERP',
      previewSequence: 3,
      bar: { ...preview().bar, volume: 52 },
    })).reason,
    'PREVIEW_VOLUME_STALE',
  )
})

test('closed five-minute Native anchor permits only the immediate real-trade rollover', () => {
  const symbol = 'XAUUSDT_PERP'
  const compositor = new ContractTradingViewPreviewCompositor({ symbol, interval: '5m' })
  compositor.acceptNative(native({ symbol, interval: '5m', isClosed: true }))

  const accepted = compositor.acceptPreview(preview({
    symbol,
    interval: '5m',
    openTime: OPEN_TIME + 300_000,
    baselineSource: 'TRADE_ROLLOVER',
    baselineAnchorOpenTime: OPEN_TIME,
    bar: {
      time: OPEN_TIME + 300_000,
      open: 103,
      high: 103,
      low: 103,
      close: 103,
      volume: 2,
    },
  }))

  assert.equal(accepted.reason, 'TRADE_ROLLOVER_ACCEPTED')
  assert.equal(accepted.bar?.time, OPEN_TIME + 300_000)
})

test('older Native OPEN cannot visually roll back newer trade OHLCV', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const result = compositor.acceptNative(native({
    receivedAtMs: 2_100,
    revision: { epoch: 3, sequence: 9 },
    bar: { ...native().bar, close: 102, volume: 51 },
  }))

  assert.equal(result.reason, 'NATIVE_OPEN_DEFERRED_TO_PREVIEW')
  assert.equal(result.source, 'preview')
  assert.equal(result.bar?.close, 103)
  assert.equal(result.bar?.volume, 52)
})

test('volume-ahead Native OPEN waits until its close matches the settled trade', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const ahead = compositor.acceptNative(native({
    receivedAtMs: 2_100,
    revision: { epoch: 3, sequence: 9 },
    bar: { ...native().bar, close: 102, volume: 53 },
  }))

  assert.equal(ahead.reason, 'NATIVE_OPEN_DEFERRED_TO_PREVIEW')
  assert.equal(ahead.source, 'preview')
  assert.equal(ahead.bar?.close, 103)
})

test('new Native baseline cannot release same-candle preview volume high-water', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview({
    previewSequence: 4,
    bar: { ...preview().bar, close: 104, high: 104, volume: 80 },
  }))
  compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 3, sequence: 9 },
    bar: { ...native().bar, close: 102, volume: 60 },
  }))

  const rollback = compositor.acceptPreview(preview({
    receivedAtMs: 4_000,
    previewSequence: 1,
    baseNativeRevision: { epoch: 3, sequence: 9 },
    bar: { ...preview().bar, close: 103, volume: 65 },
  }))
  const rebased = compositor.acceptPreview(preview({
    receivedAtMs: 4_010,
    previewSequence: 1,
    baseNativeRevision: { epoch: 3, sequence: 9 },
    bar: { ...preview().bar, close: 105, high: 105, volume: 81 },
  }))

  assert.equal(rollback.reason, 'PREVIEW_VOLUME_STALE')
  assert.equal(rebased.source, 'preview')
  assert.equal(rebased.bar?.close, 105)
  assert.equal(rebased.bar?.volume, 81)
})

test('closed Native candle wins and prevents preview reopening', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())
  const closed = compositor.acceptNative(native({
    isClosed: true,
    revision: { epoch: 3, sequence: 10 },
    receivedAtMs: 3_000,
    bar: { ...preview().bar, close: 102, volume: 53 },
  }))
  const late = compositor.acceptPreview(preview({
    previewSequence: 2,
    baseNativeRevision: { epoch: 3, sequence: 10 },
    receivedAtMs: 3_100,
    bar: { ...preview().bar, volume: 54 },
  }))

  assert.equal(closed.source, 'native')
  assert.equal(closed.bar?.volume, 53)
  assert.equal(late.reason, 'NATIVE_CLOSED')
})

test('higher process generation accepts a backend restart with reset revision sequence', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native({
    generation: 1_000_001,
    revision: { epoch: 1_000_001, sequence: 900 },
  }))

  const restartedNative = compositor.acceptNative(native({
    generation: 2_000_001,
    revision: { epoch: 2_000_001, sequence: 1 },
    receivedAtMs: 3_000,
    bar: { ...native().bar, close: 102 },
  }))
  const restartedPreview = compositor.acceptPreview(preview({
    generation: 2_000_001,
    baseNativeRevision: { epoch: 2_000_001, sequence: 1 },
    receivedAtMs: 3_100,
    bar: { ...preview().bar, close: 104, high: 104 },
  }))

  assert.equal(restartedNative.reason, 'NATIVE_ACCEPTED')
  assert.equal(restartedNative.bar?.close, 102)
  assert.equal(restartedPreview.reason, 'PREVIEW_ACCEPTED')
  assert.equal(restartedPreview.bar?.close, 104)
})

test('generation, revision, volume and scope mismatches fail closed', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())

  assert.equal(
    compositor.acceptPreview(preview({ generation: 2 })).reason,
    'GENERATION_MISMATCH',
  )
  assert.equal(
    compositor.acceptPreview(preview({ baseNativeRevision: { epoch: 3, sequence: 7 } })).reason,
    'BASE_REVISION_STALE',
  )
  assert.equal(
    compositor.acceptPreview(preview({ bar: { ...preview().bar, volume: 49 } })).reason,
    'PREVIEW_VOLUME_STALE',
  )
  assert.equal(
    compositor.acceptPreview(preview({ symbol: 'ETHUSDT_PERP' })).reason,
    'SYMBOL_MISMATCH',
  )
  const sol = new ContractTradingViewPreviewCompositor({
    symbol: 'SOLUSDT_PERP',
    interval: '1m',
  })
  assert.equal(
    sol.acceptNative(native({ symbol: 'SOLUSDT_PERP' })).source,
    'native',
  )
  assert.equal(
    sol.acceptPreview(preview({ symbol: 'SOLUSDT_PERP' })).source,
    'preview',
  )
  assert.equal(
    new ContractTradingViewPreviewCompositor({
      symbol: 'SOLUSDT_PERP',
      interval: '5m',
    }).acceptNative(native({ symbol: 'SOLUSDT_PERP', interval: '5m' })).source,
    'native',
  )
  const fiveMinute = new ContractTradingViewPreviewCompositor({
    symbol: 'SOLUSDT_PERP',
    interval: '5m',
  })
  fiveMinute.acceptNative(native({ symbol: 'SOLUSDT_PERP', interval: '5m' }))
  assert.equal(
    fiveMinute.acceptPreview(preview({
      symbol: 'SOLUSDT_PERP',
      interval: '5m',
    })).source,
    'preview',
  )
  assert.equal(
    new ContractTradingViewPreviewCompositor({
      symbol: 'SOLUSDT_PERP',
      interval: '15m',
    }).acceptNative(native({ symbol: 'SOLUSDT_PERP', interval: '15m' })).reason,
    'UNSUPPORTED_SCOPE',
  )
})

test('stock symbols containing a dot keep trade-preview composition enabled', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BRK.BUSDT_PERP',
    interval: '1m',
  })

  assert.equal(compositor.supported, true)
})
