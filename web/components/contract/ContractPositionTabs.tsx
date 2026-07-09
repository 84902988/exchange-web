'use client';

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  cancelContractOrder,
  closeContractOrder,
  closeContractSummaryOrder,
  updateContractPositionTpSl,
  type ContractOrderListItem,
  type ContractPositionItem,
  type ContractPositionSide,
  type ContractPositionSummaryItem,
  type ContractTpSlTriggerPriceType,
  type ContractQuote,
  type ContractTradeListItem,
} from '@/lib/api/modules/contract';
import {
  formatNumber,
  formatTime,
  friendlyContractError,
  toNumber,
} from './contractFormat';
import TradingConfirmModal from '@/components/common/TradingConfirmModal';
import ContractOrderTabs, {
  contractOrderActionTone,
  formatContractOrderAction,
} from './ContractOrderTabs';
import { formatPrice as formatMarketPrice, formatRawPrice as formatRawMarketPrice } from '@/lib/marketPrecision';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { ContractOrderFilterState, ContractTradeFilterState } from './hooks/useContractUserState';

export type ContractPositionTabKey = 'positions' | 'historyPositions' | 'openOrders' | 'historyOrders' | 'trades';
type TabKey = ContractPositionTabKey;
type PositionScope = 'current' | 'all';
type ContractRealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type ContractTranslator = (key: string, namespace?: 'contracts') => string;
type ServerPaginationState = {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
};
type FilterOption = {
  value: string;
  label: string;
};
type FilterGroup<T extends string> = {
  key: T;
  label: string;
  options: FilterOption[];
};
type OrderFeedback = {
  type: 'success' | 'error';
  message: string;
};
type TpSlTarget =
  | { mode: 'single'; positionId: number }
  | { mode: 'summary'; symbol: string; side: 'LONG' | 'SHORT'; positionIds: number[] };
type TpSlDraft = {
  target: TpSlTarget;
  position: ContractPositionItem;
  positions: ContractPositionItem[];
  referencePrice: string | null;
  referencePriceLabel: string;
  takeProfitPrice: string;
  stopLossPrice: string;
};

type AggregatedPositionRow = ContractPositionSummaryItem & {
  positions: ContractPositionItem[];
};

type ContractPositionTabsProps = {
  currentSymbol: string;
  scope?: PositionScope;
  positions: ContractPositionItem[];
  positionSummaries: ContractPositionSummaryItem[];
  activeOrders?: ContractOrderListItem[];
  orders: ContractOrderListItem[];
  trades: ContractTradeListItem[];
  quote?: ContractQuote | null;
  tpSlTriggerPriceType?: ContractTpSlTriggerPriceType | string | null;
  pricePrecision: number;
  quantityUnit?: string;
  isLoggedIn: boolean;
  loading?: boolean;
  isScopeSwitching?: boolean;
  isAllPositionsLoading?: boolean;
  isOrdersLoading?: boolean;
  isTradesLoading?: boolean;
  realtimeStatus?: ContractRealtimeStatus;
  activeOrdersPagination?: ServerPaginationState;
  orderHistoryPagination?: ServerPaginationState;
  tradeHistoryPagination?: ServerPaginationState;
  activeOrdersFilters?: ContractOrderFilterState;
  orderHistoryFilters?: ContractOrderFilterState;
  tradeHistoryFilters?: ContractTradeFilterState;
  onActiveOrdersFiltersChange?: (filters: ContractOrderFilterState) => void;
  onOrderHistoryFiltersChange?: (filters: ContractOrderFilterState) => void;
  onTradeHistoryFiltersChange?: (filters: ContractTradeFilterState) => void;
  onActiveTabChange?: (tab: ContractPositionTabKey) => void;
  onSymbolSelect?: (symbol: string) => void;
  onScopeChange?: (scope: PositionScope) => void;
  onSuccess: () => Promise<void> | void;
};

const tabs: Array<{ key: TabKey; labelKey: string }> = [
  { key: 'positions', labelKey: 'positionTabCurrent' },
  { key: 'historyPositions', labelKey: 'positionTabHistoryPositions' },
  { key: 'openOrders', labelKey: 'positionTabOpenOrders' },
  { key: 'historyOrders', labelKey: 'positionTabHistoryOrders' },
  { key: 'trades', labelKey: 'positionTabTrades' },
];

const cancelTimeoutMs = 15000;
const pageSize = 5;
const TP_SL_EDITOR_STEP = 1;
const TP_SL_DEFAULT_OFFSET_RATE = 0.002;
const CONTRACT_TRADE_CONFIRM_HIDDEN_KEY = 'contract_trade_confirm_hidden';

function normalizeTpSlTriggerPriceType(value: ContractTpSlTriggerPriceType | string | null | undefined): ContractTpSlTriggerPriceType {
  return value === 'LAST_PRICE' ? 'LAST_PRICE' : 'MARK_PRICE';
}

function getTpSlReferencePrice(
  quote: ContractQuote | null | undefined,
  triggerPriceType: ContractTpSlTriggerPriceType,
  fallback?: string | number | null,
) {
  const preferred = triggerPriceType === 'LAST_PRICE' ? quote?.last_price : quote?.mark_price;
  if (toNumber(preferred) > 0) return preferred ?? null;
  const markPrice = quote?.mark_price;
  if (toNumber(markPrice) > 0) return markPrice ?? null;
  return fallback ?? null;
}

