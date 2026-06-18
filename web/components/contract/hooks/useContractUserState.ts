'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toNumber } from '@/components/contract/contractFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractAccountSummary,
  getContractPrivateWsBridgeHealth,
  getContractOrders,
  getContractPositionSummaries,
  getContractPositions,
  getContractTrades,
  type ContractAccountSummary,
  type ContractOrderListItem,
  type ContractPositionItem,
  type ContractPositionSummaryItem,
  type ContractTradeListItem,
} from '@/lib/api/modules/contract';
import {
  contractUserRealtime,
  type ContractUserRealtimeMessage,
  type ContractUserRealtimeStatus,
} from '@/lib/realtime/contractUserRealtime';

type UseContractUserStateParams = {
  contractSymbol: string;
  dataScope?: 'current' | 'all';
  isLoggedIn: boolean;
  onErrorChange: (message: string | null) => void;
};

type ContractDataScope = NonNullable<UseContractUserStateParams['dataScope']>;
const CONTRACT_WS_BRIDGE_HEALTH_CHECK_MS = 30000;

type PositionScopeCacheEntry = {
  positions: ContractPositionItem[];
  positionSummaries: ContractPositionSummaryItem[];
  loadedAt: number;
};

type ListScopeCacheEntry<T> = {
  rows: T[];
  total: number;
  page: number;
  loadedAt: number;
};

const ACTIVE_CONTRACT_ORDER_STATUSES = new Set(['OPEN', 'NEW', 'PENDING', 'PARTIALLY_FILLED']);

function normalizeCacheSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function getPositionScopeCacheKey(scope: ContractDataScope, symbol: string) {
  return scope === 'all' ? 'all' : `current:${normalizeCacheSymbol(symbol)}`;
}

function getScopedSymbol(scope: ContractDataScope, symbol: string) {
  return scope === 'current' ? normalizeCacheSymbol(symbol) : undefined;
}

function getListCacheSymbol(scope: ContractDataScope, symbol: string) {
  return getScopedSymbol(scope, symbol) || 'all';
}

function getOrdersCacheKey(scope: ContractDataScope, symbol: string, page = 1) {
  return `orders:${getListCacheSymbol(scope, symbol)}:${page}`;
}

function getActiveOrdersCacheKey(scope: ContractDataScope, symbol: string, page = 1) {
  return `active-orders:${getListCacheSymbol(scope, symbol)}:${page}`;
}

function getTradesCacheKey(scope: ContractDataScope, symbol: string, page = 1) {
  return `trades:${getListCacheSymbol(scope, symbol)}:${page}`;
}

function mergePositionLists(lists: Array<ContractPositionItem[]>) {
  const map = new Map<number, ContractPositionItem>();
  lists.flat().forEach((item) => {
    map.set(item.id, item);
  });
  return Array.from(map.values()).sort((a, b) => b.id - a.id);
}

function getPositionAmount(item: ContractPositionItem) {
  const record = item as ContractPositionItem & {
    amount?: string | number | null;
    size?: string | number | null;
  };
  return toNumber(record.quantity ?? record.amount ?? record.size);
}

function isActiveContractOrder(item: ContractOrderListItem) {
  return ACTIVE_CONTRACT_ORDER_STATUSES.has(String(item.status || '').trim().toUpperCase());
}

