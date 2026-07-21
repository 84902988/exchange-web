export type MarketsTickerRefreshTask = {
  market: 'spot' | 'contract';
  lane: 'priority' | 'crypto' | 'tradfi';
  symbols: string[];
};

type BuildMarketsTickerRefreshTasksOptions = {
  prioritySymbols: string[];
  cryptoSpotSymbols: string[];
  cryptoContractSymbols: string[];
  tradfiSpotSymbols: string[];
  tradfiContractSymbols: string[];
  spotBatchSize: number;
  contractBatchSize: number;
};

function normalizeSymbols(symbols: string[]): string[] {
  return Array.from(new Set(
    symbols
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean),
  ));
}

function chunkSymbols(symbols: string[], size: number): string[][] {
  const chunks: string[][] = [];
  const safeSize = Math.max(1, Math.floor(size || 1));
  for (let index = 0; index < symbols.length; index += safeSize) {
    chunks.push(symbols.slice(index, index + safeSize));
  }
  return chunks;
}

export function buildMarketsTickerRefreshTasks({
  prioritySymbols,
  cryptoSpotSymbols,
  cryptoContractSymbols,
  tradfiSpotSymbols,
  tradfiContractSymbols,
  spotBatchSize,
  contractBatchSize,
}: BuildMarketsTickerRefreshTasksOptions): MarketsTickerRefreshTask[] {
  const prioritySet = new Set(normalizeSymbols(prioritySymbols));
  const seenSpot = new Set<string>();
  const seenContract = new Set<string>();
  const tasks: MarketsTickerRefreshTask[] = [];

  const append = (
    market: MarketsTickerRefreshTask['market'],
    lane: MarketsTickerRefreshTask['lane'],
    symbols: string[],
    priorityOnly: boolean,
  ) => {
    const seen = market === 'spot' ? seenSpot : seenContract;
    const selected = normalizeSymbols(symbols).filter((symbol) => {
      if (seen.has(symbol) || prioritySet.has(symbol) !== priorityOnly) return false;
      seen.add(symbol);
      return true;
    });
    const batchSize = market === 'spot' ? spotBatchSize : contractBatchSize;
    chunkSymbols(selected, batchSize).forEach((chunk) => {
      tasks.push({ market, lane, symbols: chunk });
    });
  };

  // First paint: hot/summary/first-visible symbols from every market share the
  // same bounded queue, so a slow stock batch cannot block crypto or CFD rows.
  append('spot', 'priority', [...cryptoSpotSymbols, ...tradfiSpotSymbols], true);
  append('contract', 'priority', [...cryptoContractSymbols, ...tradfiContractSymbols], true);

  append('spot', 'crypto', cryptoSpotSymbols, false);
  append('contract', 'crypto', cryptoContractSymbols, false);
  append('spot', 'tradfi', tradfiSpotSymbols, false);
  append('contract', 'tradfi', tradfiContractSymbols, false);

  return tasks;
}

export async function runMarketsTickerRefreshTasks(
  tasks: MarketsTickerRefreshTask[],
  worker: (task: MarketsTickerRefreshTask) => Promise<void>,
  concurrency: number,
): Promise<PromiseSettledResult<void>[]> {
  if (tasks.length === 0) return [];

  const results: PromiseSettledResult<void>[] = new Array(tasks.length);
  let nextTaskIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency || 1), tasks.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextTaskIndex < tasks.length) {
      const taskIndex = nextTaskIndex;
      nextTaskIndex += 1;
      try {
        await worker(tasks[taskIndex]);
        results[taskIndex] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[taskIndex] = { status: 'rejected', reason };
      }
    }
  }));

  return results;
}
