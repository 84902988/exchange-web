'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toNumber } from '@/components/contract/contractFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractAccountSummary,
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
} from '@/lib/realtime/contractUserRealtime';

type UseContractUserStateParams = {
  contractSymbol: string;
  dataScope?: 'current' | 'all';
  isLoggedIn: boolean;
  onErrorChange: (message: string | null) => void;
};

type ContractDataScope = NonNullable<UseContractUserStateParams['dataScope']>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getContractUserPayload(message: ContractUserRealtimeMessage) {
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
  const [orders, setOrders] = useState<ContractOrderListItem[]>([]);
  const [trades, setTrades] = useState<ContractTradeListItem[]>([]);
  const [privateLoading, setPrivateLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isScopeSwitching, setIsScopeSwitching] = useState(false);
  const [isAllPositionsLoading, setIsAllPositionsLoading] = useState(false);
  const [isOrdersLoading, setIsOrdersLoading] = useState(false);
  const [isTradesLoading, setIsTradesLoading] = useState(false);
  const hasLoadedPrivateRef = useRef(false);
  const positionScopeCacheRef = useRef<Map<string, PositionScopeCacheEntry>>(new Map());
  const ordersCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractOrderListItem>>>(new Map());
  const tradesCacheRef = useRef<Map<string, ListScopeCacheEntry<ContractTradeListItem>>>(new Map());
  const allPrefetchInFlightRef = useRef<Promise<void> | null>(null);
  const ordersTradesPrefetchInFlightRef = useRef<Promise<void> | null>(null);
  const hasPrefetchedAllRef = useRef(false);
  const hasPrefetchedOrdersTradesRef = useRef(false);
  const activePositionScopeKey = useMemo(
    () => getPositionScopeCacheKey(dataScope, contractSymbol),
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
  const activeOrdersCacheKeyRef = useRef(activeOrdersCacheKey);
  const activeTradesCacheKeyRef = useRef(activeTradesCacheKey);

  useEffect(() => {
    activePositionScopeKeyRef.current = activePositionScopeKey;
  }, [activePositionScopeKey]);

  useEffect(() => {
    activeOrdersCacheKeyRef.current = activeOrdersCacheKey;
  }, [activeOrdersCacheKey]);

  useEffect(() => {
    activeTradesCacheKeyRef.current = activeTradesCacheKey;
  }, [activeTradesCacheKey]);

  const applyPositionScopeCache = useCallback((entry: PositionScopeCacheEntry) => {
    setPositions(entry.positions);
    setPositionSummaries(entry.positionSummaries);
  }, []);

  const applyOrdersCache = useCallback((entry: ListScopeCacheEntry<ContractOrderListItem>) => {
    setOrders(entry.rows);
  }, []);

  const applyTradesCache = useCallback((entry: ListScopeCacheEntry<ContractTradeListItem>) => {
    setTrades(entry.rows);
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
    const ordersCacheKey = getOrdersCacheKey('current', contractSymbol, 1);
    const tradesCacheKey = getTradesCacheKey('current', contractSymbol, 1);
    if (ordersCacheRef.current.has(ordersCacheKey) && tradesCacheRef.current.has(tradesCacheKey)) return null;
    if (ordersTradesPrefetchInFlightRef.current) return ordersTradesPrefetchInFlightRef.current;

    const scopedSymbol = getScopedSymbol('current', contractSymbol);
    const request = Promise.allSettled([
      getContractOrders({ symbol: scopedSymbol, page: 1, page_size: 50 }),
      getContractTrades({ symbol: scopedSymbol, page: 1, page_size: 50 }),
    ])
      .then(([ordersResult, tradesResult]) => {
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
  }, [applyOrdersCache, applyTradesCache, contractSymbol, isLoggedIn]);

  const refreshPrivate = useCallback(async (options?: { silent?: boolean }) => {
    if (!isLoggedIn) return;

    const requestedScope = dataScope;
    const scopedSymbol = getScopedSymbol(requestedScope, contractSymbol);
    const positionScopeKey = getPositionScopeCacheKey(requestedScope, contractSymbol);
    const ordersCacheKey = getOrdersCacheKey(requestedScope, contractSymbol, 1);
    const tradesCacheKey = getTradesCacheKey(requestedScope, contractSymbol, 1);
    const isActivePositionScope = () => activePositionScopeKeyRef.current === positionScopeKey;
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
    if (isActiveOrdersScope()) {
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
        ordersResult,
        tradesResult,
      ] = await Promise.allSettled([
        getContractAccountSummary(),
        getContractPositions({ symbol: scopedSymbol, status: 'ALL' }),
        getContractPositionSummaries({ symbol: scopedSymbol }),
        getContractOrders({ symbol: scopedSymbol, page: 1, page_size: 50 }),
        getContractTrades({ symbol: scopedSymbol, page: 1, page_size: 50 }),
      ]);

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
          setPositions(nextPositions);
        }
        if (nextPositionSummaries) {
          setPositionSummaries(nextPositionSummaries);
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

      const hasDataError = [positionsResult, positionSummariesResult, ordersResult, tradesResult]
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
        ordersResult.status === 'fulfilled' &&
        tradesResult.status === 'fulfilled' &&
        !hasPrefetchedOrdersTradesRef.current
      ) {
        hasPrefetchedOrdersTradesRef.current = true;
        void prefetchOrdersAndTrades();
      }
    } finally {
      hasLoadedPrivateRef.current = true;
      if (isActivePositionScope()) {
        setIsScopeSwitching(false);
      }
      if (requestedScope === 'all') {
        setIsAllPositionsLoading(false);
      }
      if (isActiveOrdersScope()) {
        setIsOrdersLoading(false);
      }
      if (isActiveTradesScope()) {
        setIsTradesLoading(false);
      }
      if (shouldShowLoading) {
        setPrivateLoading(false);
      }
    }
  }, [applyOrdersCache, applyTradesCache, contractSymbol, dataScope, isLoggedIn, onErrorChange, prefetchAllPositionScope, prefetchOrdersAndTrades, t]);

  const refreshPrivateSilently = useCallback(() => refreshPrivate({ silent: true }), [refreshPrivate]);

  useEffect(() => {
    contractUserRealtime.setSession({
      isLoggedIn,
      symbol: contractSymbol,
    });
  }, [contractSymbol, isLoggedIn]);

  useEffect(() => {
    return () => {
      contractUserRealtime.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleAccountMessage = (message: ContractUserRealtimeMessage) => {
      const nextAccount = extractContractAccountUpdate(message);
      if (nextAccount) {
        setAccount(nextAccount);
        setAccountError(null);
        hasLoadedPrivateRef.current = true;
      }
    };

    const handlePositionsMessage = (message: ContractUserRealtimeMessage) => {
      const update = extractContractPositionsUpdate(message, contractSymbol);
      if (!update) return;
      setPositions((previous) => replaceOrMergePositions(previous, update.items, update.replace, contractSymbol));
      hasLoadedPrivateRef.current = true;
    };

    const handleOrdersMessage = (message: ContractUserRealtimeMessage) => {
      const update = extractContractOrdersUpdate(message, contractSymbol);
      if (!update) return;
      setOrders((previous) => replaceOrMergeById(previous, update.items, update.replace));
      hasLoadedPrivateRef.current = true;
    };

    const handleTradesMessage = (message: ContractUserRealtimeMessage) => {
      const update = extractContractTradesUpdate(message, contractSymbol);
      if (!update) return;
      setTrades((previous) => replaceOrMergeById(previous, update.items, update.replace));
      hasLoadedPrivateRef.current = true;
    };

    const unsubscribeAccount = contractUserRealtime.subscribe('account', handleAccountMessage);
    const unsubscribePositions = contractUserRealtime.subscribe('positions', handlePositionsMessage);
    const unsubscribeOrders = contractUserRealtime.subscribe('orders', handleOrdersMessage);
    const unsubscribeTrades = contractUserRealtime.subscribe('trades', handleTradesMessage);

    return () => {
      unsubscribeAccount();
      unsubscribePositions();
      unsubscribeOrders();
      unsubscribeTrades();
    };
  }, [contractSymbol]);

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
      setPositions([]);
      setPositionSummaries([]);
      setOrders([]);
      setTrades([]);
      return;
    }

    const cachedPositions = positionScopeCacheRef.current.get(activePositionScopeKey);
    if (cachedPositions) {
      applyPositionScopeCache(cachedPositions);
      setIsScopeSwitching(false);
    } else {
      setPositions([]);
      setPositionSummaries([]);
      setIsScopeSwitching(true);
    }

    const cachedOrders = ordersCacheRef.current.get(activeOrdersCacheKey);
    if (cachedOrders) {
      applyOrdersCache(cachedOrders);
      setIsOrdersLoading(false);
    } else {
      setOrders([]);
      setIsOrdersLoading(true);
    }

    const cachedTrades = tradesCacheRef.current.get(activeTradesCacheKey);
    if (cachedTrades) {
      applyTradesCache(cachedTrades);
      setIsTradesLoading(false);
    } else {
      setTrades([]);
      setIsTradesLoading(true);
    }

    void refreshPrivate({ silent: hasLoadedPrivateRef.current });
    const timer = window.setInterval(() => {
      void refreshPrivate({ silent: true });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    activeOrdersCacheKey,
    activePositionScopeKey,
    activeTradesCacheKey,
    applyOrdersCache,
    applyPositionScopeCache,
    applyTradesCache,
    isLoggedIn,
    refreshPrivate,
  ]);

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
    orders,
    trades,
    privateLoading,
    isScopeSwitching,
    isAllPositionsLoading,
    isOrdersLoading,
    isTradesLoading,
    accountError,
    openPositionsForTrading,
    refreshPrivateSilently,
  };
}
