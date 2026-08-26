import {
  AdvancedChartIndicatorController,
  advancedChartStudyInputs,
  parseAdvancedChartIndicatorCommand,
  type AdvancedChartIndicatorConfigV2,
  type AdvancedChartIndicatorSelection,
  type AdvancedChartStudyApi,
} from './advancedChartIndicators';

const defaultSelection: AdvancedChartIndicatorSelection = {
  overlay: 'MA',
  pane: 'VOL',
};

function command(
  indicators: AdvancedChartIndicatorSelection = defaultSelection,
  intentId = 1,
) {
  return {
    type: 'mobile-chart-command',
    sessionId: 'session-1',
    command: 'set-indicators',
    intentId,
    indicators,
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks() {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

describe('mobile advanced chart indicator command', () => {
  test('accepts only the exact session-scoped full indicator selection', () => {
    expect(parseAdvancedChartIndicatorCommand(
      JSON.stringify(command()),
      'session-1',
    )).toEqual(command());
    expect(parseAdvancedChartIndicatorCommand(command(), 'session-1')).toEqual(command());

    expect(parseAdvancedChartIndicatorCommand(command(), 'other-session')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand({
      ...command(),
      indicators: { overlay: 'MA', pane: 'VOL', extra: true },
    }, 'session-1')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand({
      ...command(),
      indicators: { overlay: 'INVALID', pane: 'VOL' },
    }, 'session-1')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand('{bad-json', 'session-1')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand({ ...command(), intentId: 0 }, 'session-1')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand({
      ...command(),
      intentId: Number.MAX_SAFE_INTEGER + 1,
    }, 'session-1')).toBeNull();
  });

  test.each([
    {overlay: 'SAR' as const, pane: 'OBV' as const},
    {overlay: 'AVL' as const, pane: 'WR' as const},
    {overlay: 'SUPER' as const, pane: 'KDJ' as const},
    {overlay: 'MA' as const, pane: 'StochRSI' as const},
  ])('accepts the expanded indicator selection %#', indicators => {
    expect(parseAdvancedChartIndicatorCommand(
      command(indicators),
      'session-1',
    )).toEqual(command(indicators));
  });
});

describe('mobile advanced chart indicator controller', () => {
  test('maps Binance-style indicator labels to executable studies', async () => {
    const created: Array<[string, boolean | undefined]> = [];
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name, forceOverlay) => {
        created.push([name, forceOverlay]);
        return created.length;
      },
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(chart);

    controller.setIndicators({overlay: 'SUPER', pane: 'KDJ'}, 1);
    await settle();
    controller.setIndicators({overlay: 'AVL', pane: 'StochRSI'}, 2);
    await settle();

    expect(created).toEqual([
      ['SuperTrend', true],
      ['KDJ', false],
      ['VWAP', true],
      ['Stochastic RSI', false],
    ]);
  });

  test('creates one overlay and one pane study and makes duplicate state idempotent', async () => {
    const created: Array<[string, boolean | undefined, boolean | undefined]> = [];
    const removed: Array<string | number> = [];
    const committed: AdvancedChartIndicatorSelection[] = [];
    let nextId = 0;
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name, forceOverlay, lock) => {
        created.push([name, forceOverlay, lock]);
        nextId += 1;
        return `study-${nextId}`;
      },
      removeEntity: (entityId) => removed.push(entityId),
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: (_intentId, selection) => committed.push(selection),
      onError: () => undefined,
    });
    controller.attach(chart);

    expect(controller.setIndicators(defaultSelection, 1)).toBe(true);
    await settle();
    expect(controller.setIndicators(defaultSelection, 2)).toBe(true);
    await settle();

    expect(created).toEqual([
      ['Moving Average', true, false],
      ['Volume', false, false],
    ]);
    expect(removed).toEqual([]);
    expect(committed).toEqual([defaultSelection, defaultSelection]);
  });

  test('replaces only the changed group after the new study is ready', async () => {
    const events: string[] = [];
    let nextId = 0;
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        events.push(`create:${name}`);
        nextId += 1;
        return nextId;
      },
      removeEntity: (entityId) => events.push(`remove:${entityId}`),
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(chart);
    controller.setIndicators(defaultSelection, 1);
    await settle();
    controller.setIndicators({ overlay: 'MA', pane: 'RSI' }, 2);
    await settle();

    expect(events).toEqual([
      'create:Moving Average',
      'create:Volume',
      'create:Relative Strength Index',
      'remove:2',
    ]);
  });

  test('preserves the previous study when its replacement cannot be created', async () => {
    const errors: string[] = [];
    const removed: Array<string | number> = [];
    let nextId = 0;
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        if (name === 'Relative Strength Index') return null;
        nextId += 1;
        return nextId;
      },
      removeEntity: (entityId) => removed.push(entityId),
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: (_intentId, message) => errors.push(message),
    });
    controller.attach(chart);
    controller.setIndicators(defaultSelection, 1);
    await settle();
    controller.setIndicators({ overlay: 'MA', pane: 'RSI' }, 2);
    await settle();

    expect(removed).toEqual([]);
    expect(errors).toEqual(['技术指标切换失败']);
  });

  test('rolls back both groups when the second replacement cannot be created', async () => {
    const errors: Array<{
      intentId: number;
      message: string;
      indicators: AdvancedChartIndicatorSelection | null;
    }> = [];
    const committed: AdvancedChartIndicatorSelection[] = [];
    const removed: Array<string | number> = [];
    let nextId = 0;
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        if (name === 'MACD') return null;
        nextId += 1;
        return nextId;
      },
      removeEntity: (entityId) => removed.push(entityId),
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: (_intentId, selection) => committed.push(selection),
      onError: (intentId, message, indicators) => errors.push({
        intentId,
        message,
        indicators,
      }),
    });
    controller.attach(chart);
    controller.setIndicators(defaultSelection, 1);
    await settle();
    controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
    await settle();

    expect(committed).toEqual([defaultSelection]);
    expect(errors).toEqual([{
      intentId: 2,
      message: '技术指标切换失败',
      indicators: defaultSelection,
    }]);
    expect(removed).toEqual([3]);

    controller.setIndicators(defaultSelection, 3);
    await settle();
    expect(committed).toEqual([defaultSelection, defaultSelection]);
    expect(nextId).toBe(3);
  });

  test('fails closed before readiness and retires a late study from an old generation', async () => {
    const errors: string[] = [];
    const removed: Array<string | number> = [];
    let resolveStudy!: (id: string) => void;
    const oldChart: AdvancedChartStudyApi = {
      createStudy: () => new Promise((resolve) => { resolveStudy = resolve; }),
      removeEntity: (entityId) => removed.push(entityId),
      getAllStudies: () => [],
    };
    const newChart: AdvancedChartStudyApi = {
      createStudy: async () => 'new-study',
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: (_intentId, message) => errors.push(message),
    });

    expect(controller.setIndicators(defaultSelection, 1)).toBe(false);
    controller.attach(oldChart);
    controller.setIndicators(defaultSelection, 1);
    await settle();
    controller.attach(newChart);
    resolveStudy('late-study');
    await settle();

    expect(errors).toEqual(['图表尚未就绪']);
    expect(removed).toEqual(['late-study']);
  });

  test('adopts a pre-existing desired study, removes recognized duplicates, and preserves unknown studies', async () => {
    const studies = [
      { id: 'auto-volume', name: 'Volume' },
      { id: 'duplicate-volume', name: 'Volume' },
      { id: 'user-study', name: 'Ichimoku Cloud' },
    ];
    const created: string[] = [];
    const removed: Array<string | number> = [];
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        created.push(name);
        const id = `created-${name}`;
        studies.push({ id, name });
        return id;
      },
      removeEntity: (entityId) => {
        removed.push(entityId);
        const index = studies.findIndex((study) => study.id === entityId);
        if (index >= 0) studies.splice(index, 1);
      },
      getAllStudies: () => studies,
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(chart);
    controller.setIndicators(defaultSelection, 1);
    await settle();

    expect(created).toEqual(['Moving Average']);
    expect(removed).toEqual(['duplicate-volume']);
    expect(studies).toEqual(expect.arrayContaining([
      { id: 'auto-volume', name: 'Volume' },
      { id: 'user-study', name: 'Ichimoku Cloud' },
      { id: 'created-Moving Average', name: 'Moving Average' },
    ]));
  });

  test('replays the latest selection when a replacement widget generation attaches', async () => {
    const firstCreated: string[] = [];
    const replacementCreated: string[] = [];
    const firstChart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        firstCreated.push(name);
        return `first-${name}`;
      },
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const replacementChart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        replacementCreated.push(name);
        return `replacement-${name}`;
      },
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(firstChart);
    controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 1);
    await settle();
    controller.attach(null);
    controller.attach(replacementChart);
    await settle();

    expect(firstCreated).toEqual(['Bollinger Bands', 'MACD']);
    expect(replacementCreated).toEqual(['Bollinger Bands', 'MACD']);
  });

  test('retires an in-flight old generation before replaying its latest selection', async () => {
    const oldRemoved: Array<string | number> = [];
    const replacementCreated: string[] = [];
    let resolveOldStudy!: (id: string) => void;
    const oldChart: AdvancedChartStudyApi = {
      createStudy: () => new Promise((resolve) => { resolveOldStudy = resolve; }),
      removeEntity: (entityId) => oldRemoved.push(entityId),
      getAllStudies: () => [],
    };
    const replacementChart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        replacementCreated.push(name);
        return `replacement-${name}`;
      },
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(oldChart);
    controller.setIndicators({ overlay: 'EMA', pane: 'RSI' }, 1);
    await settle();
    controller.attach(replacementChart);
    resolveOldStudy('late-old-study');
    await settle();
    await settle();

    expect(oldRemoved).toEqual(['late-old-study']);
    expect(replacementCreated).toEqual(['Moving Average Exponential', 'Relative Strength Index']);
  });

  test('starts replacement generation replay without waiting for an abandoned old promise', async () => {
    const replacementCreated: string[] = [];
    const oldChart: AdvancedChartStudyApi = {
      createStudy: () => new Promise(() => undefined),
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const replacementChart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        replacementCreated.push(name);
        return `replacement-${name}`;
      },
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(oldChart);
    controller.setIndicators({ overlay: 'EMA', pane: 'RSI' }, 7);
    await settle();
    controller.attach(replacementChart);
    await settle();
    await settle();

    expect(replacementCreated).toEqual(['Moving Average Exponential', 'Relative Strength Index']);
  });

  test('rejects stale or conflicting external client intents', async () => {
    const created: string[] = [];
    const chart: AdvancedChartStudyApi = {
      createStudy: async (name) => {
        created.push(name);
        return `study-${name}`;
      },
      removeEntity: () => undefined,
      getAllStudies: () => [],
    };
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    controller.attach(chart);
    expect(controller.setIndicators(defaultSelection, 5)).toBe(true);
    await settle();
    expect(controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 4)).toBe(false);
    expect(controller.setIndicators({ overlay: 'EMA', pane: 'RSI' }, 5)).toBe(false);
    await settle();

    expect(created).toEqual(['Moving Average', 'Volume']);
  });

  test('times out a createStudy promise that never settles and releases its timer', async () => {
    jest.useFakeTimers();
    try {
      const errors: Array<{
        intentId: number;
        indicators: AdvancedChartIndicatorSelection | null;
      }> = [];
      const chart: AdvancedChartStudyApi = {
        createStudy: () => new Promise(() => undefined),
        removeEntity: () => undefined,
        getAllStudies: () => [],
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: () => undefined,
        onError: (intentId, _message, indicators) => errors.push({ intentId, indicators }),
        studyCreateTimeoutMs: 25,
      });
      controller.attach(chart);
      controller.setIndicators(defaultSelection, 1);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();

      expect(errors).toEqual([{ intentId: 1, indicators: null }]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('allows a later intent in the same generation to succeed after a timeout', async () => {
    jest.useFakeTimers();
    try {
      let shouldHang = false;
      let nextId = 0;
      const committed: Array<{ intentId: number; selection: AdvancedChartIndicatorSelection }> = [];
      const errors: Array<{ intentId: number; indicators: AdvancedChartIndicatorSelection | null }> = [];
      const chart: AdvancedChartStudyApi = {
        createStudy: async (name) => {
          if (shouldHang && name === 'Bollinger Bands') {
            return new Promise(() => undefined);
          }
          nextId += 1;
          return `study-${nextId}`;
        },
        removeEntity: () => undefined,
        getAllStudies: () => [],
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: (intentId, selection) => committed.push({ intentId, selection }),
        onError: (intentId, _message, indicators) => errors.push({ intentId, indicators }),
        studyCreateTimeoutMs: 25,
      });
      controller.attach(chart);
      controller.setIndicators(defaultSelection, 1);
      await flushMicrotasks();
      shouldHang = true;
      controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();
      shouldHang = false;
      controller.setIndicators({ overlay: 'EMA', pane: 'RSI' }, 3);
      await flushMicrotasks();

      expect(errors).toEqual([{ intentId: 2, indicators: defaultSelection }]);
      expect(committed.at(-1)).toEqual({
        intentId: 3,
        selection: { overlay: 'EMA', pane: 'RSI' },
      });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cleans a late timed-out entity without removing the newer active selection', async () => {
    jest.useFakeTimers();
    try {
      let resolveLate!: (entityId: string) => void;
      let shouldDefer = false;
      let nextId = 0;
      const removed: Array<string | number> = [];
      const chart: AdvancedChartStudyApi = {
        createStudy: async (name) => {
          if (shouldDefer && name === 'Bollinger Bands') {
            return new Promise((resolve) => { resolveLate = resolve; });
          }
          nextId += 1;
          return `current-${nextId}`;
        },
        removeEntity: (entityId) => removed.push(entityId),
        getAllStudies: () => [],
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: () => undefined,
        onError: () => undefined,
        studyCreateTimeoutMs: 25,
      });
      controller.attach(chart);
      controller.setIndicators(defaultSelection, 1);
      await flushMicrotasks();
      shouldDefer = true;
      controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();
      shouldDefer = false;
      controller.setIndicators({ overlay: 'EMA', pane: 'RSI' }, 3);
      await flushMicrotasks();

      resolveLate('late-boll');
      await flushMicrotasks();

      expect(removed).toContain('late-boll');
      expect(removed).not.toContain('current-3');
      expect(removed).not.toContain('current-4');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('protects an adopted late entity until the replacement transaction commits', async () => {
    jest.useFakeTimers();
    try {
      const studies: Array<{ id: string; name: string }> = [];
      const removed: Array<string | number> = [];
      const committed: Array<{ intentId: number; selection: AdvancedChartIndicatorSelection }> = [];
      let resolveOldOverlay!: (entityId: string) => void;
      let resolveNewPane!: (entityId: string) => void;
      const chart: AdvancedChartStudyApi = {
        createStudy: (name) => {
          if (name === 'Bollinger Bands') {
            return new Promise((resolve) => { resolveOldOverlay = resolve; });
          }
          if (name === 'MACD') {
            return new Promise((resolve) => { resolveNewPane = resolve; });
          }
          return Promise.resolve(`unexpected-${name}`);
        },
        removeEntity: (entityId) => removed.push(entityId),
        getAllStudies: () => studies,
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: (intentId, selection) => committed.push({ intentId, selection }),
        onError: () => undefined,
        studyCreateTimeoutMs: 25,
      });
      controller.attach(chart);
      controller.setIndicators({ overlay: 'BOLL', pane: 'VOL' }, 1);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();

      studies.push({ id: 'late-shared-overlay', name: 'Bollinger Bands' });
      controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
      await flushMicrotasks();
      expect(resolveNewPane).toBeDefined();

      resolveOldOverlay('late-shared-overlay');
      await flushMicrotasks();
      expect(removed).not.toContain('late-shared-overlay');

      resolveNewPane('new-macd-pane');
      await flushMicrotasks();
      expect(committed.at(-1)).toEqual({
        intentId: 2,
        selection: { overlay: 'BOLL', pane: 'MACD' },
      });
      expect(removed).not.toContain('late-shared-overlay');
      expect((controller as unknown as {
        protectedSelectedEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).protectedSelectedEntityIds.size).toBe(0);
      expect((controller as unknown as {
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).deferredLateEntityIds.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cleans a deferred adopted overlay when its pending pane fails', async () => {
    jest.useFakeTimers();
    try {
      const studies: Array<{ id: string; name: string }> = [];
      const removed: Array<string | number> = [];
      let resolveOldOverlay!: (entityId: string) => void;
      let resolveNewPane!: (entityId: string | null) => void;
      const chart: AdvancedChartStudyApi = {
        createStudy: (name) => {
          if (name === 'Bollinger Bands') {
            return new Promise((resolve) => { resolveOldOverlay = resolve; });
          }
          if (name === 'MACD') {
            return new Promise((resolve) => { resolveNewPane = resolve; });
          }
          return Promise.resolve(`unexpected-${name}`);
        },
        removeEntity: (entityId) => removed.push(entityId),
        getAllStudies: () => studies,
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: () => undefined,
        onError: () => undefined,
        studyCreateTimeoutMs: 25,
      });
      controller.attach(chart);
      controller.setIndicators({ overlay: 'BOLL', pane: 'VOL' }, 1);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();

      studies.push({ id: 'failed-late-overlay', name: 'Bollinger Bands' });
      controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
      await flushMicrotasks();
      resolveOldOverlay('failed-late-overlay');
      await flushMicrotasks();
      expect(removed).not.toContain('failed-late-overlay');

      resolveNewPane(null);
      await flushMicrotasks();
      expect(removed).toContain('failed-late-overlay');
      expect((controller as unknown as {
        protectedSelectedEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).protectedSelectedEntityIds.size).toBe(0);
      expect((controller as unknown as {
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).deferredLateEntityIds.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('flushes deferred late entities when the chart generation is replaced', async () => {
    jest.useFakeTimers();
    try {
      const studies: Array<{ id: string; name: string }> = [];
      const removed: Array<string | number> = [];
      let resolveOldOverlay!: (entityId: string) => void;
      let resolveOldPane!: (entityId: string | null) => void;
      const oldChart: AdvancedChartStudyApi = {
        createStudy: (name) => {
          if (name === 'Bollinger Bands') {
            return new Promise((resolve) => { resolveOldOverlay = resolve; });
          }
          return new Promise((resolve) => { resolveOldPane = resolve; });
        },
        removeEntity: (entityId) => removed.push(entityId),
        getAllStudies: () => studies,
      };
      const replacementChart: AdvancedChartStudyApi = {
        createStudy: async (name) => `replacement-${name}`,
        removeEntity: () => undefined,
        getAllStudies: () => [],
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: () => undefined,
        onError: () => undefined,
        studyCreateTimeoutMs: 25,
      });
      controller.attach(oldChart);
      controller.setIndicators({ overlay: 'BOLL', pane: 'VOL' }, 1);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();
      studies.push({ id: 'generation-late-overlay', name: 'Bollinger Bands' });
      controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
      await flushMicrotasks();
      resolveOldOverlay('generation-late-overlay');
      await flushMicrotasks();
      expect(removed).not.toContain('generation-late-overlay');

      controller.attach(replacementChart);
      expect(removed).toContain('generation-late-overlay');
      resolveOldPane(null);
      await flushMicrotasks();
      expect((controller as unknown as {
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).deferredLateEntityIds.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cleans deferred adopted and created entities when the transaction is superseded', async () => {
    jest.useFakeTimers();
    try {
      const studies: Array<{ id: string; name: string }> = [];
      const removed: Array<string | number> = [];
      const committed: Array<{ intentId: number; selection: AdvancedChartIndicatorSelection }> = [];
      let resolveOldOverlay!: (entityId: string) => void;
      let resolveSupersededPane!: (entityId: string) => void;
      const chart: AdvancedChartStudyApi = {
        createStudy: (name) => {
          if (name === 'Bollinger Bands') {
            return new Promise((resolve) => { resolveOldOverlay = resolve; });
          }
          if (name === 'MACD') {
            return new Promise((resolve) => { resolveSupersededPane = resolve; });
          }
          return Promise.resolve(`latest-${name}`);
        },
        removeEntity: (entityId) => removed.push(entityId),
        getAllStudies: () => studies,
      };
      const controller = new AdvancedChartIndicatorController({
        onCommitted: (intentId, selection) => committed.push({ intentId, selection }),
        onError: () => undefined,
        studyCreateTimeoutMs: 25,
      });
      controller.attach(chart);
      controller.setIndicators({ overlay: 'BOLL', pane: 'VOL' }, 1);
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(25);
      await flushMicrotasks();
      studies.push({ id: 'superseded-late-overlay', name: 'Bollinger Bands' });
      controller.setIndicators({ overlay: 'BOLL', pane: 'MACD' }, 2);
      await flushMicrotasks();
      resolveOldOverlay('superseded-late-overlay');
      await flushMicrotasks();
      controller.setIndicators({ overlay: 'EMA', pane: 'RSI' }, 3);
      resolveSupersededPane('superseded-pane');
      await flushMicrotasks();

      expect(removed).toContain('superseded-late-overlay');
      expect(removed).toContain('superseded-pane');
      expect(committed.at(-1)).toEqual({
        intentId: 3,
        selection: { overlay: 'EMA', pane: 'RSI' },
      });
      expect((controller as unknown as {
        protectedSelectedEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).protectedSelectedEntityIds.size).toBe(0);
      expect((controller as unknown as {
        deferredLateEntityIds: Map<AdvancedChartStudyApi, Set<string | number>>;
      }).deferredLateEntityIds.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

type VerifiedChartHarness = Readonly<{
  chart: AdvancedChartStudyApi;
  created: Array<{
    id: string;
    name: string;
    forceOverlay: boolean | undefined;
    inputs: Readonly<Record<string, string | number | boolean>>;
  }>;
  removed: Array<string | number>;
  studies: Array<{ id: string; name: string }>;
  addStudy: (
    id: string,
    name: string,
    inputs: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}>;

function createVerifiedChartHarness(
  mutateCreatedInputs?: (
    name: string,
    inputs: Record<string, string | number | boolean>,
  ) => void,
): VerifiedChartHarness {
  const studies: Array<{ id: string; name: string }> = [];
  const inputValues = new Map<string | number, Record<string, string | number | boolean>>();
  const created: VerifiedChartHarness['created'] = [];
  const removed: Array<string | number> = [];
  let sequence = 0;
  const addStudy = (
    id: string,
    name: string,
    inputs: Readonly<Record<string, string | number | boolean>>,
  ) => {
    studies.push({ id, name });
    inputValues.set(id, { ...inputs });
  };
  const chart: AdvancedChartStudyApi = {
    createStudy: async (name, forceOverlay, _lock, inputs) => {
      sequence += 1;
      const id = `verified-${sequence}`;
      const stored = { ...(inputs || {}) };
      mutateCreatedInputs?.(name, stored);
      addStudy(id, name, stored);
      created.push({ id, name, forceOverlay, inputs: { ...(inputs || {}) } });
      return id;
    },
    removeEntity: (entityId) => {
      removed.push(entityId);
      inputValues.delete(entityId);
      const index = studies.findIndex((study) => study.id === entityId);
      if (index >= 0) studies.splice(index, 1);
    },
    getAllStudies: () => studies,
    getStudyById: (entityId) => {
      const values = inputValues.get(entityId);
      if (!values) throw new Error('missing study');
      return {
        getInputValues: () => Object.entries(values).map(([id, value]) => ({ id, value })),
      };
    },
  };
  return { chart, created, removed, studies, addStudy };
}

const defaultConfigV2: AdvancedChartIndicatorConfigV2 = {
  protocolVersion: 2,
  overlay: { kind: 'MA', params: { length: 9 } },
  pane: { kind: 'VOL', params: { showMA: false, maLength: 20 } },
};

describe('mobile advanced chart indicator config v2', () => {
  test('parses the strict versioned config and rejects invalid keys and ranges', () => {
    const valid = {
      type: 'mobile-chart-command',
      sessionId: 'session-1',
      command: 'set-indicator-config-v2',
      intentId: 8,
      config: {
        protocolVersion: 2,
        overlay: { kind: 'BOLL', params: { length: 20, multiplier: 2.5 } },
        pane: {
          kind: 'MACD',
          params: { fastLength: 12, slowLength: 26, signalLength: 9 },
        },
      },
    };
    expect(parseAdvancedChartIndicatorCommand(valid, 'session-1')).toEqual(valid);
    expect(parseAdvancedChartIndicatorCommand({
      ...valid,
      config: { ...valid.config, extra: true },
    }, 'session-1')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand({
      ...valid,
      config: {
        ...valid.config,
        overlay: { kind: 'BOLL', params: { length: 20, multiplier: 2.55 } },
      },
    }, 'session-1')).toBeNull();
    expect(parseAdvancedChartIndicatorCommand({
      ...valid,
      config: {
        ...valid.config,
        pane: {
          kind: 'MACD',
          params: { fastLength: 26, slowLength: 12, signalLength: 9 },
        },
      },
    }, 'session-1')).toBeNull();
  });

  test('maps every canonical config to the pinned TradingView input ids', () => {
    expect(advancedChartStudyInputs({ kind: 'MA', params: { length: 21 } })).toEqual({
      length: 21, source: 'close', offset: 0, smoothingLine: 'SMA', smoothingLength: 9,
    });
    expect(advancedChartStudyInputs({ kind: 'EMA', params: { length: 13 } })).toEqual({
      length: 13, source: 'close', offset: 0, smoothingLine: 'SMA', smoothingLength: 9,
    });
    expect(advancedChartStudyInputs({
      kind: 'BOLL', params: { length: 20, multiplier: 2.5 },
    })).toEqual({ in_0: 20, in_1: 2.5, offset: 0, maType: 'SMA' });
    expect(advancedChartStudyInputs({
      kind: 'VOL', params: { showMA: true, maLength: 30 },
    })).toEqual({ showMA: true, length: 30, volumeMA: 'SMA', col_prev_close: false });
    expect(advancedChartStudyInputs({
      kind: 'MACD', params: { fastLength: 8, slowLength: 21, signalLength: 5 },
    })).toEqual({
      in_0: 8,
      in_1: 21,
      in_2: 5,
      in_3: 'close',
      oscillatorMAType: 'EMA',
      signalLineMAType: 'EMA',
    });
    expect(advancedChartStudyInputs({ kind: 'RSI', params: { length: 7 } })).toEqual({
      length: 7, smoothingLine: 'SMA', smoothingLength: 14,
    });
    expect(advancedChartStudyInputs({
      kind: 'SAR', params: { start: 0.02, increment: 0.03, maximum: 0.3 },
    })).toEqual({ in_0: 0.02, in_1: 0.03, in_2: 0.3 });
    expect(advancedChartStudyInputs({
      kind: 'AVL', params: { length: 20 },
    })).toEqual({});
    expect(advancedChartStudyInputs({
      kind: 'SUPER', params: { length: 7, multiplier: 2.5 },
    })).toEqual({ in_0: 7, in_1: 2.5 });
    expect(advancedChartStudyInputs({
      kind: 'KDJ', params: { length: 9, kSmoothing: 2, dSmoothing: 4 },
    })).toEqual({ in_0: 9, in_1: 2, in_2: 4 });
    expect(advancedChartStudyInputs({
      kind: 'OBV', params: { maLength: 10 },
    })).toEqual({ smoothingLine: 'SMA', smoothingLength: 10 });
    expect(advancedChartStudyInputs({
      kind: 'WR', params: { length: 21 },
    })).toEqual({ in_0: 21 });
    expect(advancedChartStudyInputs({
      kind: 'StochRSI',
      params: {
        rsiLength: 10,
        stochasticLength: 12,
        kSmoothing: 2,
        dSmoothing: 4,
      },
    })).toEqual({ in_0: 10, in_1: 12, in_2: 2, in_3: 4 });
  });

  test('creates configured studies, verifies readback, and emits only the v2 receipt', async () => {
    const harness = createVerifiedChartHarness();
    const legacyCommitted = jest.fn();
    const configCommitted = jest.fn();
    const controller = new AdvancedChartIndicatorController({
      onCommitted: legacyCommitted,
      onError: jest.fn(),
      onConfigCommitted: configCommitted,
      onConfigError: jest.fn(),
    });
    controller.attach(harness.chart);
    expect(controller.setIndicatorConfig(defaultConfigV2, 3)).toBe(true);
    await settle();

    expect(configCommitted).toHaveBeenCalledWith(3, defaultConfigV2);
    expect(legacyCommitted).not.toHaveBeenCalled();
    expect(harness.created.map(({ name, forceOverlay, inputs }) => ({
      name, forceOverlay, inputs,
    }))).toEqual([
      {
        name: 'Moving Average',
        forceOverlay: true,
        inputs: advancedChartStudyInputs(defaultConfigV2.overlay),
      },
      {
        name: 'Volume',
        forceOverlay: false,
        inputs: advancedChartStudyInputs(defaultConfigV2.pane),
      },
    ]);
  });

  test('atomically replaces only the same-kind study whose parameters changed', async () => {
    const harness = createVerifiedChartHarness();
    const controller = new AdvancedChartIndicatorController({
      onCommitted: jest.fn(),
      onError: jest.fn(),
      onConfigCommitted: jest.fn(),
      onConfigError: jest.fn(),
    });
    controller.attach(harness.chart);
    controller.setIndicatorConfig(defaultConfigV2, 1);
    await settle();
    const originalOverlayId = harness.created[0].id;
    const originalPaneId = harness.created[1].id;

    const updated: AdvancedChartIndicatorConfigV2 = {
      ...defaultConfigV2,
      overlay: { kind: 'MA', params: { length: 20 } },
    };
    controller.setIndicatorConfig(updated, 2);
    await settle();

    expect(harness.created).toHaveLength(3);
    expect(harness.created[2].name).toBe('Moving Average');
    expect(harness.removed).toContain(originalOverlayId);
    expect(harness.removed).not.toContain(originalPaneId);
    expect(harness.studies).toEqual(expect.arrayContaining([
      { id: originalPaneId, name: 'Volume' },
      { id: harness.created[2].id, name: 'Moving Average' },
    ]));
  });

  test('rolls back both prepared groups when new study readback mismatches', async () => {
    let corruptMacd = false;
    const harness = createVerifiedChartHarness((name, inputs) => {
      if (corruptMacd && name === 'MACD') inputs.in_2 = 10;
    });
    const configErrors = jest.fn();
    const controller = new AdvancedChartIndicatorController({
      onCommitted: jest.fn(),
      onError: jest.fn(),
      onConfigCommitted: jest.fn(),
      onConfigError: configErrors,
    });
    controller.attach(harness.chart);
    controller.setIndicatorConfig(defaultConfigV2, 1);
    await settle();
    const stableIds = harness.studies.map((study) => study.id);
    corruptMacd = true;

    controller.setIndicatorConfig({
      protocolVersion: 2,
      overlay: { kind: 'BOLL', params: { length: 20, multiplier: 2 } },
      pane: {
        kind: 'MACD',
        params: { fastLength: 12, slowLength: 26, signalLength: 9 },
      },
    }, 2);
    await settle();

    expect(configErrors).toHaveBeenCalledWith(2, '技术指标配置失败', defaultConfigV2);
    expect(harness.studies.map((study) => study.id)).toEqual(stableIds);
    expect(harness.removed).toEqual(expect.arrayContaining(['verified-3', 'verified-4']));
  });

  test('rejects stale v2 intents and replays the canonical config on a new generation', async () => {
    const first = createVerifiedChartHarness();
    const replacement = createVerifiedChartHarness();
    const committed = jest.fn();
    const controller = new AdvancedChartIndicatorController({
      onCommitted: jest.fn(),
      onError: jest.fn(),
      onConfigCommitted: committed,
      onConfigError: jest.fn(),
    });
    controller.attach(first.chart);
    expect(controller.setIndicatorConfig(defaultConfigV2, 2)).toBe(true);
    expect(controller.setIndicatorConfig({
      ...defaultConfigV2,
      pane: { kind: 'RSI', params: { length: 14 } },
    }, 1)).toBe(false);
    await settle();
    controller.attach(replacement.chart);
    await settle();

    expect(replacement.created.map((study) => study.name)).toEqual(['Moving Average', 'Volume']);
    expect(committed).toHaveBeenLastCalledWith(2, defaultConfigV2);
  });

  test('adopts only matching readback, removes duplicate Volume, and preserves unknown studies', async () => {
    const harness = createVerifiedChartHarness();
    harness.addStudy('ma-existing', 'Moving Average', advancedChartStudyInputs(defaultConfigV2.overlay));
    harness.addStudy('volume-match', 'Volume', advancedChartStudyInputs(defaultConfigV2.pane));
    harness.addStudy('volume-stale', 'Volume', {
      ...advancedChartStudyInputs(defaultConfigV2.pane),
      length: 99,
    });
    harness.addStudy('unknown', 'Ichimoku Cloud', { length: 10 });
    const controller = new AdvancedChartIndicatorController({
      onCommitted: jest.fn(),
      onError: jest.fn(),
      onConfigCommitted: jest.fn(),
      onConfigError: jest.fn(),
    });
    controller.attach(harness.chart);
    controller.setIndicatorConfig(defaultConfigV2, 1);
    await settle();

    expect(harness.created).toHaveLength(0);
    expect(harness.removed).toContain('volume-stale');
    expect(harness.removed).not.toContain('volume-match');
    expect(harness.removed).not.toContain('unknown');
  });

  test('keeps a committed v2 transaction when its receipt callback throws', async () => {
    const harness = createVerifiedChartHarness();
    const configError = jest.fn();
    const controller = new AdvancedChartIndicatorController({
      onCommitted: jest.fn(),
      onError: jest.fn(),
      onConfigCommitted: () => { throw new Error('bridge unavailable'); },
      onConfigError: configError,
    });
    controller.attach(harness.chart);
    controller.setIndicatorConfig(defaultConfigV2, 1);
    await settle();
    const firstOverlay = harness.created[0].id;
    const stablePane = harness.created[1].id;

    const updated: AdvancedChartIndicatorConfigV2 = {
      ...defaultConfigV2,
      overlay: { kind: 'MA', params: { length: 30 } },
    };
    controller.setIndicatorConfig(updated, 2);
    await settle();

    expect(configError).not.toHaveBeenCalled();
    expect(harness.removed).toContain(firstOverlay);
    expect(harness.removed).not.toContain(stablePane);
    expect(harness.studies).toEqual(expect.arrayContaining([
      { id: stablePane, name: 'Volume' },
      { id: harness.created[2].id, name: 'Moving Average' },
    ]));
    expect((controller as unknown as {
      lastCommittedConfig: AdvancedChartIndicatorConfigV2;
    }).lastCommittedConfig).toEqual(updated);
  });

  test('keeps v1 compatibility committed when the legacy receipt callback throws', async () => {
    const harness = createVerifiedChartHarness();
    const legacyError = jest.fn();
    const controller = new AdvancedChartIndicatorController({
      onCommitted: () => { throw new Error('legacy bridge unavailable'); },
      onError: legacyError,
      onConfigCommitted: jest.fn(),
      onConfigError: jest.fn(),
    });
    controller.attach(harness.chart);
    controller.setIndicators(defaultSelection, 1);
    await settle();
    const firstOverlay = harness.created[0].id;

    controller.setIndicators({ overlay: 'EMA', pane: 'VOL' }, 2);
    await settle();

    expect(legacyError).not.toHaveBeenCalled();
    expect(harness.removed).toContain(firstOverlay);
    expect(harness.studies).toEqual(expect.arrayContaining([
      { id: harness.created[1].id, name: 'Volume' },
      { id: harness.created[2].id, name: 'Moving Average Exponential' },
    ]));
  });
});