function formatI18nTemplate(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function readLocalStorageFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeLocalStorageFlag(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(key, '1');
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

export default function ContractPositionTabs({
  currentSymbol,
  scope: controlledScope,
  positions,
  positionSummaries,
  activeOrders,
  orders,
  trades,
  quote,
  tpSlTriggerPriceType,
  pricePrecision,
  quantityUnit = 'BTC',
  isLoggedIn,
  loading = false,
  isScopeSwitching = false,
  isAllPositionsLoading = false,
  isOrdersLoading = false,
  isTradesLoading = false,
  realtimeStatus = 'idle',
  activeOrdersPagination,
  orderHistoryPagination,
  tradeHistoryPagination,
  activeOrdersFilters,
  orderHistoryFilters,
  tradeHistoryFilters,
  onActiveOrdersFiltersChange,
  onOrderHistoryFiltersChange,
  onTradeHistoryFiltersChange,
  onActiveTabChange,
  onSymbolSelect,
  onScopeChange,
  onSuccess,
}: ContractPositionTabsProps) {
  const { t } = useLocaleContext();
  const normalizedTpSlTriggerPriceType = normalizeTpSlTriggerPriceType(tpSlTriggerPriceType);
  const tpSlTriggerPriceTypeHint = normalizedTpSlTriggerPriceType === 'LAST_PRICE'
    ? t('tpSlLastPriceTrigger', 'contracts')
    : t('tpSlMarkPriceTrigger', 'contracts');
  const tpSlReferencePriceLabel = normalizedTpSlTriggerPriceType === 'LAST_PRICE'
    ? t('latestPrice', 'contracts')
    : t('markPrice', 'contracts');
  const [activeTab, setActiveTab] = useState<TabKey>('positions');
  const [internalScope, setInternalScope] = useState<PositionScope>('current');
  const scope = controlledScope ?? internalScope;
  const [pages, setPages] = useState<Record<TabKey, number>>({
    positions: 1,
    historyPositions: 1,
    openOrders: 1,
    historyOrders: 1,
    trades: 1,
  });
  const [closingId, setClosingId] = useState<number | null>(null);
  const [closingSummaryKey, setClosingSummaryKey] = useState<string | null>(null);
  const [pendingClosePosition, setPendingClosePosition] = useState<ContractPositionItem | null>(null);
  const [closeQuantityDraft, setCloseQuantityDraft] = useState('');
  const [closePositionError, setClosePositionError] = useState('');
  const [pendingCloseSummary, setPendingCloseSummary] = useState<ContractPositionSummaryItem | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [contractConfirmHidden, setContractConfirmHidden] = useState(() => readLocalStorageFlag(CONTRACT_TRADE_CONFIRM_HIDDEN_KEY));
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null);
  const [orderFeedback, setOrderFeedback] = useState<OrderFeedback | null>(null);
  const [tpSlDraft, setTpSlDraft] = useState<TpSlDraft | null>(null);
  const [tpSlError, setTpSlError] = useState<string | null>(null);
  const [tpSlSaving, setTpSlSaving] = useState(false);

  const openOrders = useMemo(
    () => activeOrders ?? orders.filter((item) => item.status === 'OPEN' || item.status === 'NEW' || item.status === 'PENDING' || item.status === 'PARTIALLY_FILLED'),
    [activeOrders, orders],
  );
  // Backend history filtering is driven by status_group=HISTORY; keep this guard for older responses.
  const historyOrders = useMemo(
    () => orders.filter((item) => item.status !== 'OPEN' && item.status !== 'NEW' && item.status !== 'PENDING' && item.status !== 'PARTIALLY_FILLED'),
    [orders],
  );
  const directionFilterOptions = useMemo(() => [
    { value: '', label: t('filterAll', 'contracts') },
    { value: 'LONG', label: t('long', 'contracts') },
    { value: 'SHORT', label: t('short', 'contracts') },
  ], [t]);
  const orderTypeFilterOptions = useMemo(() => [
    { value: '', label: t('filterAll', 'contracts') },
    { value: 'LIMIT', label: t('limit', 'contracts') },
    { value: 'MARKET', label: t('market', 'contracts') },
  ], [t]);
  const actionFilterOptions = useMemo(() => [
    { value: '', label: t('filterAll', 'contracts') },
    { value: 'OPEN', label: t('openPosition', 'contracts') },
    { value: 'CLOSE', label: t('closePosition', 'contracts') },
  ], [t]);
  const orderFilterGroups = useMemo<Array<FilterGroup<keyof ContractOrderFilterState>>>(() => [
    { key: 'position_side', label: t('direction', 'contracts'), options: directionFilterOptions },
    { key: 'order_type', label: t('filterOrderType', 'contracts'), options: orderTypeFilterOptions },
    { key: 'action', label: t('filterAction', 'contracts'), options: actionFilterOptions },
  ], [actionFilterOptions, directionFilterOptions, orderTypeFilterOptions, t]);
  const tradeFilterGroups = useMemo<Array<FilterGroup<keyof ContractTradeFilterState>>>(() => [
    { key: 'position_side', label: t('direction', 'contracts'), options: directionFilterOptions },
    { key: 'action', label: t('filterAction', 'contracts'), options: actionFilterOptions },
  ], [actionFilterOptions, directionFilterOptions, t]);
  const normalizedCurrentSymbol = useMemo(() => normalizeContractSymbol(currentSymbol), [currentSymbol]);
  const allOpenPositions = useMemo(
    () => positions.filter((item) => item.status === 'OPEN' && getPositionAmount(item) > 0),
    [positions],
  );
  const allOpenPositionSummaries = useMemo(
    () => positionSummaries.filter((item) => (
      toNumber(item.quantity) > 0 &&
      getPositionRecordSide(item) !== null
    )),
    [positionSummaries],
  );
  const currentOpenPositionSummaries = useMemo(
    () => allOpenPositionSummaries.filter((item) => normalizeContractSymbol(item.symbol) === normalizedCurrentSymbol),
    [allOpenPositionSummaries, normalizedCurrentSymbol],
  );
  const openPositionSummaries = scope === 'current' ? currentOpenPositionSummaries : allOpenPositionSummaries;
  const openPositionSummaryRows = useMemo(
    () => openPositionSummaries.map((summary) => ({
      ...summary,
      positions: allOpenPositions.filter((position) => (
        normalizeContractSymbol(position.symbol) === normalizeContractSymbol(summary.symbol) &&
        getPositionRecordSide(position) === getPositionRecordSide(summary)
      )),
    })),
    [allOpenPositions, openPositionSummaries],
  );
  const historyPositions = useMemo(
    () => positions.filter((item) => (
      (item.status === 'CLOSED' || item.status === 'LIQUIDATED' || getPositionAmount(item) <= 0)
    )),
    [positions],
  );
  const scopedHistoryPositions = useMemo(
    () => filterRowsByScope(historyPositions, scope, normalizedCurrentSymbol),
    [historyPositions, normalizedCurrentSymbol, scope],
  );
  const scopedOpenOrders = useMemo(
    () => filterRowsByScope(openOrders, scope, normalizedCurrentSymbol),
    [normalizedCurrentSymbol, openOrders, scope],
  );
  const scopedHistoryOrders = useMemo(
    () => filterRowsByScope(historyOrders, scope, normalizedCurrentSymbol),
    [historyOrders, normalizedCurrentSymbol, scope],
  );
  const scopedTrades = useMemo(
    () => filterRowsByScope(trades, scope, normalizedCurrentSymbol),
    [normalizedCurrentSymbol, scope, trades],
  );
  const pagedOpenPositionSummaries = useMemo(
    () => paginateItems(openPositionSummaryRows, pages.positions, pageSize),
    [openPositionSummaryRows, pages.positions],
  );
  const pagedHistoryPositions = useMemo(
    () => paginateItems(scopedHistoryPositions, pages.historyPositions, pageSize),
    [pages.historyPositions, scopedHistoryPositions],
  );
  const pagedOpenOrders = useMemo(
    () => activeOrdersPagination ? scopedOpenOrders : paginateItems(scopedOpenOrders, pages.openOrders, pageSize),
    [activeOrdersPagination, pages.openOrders, scopedOpenOrders],
  );
  const pagedHistoryOrders = useMemo(
    () => orderHistoryPagination ? scopedHistoryOrders : paginateItems(scopedHistoryOrders, pages.historyOrders, pageSize),
    [orderHistoryPagination, pages.historyOrders, scopedHistoryOrders],
  );
  const pagedTrades = useMemo(
    () => tradeHistoryPagination ? scopedTrades : paginateItems(scopedTrades, pages.trades, pageSize),
    [pages.trades, scopedTrades, tradeHistoryPagination],
  );
  const isPositionsScopeLoading = activeTab === 'positions' && isScopeSwitching;
  const isAllScopeRefreshing = scope === 'all' && isAllPositionsLoading && !isScopeSwitching;
  const isOpenOrdersTabLoading = activeTab === 'openOrders' && isOrdersLoading;
  const isHistoryOrdersTabLoading = activeTab === 'historyOrders' && isOrdersLoading;
  const isTradesTabLoading = activeTab === 'trades' && isTradesLoading;
  const statusText = isPositionsScopeLoading
    ? scope === 'all'
      ? t('positionsLoadingAll', 'contracts')
      : t('positionsLoadingCurrent', 'contracts')
    : isOpenOrdersTabLoading
      ? t('ordersUpdating', 'contracts')
    : isHistoryOrdersTabLoading
      ? scopedHistoryOrders.length > 0
        ? t('ordersUpdating', 'contracts')
        : t('historyOrdersLoading', 'contracts')
    : isTradesTabLoading
      ? scopedTrades.length > 0
        ? t('tradesUpdating', 'contracts')
        : t('tradesLoading', 'contracts')
    : isAllScopeRefreshing
      ? t('positionsUpdatingAll', 'contracts')
      : loading
        ? t('refreshing', 'contracts')
        : t('contractData', 'contracts');
  const realtimeBadgeText = realtimeStatus === 'connected' || realtimeStatus === 'idle'
    ? t('contractData', 'contracts')
    : t('refreshing', 'contracts');
  const realtimeDotClass = realtimeStatus === 'connected'
    ? 'bg-emerald-400'
    : realtimeStatus === 'connecting' || realtimeStatus === 'reconnecting'
      ? 'bg-amber-300'
      : 'bg-white/30';

  useEffect(() => {
    if (!orderFeedback) return undefined;
    const timer = window.setTimeout(() => setOrderFeedback(null), orderFeedback.type === 'success' ? 3000 : 5000);
    return () => window.clearTimeout(timer);
  }, [orderFeedback]);

  useEffect(() => {
    const lengths: Record<TabKey, number> = {
      positions: openPositionSummaryRows.length,
      historyPositions: scopedHistoryPositions.length,
      openOrders: scopedOpenOrders.length,
      historyOrders: scopedHistoryOrders.length,
      trades: scopedTrades.length,
    };

    setPages((previous) => {
      let changed = false;
      const next = { ...previous };
      tabs.forEach((tab) => {
        const maxPage = getTotalPages(lengths[tab.key], pageSize);
        if (next[tab.key] > maxPage) {
          next[tab.key] = maxPage;
          changed = true;
        }
        if (next[tab.key] < 1) {
          next[tab.key] = 1;
          changed = true;
        }
      });
      return changed ? next : previous;
    });
  }, [openPositionSummaryRows.length, scopedHistoryOrders.length, scopedHistoryPositions.length, scopedOpenOrders.length, scopedTrades.length]);

  useEffect(() => {
    setInternalScope('current');
    onScopeChange?.('current');
  }, [activeTab, onScopeChange]);

  useEffect(() => {
    setPages((previous) => ({ ...previous, [activeTab]: 1 }));
  }, [activeTab, scope]);

  function selectTab(tab: TabKey) {
    setActiveTab(tab);
    onActiveTabChange?.(tab);
    setTabPage(tab, 1);
  }

  function changeScope(nextScope: PositionScope) {
    setInternalScope(nextScope);
    onScopeChange?.(nextScope);
  }

  function setTabPage(tab: TabKey, page: number) {
    const safePage = Math.max(1, page);
    const serverPagination = tab === 'openOrders'
      ? activeOrdersPagination
      : tab === 'historyOrders'
        ? orderHistoryPagination
        : tab === 'trades'
          ? tradeHistoryPagination
          : null;
    if (serverPagination) {
      serverPagination.onPageChange(safePage);
      return;
    }
    setPages((previous) => ({
      ...previous,
      [tab]: safePage,
    }));
  }

  function requestClosePosition(position: ContractPositionItem) {
    if (closingId !== null) return;
    setOrderFeedback(null);
    setClosePositionError('');
    if (contractConfirmHidden) {
      void executeClosePosition(position, formatRawQuantity(getPositionAmount(position)));
      return;
    }
    setPendingClosePosition(position);
    setCloseQuantityDraft(formatRawQuantity(getPositionAmount(position)));
  }

  async function executeClosePosition(position: ContractPositionItem, closeQuantityText: string) {
    if (closingId !== null) return;

    setClosingId(position.id);
    setClosePositionError('');
    setOrderFeedback(null);
    try {
      await closeContractOrder({
        position_id: position.id,
        order_type: 'MARKET',
        price: null,
        quantity: closeQuantityText,
      });
      setOrderFeedback({ type: 'success', message: t('closePositionSuccess', 'contracts') });
      setPendingClosePosition(null);
      setCloseQuantityDraft('');
      setPendingCloseSummary(null);
      await onSuccess();
    } catch (error) {
      const message = friendlyContractError(error, t);
      if (pendingClosePosition) {
        setClosePositionError(message);
      } else {
        setOrderFeedback({ type: 'error', message });
      }
    } finally {
      setClosingId(null);
    }
  }

  async function confirmClosePosition() {
    const position = pendingClosePosition;
    if (!position || closingId !== null) return;

    const maxQuantity = getPositionAmount(position);
    const closeQuantityText = normalizeQuantityInputText(closeQuantityDraft);
    const closeQuantity = Number(closeQuantityText);

    if (!closeQuantityText || !Number.isFinite(closeQuantity) || closeQuantity <= 0) {
      setClosePositionError(t('closeQuantityInvalid', 'contracts'));
      return;
    }
    if (closeQuantity > maxQuantity) {
      setClosePositionError(t('closeQuantityExceedsRemaining', 'contracts'));
      return;
    }

    setClosingId(position.id);
    setClosePositionError('');
    setOrderFeedback(null);
    try {
      await closeContractOrder({
        position_id: position.id,
        order_type: 'MARKET',
        price: null,
        quantity: closeQuantityText,
      });
      setOrderFeedback({ type: 'success', message: t('closePositionSuccess', 'contracts') });
      setPendingClosePosition(null);
      setCloseQuantityDraft('');
      setPendingCloseSummary(null);
      await onSuccess();
    } catch (error) {
      setClosePositionError(friendlyContractError(error, t));
    } finally {
      setClosingId(null);
    }
  }

  function closeSummaryPosition(summary: ContractPositionSummaryItem) {
    setConfirmError('');
    const side = getPositionRecordSide(summary);
    if (!side) {
      console.warn('[close-summary] invalid side', { summary, pendingCloseSummary });
      setOrderFeedback({ type: 'error', message: t('positionSideInvalidRetry', 'contracts') });
      return;
    }
    const normalizedSummary = { ...summary, side };
    if (contractConfirmHidden) {
      void executeCloseSummaryPosition(normalizedSummary, true);
      return;
    }
    setPendingCloseSummary(normalizedSummary);
  }

  async function confirmCloseSummaryPosition() {
    const summary = pendingCloseSummary;
    if (!summary) return;
    await executeCloseSummaryPosition(summary, false);
  }

  async function executeCloseSummaryPosition(summary: ContractPositionSummaryItem, directSubmit: boolean) {
    if (!summary || confirmLoading) return;
    const side = getPositionRecordSide(summary);
    if (!side) {
      console.warn('[close-summary] invalid side', { summary, pendingCloseSummary });
      if (directSubmit) {
        setOrderFeedback({ type: 'error', message: t('positionSideInvalidRetry', 'contracts') });
      } else {
        setConfirmError(t('positionSideInvalidRetry', 'contracts'));
      }
      return;
    }
    if (closingSummaryKey !== null) return;

    const summaryKey = getSummaryKey(summary);
    const latestSummary = allOpenPositionSummaries.find((item) => getSummaryKey(item) === summaryKey);
    if (!latestSummary) {
      setPendingCloseSummary(null);
      setConfirmError('');
      setOrderFeedback({ type: 'error', message: t('positionUpdatedRetry', 'contracts') });
      await onSuccess();
      return;
    }

    setConfirmLoading(true);
    setConfirmError('');
    setClosingSummaryKey(summaryKey);
    setOrderFeedback(null);
    try {
      await closeContractSummaryOrder({
        symbol: latestSummary.symbol,
        side,
        order_type: 'MARKET',
        price: null,
        quantity: null,
      });
      setPendingCloseSummary(null);
      setConfirmError('');
      setOrderFeedback({ type: 'success', message: t('closePositionSuccess', 'contracts') });
      await onSuccess();
    } catch (error) {
      const message = friendlyContractError(error, t);
      if (directSubmit) {
        setOrderFeedback({ type: 'error', message });
      } else {
        setConfirmError(message);
      }
    } finally {
      setConfirmLoading(false);
      setClosingSummaryKey(null);
    }
  }

  function openTpSlEditor(position: ContractPositionItem, referencePrice: string | number | null) {
    setOrderFeedback(null);
    setTpSlError(null);
    const side = getPositionRecordSide(position);
    if (!side) {
      setOrderFeedback({ type: 'error', message: t('positionSideInvalidRetry', 'contracts') });
      return;
    }
    const defaultPrices = buildTpSlEditorDefaultPrices({
      side,
      markPrice: referencePrice,
      entryPrice: position.entry_price,
      takeProfitPrice: position.take_profit_price,
      stopLossPrice: position.stop_loss_price,
      pricePrecision,
    });
    setTpSlDraft({
      target: { mode: 'single', positionId: position.id },
      position: { ...position, side },
      positions: [{ ...position, side }],
      referencePrice: referencePrice === null || referencePrice === undefined ? null : String(referencePrice),
      referencePriceLabel: tpSlReferencePriceLabel,
      takeProfitPrice: defaultPrices.takeProfitPrice,
      stopLossPrice: defaultPrices.stopLossPrice,
    });
  }

  function openSummaryTpSlEditor(summary: AggregatedPositionRow, referencePrice: string | number | null) {
    setOrderFeedback(null);
    setTpSlError(null);
    const side = getPositionRecordSide(summary);

    const positionIds = new Set((summary.position_ids || []).map((id) => Number(id)));
    const detailPositions = summary.positions.filter((position) => (
      position.status === 'OPEN' &&
      (positionIds.size === 0 || positionIds.has(Number(position.id)))
    ));
    const representative = detailPositions[0];
    if (!representative || !side) {
      setOrderFeedback({ type: 'error', message: t('tpSlSummaryDetailsMissing', 'contracts') });
      return;
    }
    const defaultPrices = buildTpSlEditorDefaultPrices({
      side,
      markPrice: referencePrice,
      entryPrice: summary.avg_entry_price || representative.entry_price,
      takeProfitPrice: summary.tp_sl_mode === 'SINGLE' ? summary.take_profit_price : representative.take_profit_price,
      stopLossPrice: summary.tp_sl_mode === 'SINGLE' ? summary.stop_loss_price : representative.stop_loss_price,
      pricePrecision,
    });

    setTpSlDraft({
      target: {
        mode: 'summary',
        symbol: summary.symbol,
        side,
        positionIds: detailPositions.map((position) => position.id),
      },
      position: { ...representative, side },
      positions: detailPositions.map((position) => ({ ...position, side: getPositionRecordSide(position) || side })),
      referencePrice: referencePrice === null || referencePrice === undefined ? null : String(referencePrice),
      referencePriceLabel: tpSlReferencePriceLabel,
      takeProfitPrice: defaultPrices.takeProfitPrice,
      stopLossPrice: defaultPrices.stopLossPrice,
    });
  }

  function updateTpSlDraft(action: React.SetStateAction<TpSlDraft | null>) {
    setTpSlError(null);
    setTpSlDraft(action);
  }

  function closeTpSlEditor() {
    setTpSlError(null);
    setTpSlDraft(null);
  }

  async function saveTpSl() {
    if (!tpSlDraft || tpSlSaving) return;

    const referencePrice = toNumber(tpSlDraft.referencePrice);
    const takeProfitText = normalizeTpSlInputText(tpSlDraft.takeProfitPrice);
    const stopLossText = normalizeTpSlInputText(tpSlDraft.stopLossPrice);
    const takeProfitPrice = takeProfitText === '' ? null : takeProfitText;
    const stopLossPrice = stopLossText === '' ? null : stopLossText;
    const takeProfitNumber = takeProfitPrice === null ? null : Number(takeProfitPrice);
    const stopLossNumber = stopLossPrice === null ? null : Number(stopLossPrice);

    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      setTpSlError(t('markPriceUnavailableTpSl', 'contracts'));
      return;
    }
    if (takeProfitNumber !== null && (!Number.isFinite(takeProfitNumber) || takeProfitNumber <= 0)) {
      setTpSlError(t('takeProfitPriceInvalid', 'contracts'));
      return;
    }
    if (stopLossNumber !== null && (!Number.isFinite(stopLossNumber) || stopLossNumber <= 0)) {
      setTpSlError(t('stopLossPriceInvalid', 'contracts'));
      return;
    }

    const side = getPositionRecordSide(tpSlDraft.position);
    if (!side) {
      setTpSlError(t('positionSideInvalidRetry', 'contracts'));
      return;
    }
    if (side === 'LONG') {
      if (takeProfitNumber !== null && takeProfitNumber <= referencePrice) {
        setTpSlError(t('longTakeProfitAboveMark', 'contracts'));
        return;
      }
      if (stopLossNumber !== null && stopLossNumber >= referencePrice) {
        setTpSlError(t('longStopLossBelowMark', 'contracts'));
        return;
      }
    }
    if (side === 'SHORT') {
      if (takeProfitNumber !== null && takeProfitNumber >= referencePrice) {
        setTpSlError(t('shortTakeProfitBelowMark', 'contracts'));
        return;
      }
      if (stopLossNumber !== null && stopLossNumber <= referencePrice) {
        setTpSlError(t('shortStopLossAboveMark', 'contracts'));
        return;
      }
    }

    setTpSlSaving(true);
    setTpSlError(null);
    setOrderFeedback(null);
    try {
      const results = await Promise.allSettled(
        tpSlDraft.positions.map((position) => updateContractPositionTpSl(position.id, {
          take_profit_price: takeProfitPrice,
          stop_loss_price: stopLossPrice,
        })),
      );
      const failedCount = results.filter((result) => result.status === 'rejected').length;
      if (failedCount > 0) {
        setTpSlError(failedCount === results.length ? t('tpSlSaveFailedRetry', 'contracts') : t('tpSlPartialSaveFailed', 'contracts'));
        if (failedCount < results.length) {
          await onSuccess();
        }
        return;
      }
      closeTpSlEditor();
      setOrderFeedback({ type: 'success', message: t('tpSlUpdated', 'contracts') });
      await onSuccess();
    } catch (error) {
      setTpSlError(friendlyContractError(error, t));
    } finally {
      setTpSlSaving(false);
    }
  }

  async function cancelOrder(orderId: number) {
    if (cancelingOrderId !== null) return;
    setCancelingOrderId(orderId);
    setOrderFeedback(null);
    try {
      await withTimeout(cancelContractOrder(orderId), cancelTimeoutMs, t('cancelRequestTimeout', 'contracts'));
      setOrderFeedback({ type: 'success', message: t('cancelOrderSuccess', 'contracts') });
      void Promise.resolve().then(onSuccess).catch(() => {
        setOrderFeedback({ type: 'error', message: t('cancelOrderSuccessRefreshFailed', 'contracts') });
      });
    } catch (error) {
      setOrderFeedback({ type: 'error', message: friendlyContractError(error, t) });
    } finally {
      setCancelingOrderId(null);
    }
  }

  return (
    <div className="tabular-nums min-w-0 bg-[#12171f] px-2 py-1.5 text-white">
      <div className="mb-1 flex items-center gap-2">
        <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => selectTab(tab.key)}
            className={`rounded-md px-2 py-0.5 text-[12px] ${
              activeTab === tab.key
                ? 'bg-white text-black'
                : 'bg-white/5 text-white/70'
            }`}
          >
            {t(tab.labelKey, 'contracts')}
          </button>
        ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 self-center text-xs text-white/40" title={statusText}>
          <span className={`h-1.5 w-1.5 rounded-full ${realtimeDotClass}`} aria-hidden="true" />
          <span>{loading ? t('refreshing', 'contracts') : realtimeBadgeText}</span>
        </div>
      </div>

      <PositionScopeSwitcher value={scope} onChange={changeScope} />

      <div className="overflow-visible">
        {activeTab === 'positions' ? (
          <>
            {orderFeedback ? <OrderFeedbackBox feedback={orderFeedback} /> : null}
            <SummaryPositionsCards
              rows={pagedOpenPositionSummaries}
              currentSymbol={normalizedCurrentSymbol}
              scope={scope}
              quote={quote}
              tpSlTriggerPriceType={normalizedTpSlTriggerPriceType}
              tpSlTriggerPriceTypeHint={tpSlTriggerPriceTypeHint}
              pricePrecision={pricePrecision}
              quantityUnit={quantityUnit}
              isLoggedIn={isLoggedIn}
              loading={loading || isScopeSwitching}
              closingId={closingId}
              closingSummaryKey={closingSummaryKey}
              emptyTitle={scope === 'current' ? t('emptyCurrentSymbolPositions', 'contracts') : t('emptyContractPositions', 'contracts')}
              emptyDescription={scope === 'current' ? t('emptyCurrentSymbolPositionsDesc', 'contracts') : t('emptyAllPositionsDesc', 'contracts')}
              onClose={closeSummaryPosition}
              onEditTpSl={openSummaryTpSlEditor}
              onClosePosition={requestClosePosition}
              onEditPositionTpSl={openTpSlEditor}
              onSymbolSelect={onSymbolSelect}
            />
            <PaginationControls
              page={pages.positions}
              totalItems={openPositionSummaryRows.length}
              pageSize={pageSize}
              onPageChange={(page) => setTabPage('positions', page)}
            />
          </>
        ) : null}
        {activeTab === 'historyPositions' ? (
          <>
            <HistoryPositionsTable rows={pagedHistoryPositions} pricePrecision={pricePrecision} isLoggedIn={isLoggedIn} loading={loading} />
            <PaginationControls
              page={pages.historyPositions}
              totalItems={scopedHistoryPositions.length}
              pageSize={pageSize}
              onPageChange={(page) => setTabPage('historyPositions', page)}
            />
          </>
        ) : null}
        {activeTab === 'openOrders' ? (
          <>
            {orderFeedback ? <OrderFeedbackBox feedback={orderFeedback} /> : null}
            <OrderTradeFilterBar
              groups={orderFilterGroups}
              values={activeOrdersFilters}
              onChange={(key, value) => setOrderFilterValue(activeOrdersFilters, onActiveOrdersFiltersChange, key, value)}
            />
            <ContractOrderTabs
              rows={pagedOpenOrders}
              emptyText={t('emptyOpenOrders', 'contracts')}
              pricePrecision={pricePrecision}
              loading={isOpenOrdersTabLoading}
              showOperation
              cancelingOrderId={cancelingOrderId}
              onCancel={cancelOrder}
            />
            <PaginationControls
              page={activeOrdersPagination?.page ?? pages.openOrders}
              totalItems={activeOrdersPagination?.total ?? scopedOpenOrders.length}
              pageSize={activeOrdersPagination?.pageSize ?? pageSize}
              onPageChange={(page) => setTabPage('openOrders', page)}
            />
          </>
        ) : null}
        {activeTab === 'historyOrders' ? (
          <>
            <OrderTradeFilterBar
              groups={orderFilterGroups}
              values={orderHistoryFilters}
              onChange={(key, value) => setOrderFilterValue(orderHistoryFilters, onOrderHistoryFiltersChange, key, value)}
            />
            <ContractOrderTabs
              rows={pagedHistoryOrders}
              emptyText={t('emptyHistoryOrders', 'contracts')}
              pricePrecision={pricePrecision}
              loading={isHistoryOrdersTabLoading}
              loadingText={t('historyOrdersLoading', 'contracts')}
              loadingDescription={t('historyOrdersLoadingDesc', 'contracts')}
              positions={positions}
            />
            <PaginationControls
              page={orderHistoryPagination?.page ?? pages.historyOrders}
              totalItems={orderHistoryPagination?.total ?? scopedHistoryOrders.length}
              pageSize={orderHistoryPagination?.pageSize ?? pageSize}
              onPageChange={(page) => setTabPage('historyOrders', page)}
            />
          </>
        ) : null}
        {activeTab === 'trades' ? (
          <>
            <OrderTradeFilterBar
              groups={tradeFilterGroups}
              values={tradeHistoryFilters}
              onChange={(key, value) => setTradeFilterValue(tradeHistoryFilters, onTradeHistoryFiltersChange, key, value)}
            />
            <TradesTable rows={pagedTrades} pricePrecision={pricePrecision} loading={isTradesTabLoading} />
            <PaginationControls
              page={tradeHistoryPagination?.page ?? pages.trades}
              totalItems={tradeHistoryPagination?.total ?? scopedTrades.length}
              pageSize={tradeHistoryPagination?.pageSize ?? pageSize}
              onPageChange={(page) => setTabPage('trades', page)}
            />
          </>
        ) : null}
      </div>
      <TradingConfirmModal
        open={!!pendingCloseSummary}
        title={t('confirmMarketCloseTitle', 'contracts')}
        description={t('confirmMarketCloseDesc', 'contracts')}
        confirmText={t('confirmClosePosition', 'contracts')}
        danger
        loading={confirmLoading}
        error={confirmError}
        details={pendingCloseSummary ? [
          { label: t('symbol', 'contracts'), value: displayPositionSymbol(pendingCloseSummary.symbol) },
          { label: t('direction', 'contracts'), value: sideLabel(pendingCloseSummary.side, t) },
          { label: t('quantity', 'contracts'), value: formatNumber(pendingCloseSummary.quantity, 6) },
          { label: t('entryPrice', 'contracts'), value: formatDisplayPrice(pendingCloseSummary.avg_entry_price, pricePrecision) },
        ] : []}
        suppressChecked={contractConfirmHidden}
        onSuppressChange={(checked) => {
          setContractConfirmHidden(checked);
          writeLocalStorageFlag(CONTRACT_TRADE_CONFIRM_HIDDEN_KEY, checked);
        }}
        onCancel={() => {
          if (!confirmLoading) {
            setConfirmError('');
            setPendingCloseSummary(null);
          }
        }}
        onConfirm={() => {
          void confirmCloseSummaryPosition();
        }}
      />
      {pendingClosePosition ? (
        <ClosePositionDialog
          position={pendingClosePosition}
          quantity={closeQuantityDraft}
          error={closePositionError}
          pricePrecision={pricePrecision}
          saving={closingId === pendingClosePosition.id}
          suppressChecked={contractConfirmHidden}
          onSuppressChange={(checked) => {
            setContractConfirmHidden(checked);
            writeLocalStorageFlag(CONTRACT_TRADE_CONFIRM_HIDDEN_KEY, checked);
          }}
          onQuantityChange={(value) => {
            setCloseQuantityDraft(value);
            setClosePositionError('');
          }}
          onClose={() => {
            if (closingId === null) {
              setPendingClosePosition(null);
              setCloseQuantityDraft('');
              setClosePositionError('');
            }
          }}
          onConfirm={confirmClosePosition}
        />
      ) : null}
      {tpSlDraft ? (
        <TpSlEditorDialog
          draft={tpSlDraft}
          error={tpSlError}
          pricePrecision={pricePrecision}
          tpSlTriggerPriceTypeHint={tpSlTriggerPriceTypeHint}
          saving={tpSlSaving}
          onChange={updateTpSlDraft}
          onClose={closeTpSlEditor}
          onSave={saveTpSl}
        />
      ) : null}
    </div>
  );
}

