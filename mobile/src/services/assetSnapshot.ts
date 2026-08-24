import {
  fetchAssetAccountBalances,
  type AssetAccountBalance,
} from '../api/assets';
import { publicApiClient } from '../api/client';

export const ASSET_SNAPSHOT_TTL_MS = 25_000;

const QUOTE_ASSET = 'USDT';
const ACCOUNT_ORDER = new Map([
  ['funding', 0],
  ['spot', 1],
  ['contract', 2],
]);

export type AssetValuationRow = AssetAccountBalance & {
  key: string;
  totalAmount: number | null;
  priceUsdt: number | null;
  valueUsdt: number | null;
  valuationComplete: boolean;
};

export type AssetAccountValuation = {
  accountKey: string;
  rowCount: number;
  positiveAssetCount: number;
  knownValueUsdt: number;
  totalUsdt: number | null;
  valuationComplete: boolean;
};

export type AssetSnapshot = {
  userId: string;
  rows: AssetValuationRow[];
  accounts: AssetAccountValuation[];
  knownTotalUsdt: number;
  totalUsdt: number | null;
  valuationComplete: boolean;
  missingPriceSymbols: string[];
  incompleteSymbols: string[];
  fetchedAt: number;
};

export type AssetSnapshotLoadResult = {
  snapshot: AssetSnapshot | null;
  source: 'cache' | 'network' | 'stale-cache' | 'error';
  error: string | null;
};

export type AssetSnapshotRepository = {
  load: (options: {
    userId: number | string;
    force?: boolean;
  }) => Promise<AssetSnapshotLoadResult>;
  peek: (userId: number | string) => AssetSnapshot | null;
  reset: () => void;
};

type AssetSnapshotRepositoryOptions = {
  fetchBalances?: (userId: string) => Promise<AssetAccountBalance[]>;
  fetchTickerPayload?: (pairSymbols: string[]) => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
};

type SnapshotCacheEntry = {
  snapshot: AssetSnapshot;
  fetchedAt: number;
};

export function calculateAssetSnapshot({
  balances,
  fetchedAt,
  pricesUsdt,
  userId,
}: {
  balances: AssetAccountBalance[];
  fetchedAt: number;
  pricesUsdt: Readonly<Record<string, number>>;
  userId: number | string;
}): AssetSnapshot {
  const normalizedUserId = requireUserId(userId);
  const rows = aggregateAssetBalances(balances).map(row =>
    valueAssetRow(row, pricesUsdt),
  );
  const accountKeys = Array.from(new Set(rows.map(row => row.accountKey)));
  const accounts = accountKeys
    .map(accountKey => calculateAccountValuation(accountKey, rows))
    .sort(compareAccounts);
  const valuationComplete = rows.every(row => row.valuationComplete);
  const knownTotalUsdt = rows.reduce(
    (sum, row) => sum + (row.valueUsdt ?? 0),
    0,
  );

  return {
    userId: normalizedUserId,
    rows,
    accounts,
    knownTotalUsdt,
    totalUsdt: valuationComplete ? knownTotalUsdt : null,
    valuationComplete,
    missingPriceSymbols: Array.from(
      new Set(
        rows
          .filter(
            row =>
              row.symbol !== QUOTE_ASSET &&
              row.totalAmount !== null &&
              row.totalAmount !== 0 &&
              row.priceUsdt === null,
          )
          .map(row => row.symbol),
      ),
    ).sort(),
    incompleteSymbols: Array.from(
      new Set(
        rows.filter(row => !row.valuationComplete).map(row => row.symbol),
      ),
    ).sort(),
    fetchedAt,
  };
}

export function getRequiredAssetPriceSymbols(balances: AssetAccountBalance[]) {
  return Array.from(
    new Set(
      aggregateAssetBalances(balances)
        .filter(
          row =>
            row.symbol !== QUOTE_ASSET &&
            row.totalAmount !== null &&
            row.totalAmount !== 0,
        )
        .map(row => row.symbol),
    ),
  ).sort();
}

export function normalizeAssetTickerPrices(
  payload: unknown,
  requestedAssetSymbols: string[],
): Record<string, number> {
  const rows = readTickerRows(payload);
  const prices: Record<string, number> = {};

  Array.from(
    new Set(
      requestedAssetSymbols
        .map(symbol => normalizeSymbol(symbol))
        .filter(symbol => symbol && symbol !== QUOTE_ASSET),
    ),
  ).forEach(assetSymbol => {
    const pairSymbol = `${assetSymbol}${QUOTE_ASSET}`;
    const matchingRows = rows.filter(row => {
      const record = asRecord(row);
      return normalizeSymbol(record?.symbol) === pairSymbol;
    });
    if (matchingRows.length !== 1) {
      return;
    }

    const record = asRecord(matchingRows[0]);
    const price = readStrictPositiveNumber(record?.last_price);
    if (!record || record.stale !== false || price === null) {
      return;
    }
    prices[assetSymbol] = price;
  });

  return prices;
}

