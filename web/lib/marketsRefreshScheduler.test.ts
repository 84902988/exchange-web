import { describe, expect, it, jest } from '@jest/globals';

import {
  buildMarketsTickerRefreshTasks,
  runMarketsTickerRefreshTasks,
} from './marketsRefreshScheduler';

describe('markets refresh scheduler', () => {
  it('prioritizes first-paint symbols and never schedules a symbol twice', () => {
    const tasks = buildMarketsTickerRefreshTasks({
      prioritySymbols: ['BTCUSDT', 'AAPLUSDT_PERP'],
      cryptoSpotSymbols: ['BTCUSDT', 'ETHUSDT'],
      cryptoContractSymbols: ['BTCUSDT_PERP'],
      tradfiSpotSymbols: [],
      tradfiContractSymbols: ['AAPLUSDT_PERP', 'ABBVUSDT_PERP'],
      spotBatchSize: 50,
      contractBatchSize: 20,
    });

    expect(tasks.slice(0, 2)).toEqual([
      { market: 'spot', lane: 'priority', symbols: ['BTCUSDT'] },
      { market: 'contract', lane: 'priority', symbols: ['AAPLUSDT_PERP'] },
    ]);
    expect(tasks.flatMap((task) => task.symbols)).toEqual([
      'BTCUSDT',
      'AAPLUSDT_PERP',
      'ETHUSDT',
      'BTCUSDT_PERP',
      'ABBVUSDT_PERP',
    ]);
  });

  it('keeps total task concurrency within the configured bound', async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      market: 'contract' as const,
      lane: 'tradfi' as const,
      symbols: [`S${index}`],
    }));
    let active = 0;
    let peak = 0;
    const worker = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });

    const results = await runMarketsTickerRefreshTasks(tasks, worker, 2);

    expect(peak).toBe(2);
    expect(worker).toHaveBeenCalledTimes(6);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it('continues remaining batches when one provider batch fails', async () => {
    const tasks = ['A', 'B', 'C'].map((symbol) => ({
      market: 'contract' as const,
      lane: 'tradfi' as const,
      symbols: [symbol],
    }));
    const visited: string[] = [];

    const results = await runMarketsTickerRefreshTasks(tasks, async (task) => {
      const symbol = task.symbols[0];
      visited.push(symbol);
      if (symbol === 'B') throw new Error('provider unavailable');
    }, 2);

    expect(visited.sort()).toEqual(['A', 'B', 'C']);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
