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

export type ContractUserDataTab = 'positions' | 'historyPositions' | 'openOrders' | 'historyOrders' | 'trades';

type UseContractUserStateParams = {
  contractSymbol: string;
  dataScope?: 'current' | 'all';
  activeTab?: ContractUserDataTab;
  isLoggedIn: boolean;
  onErrorChange: (message: string | null) => void;
};

type ContractDataScope = NonNullable<UseContractUserStateParams['dataScope']>;
const CONTRACT_WS_BRIDGE_HEALTH_CHECK_MS = 30000;
const CONTRACT_ORDER_TRADE_PAGE_SIZE = 5;

type PositionScopeCacheEntry = {
  positions: ContractPositionItem[];
  positionSummaries: ContractPositionSummaryItem[];
  loadedAt: number;
};

type ListScopeCacheEntry<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  loadedAt: number;
};

type ListPaginationMeta = {
  total: number;
  pageSize: number;
};

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

function getSafePage(page: number) {
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function getListPaginationMeta(entry: ListScopeCacheEntry<unknown> | undefined | null): ListPaginationMeta {
  return {
    total: entry?.total ?? 0,
    pageSize: entry?.pageSize ?? CONTRACT_ORDER_TRADE_PAGE_SIZE,
  };
}

function buildListCacheEntry<T>(
  response: {
    items?: T[] | null;
    total?: number | null;
    page?: number | null;
    page_size?: number | null;
  },
  fallbackPage: number,
): ListScopeCacheEntry<T> {
  const rows = response.items || [];
  const responsePage = Number(response.page);
  const responsePageSize = Number(response.page_size);
  return {
    rows,
    total: Number.isFinite(Number(response.total)) ? Number(response.total) : rows.length,
    page: Number.isFinite(responsePage) && responsePage > 0 ? Math.floor(responsePage) : fallbackPage,
    pageSize: Number.isFinite(responsePageSize) && responsePageSize > 0
      ? Math.floor(responsePageSize)
      : CONTRACT_ORDER_TRADE_PAGE_SIZE,
    loadedAt: Date.now(),
  };
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
  activeTab = 'positions',
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
  const [activeOrdersPage, setActiveOrdersPage] = useState(1);
  const [orderHistoryPage, setOrderHistoryPage] = useState(1);
  const [tradeHistoryPage, setTradeHistoryPage] = useState(1);
  const [activeOrdersPaginationMeta, setActiveOrdersPaginationMeta] = useState<ListPaginationMeta>(() => ({
    total: 0,
    pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE,
  }));
  const [orderHistoryPaginationMeta, setOrderHistoryPaginationMeta] = useState<ListPaginationMeta>(() => ({
    total: 0,
    pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE,
  }));
  const [tradeHistoryPaginationMeta, setTradeHistoryPaginationMeta] = useState<ListPaginationMeta>(() => ({
    total: 0,
    pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE,
  }));
  const [realtimeStatus, setRealtimeStatus] = useState<ContractUserRealtimeStatus>('idle');
  const hasLoadedPrivateRef = useRef(false);
  const positionScopeCacheRef = useRef<Map<string, PositionScopeCacheEntry>>(new Map());
  const activeOrdersCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractOrderListItem>>>(new Map());
  const ordersCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractOrderListItem>>>(new Map());
  const tradesCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractTradeListItem>>>(new Map());
  const allPrefetchInFlightRef = useRef<Promise<void> | null>(null);
  const refreshPrivateRequestSeqRef = useRef(0);
  const realtimeVersionRef = useRef(0);
  const lastRealtimeSeqRef = useRef(0);
  const lastRealtimeTsRef = useRef(0);
  const positionsRef = useRef<ContractPositionItem[]>([]);
  const positionSummariesRef = useRef<ContractPositionSummaryItem[]>([]);
  const hasPrefetchedAllRef = useRef(false);
  const activeTabRef = useRef<ContractUserDataTab>(activeTab);
  const activePositionScopeKey = useMemo(
    () => getPositionScopeCacheKey(dataScope, contractSymbol),
    [contractSymbol, dataScope],
  );
  const activeOrdersScopeKey = useMemo(
    () => getActiveOrdersCacheKey(dataScope, contractSymbol, activeOrdersPage),
    [activeOrdersPage, contractSymbol, dataScope],
  );
  const activeOrdersCacheKey = useMemo(
    () => getOrdersCacheKey(dataScope, contractSymbol, orderHistoryPage),
    [contractSymbol, dataScope, orderHistoryPage],
  );
  const activeTradesCacheKey = useMemo(
    () => getTradesCacheKey(dataScope, contractSymbol, tradeHistoryPage),
    [contractSymbol, dataScope, tradeHistoryPage],
  );
  const activePositionScopeKeyRef = useRef(activePositionScopeKey);
  const activeOrdersScopeKeyRef = useRef(activeOrdersScopeKey);
  const activeOrdersCacheKeyRef = useRef(activeOrdersCacheKey);
  const activeTradesCacheKeyRef = useRef(activeTradesCacheKey);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    activePositionScopeKeyRef.current = activePositionScopeKey;
  }, [activePositionScopeKey]);

  useEffect(() => {
    activeOrdersScopeKeyRef.current = activeOrdersScopeKey;
    const cached = activeOrdersCacheRef.current.get(activeOrdersScopeKey);
    setActiveOrders(cached?.rows || []);
    setActiveOrdersPaginationMeta(getListPaginationMeta(cached));
  }, [activeOrdersScopeKey]);

  useEffect(() => {
    activeOrdersCacheKeyRef.current = activeOrdersCacheKey;
    const cached = ordersCacheRef.current.get(activeOrdersCacheKey);
    setOrders(cached?.rows || []);
    setOrderHistoryPaginationMeta(getListPaginationMeta(cached));
  }, [activeOrdersCacheKey]);

  useEffect(() => {
    activeTradesCacheKeyRef.current = activeTradesCacheKey;
    const cached = tradesCacheRef.current.get(activeTradesCacheKey);
    setTrades(cached?.rows || []);
    setTradeHistoryPaginationMeta(getListPaginationMeta(cached));
  }, [activeTradesCacheKey]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    positionSummariesRef.current = positionSummaries;
  }, [positionSummaries]);

  useEffect(() => {
    setActiveOrdersPage(1);
    setOrderHistoryPage(1);
    setTradeHistoryPage(1);
    setActiveOrdersPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
    setOrderHistoryPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
    setTradeHistoryPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
  }, [contractSymbol, dataScope]);

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

  const refreshPrivate = useCallback(async (options?: { silent?: boolean }) => {
    if (!isLoggedIn) return;

    const requestSeq = refreshPrivateRequestSeqRef.current + 1;
    refreshPrivateRequestSeqRef.current = requestSeq;
    const realtimeVersionAtStart = realtimeVersionRef.current;
    const requestedScope = dataScope;
    const requestedActiveTab = activeTab;
    const scopedSymbol = getScopedSymbol(requestedScope, contractSymbol);
    const positionScopeKey = getPositionScopeCacheKey(requestedScope, contractSymbol);
    const requestedActiveOrdersPage = getSafePage(activeOrdersPage);
    const requestedOrderHistoryPage = getSafePage(orderHistoryPage);
    const requestedTradeHistoryPage = getSafePage(tradeHistoryPage);
    const activeOrdersScopeKey = getActiveOrdersCacheKey(requestedScope, contractSymbol, requestedActiveOrdersPage);
    const ordersCacheKey = getOrdersCacheKey(requestedScope, contractSymbol, requestedOrderHistoryPage);
    const tradesCacheKey = getTradesCacheKey(requestedScope, contractSymbol, requestedTradeHistoryPage);
    const shouldRequestActiveOrders = requestedActiveTab === 'openOrders';
    const shouldRequestOrderHistory = requestedActiveTab === 'historyOrders';
    const shouldRequestTrades = requestedActiveTab === 'trades';
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
    if ((shouldRequestActiveOrders && isActiveCurrentOrdersScope()) || (shouldRequestOrderHistory && isActiveOrdersScope())) {
      setIsOrdersLoading(true);
    }
    if (shouldRequestTrades && isActiveTradesScope()) {
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
        shouldRequestActiveOrders
          ? getContractOrders({
              symbol: scopedSymbol,
              status: 'ACTIVE',
              page: requestedActiveOrdersPage,
              page_size: CONTRACT_ORDER_TRADE_PAGE_SIZE,
            })
          : Promise.resolve(null),
        shouldRequestOrderHistory
          ? getContractOrders({
              symbol: scopedSymbol,
              page: requestedOrderHistoryPage,
              page_size: CONTRACT_ORDER_TRADE_PAGE_SIZE,
            })
          : Promise.resolve(null),
        shouldRequestTrades
          ? getContractTrades({
              symbol: scopedSymbol,
              page: requestedTradeHistoryPage,
              page_size: CONTRACT_ORDER_TRADE_PAGE_SIZE,
            })
          : Promise.resolve(null),
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

      if (shouldRequestActiveOrders && activeOrdersResult.status === 'fulfilled' && activeOrdersResult.value) {
        const entry = buildListCacheEntry<ContractOrderListItem>(activeOrdersResult.value, requestedActiveOrdersPage);
        activeOrdersCacheRef.current.set(activeOrdersScopeKey, entry);
        if (isActiveCurrentOrdersScope()) {
          applyActiveOrdersCache(entry);
          setActiveOrdersPaginationMeta(getListPaginationMeta(entry));
        }
      }

      if (shouldRequestOrderHistory && ordersResult.status === 'fulfilled' && ordersResult.value) {
        const entry = buildListCacheEntry<ContractOrderListItem>(ordersResult.value, requestedOrderHistoryPage);
        ordersCacheRef.current.set(ordersCacheKey, entry);
        if (isActiveOrdersScope()) {
          applyOrdersCache(entry);
          setOrderHistoryPaginationMeta(getListPaginationMeta(entry));
        }
      }
      if (shouldRequestTrades && tradesResult.status === 'fulfilled' && tradesResult.value) {
        const entry = buildListCacheEntry<ContractTradeListItem>(tradesResult.value, requestedTradeHistoryPage);
        tradesCacheRef.current.set(tradesCacheKey, entry);
        if (isActiveTradesScope()) {
          applyTradesCache(entry);
          setTradeHistoryPaginationMeta(getListPaginationMeta(entry));
        }
      }

      const hasDataError = positionsResult.status === 'rejected' ||
        positionSummariesResult.status === 'rejected' ||
        (shouldRequestActiveOrders && activeOrdersResult.status === 'rejected') ||
        (shouldRequestOrderHistory && ordersResult.status === 'rejected') ||
        (shouldRequestTrades && tradesResult.status === 'rejected');
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
      if ((shouldRequestActiveOrders && isActiveCurrentOrdersScope()) || (shouldRequestOrderHistory && isActiveOrdersScope())) {
        setIsOrdersLoading(false);
      }
      if (shouldRequestTrades && isActiveTradesScope()) {
        setIsTradesLoading(false);
      }
      if (shouldShowLoading) {
        setPrivateLoading(false);
      }
    }
  }, [
    activeOrdersPage,
    activeTab,
    applyActiveOrdersCache,
    applyOrdersCache,
    applyTradesCache,
    contractSymbol,
    dataScope,
    isLoggedIn,
    onErrorChange,
    orderHistoryPage,
    prefetchAllPositionScope,
    t,
    tradeHistoryPage,
  ]);

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
        if (activeTabRef.current === 'openOrders' || activeTabRef.current === 'historyOrders') {
          void refreshPrivate({ silent: true });
        }
      }

      const tradesUpdate = extractContractTradesUpdate(message, contractSymbol);
      if (tradesUpdate) {
        if (activeTabRef.current === 'trades') {
          void refreshPrivate({ silent: true });
        }
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
      if (activeTabRef.current === 'openOrders' || activeTabRef.current === 'historyOrders') {
        void refreshPrivate({ silent: true });
      }
      hasLoadedPrivateRef.current = true;
    };

    const handleTradesMessage = (message: ContractUserRealtimeMessage) => {
      if (String(message.type || '').toLowerCase().includes('snapshot')) return;
      if (!markRealtimeMessage(message)) return;
      const update = extractContractTradesUpdate(message, contractSymbol);
      if (!update) return;
      if (activeTabRef.current === 'trades') {
        void refreshPrivate({ silent: true });
      }
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
  }, [contractSymbol, markRealtimeMessage, refreshPrivate, updateActivePositionScopeCache]);

  useEffect(() => {
    if (!isLoggedIn) {
      hasLoadedPrivateRef.current = false;
      hasPrefetchedAllRef.current = false;
      positionScopeCacheRef.current.clear();
      activeOrdersCacheRef.current.clear();
      ordersCacheRef.current.clear();
      tradesCacheRef.current.clear();
      allPrefetchInFlightRef.current = null;
      setPrivateLoading(false);
      setIsScopeSwitching(false);
      setIsAllPositionsLoading(false);
      setIsOrdersLoading(false);
      setIsTradesLoading(false);
      setActiveOrdersPage(1);
      setOrderHistoryPage(1);
      setTradeHistoryPage(1);
      setActiveOrdersPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
      setOrderHistoryPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
      setTradeHistoryPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
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
      setActiveOrdersPaginationMeta(getListPaginationMeta(cachedActiveOrders));
    } else {
      setActiveOrders([]);
      setActiveOrdersPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
    }

    const cachedOrders = ordersCacheRef.current.get(activeOrdersCacheKey);
    if (cachedOrders) {
      applyOrdersCache(cachedOrders);
      setOrderHistoryPaginationMeta(getListPaginationMeta(cachedOrders));
    } else {
      setOrders([]);
      setOrderHistoryPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
    }
    setIsOrdersLoading(
      (activeTab === 'openOrders' && !cachedActiveOrders) ||
      (activeTab === 'historyOrders' && !cachedOrders),
    );

    const cachedTrades = tradesCacheRef.current.get(activeTradesCacheKey);
    if (cachedTrades) {
      applyTradesCache(cachedTrades);
      setTradeHistoryPaginationMeta(getListPaginationMeta(cachedTrades));
    } else {
      setTrades([]);
      setTradeHistoryPaginationMeta({ total: 0, pageSize: CONTRACT_ORDER_TRADE_PAGE_SIZE });
    }
    setIsTradesLoading(activeTab === 'trades' && !cachedTrades);

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
    activeTab,
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

  const handleActiveOrdersPageChange = useCallback((page: number) => {
    setActiveOrdersPage(getSafePage(page));
  }, []);

  const handleOrderHistoryPageChange = useCallback((page: number) => {
    setOrderHistoryPage(getSafePage(page));
  }, []);

  const handleTradeHistoryPageChange = useCallback((page: number) => {
    setTradeHistoryPage(getSafePage(page));
  }, []);

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
    activeOrdersPagination: {
      page: activeOrdersPage,
      total: activeOrdersPaginationMeta.total,
      pageSize: activeOrdersPaginationMeta.pageSize,
      onPageChange: handleActiveOrdersPageChange,
    },
    orderHistoryPagination: {
      page: orderHistoryPage,
      total: orderHistoryPaginationMeta.total,
      pageSize: orderHistoryPaginationMeta.pageSize,
      onPageChange: handleOrderHistoryPageChange,
    },
    tradeHistoryPagination: {
      page: tradeHistoryPage,
      total: tradeHistoryPaginationMeta.total,
      pageSize: tradeHistoryPaginationMeta.pageSize,
      onPageChange: handleTradeHistoryPageChange,
    },
  };
}