export function buildAssetTickerBatchPath(pairSymbols: string[]) {
  return `/market/tickers?symbols=${encodeURIComponent(pairSymbols.join(','))}`;
}

export function createAssetSnapshotRepository({
  fetchBalances = () => fetchAssetAccountBalances(),
  fetchTickerPayload = pairSymbols =>
    publicApiClient.get<unknown>(buildAssetTickerBatchPath(pairSymbols)),
  now = Date.now,
  ttlMs = ASSET_SNAPSHOT_TTL_MS,
}: AssetSnapshotRepositoryOptions = {}): AssetSnapshotRepository {
  const maxUserEntries = 4;
  const cache = new Map<string, SnapshotCacheEntry>();
  const inFlight = new Map<string, Promise<AssetSnapshotLoadResult>>();

  function peek(userId: number | string) {
    const userKey = normalizeAssetSnapshotUserId(userId);
    return userKey ? cache.get(userKey)?.snapshot ?? null : null;
  }

  function load({
    userId,
    force = false,
  }: {
    userId: number | string;
    force?: boolean;
  }): Promise<AssetSnapshotLoadResult> {
    const userKey = normalizeAssetSnapshotUserId(userId);
    if (!userKey) {
      return Promise.resolve({
        snapshot: null,
        source: 'error',
        error: '用户身份无效，无法读取资产',
      });
    }

    const requestedAt = now();
    const cached = cache.get(userKey);
    if (
      !force &&
      cached &&
      requestedAt - cached.fetchedAt < Math.max(0, ttlMs)
    ) {
      return Promise.resolve({
        snapshot: cached.snapshot,
        source: 'cache',
        error: null,
      });
    }

    const existing = inFlight.get(userKey);
    if (existing) {
      return existing;
    }

    const promise = fetchBalances(userKey)
      .then(async balances => {
        const assetSymbols = getRequiredAssetPriceSymbols(balances);
        const pairSymbols = assetSymbols.map(
          symbol => `${symbol}${QUOTE_ASSET}`,
        );
        const pricesUsdt =
          pairSymbols.length === 0
            ? {}
            : normalizeAssetTickerPrices(
                await fetchTickerPayload(pairSymbols),
                assetSymbols,
              );
        const fetchedAt = now();
        const snapshot = calculateAssetSnapshot({
          balances,
          fetchedAt,
          pricesUsdt,
          userId: userKey,
        });
        cache.delete(userKey);
        cache.set(userKey, { snapshot, fetchedAt });
        while (cache.size > maxUserEntries) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
        return {
          snapshot,
          source: 'network' as const,
          error: null,
        };
      })
      .catch(() => ({
        snapshot: cached?.snapshot ?? null,
        source: cached ? ('stale-cache' as const) : ('error' as const),
        error: '资产快照更新失败，请稍后重试',
      }))
      .finally(() => {
        if (inFlight.get(userKey) === promise) {
          inFlight.delete(userKey);
        }
      });

    inFlight.set(userKey, promise);
    return promise;
  }

  return {
    load,
    peek,
    reset: () => {
      cache.clear();
      inFlight.clear();
    },
  };
}

export function isAssetSnapshotExpired(
  snapshot: AssetSnapshot,
  now = Date.now(),
) {
  return now - snapshot.fetchedAt >= ASSET_SNAPSHOT_TTL_MS;
}

export function getAssetAccountValuation(
  snapshot: AssetSnapshot | null,
  accountKey: string,
): AssetAccountValuation {
  const normalizedAccountKey = normalizeAccountKey(accountKey);
  const account = snapshot?.accounts.find(
    item => item.accountKey === normalizedAccountKey,
  );
  return (
    account ?? {
      accountKey: normalizedAccountKey,
      rowCount: 0,
      positiveAssetCount: 0,
      knownValueUsdt: 0,
      totalUsdt: snapshot ? 0 : null,
      valuationComplete: Boolean(snapshot),
    }
  );
}

const repository = createAssetSnapshotRepository();

export const loadAssetSnapshot = repository.load;
export const getCachedAssetSnapshot = repository.peek;

export function __resetAssetSnapshotForTests() {
  repository.reset();
}

function aggregateAssetBalances(balances: AssetAccountBalance[]): Array<
  AssetAccountBalance & {
    key: string;
    totalAmount: number | null;
  }