function paginateItems<T>(items: T[], page: number, size: number) {
  const safePage = Math.max(1, page);
  return items.slice((safePage - 1) * size, safePage * size);
}

function filterRowsByScope<T extends { symbol?: string | null }>(
  rows: T[],
  scope: PositionScope,
  currentSymbol: string,
) {
  if (scope === 'all') return rows;
  return rows.filter((item) => normalizeContractSymbol(item.symbol) === currentSymbol);
}

function getTotalPages(totalItems: number, size: number) {
  return Math.max(1, Math.ceil(totalItems / size));
}

function setOrderFilterValue(
  filters: ContractOrderFilterState | undefined,
  onChange: ((filters: ContractOrderFilterState) => void) | undefined,
  key: keyof ContractOrderFilterState,
  value: string,
) {
  if (!onChange) return;
  const next = { ...(filters || {}) };
  if (value) {
    next[key] = value;
  } else {
    delete next[key];
  }
  onChange(next);
}

function setTradeFilterValue(
  filters: ContractTradeFilterState | undefined,
  onChange: ((filters: ContractTradeFilterState) => void) | undefined,
  key: keyof ContractTradeFilterState,
  value: string,
) {
  if (!onChange) return;
  const next = { ...(filters || {}) };
  if (value) {
    next[key] = value;
  } else {
    delete next[key];
  }
  onChange(next);
}