function filterActiveContractOrders(items: ContractOrderListItem[]) {
  return items.filter(isActiveContractOrder);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getContractUserPayload(message: ContractUserRealtimeMessage) {
  if (isRecord(message.payload)) return message.payload;
  return isRecord(message.data) ? message.data : message as Record<string, unknown>;
}

function getContractUserMessageSymbol(
  message: ContractUserRealtimeMessage,
  payload: Record<string, unknown>,
) {
  return String(message.symbol || payload.symbol || '').trim().toUpperCase();
}

function isContractUserMessageForSymbol(
  message: ContractUserRealtimeMessage,
  payload: Record<string, unknown>,
  currentSymbol: string,
) {
  const msgSymbol = getContractUserMessageSymbol(message, payload);
  return !msgSymbol || msgSymbol === currentSymbol.toUpperCase();
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function extractContractAccountUpdate(message: ContractUserRealtimeMessage) {
  const payload = getContractUserPayload(message);
  const source = isRecord(message.account)
    ? message.account
    : isRecord(message.summary)
      ? message.summary
      : isRecord(payload.account)
        ? payload.account
        : isRecord(payload.summary)
          ? payload.summary
          : payload;

  if (!('available_margin' in source) && !('equity' in source)) return null;
  return source as unknown as ContractAccountSummary;
}

function extractContractPositionsUpdate(
  message: ContractUserRealtimeMessage,
  currentSymbol: string,
) {
  const payload = getContractUserPayload(message);
  if (!isContractUserMessageForSymbol(message, payload, currentSymbol)) return null;
  const hasSummaryPayload =
    message.position_summaries !== undefined ||
    message.position_summary !== undefined ||
    payload.position_summaries !== undefined ||
    payload.position_summary !== undefined;
  if (!hasSummaryPayload) return null;

  const items = [
    ...asRecordArray(message.positions),
    ...asRecordArray(message.position),
    ...asRecordArray(payload.positions),
    ...asRecordArray(payload.position),
  ].filter((item) => {
    const itemSymbol = String(item.symbol || '').trim().toUpperCase();
    return !itemSymbol || itemSymbol === currentSymbol.toUpperCase();
  });

  if (items.length === 0) return null;
  return {
    replace: Array.isArray(message.positions) || Array.isArray(payload.positions),
    items: items as unknown as ContractPositionItem[],
  };
}

function extractContractPositionSummariesUpdate(
  message: ContractUserRealtimeMessage,
  currentSymbol: string,
) {
  const payload = getContractUserPayload(message);
  if (!isContractUserMessageForSymbol(message, payload, currentSymbol)) return null;

  const items = [
    ...asRecordArray(message.position_summaries),
    ...asRecordArray(message.position_summary),
    ...asRecordArray(payload.position_summaries),
    ...asRecordArray(payload.position_summary),
  ].filter((item) => {
    const itemSymbol = String(item.symbol || '').trim().toUpperCase();
    return !itemSymbol || itemSymbol === currentSymbol.toUpperCase();
  });

  return {
    replace: Array.isArray(message.position_summaries) || Array.isArray(payload.position_summaries),
    items: items as unknown as ContractPositionSummaryItem[],
  };
}

function extractContractOrdersUpdate(
  message: ContractUserRealtimeMessage,
  currentSymbol: string,
) {
  const payload = getContractUserPayload(message);
  if (!isContractUserMessageForSymbol(message, payload, currentSymbol)) return null;

  const items = [
    ...asRecordArray(message.orders),
    ...asRecordArray(message.order),
    ...asRecordArray(payload.orders),
    ...asRecordArray(payload.order),
  ].filter((item) => {
    const itemSymbol = String(item.symbol || '').trim().toUpperCase();
    return !itemSymbol || itemSymbol === currentSymbol.toUpperCase();
  });

  if (items.length === 0) return null;
  return {
    replace: Array.isArray(message.orders) || Array.isArray(payload.orders),
    items: items as unknown as ContractOrderListItem[],
  };
}

function extractContractTradesUpdate(
  message: ContractUserRealtimeMessage,
  currentSymbol: string,
) {
  const payload = getContractUserPayload(message);
  if (!isContractUserMessageForSymbol(message, payload, currentSymbol)) return null;

  const items = [
    ...asRecordArray(message.trades),
    ...asRecordArray(message.trade),
    ...asRecordArray(payload.trades),
    ...asRecordArray(payload.trade),
  ].filter((item) => {
    const itemSymbol = String(item.symbol || '').trim().toUpperCase();
    return !itemSymbol || itemSymbol === currentSymbol.toUpperCase();
  });

  if (items.length === 0) return null;
  return {
    replace: Array.isArray(message.trades) || Array.isArray(payload.trades),
    items: items as unknown as ContractTradeListItem[],
  };
}

function replaceOrMergeById<T extends { id: number }>(previous: T[], items: T[], replace: boolean) {
  if (replace) return [...items].sort((a, b) => b.id - a.id);

  const map = new Map<number, T>();
  for (const item of previous) {
    map.set(item.id, item);
  }
  for (const item of items) {
    map.set(item.id, item);
  }
  return Array.from(map.values()).sort((a, b) => b.id - a.id);
}

function replaceOrMergeByIdForSymbol<T extends { id: number; symbol?: string }>(
  previous: T[],
  items: T[],
  replace: boolean,
  currentSymbol: string,
) {
  if (!replace) return replaceOrMergeById(previous, items, false);

  const normalizedSymbol = currentSymbol.toUpperCase();
  const preserved = previous.filter((item) => String(item.symbol || '').trim().toUpperCase() !== normalizedSymbol);
  return replaceOrMergeById(preserved, items, false);
}

function replaceOrMergeActiveOrdersByIdForSymbol(
  previous: ContractOrderListItem[],
  items: ContractOrderListItem[],
  replace: boolean,
  currentSymbol: string,
) {
  const activeItems = filterActiveContractOrders(items);
  if (replace) return replaceOrMergeByIdForSymbol(previous, activeItems, true, currentSymbol);

  const itemIds = new Set(items.map((item) => Number(item.id)));
  const normalizedSymbol = currentSymbol.toUpperCase();
  const preserved = previous.filter((item) => {
    const itemSymbol = String(item.symbol || '').trim().toUpperCase();
    return itemSymbol !== normalizedSymbol || !itemIds.has(Number(item.id));
  });
  return replaceOrMergeById(preserved, activeItems, false);
}

function replaceOrMergePositions(
  previous: ContractPositionItem[],
  items: ContractPositionItem[],
  replace: boolean,
  currentSymbol: string,
) {
  if (!replace) return replaceOrMergeById(previous, items, false);

  const normalizedSymbol = currentSymbol.toUpperCase();
  const preserved = previous.filter((item) => String(item.symbol || '').trim().toUpperCase() !== normalizedSymbol);
  return replaceOrMergeById(preserved, items, false);
}

function replaceOrMergePositionSummaries(
  previous: ContractPositionSummaryItem[],
  items: ContractPositionSummaryItem[],
  replace: boolean,
  currentSymbol: string,
) {
  const normalizedSymbol = currentSymbol.toUpperCase();
  const currentItems = replace
    ? items
    : [
        ...previous.filter((item) => String(item.symbol || '').trim().toUpperCase() === normalizedSymbol),
        ...items,
      ];
  const map = new Map<string, ContractPositionSummaryItem>();
  currentItems.forEach((item) => {
    const key = `${String(item.symbol || '').trim().toUpperCase()}:${String(item.side || '').trim().toUpperCase()}`;
    map.set(key, item);
  });
  const mergedCurrentItems = Array.from(map.values());
  if (replace) {
    const preserved = previous.filter((item) => String(item.symbol || '').trim().toUpperCase() !== normalizedSymbol);
    return [...preserved, ...mergedCurrentItems];
  }
  return [
    ...previous.filter((item) => String(item.symbol || '').trim().toUpperCase() !== normalizedSymbol),
    ...mergedCurrentItems,
  ];
}

function getMessageSeq(message: ContractUserRealtimeMessage) {
  const value = Number(message.seq);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getMessageServerTs(message: ContractUserRealtimeMessage) {
  if (!message.server_ts) return null;
  const value = Date.parse(message.server_ts);
  return Number.isFinite(value) ? value : null;
}

export function useContractUserState({
  contractSymbol,
  dataScope = 'current',
  isLoggedIn,
  onErrorChange,
}: UseContractUserStateParams) {
  const { t } = useLocaleContext();
  const [account, setAccount] = useState<ContractAccountSummary | null>(null);
  const [positions, setPositions] = useState<ContractPositionItem[]>([]);
  const [positionSummaries, setPositionSummaries] = useState<ContractPositionSummaryItem[]>([]);
  const [activeOrders, setActiveOrders] = useState<ContractOrderListItem[]>([]);
  const [orders, setOrders] = useState<ContractOrderListItem[]>([]);
  const [trades, setTrades] = useState<ContractTradeListItem[]>([]);
  const [privateLoading, setPrivateLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isScopeSwitching, setIsScopeSwitching] = useState(false);
  const [isAllPositionsLoading, setIsAllPositionsLoading] = useState(false);
  const [isOrdersLoading, setIsOrdersLoading] = useState(false);
  const [isTradesLoading, setIsTradesLoading] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<ContractUserRealtimeStatus>('idle');
  const hasLoadedPrivateRef = useRef(false);
  const positionScopeCacheRef = useRef<Map<string, PositionScopeCacheEntry>>(new Map());
  const activeOrdersCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractOrderListItem>>>(new Map());
  const ordersCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractOrderListItem>>>(new Map());
  const tradesCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractTradeListItem>>>(new Map());
  const allPrefetchInFlightRef = useRef<Promise<void> | null>(null);
  const ordersTradesPrefetchInFlightRef = useRef<Promise<void> | null>(null);
  const refreshPrivateRequestSeqRef = useRef(0);
  const realtimeVersionRef = useRef(0);
  const lastRealtimeSeqRef = useRef(0);
  const lastRealtimeTsRef = useRef(0);
  const positionsRef = useRef<ContractPositionItem[]>([]);
  const positionSummariesRef = useRef<ContractPositionSummaryItem[]>([]);
  const hasPrefetchedAllRef = useRef(false);
  const hasPrefetchedOrdersTradesRef = useRef(false);
  const activePositionScopeKey = useMemo(
    () => getPositionScopeCacheKey(dataScope, contractSymbol),
    [contractSymbol, dataScope],
  );
  const activeOrdersScopeKey = useMemo(
    () => getActiveOrdersCacheKey(dataScope, contractSymbol, 1),
    [contractSymbol, dataScope],
  );
  const activeOrdersCacheKey = useMemo(
    () => getOrdersCacheKey(dataScope, contractSymbol, 1),
    [contractSymbol, dataScope],
  );
  const activeTradesCacheKey = useMemo(
    () => getTradesCacheKey(dataScope, contractSymbol, 1),
    [contractSymbol, dataScope],
  );
  const activePositionScopeKeyRef = useRef(activePositionScopeKey);
  const activeOrdersScopeKeyRef = useRef(activeOrdersScopeKey);
  const activeOrdersCacheKeyRef = useRef(activeOrdersCacheKey);
  const activeTradesCacheKeyRef = useRef(activeTradesCacheKey);

  useEffect(() => {
    activePositionScopeKeyRef.current = activePositionScopeKey;
  }, [activePositionScopeKey]);

  useEffect(() => {
    activeOrdersScopeKeyRef.current = activeOrdersScopeKey;
    const cached = activeOrdersCacheRef.current.get(activeOrdersScopeKey);
    setActiveOrders(cached?.rows || []);
  }, [activeOrdersScopeKey]);

  useEffect(() => {
    activeOrdersCacheKeyRef.current = activeOrdersCacheKey;
  }, [activeOrdersCacheKey]);

  useEffect(() => {
    activeTradesCacheKeyRef.current = activeTradesCacheKey;
  }, [activeTradesCacheKey]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    positionSummariesRef.current = positionSummaries;
  }, [positionSummaries]);

  const applyPositionScopeCache = useCallback((entry: PositionScopeCacheEntry) => {
    positionsRef.current = entry.positions;
    positionSummariesRef.current = entry.positionSummaries;
    setPositions(entry.positions);
    setPositionSummaries(entry.positionSummaries);
  }, []);

  const applyActiveOrdersCache = useCallback((entry: ListScopeCacheEntry<ContractOrderListItem>) => {
    setActiveOrders(entry.rows);
  }, []);

  const applyOrdersCache = useCallback((entry: ListScopeCacheEntry<ContractOrderListItem>) => {
    setOrders(entry.rows);
  }, []);

  const applyTradesCache = useCallback((entry: ListScopeCacheEntry<ContractTradeListItem>) => {
    setTrades(entry.rows);
  }, []);

  const markRealtimeMessage = useCallback((message: ContractUserRealtimeMessage) => {
    const seq = getMessageSeq(message);
    if (seq !== null) {
      if (seq < lastRealtimeSeqRef.current) return false;
      if (seq > lastRealtimeSeqRef.current) {
        lastRealtimeSeqRef.current = seq;
        realtimeVersionRef.current += 1;
      }
      return true;
    }

    const serverTs = getMessageServerTs(message);
    if (serverTs !== null) {
      if (serverTs < lastRealtimeTsRef.current) return false;
      if (serverTs > lastRealtimeTsRef.current) {
        lastRealtimeTsRef.current = serverTs;
        realtimeVersionRef.current += 1;
      }
    } else {
      realtimeVersionRef.current += 1;
    }
    return true;
  }, []);

  const updateActivePositionScopeCache = useCallback((
    nextPositions: ContractPositionItem[],
    nextSummaries: ContractPositionSummaryItem[],
  ) => {
    positionScopeCacheRef.current.set(activePositionScopeKeyRef.current, {
      positions: nextPositions,
      positionSummaries: nextSummaries,
      loadedAt: Date.now(),
    });
  }, []);

  const prefetchAllPositionScope = useCallback(() => {
    if (!isLoggedIn) return null;
    if (positionScopeCacheRef.current.has('all')) return null;
    if (allPrefetchInFlightRef.current) return allPrefetchInFlightRef.current;

    const request = Promise.allSettled([
      getContractPositions({ status: 'ALL' }),
      getContractPositionSummaries(),
    ])
      .then(([positionsResult, positionSummariesResult]) => {
        if (positionsResult.status !== 'fulfilled' || positionSummariesResult.status !== 'fulfilled') {
          return;
        }

        const entry: PositionScopeCacheEntry = {
          positions: mergePositionLists([positionsResult.value.items || []]),
          positionSummaries: positionSummariesResult.value.items || [],
          loadedAt: Date.now(),
        };
        positionScopeCacheRef.current.set('all', entry);

        if (activePositionScopeKeyRef.current === 'all') {
          applyPositionScopeCache(entry);
          setIsScopeSwitching(false);
        }
      })
      .finally(() => {
        allPrefetchInFlightRef.current = null;
        if (activePositionScopeKeyRef.current === 'all') {
          setIsAllPositionsLoading(false);
        }
      });

    allPrefetchInFlightRef.current = request;
    return request;
  }, [applyPositionScopeCache, isLoggedIn]);

  const prefetchOrdersAndTrades = useCallback(() => {
    if (!isLoggedIn) return null;
    const activeOrdersScopeKey = getActiveOrdersCacheKey('current', contractSymbol, 1);
    const ordersCacheKey = getOrdersCacheKey('current', contractSymbol, 1);
    const tradesCacheKey = getTradesCacheKey('current', contractSymbol, 1);
    if (
      activeOrdersCacheRef.current.has(activeOrdersScopeKey) &&
      ordersCacheRef.current.has(ordersCacheKey) &&
      tradesCacheRef.current.has(tradesCacheKey)
    ) return null;
    if (ordersTradesPrefetchInFlightRef.current) return ordersTradesPrefetchInFlightRef.current;

    const scopedSymbol = getScopedSymbol('current', contractSymbol);
    const request = Promise.allSettled([
      getContractOrders({ symbol: scopedSymbol, status: 'ACTIVE', page: 1, page_size: 100 }),
      getContractOrders({ symbol: scopedSymbol, page: 1, page_size: 50 }),
      getContractTrades({ symbol: scopedSymbol, page: 1, page_size: 50 }),
    ])
      .then(([activeOrdersResult, ordersResult, tradesResult]) => {
        if (activeOrdersResult.status === 'fulfilled') {
          const entry: ListScopeCacheEntry<ContractOrderListItem> = {
            rows: activeOrdersResult.value.items || [],
            total: activeOrdersResult.value.total ?? activeOrdersResult.value.items?.length ?? 0,
            page: activeOrdersResult.value.page ?? 1,
            loadedAt: Date.now(),
          };
          activeOrdersCacheRef.current.set(activeOrdersScopeKey, entry);
          if (activeOrdersScopeKeyRef.current === activeOrdersScopeKey) {
            applyActiveOrdersCache(entry);
          }
        }
        if (ordersResult.status === 'fulfilled') {
          const entry: ListScopeCacheEntry<ContractOrderListItem> = {
            rows: ordersResult.value.items || [],
            total: ordersResult.value.total ?? ordersResult.value.items?.length ?? 0,
            page: ordersResult.value.page ?? 1,
            loadedAt: Date.now(),
          };
          ordersCacheRef.current.set(ordersCacheKey, entry);
          if (activeOrdersCacheKeyRef.current === ordersCacheKey) {
            applyOrdersCache(entry);
          }
        }
        if (tradesResult.status === 'fulfilled') {
          const entry: ListScopeCacheEntry<ContractTradeListItem> = {
            rows: tradesResult.value.items || [],
            total: tradesResult.value.total ?? tradesResult.value.items?.length ?? 0,
            page: tradesResult.value.page ?? 1,
            loadedAt: Date.now(),
          };
          tradesCacheRef.current.set(tradesCacheKey, entry);
          if (activeTradesCacheKeyRef.current === tradesCacheKey) {
            applyTradesCache(entry);
          }
        }
      })
      .finally(() => {
        ordersTradesPrefetchInFlightRef.current = null;
      });

    ordersTradesPrefetchInFlightRef.current = request;
    return request;
  }, [applyActiveOrdersCache, applyOrdersCache, applyTradesCache, contractSymbol, isLoggedIn]);

  const refreshPrivate = useCallback(async (options?: { silent?: boolean }) => {
    if (!isLoggedIn) return;

    const requestSeq = refreshPrivateRequestSeqRef.current + 1;
    refreshPrivateRequestSeqRef.current = requestSeq;
    const realtimeVersionAtStart = realtimeVersionRef.current;
    const requestedScope = dataScope;
    const scopedSymbol = getScopedSymbol(requestedScope, contractSymbol);
    const positionScopeKey = getPositionScopeCacheKey(requestedScope, contractSymbol);
    const activeOrdersScopeKey = getActiveOrdersCacheKey(requestedScope, contractSymbol, 1);
    const ordersCacheKey = getOrdersCacheKey(requestedScope, contractSymbol, 1);
    const tradesCacheKey = getTradesCacheKey(requestedScope, contractSymbol, 1);
    const isActivePositionScope = () => activePositionScopeKeyRef.current === positionScopeKey;
    const isActiveCurrentOrdersScope = () => activeOrdersScopeKeyRef.current === activeOrdersScopeKey;
    const isActiveOrdersScope = () => activeOrdersCacheKeyRef.current === ordersCacheKey;
    const isActiveTradesScope = () => activeTradesCacheKeyRef.current === tradesCacheKey;
    const shouldShowLoading = !options?.silent && !hasLoadedPrivateRef.current;
    if (shouldShowLoading) {
      setPrivateLoading(true);
    }
    if (isActivePositionScope() && !positionScopeCacheRef.current.has(positionScopeKey)) {
      setIsScopeSwitching(true);
    }
    if (requestedScope === 'all') {
      setIsAllPositionsLoading(true);
    }
    if (isActiveCurrentOrdersScope() || isActiveOrdersScope()) {
      setIsOrdersLoading(true);
    }
    if (isActiveTradesScope()) {
      setIsTradesLoading(true);
    }
    setAccountError(null);
    try {
      const [
        accountResult,
        positionsResult,
        positionSummariesResult,
        activeOrdersResult,
        ordersResult,
        tradesResult,
      ] = await Promise.allSettled([
        getContractAccountSummary(),
        getContractPositions({ symbol: scopedSymbol, status: 'ALL' }),
        getContractPositionSummaries({ symbol: scopedSymbol }),
        getContractOrders({ symbol: scopedSymbol, status: 'ACTIVE', page: 1, page_size: 100 }),
        getContractOrders({ symbol: scopedSymbol, page: 1, page_size: 50 }),
        getContractTrades({ symbol: scopedSymbol, page: 1, page_size: 50 }),
      ]);

      if (refreshPrivateRequestSeqRef.current !== requestSeq) {
        return;
      }
      if (realtimeVersionRef.current !== realtimeVersionAtStart) {
        return;
      }

      if (accountResult.status === 'fulfilled') {
        setAccount(accountResult.value);
      } else {
        setAccountError(t('contractAccountLoadFailed', 'contracts'));
      }

      let nextPositions: ContractPositionItem[] | null = null;
      let nextPositionSummaries: ContractPositionSummaryItem[] | null = null;
      const positionLists = [positionsResult]
        .filter((item): item is PromiseFulfilledResult<{ items: ContractPositionItem[] }> => item.status === 'fulfilled')
        .map((item) => item.value.items || []);
      if (positionLists.length > 0) {
        nextPositions = mergePositionLists(positionLists);
      }

      if (positionSummariesResult.status === 'fulfilled') {
        nextPositionSummaries = positionSummariesResult.value.items || [];
      }

      if (nextPositions && nextPositionSummaries) {
        const entry: PositionScopeCacheEntry = {
          positions: nextPositions,
          positionSummaries: nextPositionSummaries,
          loadedAt: Date.now(),
        };
        positionScopeCacheRef.current.set(positionScopeKey, entry);
      }

      if (isActivePositionScope()) {
        if (nextPositions) {
          positionsRef.current = nextPositions;
          setPositions(nextPositions);
        }
        if (nextPositionSummaries) {
          positionSummariesRef.current = nextPositionSummaries;
          setPositionSummaries(nextPositionSummaries);
        }
      }

      if (activeOrdersResult.status === 'fulfilled') {
        const entry: ListScopeCacheEntry<ContractOrderListItem> = {
          rows: activeOrdersResult.value.items || [],
          total: activeOrdersResult.value.total ?? activeOrdersResult.value.items?.length ?? 0,
          page: activeOrdersResult.value.page ?? 1,
          loadedAt: Date.now(),
        };
        activeOrdersCacheRef.current.set(activeOrdersScopeKey, entry);
        if (isActiveCurrentOrdersScope()) {
          applyActiveOrdersCache(entry);
        }
      }

      if (ordersResult.status === 'fulfilled') {
        const entry: ListScopeCacheEntry<ContractOrderListItem> = {
          rows: ordersResult.value.items || [],
          total: ordersResult.value.total ?? ordersResult.value.items?.length ?? 0,
          page: ordersResult.value.page ?? 1,
          loadedAt: Date.now(),
        };
        ordersCacheRef.current.set(ordersCacheKey, entry);
        if (isActiveOrdersScope()) {
          applyOrdersCache(entry);
        }
      }
      if (tradesResult.status === 'fulfilled') {
        const entry: ListScopeCacheEntry<ContractTradeListItem> = {
          rows: tradesResult.value.items || [],
          total: tradesResult.value.total ?? tradesResult.value.items?.length ?? 0,
          page: tradesResult.value.page ?? 1,
          loadedAt: Date.now(),
        };
        tradesCacheRef.current.set(tradesCacheKey, entry);
        if (isActiveTradesScope()) {
          applyTradesCache(entry);
        }
      }

      const hasDataError = [positionsResult, positionSummariesResult, activeOrdersResult, ordersResult, tradesResult]
        .some((item) => item.status === 'rejected');
      if (hasDataError) {
        onErrorChange(t('contractDataLoadFailed', 'contracts'));
      } else {
        onErrorChange(null);
      }

      if (
        requestedScope === 'current' &&
        positionsResult.status === 'fulfilled' &&
        positionSummariesResult.status === 'fulfilled' &&
        !hasPrefetchedAllRef.current
      ) {
        hasPrefetchedAllRef.current = true;
        void prefetchAllPositionScope();
      }
      if (
        requestedScope === 'current' &&
        activeOrdersResult.status === 'fulfilled' &&
        ordersResult.status === 'fulfilled' &&
        tradesResult.status === 'fulfilled' &&
        !hasPrefetchedOrdersTradesRef.current
      ) {
        hasPrefetchedOrdersTradesRef.current = true;
        void prefetchOrdersAndTrades();
      }
    } finally {
      if (refreshPrivateRequestSeqRef.current !== requestSeq) {
        return;
      }
      hasLoadedPrivateRef.current = true;
      if (isActivePositionScope()) {
        setIsScopeSwitching(false);
      }
      if (requestedScope === 'all') {
        setIsAllPositionsLoading(false);
      }
      if (isActiveCurrentOrdersScope() || isActiveOrdersScope()) {
        setIsOrdersLoading(false);
      }
      if (isActiveTradesScope()) {
        setIsTradesLoading(false);
      }
      if (shouldShowLoading) {
        setPrivateLoading(false);
      }
    }
  }, [applyActiveOrdersCache, applyOrdersCache, applyTradesCache, contractSymbol, dataScope, isLoggedIn, onErrorChange, prefetchAllPositionScope, prefetchOrdersAndTrades, t]);

  const refreshPrivateSilently = useCallback(() => refreshPrivate({ silent: true }), [refreshPrivate]);

  useEffect(() => {
    contractUserRealtime.setSession({
      isLoggedIn,
      symbol: contractSymbol,
    });
  }, [contractSymbol, isLoggedIn]);

  useEffect(() => contractUserRealtime.subscribeStatus(setRealtimeStatus), []);

  useEffect(() => {
    return () => {
      contractUserRealtime.disconnect();
    };
  }, []);

  useEffect(() => {
    const applyRealtimePositionState = (
      positionsUpdate: ReturnType<typeof extractContractPositionsUpdate> | null,
      summariesUpdate: ReturnType<typeof extractContractPositionSummariesUpdate> | null,
    ) => {
      if (!positionsUpdate && !summariesUpdate) return;

      const nextPositions = positionsUpdate
        ? replaceOrMergePositions(
            positionsRef.current,
            positionsUpdate.items,
            positionsUpdate.replace,
            contractSymbol,
          )
        : positionsRef.current;
      const nextSummaries = summariesUpdate
        ? replaceOrMergePositionSummaries(
            positionSummariesRef.current,
            summariesUpdate.items,
            summariesUpdate.replace,
            contractSymbol,
          )
        : positionSummariesRef.current;

      positionsRef.current = nextPositions;
      positionSummariesRef.current = nextSummaries;
      setPositions(nextPositions);
      setPositionSummaries(nextSummaries);
      updateActivePositionScopeCache(nextPositions, nextSummaries);
      setIsScopeSwitching(false);
      hasLoadedPrivateRef.current = true;
    };

    const handleSnapshotMessage = (message: ContractUserRealtimeMessage) => {
      if (!markRealtimeMessage(message)) return;
      const payload = getContractUserPayload(message);
      if (!isContractUserMessageForSymbol(message, payload, contractSymbol)) return;

      const nextAccount = extractContractAccountUpdate(message);
      if (nextAccount) {
        setAccount(nextAccount);
        setAccountError(null);
      }
      applyRealtimePositionState(
        extractContractPositionsUpdate(message, contractSymbol),
        extractContractPositionSummariesUpdate(message, contractSymbol),
      );

      const ordersUpdate = extractContractOrdersUpdate(message, contractSymbol);
      if (ordersUpdate) {
        setActiveOrders((previous) => {
          const nextActiveOrders = replaceOrMergeActiveOrdersByIdForSymbol(
            previous,
            ordersUpdate.items,
            ordersUpdate.replace,
            contractSymbol,
          );
          activeOrdersCacheRef.current.set(activeOrdersScopeKeyRef.current, {
            rows: nextActiveOrders,
            total: nextActiveOrders.length,
            page: 1,
            loadedAt: Date.now(),
          });
          return nextActiveOrders;
        });
        setOrders((previous) => {
          const nextOrders = replaceOrMergeByIdForSymbol(previous, ordersUpdate.items, ordersUpdate.replace, contractSymbol);
          ordersCacheRef.current.set(activeOrdersCacheKeyRef.current, {
            rows: nextOrders,
            total: nextOrders.length,
            page: 1,
            loadedAt: Date.now(),
          });
          return nextOrders;
        });
        setIsOrdersLoading(false);
      }

      const tradesUpdate = extractContractTradesUpdate(message, contractSymbol);
      if (tradesUpdate) {
        setTrades((previous) => {
          const nextTrades = replaceOrMergeByIdForSymbol(previous, tradesUpdate.items, tradesUpdate.replace, contractSymbol);
          tradesCacheRef.current.set(activeTradesCacheKeyRef.current, {
            rows: nextTrades,
            total: nextTrades.length,
            page: 1,
            loadedAt: Date.now(),
          });
          return nextTrades;
        });
        setIsTradesLoading(false);
      }
      hasLoadedPrivateRef.current = true;
      setPrivateLoading(false);
    };

    const handleAccountMessage = (message: ContractUserRealtimeMessage) => {
      if (String(message.type || '').toLowerCase().includes('snapshot')) return;
      if (!markRealtimeMessage(message)) return;
      const nextAccount = extractContractAccountUpdate(message);
      if (nextAccount) {
        setAccount(nextAccount);
        setAccountError(null);
        hasLoadedPrivateRef.current = true;
      }
    };

    const handlePositionsMessage = (message: ContractUserRealtimeMessage) => {
      if (String(message.type || '').toLowerCase().includes('snapshot')) return;
      if (!markRealtimeMessage(message)) return;
      applyRealtimePositionState(
        extractContractPositionsUpdate(message, contractSymbol),
        extractContractPositionSummariesUpdate(message, contractSymbol),
      );
    };

    const handleOrdersMessage = (message: ContractUserRealtimeMessage) => {
      if (String(message.type || '').toLowerCase().includes('snapshot')) return;
      if (!markRealtimeMessage(message)) return;
      const update = extractContractOrdersUpdate(message, contractSymbol);
      if (!update) return;
      setActiveOrders((previous) => {
        const nextActiveOrders = replaceOrMergeActiveOrdersByIdForSymbol(
          previous,
          update.items,
          update.replace,
          contractSymbol,
        );
        activeOrdersCacheRef.current.set(activeOrdersScopeKeyRef.current, {
          rows: nextActiveOrders,
          total: nextActiveOrders.length,
          page: 1,
          loadedAt: Date.now(),
        });
        return nextActiveOrders;
      });
      setOrders((previous) => {
        const nextOrders = replaceOrMergeByIdForSymbol(previous, update.items, update.replace, contractSymbol);
        ordersCacheRef.current.set(activeOrdersCacheKeyRef.current, {
          rows: nextOrders,
          total: nextOrders.length,
          page: 1,
          loadedAt: Date.now(),
        });
        return nextOrders;
      });
      hasLoadedPrivateRef.current = true;
    };

    const handleTradesMessage = (message: ContractUserRealtimeMessage) => {
      if (String(message.type || '').toLowerCase().includes('snapshot')) return;
      if (!markRealtimeMessage(message)) return;
      const update = extractContractTradesUpdate(message, contractSymbol);
      if (!update) return;
      setTrades((previous) => {
        const nextTrades = replaceOrMergeByIdForSymbol(previous, update.items, update.replace, contractSymbol);
        tradesCacheRef.current.set(activeTradesCacheKeyRef.current, {
          rows: nextTrades,
          total: nextTrades.length,
          page: 1,
          loadedAt: Date.now(),
        });
        return nextTrades;
      });
      hasLoadedPrivateRef.current = true;
    };

    const unsubscribeSnapshot = contractUserRealtime.subscribe('snapshot', handleSnapshotMessage);
    const unsubscribeAccount = contractUserRealtime.subscribe('account', handleAccountMessage);
    const unsubscribePositions = contractUserRealtime.subscribe('positions', handlePositionsMessage);
    const unsubscribeOrders = contractUserRealtime.subscribe('orders', handleOrdersMessage);
    const unsubscribeTrades = contractUserRealtime.subscribe('trades', handleTradesMessage);

    return () => {
      unsubscribeSnapshot();
      unsubscribeAccount();
      unsubscribePositions();
      unsubscribeOrders();
      unsubscribeTrades();
    };
  }, [contractSymbol, markRealtimeMessage, updateActivePositionScopeCache]);

  useEffect(() => {
    if (!isLoggedIn) {
      hasLoadedPrivateRef.current = false;
      hasPrefetchedAllRef.current = false;
      hasPrefetchedOrdersTradesRef.current = false;
      positionScopeCacheRef.current.clear();
      ordersCacheRef.current.clear();
      tradesCacheRef.current.clear();
      allPrefetchInFlightRef.current = null;
      ordersTradesPrefetchInFlightRef.current = null;
      setPrivateLoading(false);
      setIsScopeSwitching(false);
      setIsAllPositionsLoading(false);
      setIsOrdersLoading(false);
      setIsTradesLoading(false);
      setAccount(null);
      setAccountError(null);
      positionsRef.current = [];
      positionSummariesRef.current = [];
      setPositions([]);
      setPositionSummaries([]);
      setActiveOrders([]);
      setOrders([]);
      setTrades([]);
      return;
    }

    const cachedPositions = positionScopeCacheRef.current.get(activePositionScopeKey);
    if (cachedPositions) {
      applyPositionScopeCache(cachedPositions);
      setIsScopeSwitching(false);
    } else {
      positionsRef.current = [];
      positionSummariesRef.current = [];
      setPositions([]);
      setPositionSummaries([]);
      setIsScopeSwitching(true);
    }

    const cachedActiveOrders = activeOrdersCacheRef.current.get(activeOrdersScopeKey);
    if (cachedActiveOrders) {
      applyActiveOrdersCache(cachedActiveOrders);
    } else {
      setActiveOrders([]);
    }

    const cachedOrders = ordersCacheRef.current.get(activeOrdersCacheKey);
    if (cachedOrders) {
      applyOrdersCache(cachedOrders);
    } else {
      setOrders([]);
    }
    setIsOrdersLoading(!cachedActiveOrders || !cachedOrders);

    const cachedTrades = tradesCacheRef.current.get(activeTradesCacheKey);
    if (cachedTrades) {
      applyTradesCache(cachedTrades);
      setIsTradesLoading(false);
    } else {
      setTrades([]);
      setIsTradesLoading(true);
    }

    void refreshPrivate({ silent: hasLoadedPrivateRef.current });
  }, [
    activeOrdersCacheKey,
    activeOrdersScopeKey,
    activePositionScopeKey,
    activeTradesCacheKey,
    applyActiveOrdersCache,
    applyOrdersCache,
    applyPositionScopeCache,
    applyTradesCache,
    isLoggedIn,
    refreshPrivate,
  ]);

  useEffect(() => {
    if (!isLoggedIn) return;

    const refreshIfRealtimeUnavailable = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (contractUserRealtime.getStatus() === 'connected') return;
      void refreshPrivate({ silent: true });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) refreshIfRealtimeUnavailable();
    };

    window.addEventListener('focus', refreshIfRealtimeUnavailable);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshIfRealtimeUnavailable);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isLoggedIn, refreshPrivate]);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (realtimeStatus !== 'disconnected' && realtimeStatus !== 'reconnecting') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    void refreshPrivate({ silent: true });
  }, [isLoggedIn, realtimeStatus, refreshPrivate]);

  useEffect(() => {
    if (!isLoggedIn || realtimeStatus !== 'connected') return;
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      timer = window.setTimeout(checkBridgeHealth, CONTRACT_WS_BRIDGE_HEALTH_CHECK_MS);
    };

    const checkBridgeHealth = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext();
        return;
      }

      try {
        const health = await getContractPrivateWsBridgeHealth();
        if (health.rest_fallback_recommended || String(health.status || '').toLowerCase() !== 'ok') {
          void refreshPrivate({ silent: true });
        }
      } catch {
        void refreshPrivate({ silent: true });
      } finally {
        scheduleNext();
      }
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [isLoggedIn, realtimeStatus, refreshPrivate]);

  const openPositionsForTrading = useMemo(
    () => positions.filter((item) => (
      item.status === 'OPEN' &&
      getPositionAmount(item) > 0 &&
      String(item.symbol || '').trim().toUpperCase() === contractSymbol.toUpperCase()
    )),
    [contractSymbol, positions],
  );

  return {
    account,
    positions,
    positionSummaries,
    activeOrders,
    orders,
    trades,
    privateLoading,
    isScopeSwitching,
    isAllPositionsLoading,
    isOrdersLoading,
    isTradesLoading,
    realtimeStatus,
    accountError,
    openPositionsForTrading,
    refreshPrivateSilently,
  };
}