> {
  const aggregated = new Map<
    string,
    {
      symbol: string;
      accountKey: string;
      available: number | null;
      frozen: number | null;
    }
  >();

  balances.forEach(balance => {
    const symbol = normalizeSymbol(balance.symbol);
    const accountKey = normalizeAccountKey(balance.accountKey);
    if (!symbol || !accountKey) {
      throw new Error('Asset balance identity is invalid');
    }
    const key = `${accountKey}:${symbol}`;
    const existing = aggregated.get(key);
    const available = normalizeFiniteNumber(balance.available);
    const frozen = normalizeFiniteNumber(balance.frozen);
    if (!existing) {
      aggregated.set(key, { symbol, accountKey, available, frozen });
      return;
    }
    existing.available = addNullable(existing.available, available);
    existing.frozen = addNullable(existing.frozen, frozen);
  });

  return Array.from(aggregated.entries())
    .map(([key, row]) => ({
      key,
      ...row,
      totalAmount:
        row.available === null || row.frozen === null
          ? null
          : row.available + row.frozen,
    }))
    .sort(compareRows);
}

function valueAssetRow(
  row: ReturnType<typeof aggregateAssetBalances>[number],
  pricesUsdt: Readonly<Record<string, number>>,
): AssetValuationRow {
  const rawPrice = row.symbol === QUOTE_ASSET ? 1 : pricesUsdt[row.symbol];
  const priceUsdt =
    typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0
      ? rawPrice
      : null;
  const rawValue =
    row.totalAmount !== null && priceUsdt !== null
      ? row.totalAmount * priceUsdt
      : null;
  const valueUsdt =
    rawValue !== null && Number.isFinite(rawValue) ? rawValue : null;
  const valuationComplete =
    row.totalAmount === 0 ||
    (row.totalAmount !== null && priceUsdt !== null && valueUsdt !== null);

  return {
    ...row,
    priceUsdt,
    valueUsdt: row.totalAmount === 0 ? 0 : valueUsdt,
    valuationComplete,
  };
}

function calculateAccountValuation(
  accountKey: string,
  rows: AssetValuationRow[],
): AssetAccountValuation {
  const accountRows = rows.filter(row => row.accountKey === accountKey);
  const valuationComplete = accountRows.every(row => row.valuationComplete);
  const knownValueUsdt = accountRows.reduce(
    (sum, row) => sum + (row.valueUsdt ?? 0),
    0,
  );
  return {
    accountKey,
    rowCount: accountRows.length,
    positiveAssetCount: accountRows.filter(row => (row.totalAmount ?? 0) > 0)
      .length,
    knownValueUsdt,
    totalUsdt: valuationComplete ? knownValueUsdt : null,
    valuationComplete,
  };
}

function compareRows(
  left: { accountKey: string; symbol: string },
  right: { accountKey: string; symbol: string },
) {
  const accountOrder =
    (ACCOUNT_ORDER.get(left.accountKey) ?? Number.MAX_SAFE_INTEGER) -
    (ACCOUNT_ORDER.get(right.accountKey) ?? Number.MAX_SAFE_INTEGER);
  return (
    accountOrder ||
    left.accountKey.localeCompare(right.accountKey) ||
    left.symbol.localeCompare(right.symbol)
  );
}

function compareAccounts(
  left: AssetAccountValuation,
  right: AssetAccountValuation,
) {
  const accountOrder =
    (ACCOUNT_ORDER.get(left.accountKey) ?? Number.MAX_SAFE_INTEGER) -
    (ACCOUNT_ORDER.get(right.accountKey) ?? Number.MAX_SAFE_INTEGER);
  return accountOrder || left.accountKey.localeCompare(right.accountKey);
}

function readTickerRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  throw new Error('Asset ticker batch payload must be an array');
}

function readStrictPositiveNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (
    typeof value !== 'string' ||
    !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function addNullable(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right;
}

function normalizeFiniteNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSymbol(value: unknown) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z0-9._-]{1,32}$/.test(symbol) ? symbol : '';
}

function normalizeAccountKey(value: unknown) {
  const accountKey =
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9_-]{1,32}$/.test(accountKey) ? accountKey : '';
}

export function normalizeAssetSnapshotUserId(value: unknown) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  if (typeof value !== 'string') {
    return '';
  }
  const userId = value.trim();
  if (!userId || userId.length > 128) {
    return '';
  }
  if (/^\d+$/.test(userId)) {
    const numericUserId = Number(userId);
    return Number.isSafeInteger(numericUserId) && numericUserId > 0
      ? String(numericUserId)
      : '';
  }
  return userId;
}

function requireUserId(value: number | string) {
  const userId = normalizeAssetSnapshotUserId(value);
  if (!userId) {
    throw new Error('Asset snapshot user identity is invalid');
  }
  return userId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