function OrderTradeFilterBar<T extends string>({
  groups,
  values,
  onChange,
}: {
  groups: Array<FilterGroup<T>>;
  values?: Partial<Record<T, string | undefined>>;
  onChange: (key: T, value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2 text-[12px] text-white/55">
      {groups.map((group) => (
        <div key={group.key} className="flex items-center gap-1.5">
          <span className="shrink-0 text-white/40">{group.label}</span>
          <div className="flex items-center gap-1">
            {group.options.map((option) => {
              const active = (values?.[group.key] || '') === option.value;
              return (
                <button
                  key={option.value || 'all'}
                  type="button"
                  onClick={() => onChange(group.key, option.value)}
                  className={`h-6 rounded-md px-2 text-[12px] transition-colors ${
                    active
                      ? 'bg-white text-black'
                      : 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PaginationControls({
  page,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useLocaleContext();
  const totalPages = getTotalPages(totalItems, pageSize);
  if (totalItems === 0 || totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-end gap-2 border-t border-white/5 px-3 py-2 text-[12px] text-white/45">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        className="h-7 rounded-md border border-white/10 px-2.5 text-white/65 transition-colors hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
      >
        {t('previousPage', 'contracts')}
      </button>
      <span className="min-w-[72px] text-center font-mono tabular-nums">
        {formatI18nTemplate(t('pageIndicator', 'contracts'), { page, totalPages })}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        className="h-7 rounded-md border border-white/10 px-2.5 text-white/65 transition-colors hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
      >
        {t('nextPage', 'contracts')}
      </button>
    </div>
  );
}

function PositionScopeSwitcher({
  value,
  onChange,
}: {
  value: PositionScope;
  onChange: (value: PositionScope) => void;
}) {
  const { t } = useLocaleContext();
  return (
    <div className="flex items-center gap-1 border-b border-white/5 px-3 py-2">
      {[
        { key: 'current' as const, label: t('currentSymbolScope', 'contracts') },
        { key: 'all' as const, label: t('allPositionsScope', 'contracts') },
      ].map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={`h-7 rounded-md px-2.5 text-[12px] transition-colors ${
            value === item.key
              ? 'bg-white text-black'
              : 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function SummaryPositionsCards({
  rows,
  currentSymbol,
  scope,
  quote,
  tpSlTriggerPriceType,
  tpSlTriggerPriceTypeHint,
  pricePrecision,
  quantityUnit,
  isLoggedIn,
  loading,
  closingId,
  closingSummaryKey,
  emptyTitle,
  emptyDescription,
  onClose,
  onEditTpSl,
  onClosePosition,
  onEditPositionTpSl,
  onSymbolSelect,
}: {
  rows: AggregatedPositionRow[];
  currentSymbol: string;
  scope: PositionScope;
  quote?: ContractQuote | null;
  tpSlTriggerPriceType: ContractTpSlTriggerPriceType;
  tpSlTriggerPriceTypeHint: string;
  pricePrecision: number;
  quantityUnit: string;
  isLoggedIn: boolean;
  loading: boolean;
  closingId: number | null;
  closingSummaryKey: string | null;
  emptyTitle: string;
  emptyDescription: string;
  onClose: (summary: ContractPositionSummaryItem) => void;
  onEditTpSl: (summary: AggregatedPositionRow, markPrice: string | number | null) => void;
  onClosePosition: (position: ContractPositionItem) => void;
  onEditPositionTpSl: (position: ContractPositionItem, markPrice: string | number | null) => void;
  onSymbolSelect?: (symbol: string) => void;
}) {
  const { t } = useLocaleContext();
  const [expandedDetailKeys, setExpandedDetailKeys] = useState<Set<string>>(() => new Set());

  if (rows.length === 0 && loading && scope === 'all') {
    return (
      <EmptyState
        title={t('positionsLoadingAll', 'contracts')}
        description={t('positionsLoadingAllDesc', 'contracts')}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title={loading ? t('positionsRefreshing', 'contracts') : isLoggedIn ? emptyTitle : t('loginToViewPositions', 'contracts')}
        description={isLoggedIn ? emptyDescription : t('loginToViewPositionsDesc', 'contracts')}
      />
    );
  }

  return (
    <div className="space-y-2 p-3">
      {rows.map((item) => {
        const summaryKey = getSummaryKey(item);
        const side = normalizePositionSide(item.side);
        const itemSymbol = normalizeContractSymbol(item.symbol);
        const isCurrent = itemSymbol === currentSymbol;
        const markPrice: string | number | null = isCurrent && toNumber(quote?.mark_price) > 0
          ? quote?.mark_price ?? null
          : item.positions.find((position) => toNumber(position.mark_price) > 0)?.mark_price ?? null;
        const tpSlReferencePrice = isCurrent
          ? getTpSlReferencePrice(quote, tpSlTriggerPriceType, markPrice)
          : markPrice;
        const liquidationPrice = toNumber(item.liquidation_price);
        const realtimeUnrealized = item.positions.reduce(
          (sum, position) => sum + calculatePositionUnrealizedPnl(position, markPrice),
          0,
        );
        const unrealized = item.positions.length > 0 ? realtimeUnrealized : toNumber(item.unrealized_pnl);
        const pnlPercent = calcUnrealizedPnlPercent(unrealized, item.margin_amount);
        const displayUnit = scope === 'current' ? quantityUnit : inferPositionQuantityUnit(item.symbol, quantityUnit);
        const closing = closingSummaryKey === summaryKey;
        const detailsExpanded = expandedDetailKeys.has(summaryKey);

        return (
          <div
            key={summaryKey}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSymbolSelect?.(item.symbol)}
                    className="font-semibold text-white hover:text-[#f0b90b]"
                  >
                    {displayPositionSymbol(item.symbol)}
                  </button>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${side === 'LONG' ? 'bg-[#00c087]/12 text-[#00c087]' : 'bg-[#f6465d]/12 text-[#f6465d]'}`}>
                    {sideLabel(item.side, t)}
                  </span>
                  {isCurrent ? (
                    <span className="rounded bg-[#f0b90b]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[#f0b90b]">{t('current', 'contracts')}</span>
                  ) : null}
                  <StatusBadge status="OPEN" />
                </div>
                <div className="mt-1 text-[11px] text-white/42">
                  {item.count > 1 ? formatI18nTemplate(t('mergedPositionDetails', 'contracts'), { count: item.count }) : t('singlePosition', 'contracts')}
                </div>
                {item.positions.some(hasPositionTpSl) ? (
                  <div className="mt-0.5 text-[10px] text-white/35">{tpSlTriggerPriceTypeHint}</div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEditTpSl(item, tpSlReferencePrice)}
                  className="h-8 rounded-md border border-white/10 px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {t('setTpSl', 'contracts')}
                </button>
                <button
                  type="button"
                  disabled={closing}
                  onClick={() => onClose(item)}
                  className="h-8 rounded-md border border-white/10 bg-white px-3 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {closing ? t('closingPosition', 'contracts') : t('marketClose', 'contracts')}
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
              <PositionMetric label={t('quantity', 'contracts')} value={`${formatNumber(item.quantity, 6)} ${displayUnit}`} />
              <PositionMetric
                label={t('entryPrice', 'contracts')}
                labelTitle={t('aggregatedEntryPriceTitle', 'contracts')}
                value={`${formatDisplayPrice(item.avg_entry_price, pricePrecision)} USDT`}
              />
              <PositionMetric
                label={t('markPrice', 'contracts')}
                labelTitle={t('markPriceRiskTitle', 'contracts')}
                value={markPrice ? `${formatDisplayPrice(markPrice, pricePrecision)} USDT` : '--'}
              />
              <PositionMetric
                label={t('liquidationPrice', 'contracts')}
                value={liquidationPrice > 0 ? `${formatDisplayPrice(item.liquidation_price, pricePrecision)} USDT` : '--'}
              />
              <PositionMetric label={t('margin', 'contracts')} value={`${formatNumber(item.margin_amount, 4)} USDT`} />
              <PositionMetric
                label={t('unrealizedPnl', 'contracts')}
                value={`${formatSignedPnl(unrealized, 4)} USDT`}
                valueClassName={unrealized > 0 ? 'text-[#00c087]' : unrealized < 0 ? 'text-[#f6465d]' : 'text-white/55'}
              />
              <PositionMetric
                label={t('pnlRatio', 'contracts')}
                value={formatPnlPercent(pnlPercent)}
                valueClassName={pnlPercent === null ? 'text-white/55' : pnlPercent > 0 ? 'text-[#00c087]' : pnlPercent < 0 ? 'text-[#f6465d]' : 'text-white/55'}
              />
              <PositionMetric label={t('status', 'contracts')} value={statusLabel('OPEN', null, t)} />
            </div>

            <details
              open={detailsExpanded}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpandedDetailKeys((previous) => {
                  const next = new Set(previous);
                  if (open) {
                    next.add(summaryKey);
                  } else {
                    next.delete(summaryKey);
                  }
                  return next;
                });
              }}
              className="mt-3 rounded-md border border-white/[0.06] bg-black/10"
            >
              <summary className="cursor-pointer select-none px-2.5 py-2 text-[12px] font-medium text-white/65 hover:text-white">
                {formatI18nTemplate(t('detailsCount', 'contracts'), { count: item.positions.length })}
              </summary>
              <div className="space-y-2 border-t border-white/[0.06] p-2">
                {item.positions.map((position, index) => (
                  <PositionDetailCard
                    key={position.id}
                    index={index}
                    position={position}
                    markPrice={markPrice}
                    tpSlTriggerPriceTypeHint={tpSlTriggerPriceTypeHint}
                    pricePrecision={pricePrecision}
                    closing={closingId === position.id}
                    onEditTpSl={onEditPositionTpSl}
                    onClose={onClosePosition}
                  />
                ))}
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function PositionsTable({
  rows,
  quote,
  pricePrecision,
  quantityUnit,
  isLoggedIn,
  loading,
  closingId,
  emptyTitle,
  emptyDescription,
  onClose,
  onEditTpSl,
}: {
  rows: ContractPositionItem[];
  quote?: ContractQuote | null;
  pricePrecision: number;
  quantityUnit: string;
  isLoggedIn: boolean;
  loading: boolean;
  closingId: number | null;
  emptyTitle: string;
  emptyDescription: string;
  onClose: (positionId: number) => void;
  onEditTpSl: (position: ContractPositionItem, markPrice: string | number | null) => void;
}) {
  const { t } = useLocaleContext();
  if (rows.length === 0) {
    return (
      <EmptyState
        title={loading ? t('positionsRefreshing', 'contracts') : isLoggedIn ? emptyTitle : t('loginToViewPositions', 'contracts')}
        description={isLoggedIn ? emptyDescription : t('loginToViewPositionsDesc', 'contracts')}
      />
    );
  }

  return (
    <div className="space-y-2 p-3">
      {rows.map((item) => {
        const markPrice = toNumber(quote?.mark_price) > 0 ? quote?.mark_price : null;
        const liquidationPrice = calcContractLiquidationPrice(item);
        const nearLiquidation = isNearLiquidation(item.side, toNumber(markPrice), liquidationPrice);
        const unrealized = markPrice ? calculateUnrealizedPnl(item, toNumber(markPrice)) : null;
        const unrealizedText = unrealized === null ? '--' : `${formatSignedPnl(unrealized, 4)} USDT`;
        const pnlPercent = calcUnrealizedPnlPercent(unrealized, item.margin_amount);
        const liquidationRisk = getLiquidationRisk(item.side, toNumber(markPrice), liquidationPrice);
        const isOpen = item.status === 'OPEN';
        const isLiquidated = item.status === 'LIQUIDATED';
        const hasTpSl = hasPositionTpSl(item);
        const takeProfitBadge = formatOptionalTpSlBadge(item.take_profit_price, pricePrecision);
        const stopLossBadge = formatOptionalTpSlBadge(item.stop_loss_price, pricePrecision);

        return (
          <div
            key={item.id}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{displayPositionSymbol(item.symbol)}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${item.side === 'LONG' ? 'bg-[#00c087]/12 text-[#00c087]' : 'bg-[#f6465d]/12 text-[#f6465d]'}`}>
                    {sideLabel(item.side, t)}
                  </span>
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-white/65">{item.leverage}x</span>
                  <StatusBadge status={item.status} closeReason={item.close_reason} />
                  {takeProfitBadge ? <TpSlBadge type="TP" value={takeProfitBadge} /> : null}
                  {stopLossBadge ? <TpSlBadge type="SL" value={stopLossBadge} /> : null}
                  {nearLiquidation ? (
                    <span className="rounded border border-[#f6465d]/30 bg-[#f6465d]/12 px-1.5 py-0.5 text-[11px] font-semibold text-[#f6465d]">
                      {t('highRisk', 'contracts')}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {isOpen ? (
                  <button
                    type="button"
                    onClick={() => onEditTpSl(item, markPrice ?? item.mark_price)}
                    className="h-8 rounded-md border border-white/10 px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/25 hover:text-white"
                  >
                    {hasTpSl ? t('editTpSl', 'contracts') : t('setTpSl', 'contracts')}
                  </button>
                ) : null}
                {isLiquidated ? (
                  <span className="text-[12px] text-[#f6465d]">{t('statusLiquidated', 'contracts')}</span>
                ) : isOpen ? (
                  <button
                    type="button"
                    disabled={closingId === item.id}
                    onClick={() => onClose(item.id)}
                    className="h-8 rounded-md border border-white/10 bg-white px-3 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {closingId === item.id ? t('closingPosition', 'contracts') : t('marketClose', 'contracts')}
                  </button>
                ) : (
                  <span className="text-[12px] text-white/35">--</span>
                )}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
              <PositionMetric label={t('quantity', 'contracts')} value={`${formatNumber(item.quantity, 6)} ${quantityUnit}`} />
              <PositionMetric
                label={t('entryPrice', 'contracts')}
                labelTitle={t('entryPriceTitle', 'contracts')}
                value={`${formatDisplayPrice(item.entry_price, pricePrecision)} USDT`}
              />
              <PositionMetric
                label={t('markPrice', 'contracts')}
                labelTitle={t('markPricePnlRiskTitle', 'contracts')}
                value={markPrice ? `${formatDisplayPrice(markPrice, pricePrecision)} USDT` : '--'}
              />
              <PositionMetric
                label={t('liquidationPrice', 'contracts')}
                value={liquidationPrice ? `${formatDisplayPrice(liquidationPrice, pricePrecision)} USDT` : '--'}
                valueClassName={nearLiquidation ? 'text-[#f6465d]' : 'text-white/86'}
              />
              <PositionMetric label={t('margin', 'contracts')} value={`${formatNumber(item.margin_amount, 2)} USDT`} />
              <PositionMetric
                label={t('unrealizedPnl', 'contracts')}
                value={unrealizedText}
                valueClassName={unrealized === null ? 'text-white/55' : unrealized > 0 ? 'text-[#00c087]' : unrealized < 0 ? 'text-[#f6465d]' : 'text-white/55'}
              />
              <PositionMetric
                label={t('pnlRatio', 'contracts')}
                value={formatPnlPercent(pnlPercent)}
                valueClassName={pnlPercent === null ? 'text-white/55' : pnlPercent > 0 ? 'text-[#00c087]' : pnlPercent < 0 ? 'text-[#f6465d]' : 'text-white/55'}
              />
              <PositionMetric label={t('status', 'contracts')} value={statusLabel(item.status, item.close_reason, t)} />
            </div>
            <RiskBar risk={liquidationRisk} />
          </div>
        );
      })}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AllPositionsTable({
  rows,
  currentSymbol,
  pricePrecision,
  isLoggedIn,
  loading,
  closingId,
  onClose,
  onEditTpSl,
  onSymbolSelect,
}: {
  rows: ContractPositionItem[];
  currentSymbol: string;
  pricePrecision: number;
  isLoggedIn: boolean;
  loading: boolean;
  closingId: number | null;
  onClose: (positionId: number) => void;
  onEditTpSl: (position: ContractPositionItem, markPrice: string | number | null) => void;
  onSymbolSelect?: (symbol: string) => void;
}) {
  const { t } = useLocaleContext();
  if (rows.length === 0) {
    return (
      <EmptyState
        title={loading ? t('positionsRefreshing', 'contracts') : isLoggedIn ? t('emptyContractPositions', 'contracts') : t('loginToViewPositions', 'contracts')}
        description={isLoggedIn ? t('emptyAllPositionsDesc', 'contracts') : t('loginToViewPositionsDesc', 'contracts')}
      />
    );
  }

  return (
    <div className="overflow-x-auto p-3">
      <table className="min-w-[1120px] w-full table-fixed text-left text-[12px]">
        <thead className="bg-[#0b0e11] text-white/40">
          <tr>
            {[t('symbol', 'contracts'), t('direction', 'contracts'), t('leverage', 'contracts'), t('quantity', 'contracts'), t('entryPrice', 'contracts'), t('markPrice', 'contracts'), t('margin', 'contracts'), t('unrealizedPnl', 'contracts'), t('pnlRatio', 'contracts'), t('liquidationPrice', 'contracts'), t('risk', 'contracts'), t('status', 'contracts'), t('operation', 'contracts')].map((head) => (
              <th key={head} className="whitespace-nowrap px-2 py-2 font-medium">{head}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((item) => {
            const itemSymbol = normalizeContractSymbol(item.symbol);
            const isCurrent = itemSymbol === currentSymbol;
            const markPrice = toNumber(item.mark_price);
            const liquidationPrice = calcContractLiquidationPrice(item);
            const unrealized = markPrice > 0 ? calculateUnrealizedPnl(item, markPrice) : null;
            const pnlPercent = calcUnrealizedPnlPercent(unrealized, item.margin_amount);
            const liquidationRisk = getLiquidationRisk(item.side, markPrice, liquidationPrice);
            const unrealizedClassName = unrealized === null
              ? 'text-white/55'
              : unrealized > 0
                ? 'text-[#00c087]'
                : unrealized < 0
                  ? 'text-[#f6465d]'
                  : 'text-white/55';
            const pnlClassName = pnlPercent === null
              ? 'text-white/55'
              : pnlPercent > 0
                ? 'text-[#00c087]'
                : pnlPercent < 0
                  ? 'text-[#f6465d]'
                  : 'text-white/55';

            return (
              <tr key={item.id} className={isCurrent ? 'bg-white/[0.025] text-white/88' : 'text-white/78'}>
                <td className="whitespace-nowrap px-2 py-2.5">
                  <button
                    type="button"
                    onClick={() => onSymbolSelect?.(item.symbol)}
                    className="font-semibold text-white hover:text-[#f0b90b]"
                  >
                    {displayPositionSymbol(item.symbol)}
                  </button>
                  {isCurrent ? (
                    <span className="ml-1 rounded bg-[#f0b90b]/12 px-1 py-0.5 text-[10px] font-semibold text-[#f0b90b]">{t('current', 'contracts')}</span>
                  ) : null}
                </td>
                <Td color={item.side === 'LONG' ? 'green' : 'red'}>{sideLabel(item.side, t)}</Td>
                <Td>{item.leverage}x</Td>
                <Td>{formatNumber(item.quantity, 6)}</Td>
                <Td>{formatDisplayPrice(item.entry_price, pricePrecision)}</Td>
                <Td>{markPrice > 0 ? formatDisplayPrice(markPrice, pricePrecision) : '--'}</Td>
                <Td>{formatNumber(item.margin_amount, 2)}</Td>
                <td className={`whitespace-nowrap px-2 py-2.5 font-mono tabular-nums ${unrealizedClassName}`}>
                  {unrealized === null ? '--' : formatSignedPnl(unrealized, 4)}
                </td>
                <td className={`whitespace-nowrap px-2 py-2.5 font-mono tabular-nums ${pnlClassName}`}>
                  {formatPnlPercent(pnlPercent)}
                </td>
                <Td>{liquidationPrice ? formatDisplayPrice(liquidationPrice, pricePrecision) : '--'}</Td>
                <td className={`whitespace-nowrap px-2 py-2.5 font-mono tabular-nums ${liquidationRisk ? riskTextClassName(liquidationRisk.tone) : 'text-white/55'}`}>
                  {liquidationRisk ? t(liquidationRisk.labelKey, 'contracts') : '--'}
                </td>
                <td className="whitespace-nowrap px-2 py-2.5">
                  <StatusBadge status={item.status} closeReason={item.close_reason} />
                </td>
                <td className="whitespace-nowrap px-2 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onEditTpSl(item, item.mark_price)}
                      className="h-7 rounded-md border border-white/10 px-2 text-[11px] font-semibold text-white/70 hover:border-white/25 hover:text-white"
                    >
                      TP/SL
                    </button>
                    <button
                      type="button"
                      disabled={closingId === item.id}
                      onClick={() => onClose(item.id)}
                      className="h-7 rounded-md bg-white px-2 text-[11px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {closingId === item.id ? t('closingPositionShort', 'contracts') : t('marketClose', 'contracts')}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryPositionsTable({
  rows,
  pricePrecision,
  isLoggedIn,
  loading,
}: {
  rows: ContractPositionItem[];
  pricePrecision: number;
  isLoggedIn: boolean;
  loading: boolean;
}) {
  const { t } = useLocaleContext();
  if (rows.length === 0) {
    return (
      <EmptyState
        title={loading ? t('historyPositionsRefreshing', 'contracts') : isLoggedIn ? t('emptyHistoryPositions', 'contracts') : t('loginToViewHistoryPositions', 'contracts')}
        description={isLoggedIn ? t('emptyHistoryPositionsDesc', 'contracts') : t('loginToViewHistoryPositionsDesc', 'contracts')}
      />
    );
  }

  return (
    <div className="space-y-2 p-3">
      {rows.map((item) => {
        const displayQuantity = getHistoryPositionQuantity(item);
        const displayMargin = getHistoryPositionMargin(item);
        const realizedPnl = toNumber(item.realized_pnl);
        const closeAvgPrice = toNumber(item.close_avg_price);

        return (
          <div
            key={item.id}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-white">{displayPositionSymbol(item.symbol)}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${item.side === 'LONG' ? 'bg-[#00c087]/12 text-[#00c087]' : 'bg-[#f6465d]/12 text-[#f6465d]'}`}>
                    {sideLabel(item.side, t)}
                  </span>
                  <span className="font-mono text-[12px] text-white/75">{formatNumber(displayQuantity, 6)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/45">
                  <HistoryMeta label={t('openShort', 'contracts')} value={formatDisplayPrice(item.entry_price, pricePrecision)} />
                  <HistoryMeta label={t('closeShort', 'contracts')} value={closeAvgPrice > 0 ? formatDisplayPrice(item.close_avg_price, pricePrecision) : '--'} />
                  <HistoryMeta label={t('margin', 'contracts')} value={formatNumber(displayMargin, 4)} />
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                <div className={`font-mono text-[14px] font-semibold tabular-nums ${realizedPnl > 0 ? 'text-[#00c087]' : realizedPnl < 0 ? 'text-[#f6465d]' : 'text-white/75'}`}>
                  {formatSignedPnl(item.realized_pnl, 6)}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <StatusBadge status={item.status} closeReason={item.close_reason} />
                  <span className="text-[11px] text-white/38">{formatHistoryTime(item.closed_at)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getHistoryPositionQuantity(item: ContractPositionItem) {
  const closedQuantity = toNumber(item.closed_quantity);
  if (closedQuantity > 0) return closedQuantity;
  const openedQuantity = toNumber(item.opened_quantity);
  if (openedQuantity > 0) return openedQuantity;
  return getPositionAmount(item);
}

function getHistoryPositionMargin(item: ContractPositionItem) {
  const releasedMargin = toNumber(item.released_margin_amount);
  if (releasedMargin > 0) return releasedMargin;
  const openedMargin = toNumber(item.opened_margin_amount);
  if (openedMargin > 0) return openedMargin;
  return toNumber(item.margin_amount);
}

function HistoryMeta({
  label,
  value,
  className = '',
  valueClassName = 'text-white/70',
}: {
  label: string;
  value: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 whitespace-nowrap ${className}`}>
      <span className="shrink-0">{label}</span>
      <span className={`font-mono tabular-nums ${valueClassName}`}>{value}</span>
    </span>
  );
}

function formatHistoryTime(value?: string | null) {
  const text = formatTime(value);
  return text === '--' ? text : text.replace(/-/g, '/');
}

function displayPositionSymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}

function normalizeContractSymbol(symbol: string | null | undefined) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizePositionSide(side: string | null | undefined): ContractPositionSide | null {
  const normalized = String(side || '').trim().toUpperCase();
  if (normalized === 'LONG' || normalized === 'SHORT') return normalized;
  if (normalized === '\u591a' || normalized === '\u591a\u4ed3' || normalized === '\u5e73\u591a') return 'LONG';
  if (normalized === '\u7a7a' || normalized === '\u7a7a\u4ed3' || normalized === '\u5e73\u7a7a') return 'SHORT';
  return null;
}

function getPositionRecordSide(record: Partial<ContractPositionItem & ContractPositionSummaryItem> | null | undefined): ContractPositionSide | null {
  const sideRecord = record as Partial<ContractPositionItem & ContractPositionSummaryItem> & {
    position_side?: string | null;
    direction?: string | null;
    close_side?: string | null;
  } | null | undefined;

  return (
    normalizePositionSide(sideRecord?.side) ||
    normalizePositionSide(sideRecord?.position_side) ||
    normalizePositionSide(sideRecord?.direction) ||
    normalizePositionSide(sideRecord?.close_side)
  );
}

function getSummaryKey(summary: Pick<ContractPositionSummaryItem, 'symbol' | 'side'>) {
  return `${normalizeContractSymbol(summary.symbol)}:${getPositionRecordSide(summary) || summary.side}`;
}

function inferPositionQuantityUnit(symbol: string, fallbackUnit: string) {
  const displaySymbol = displayPositionSymbol(symbol);
  if (displaySymbol.endsWith('USDT') && displaySymbol.length > 4) {
    return displaySymbol.slice(0, -4);
  }
  return fallbackUnit;
}

function hasPositionTpSl(item: ContractPositionItem) {
  return toNumber(item.take_profit_price) > 0 || toNumber(item.stop_loss_price) > 0;
}

function formatOptionalTpSlBadge(value: string | number | null | undefined, precision: number) {
  return toNumber(value) > 0 ? formatDisplayPrice(value, precision) : null;
}

function formatOptionalTpSlInput(value: string | number | null | undefined, precision: number) {
  return toNumber(value) > 0 ? formatRawMarketPrice(value, precision) : '';
}

function isTpSlPriceValidForSide(
  side: ContractPositionSide,
  type: 'TAKE_PROFIT' | 'STOP_LOSS',
  price: number,
  markPrice: number,
) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) return false;
  if (side === 'LONG') {
    return type === 'TAKE_PROFIT' ? price > markPrice : price < markPrice;
  }
  return type === 'TAKE_PROFIT' ? price < markPrice : price > markPrice;
}

function buildTpSlEditorDefaultPrices({
  side,
  markPrice,
  entryPrice,
  takeProfitPrice,
  stopLossPrice,
  pricePrecision,
}: {
  side: ContractPositionSide;
  markPrice: string | number | null;
  entryPrice: string | number | null | undefined;
  takeProfitPrice: string | number | null | undefined;
  stopLossPrice: string | number | null | undefined;
  pricePrecision: number;
}) {
  const referencePrice = toNumber(markPrice) > 0 ? toNumber(markPrice) : toNumber(entryPrice);
  const currentTakeProfit = formatOptionalTpSlInput(takeProfitPrice, pricePrecision);
  const currentStopLoss = formatOptionalTpSlInput(stopLossPrice, pricePrecision);
  const currentTakeProfitNumber = toNumber(currentTakeProfit);
  const currentStopLossNumber = toNumber(currentStopLoss);

  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return {
      takeProfitPrice: currentTakeProfit,
      stopLossPrice: currentStopLoss,
    };
  }

  const defaultTakeProfit = side === 'LONG'
    ? referencePrice * (1 + TP_SL_DEFAULT_OFFSET_RATE)
    : referencePrice * (1 - TP_SL_DEFAULT_OFFSET_RATE);
  const defaultStopLoss = side === 'LONG'
    ? referencePrice * (1 - TP_SL_DEFAULT_OFFSET_RATE)
    : referencePrice * (1 + TP_SL_DEFAULT_OFFSET_RATE);

  return {
    takeProfitPrice: isTpSlPriceValidForSide(side, 'TAKE_PROFIT', currentTakeProfitNumber, referencePrice)
      ? currentTakeProfit
      : formatRawMarketPrice(defaultTakeProfit, pricePrecision),
    stopLossPrice: isTpSlPriceValidForSide(side, 'STOP_LOSS', currentStopLossNumber, referencePrice)
      ? currentStopLoss
      : formatRawMarketPrice(defaultStopLoss, pricePrecision),
  };
}

function normalizeTpSlInputText(value: string) {
  return value.replace(/,/g, '').trim();
}

function adjustTpSlEditorPrice(value: string, markPrice: string | null, delta: number) {
  const baseValue = getTpSlEditorStepBasePrice(value, markPrice);
  return String(Number((baseValue + delta).toFixed(12)));
}

function getTpSlEditorStepBasePrice(value: string, markPrice: string | null) {
  const normalizedValue = normalizeTpSlInputText(value);
  if (normalizedValue !== '') {
    const currentValue = toNumber(normalizedValue);
    return Number.isFinite(currentValue) ? currentValue : 0;
  }

  const markPriceValue = toNumber(markPrice);
  return Number.isFinite(markPriceValue) ? markPriceValue : 0;
}

function normalizeQuantityInputText(value: string) {
  return value.replace(/,/g, '').trim();
}

function formatRawQuantity(value: string | number | null | undefined) {
  const quantity = toNumber(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return '';
  return String(Number(quantity.toFixed(8)));
}

function TpSlBadge({ type, value }: { type: 'TP' | 'SL'; value: string }) {
  const className = type === 'TP'
    ? 'border-[#00c087]/25 bg-[#00c087]/10 text-[#00c087]'
    : 'border-[#f6465d]/25 bg-[#f6465d]/10 text-[#f6465d]';

  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-4 ${className}`}>
      {type} {value}
    </span>
  );
}

function PositionDetailCard({
  index,
  position,
  markPrice,
  tpSlTriggerPriceTypeHint,
  pricePrecision,
  closing,
  onEditTpSl,
  onClose,
}: {
  index: number;
  position: ContractPositionItem;
  markPrice: string | number | null;
  tpSlTriggerPriceTypeHint: string;
  pricePrecision: number;
  closing: boolean;
  onEditTpSl: (position: ContractPositionItem, markPrice: string | number | null) => void;
  onClose: (position: ContractPositionItem) => void;
}) {
  const { t } = useLocaleContext();
  const detailMarkPrice = toNumber(markPrice) > 0 ? markPrice : position.mark_price;
  const unrealized = calculatePositionUnrealizedPnl(position, markPrice);
  const takeProfitBadge = formatOptionalTpSlBadge(position.take_profit_price, pricePrecision);
  const stopLossBadge = formatOptionalTpSlBadge(position.stop_loss_price, pricePrecision);
  const isOpen = position.status === 'OPEN';

  return (
    <div className="rounded-lg border border-white/[0.08] bg-[#020617]/40 p-3 text-white">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="text-[15px] font-semibold text-white">{formatI18nTemplate(t('positionDetailIndex', 'contracts'), { index: index + 1 })}</div>
          {takeProfitBadge ? <TpSlBadge type="TP" value={takeProfitBadge} /> : null}
          {stopLossBadge ? <TpSlBadge type="SL" value={stopLossBadge} /> : null}
          {takeProfitBadge || stopLossBadge ? (
            <span className="text-[10px] text-white/35">{tpSlTriggerPriceTypeHint}</span>
          ) : null}
        </div>
        {isOpen ? (
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <button
              type="button"
              onClick={() => onEditTpSl(position, detailMarkPrice)}
              className="h-8 rounded-md border border-white/10 px-3 text-[12px] font-semibold text-white/72 transition-colors hover:border-white/25 hover:text-white"
            >
              {t('editTpSl', 'contracts')}
            </button>
            <button
              type="button"
              disabled={closing}
              onClick={() => onClose(position)}
              className="h-8 rounded-md bg-white px-3 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {closing ? t('closingPosition', 'contracts') : t('marketClose', 'contracts')}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-3 xl:grid-cols-7">
        <DetailMetric label={t('quantity', 'contracts')} value={formatNumber(position.quantity, 6)} />
        <DetailMetric label={t('entryPrice', 'contracts')} value={formatDisplayPrice(position.entry_price, pricePrecision)} />
        <DetailMetric label={t('margin', 'contracts')} value={`${formatNumber(position.margin_amount, 4)} USDT`} />
        <DetailMetric label={t('openedAt', 'contracts')} value={formatHistoryTime(position.opened_at)} />
        <DetailMetric label={t('takeProfit', 'contracts')} value={takeProfitBadge ?? '--'} />
        <DetailMetric label={t('stopLoss', 'contracts')} value={stopLossBadge ?? '--'} />
        <DetailMetric
          label={t('unrealizedPnl', 'contracts')}
          value={`${formatSignedPnl(unrealized, 4)} USDT`}
          valueClassName={unrealized > 0 ? 'text-[#00c087]' : unrealized < 0 ? 'text-[#f6465d]' : 'text-white/80'}
        />
      </div>
    </div>
  );
}

function DetailMetric({
  label,
  value,
  valueClassName = 'text-white/86',
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-white/38">{label}</div>
      <div className={`whitespace-nowrap font-mono text-[12px] tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}

function ClosePositionDialog({
  position,
  quantity,
  error,
  pricePrecision,
  saving,
  suppressChecked,
  onSuppressChange,
  onQuantityChange,
  onClose,
  onConfirm,
}: {
  position: ContractPositionItem;
  quantity: string;
  error: string;
  pricePrecision: number;
  saving: boolean;
  suppressChecked: boolean;
  onSuppressChange: (checked: boolean) => void;
  onQuantityChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocaleContext();
  const maxQuantity = getPositionAmount(position);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center">
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-[#111820] p-4 text-white shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold">{t('marketClose', 'contracts')}</div>
            <div className="mt-0.5 text-[11px] text-white/45">
              {displayPositionSymbol(position.symbol)} / {sideLabel(position.side, t)} / {t('entryPrice', 'contracts')} {formatDisplayPrice(position.entry_price, pricePrecision)} USDT
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-md border border-white/10 text-[16px] text-white/60 hover:text-white"
            aria-label={t('close', 'contracts')}
          >
            ×
          </button>
        </div>

        <label className="mt-4 block text-[12px] text-white/55">
          {t('closeQuantityLots', 'contracts')}
          <input
            value={quantity}
            onChange={(event) => onQuantityChange(event.target.value)}
            inputMode="decimal"
            placeholder={formatRawQuantity(maxQuantity)}
            className="mt-1 h-9 w-full rounded-md border border-white/10 bg-black/20 px-3 font-mono text-[13px] text-white outline-none focus:border-white/35"
          />
        </label>
        <div className="mt-1 text-[11px] text-white/38">
          {formatI18nTemplate(t('maxClosableQuantity', 'contracts'), { quantity: formatNumber(maxQuantity, 6) })}
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-[#f6465d]/25 bg-[#f6465d]/10 px-3 py-2 text-[12px] text-[#f6465d]">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="mr-auto flex cursor-pointer select-none items-center gap-2 text-[12px] text-white/55">
            <input
              type="checkbox"
              checked={suppressChecked}
              onChange={(event) => onSuppressChange(event.target.checked)}
              disabled={saving}
              className="h-3.5 w-3.5 accent-[#f0b90b]"
            />
            {t('doNotShowAgain', 'contracts')}
          </label>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-white/10 px-3 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            {t('cancel', 'contracts')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onConfirm}
            className="h-9 rounded-md bg-white px-4 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? t('closingPosition', 'contracts') : t('confirmClosePosition', 'contracts')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TpSlEditorDialog({
  draft,
  error,
  pricePrecision,
  tpSlTriggerPriceTypeHint,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  draft: TpSlDraft;
  error: string | null;
  pricePrecision: number;
  tpSlTriggerPriceTypeHint: string;
  saving: boolean;
  onChange: React.Dispatch<React.SetStateAction<TpSlDraft | null>>;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useLocaleContext();
  const referencePrice = toNumber(draft.referencePrice);
  const isSummaryTarget = draft.target.mode === 'summary';
  const stepTpSlPrice = (field: 'takeProfitPrice' | 'stopLossPrice', delta: number) => {
    onChange((current) => current ? {
      ...current,
      [field]: adjustTpSlEditorPrice(current[field], current.referencePrice, delta),
    } : current);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center">
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-[#111820] p-4 text-white shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold">{isSummaryTarget ? t('setUnifiedTpSl', 'contracts') : t('editTpSlSlash', 'contracts')}</div>
            <div className="mt-0.5 text-[11px] text-white/45">
              {displayPositionSymbol(draft.position.symbol)} / {sideLabel(draft.position.side, t)} / {draft.referencePriceLabel}{' '}
              {referencePrice > 0 ? `${formatDisplayPrice(referencePrice, pricePrecision)} USDT` : '--'}
              {isSummaryTarget ? ` / ${formatI18nTemplate(t('positionsCount', 'contracts'), { count: draft.positions.length })}` : ''}
            </div>
            <div className="mt-0.5 text-[10px] text-white/35">{tpSlTriggerPriceTypeHint}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-md border border-white/10 text-[16px] text-white/60 hover:text-white"
            aria-label={t('close', 'contracts')}
          >
            ×
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <TpSlEditorPriceInput
            label={t('takeProfitPrice', 'contracts')}
            value={draft.takeProfitPrice}
            onChange={(value) => onChange((current) => current ? { ...current, takeProfitPrice: value } : current)}
            onStep={(delta) => stepTpSlPrice('takeProfitPrice', delta)}
          />
          <TpSlEditorPriceInput
            label={t('stopLossPrice', 'contracts')}
            value={draft.stopLossPrice}
            onChange={(value) => onChange((current) => current ? { ...current, stopLossPrice: value } : current)}
            onStep={(delta) => stepTpSlPrice('stopLossPrice', delta)}
          />
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-[#f6465d]/25 bg-[#f6465d]/10 px-3 py-2 text-[12px] text-[#f6465d]">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-white/10 px-3 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            {t('cancel', 'contracts')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className="h-9 rounded-md bg-white px-4 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? t('saving', 'contracts') : t('save', 'contracts')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TpSlEditorPriceInput({
  label,
  value,
  onChange,
  onStep,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onStep: (delta: number) => void;
}) {
  const { t } = useLocaleContext();
  const stepButtonClassName = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/[0.08] text-[14px] text-white/50 transition-colors hover:border-white/[0.18] hover:text-white';

  return (
    <label className="block text-[12px] text-white/55">
      {label}
      <div className="mt-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onStep(-TP_SL_EDITOR_STEP)}
          className={stepButtonClassName}
          title={t('decreaseOne', 'contracts')}
        >
          -
        </button>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          placeholder={t('tpSlEmptyPlaceholder', 'contracts')}
          className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 font-mono text-[13px] text-white outline-none focus:border-white/35"
        />
        <button
          type="button"
          onClick={() => onStep(TP_SL_EDITOR_STEP)}
          className={stepButtonClassName}
          title={t('increaseOne', 'contracts')}
        >
          +
        </button>
      </div>
    </label>
  );
}

function PositionMetric({
  label,
  labelTitle,
  value,
  valueClassName = 'text-white/86',
}: {
  label: string;
  labelTitle?: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-white/[0.025] px-2 py-2">
      <div className="truncate text-[11px] text-white/38" title={labelTitle}>{label}</div>
      <div className={`mt-1 truncate font-mono text-[12px] tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}

type LiquidationRisk = {
  labelKey: string;
  percent: number;
  tone: 'low' | 'medium' | 'high' | 'extreme';
};

function RiskBar({
 risk }: { risk: LiquidationRisk | null }) {
  const { t } = useLocaleContext();
  const barClassName = risk ? riskBarClassName(risk.tone) : 'bg-white/12';
  const labelClassName = risk ? riskTextClassName(risk.tone) : 'text-white/45';

  return (
    <div className="mt-3 rounded-md bg-white/[0.025] px-2 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="text-white/38">{t('liquidationRisk', 'contracts')}</span>
        <span className={`font-medium ${labelClassName}`}>{risk ? t(risk.labelKey, 'contracts') : '--'}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={`h-full rounded-full transition-[width] ${barClassName}`}
          style={{ width: `${risk ? risk.percent : 0}%` }}
        />
      </div>
    </div>
  );
}

function riskBarClassName(tone: LiquidationRisk['tone']) {
  if (tone === 'extreme' || tone === 'high') return 'bg-[#f6465d]';
  if (tone === 'medium') return 'bg-[#f0b90b]';
  return 'bg-[#00c087]';
}

function riskTextClassName(tone: LiquidationRisk['tone']) {
  if (tone === 'extreme' || tone === 'high') return 'text-[#f6465d]';
  if (tone === 'medium') return 'text-[#f0b90b]';
  return 'text-[#00c087]';
}

function TradesTable({
 rows, pricePrecision, loading }: { rows: ContractTradeListItem[]; pricePrecision: number; loading: boolean }) {
  const { t } = useLocaleContext();
  if (rows.length === 0 && loading) {
    return (
      <EmptyState
        title={t('tradesLoading', 'contracts')}
        description={t('tradesLoadingDesc', 'contracts')}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title={loading ? t('tradesRefreshing', 'contracts') : t('emptyTrades', 'contracts')}
        description={t('emptyTradesDesc', 'contracts')}
      />
    );
  }

  return (
    <div className="space-y-2 p-3">
      {rows.map((item) => {
        const action = formatContractOrderAction(item, t);
        const actionTone = contractOrderActionTone(item);
        const realizedPnl = toNumber(item.realized_pnl);

        return (
          <div
            key={item.id}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-semibold text-white">{displayPositionSymbol(item.symbol)}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${actionTone === 'green' ? 'bg-[#00c087]/12 text-[#00c087]' : 'bg-[#f6465d]/12 text-[#f6465d]'}`}>
                  {action}
                </span>
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-white/65">{item.leverage}x</span>
              </div>
              <span className="text-[11px] text-white/38">{formatTime(item.created_at)}</span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <PositionMetric label={t('tradePrice', 'contracts')} value={`${formatDisplayPrice(item.price, pricePrecision)} USDT`} />
              <PositionMetric label={t('tradeQuantity', 'contracts')} value={formatNumber(item.quantity, 6)} />
              <PositionMetric label={t('notionalValue', 'contracts')} value={`${formatNumber(item.notional, 2)} USDT`} />
              <PositionMetric label={t('margin', 'contracts')} value={`${formatNumber(item.margin_amount, 2)} USDT`} />
              <PositionMetric
                label={t('realizedPnl', 'contracts')}
                value={`${formatSignedPnl(item.realized_pnl, 6)} USDT`}
                valueClassName={realizedPnl > 0 ? 'text-[#00c087]' : realizedPnl < 0 ? 'text-[#f6465d]' : 'text-white/55'}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function sideLabel(value: string, t?: ContractTranslator) {
  const side = normalizePositionSide(value);
  if (side === 'LONG') return t ? t('positionSideLong', 'contracts') : '多头';
  if (side === 'SHORT') return t ? t('positionSideShort', 'contracts') : '空头';
  return value || '--';
}

function getPositionAmount(item: ContractPositionItem) {
  const record = item as ContractPositionItem & {
    amount?: string | number | null;
    size?: string | number | null;
  };
  return toNumber(record.quantity ?? record.amount ?? record.size);
}

function calcContractLiquidationPrice(item: ContractPositionItem) {
  const entryPrice = toNumber(item.entry_price);
  const margin = toNumber(item.margin_amount);
  const quantity = Math.abs(getPositionAmount(item));

  if (!Number.isFinite(entryPrice) || !Number.isFinite(margin) || !Number.isFinite(quantity)) return null;
  if (entryPrice <= 0 || margin <= 0 || quantity <= 0) return null;

  const distance = margin / quantity;
  const liquidationPrice = item.side === 'LONG'
    ? entryPrice - distance
    : item.side === 'SHORT'
      ? entryPrice + distance
      : NaN;

  if (!Number.isFinite(liquidationPrice) || liquidationPrice <= 0) return null;
  return liquidationPrice;
}

function isNearLiquidation(side: string, markPrice: number, liquidationPrice: number | null) {
  if (!liquidationPrice || !Number.isFinite(markPrice) || markPrice <= 0) return false;
  if (side === 'LONG') return markPrice <= liquidationPrice * 1.02;
  if (side === 'SHORT') return markPrice >= liquidationPrice * 0.98;
  return false;
}

function calcUnrealizedPnlPercent(unrealizedPnl: number | null, marginAmount: string | number | null | undefined) {
  const margin = toNumber(marginAmount);
  if (unrealizedPnl === null || !Number.isFinite(unrealizedPnl) || !Number.isFinite(margin) || margin <= 0) {
    return null;
  }
  return (unrealizedPnl / margin) * 100;
}

function formatPnlPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--';
  if (Math.abs(value) < 0.005) return '0.00%';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function getLiquidationRisk(side: string, markPrice: number, liquidationPrice: number | null): LiquidationRisk | null {
  if (!liquidationPrice || !Number.isFinite(markPrice) || markPrice <= 0) return null;

  const distanceRatio = side === 'LONG'
    ? (markPrice - liquidationPrice) / liquidationPrice
    : side === 'SHORT'
      ? (liquidationPrice - markPrice) / liquidationPrice
      : NaN;

  if (!Number.isFinite(distanceRatio)) return null;

  const percent = clamp(100 - distanceRatio * 1000, 0, 100);
  if (distanceRatio <= 0) return { labelKey: 'riskExtreme', percent, tone: 'extreme' };
  if (distanceRatio <= 0.02) return { labelKey: 'riskHigh', percent, tone: 'high' };
  if (distanceRatio <= 0.05) return { labelKey: 'riskMedium', percent, tone: 'medium' };
  return { labelKey: 'riskLow', percent, tone: 'low' };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatDisplayPrice(value: string | number | null | undefined, precision: number) {
  return formatMarketPrice(value, precision);
}

function formatSignedPnl(value?: string | number | null, digits = 4) {
  const num = toNumber(value);
  if (Math.abs(num) < 1 / (10 ** digits)) return '0';
  const formatted = formatNumber(num, digits);
  return num > 0 ? `+${formatted}` : formatted;
}

function calculateUnrealizedPnl(item: ContractPositionItem, markPrice: number) {
  const quantity = getPositionAmount(item);
  const entryPrice = toNumber(item.entry_price);
  if (!quantity || !entryPrice || !markPrice) return 0;
  return item.side === 'LONG'
    ? (markPrice - entryPrice) * quantity
    : (entryPrice - markPrice) * quantity;
}

function calculatePositionUnrealizedPnl(position: ContractPositionItem, markPrice: string | number | null) {
  const detailMarkPrice = toNumber(markPrice) > 0 ? markPrice : position.mark_price;
  const markNumber = toNumber(detailMarkPrice);
  return markNumber > 0 ? calculateUnrealizedPnl(position, markNumber) : toNumber(position.unrealized_pnl);
}

function statusLabel(value: string, closeReason?: string | null, t?: ContractTranslator) {
  if (closeReason === 'TAKE_PROFIT') return t ? t('statusTakeProfitClosed', 'contracts') : '止盈平仓';
  if (closeReason === 'STOP_LOSS') return t ? t('statusStopLossClosed', 'contracts') : '止损平仓';
  if (value === 'OPEN') return t ? t('statusOpen', 'contracts') : '持仓中';
  if (value === 'CLOSED') return t ? t('statusClosed', 'contracts') : '已平仓';
  if (value === 'LIQUIDATED') return t ? t('statusLiquidated', 'contracts') : '已强平';
  if (value === 'FILLED') return t ? t('statusFilled', 'contracts') : '已成交';
  if (value === 'NEW') return t ? t('statusNew', 'contracts') : '新委托';
  if (value === 'CANCELED') return t ? t('statusCanceled', 'contracts') : '已取消';
  if (value === 'FAILED') return t ? t('statusFailed', 'contracts') : '失败';
  return value || '--';
}

function StatusBadge({ status, closeReason, compact = false }: { status: string; closeReason?: string | null; compact?: boolean }) {
  const { t } = useLocaleContext();
  const className =
    status === 'OPEN'
      ? 'border-[#177ddc]/30 bg-[#177ddc]/12 text-[#69c0ff]'
      : status === 'LIQUIDATED'
        ? 'border-[#f6465d]/30 bg-[#f6465d]/12 text-[#f6465d]'
        : status === 'CLOSED' || status === 'CANCELED'
          ? 'border-white/10 bg-white/[0.04] text-white/55'
          : status === 'FILLED'
            ? 'border-[#00c087]/30 bg-[#00c087]/12 text-[#00c087]'
            : 'border-white/10 bg-white/[0.04] text-white/65';

  return (
    <span className={`inline-flex rounded ${compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]'} font-medium ${className}`}>
      {statusLabel(status, closeReason, t)}
    </span>
  );
}

function OrderFeedbackBox({ feedback }: { feedback: OrderFeedback }) {
  const className = feedback.type === 'success'
    ? 'border-[#00c087]/25 bg-[#00c087]/10 text-[#00c087]'
    : 'border-[#f6465d]/25 bg-[#f6465d]/10 text-[#f6465d]';

  return (
    <div className={`mb-1 rounded-md border px-2 py-1 text-[12px] leading-5 ${className}`}>
      {feedback.message}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-white/10 px-2 py-8 text-center">
      <div className="text-[13px] text-white/38">{title}</div>
      <div className="mt-1 text-[12px] text-white/24">{description}</div>
    </div>
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function Td({
  children,
  color,
  className = '',
}: {
  children: React.ReactNode;
  color?: 'green' | 'red';
  className?: string;
}) {
  const colorClass = color === 'green' ? 'text-[#00c087]' : color === 'red' ? 'text-[#f6465d]' : 'text-white/84';
  return <td className={`whitespace-nowrap px-3 py-2.5 font-mono tabular-nums ${colorClass} ${className}`}>{children}</td>;
}
