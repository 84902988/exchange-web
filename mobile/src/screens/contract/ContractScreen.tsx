import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Pressable,
  type ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  type CompositeNavigationProp,
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import ContractBottomTabs, {
  type ContractRecordTab,
} from '../../components/contract/ContractBottomTabs';
import ContractMoreSheet, {
  type ContractMoreAction,
} from '../../components/contract/ContractMoreSheet';
import ContractMarketSelectorSheet from '../../components/contract/ContractMarketSelectorSheet';
import ContractPositionTpSlSheet from '../../components/contract/ContractPositionTpSlSheet';
import {
  applyLiveContractPositionValuations,
  buildContractPositionPriceLines,
  resolveLiveContractPositionPrice,
} from '../../components/contract/contractPositionPresentation';
import ContractOrderBook from '../../components/contract/ContractOrderBook';
import ContractCloseAllConfirmModal from '../../components/contract/ContractCloseAllConfirmModal';
import ContractOrderConfirmModal from '../../components/contract/ContractOrderConfirmModal';
import ContractOrderForm, {
  type ContractActionMode,
  type ContractDirection,
} from '../../components/contract/ContractOrderForm';
import ContractSymbolHeader from '../../components/contract/ContractSymbolHeader';
import ContractTopTabs, {
  type ContractBusinessTab,
} from '../../components/contract/ContractTopTabs';
import MobileKlineChart from '../../components/trade/MobileKlineChart';
import type { KlineInterval } from '../../components/trade/kline.utils';
import { normalizeContractTradingRouteParams } from '../../navigation/tradingRoute';
import type {
  MainTabParamList,
  RootStackParamList,
} from '../../navigation/types';
import {
  canCancelContractOrder,
  cancelContractOrder,
  closeContractSummaryOrder,
  fetchContractAccountSummary,
  fetchContractOrdersPage,
  fetchContractPositions,
  fetchContractSymbolRules,
  fetchContractTradesPage,
  isContractExecutionReady,
  openContractOrder,
  updateContractPositionTpSl,
  type ContractAccountSummary,
  type ContractMarketTrade,
  type ContractOrderBookLevel,
  type ContractOrderItem,
  type ContractPage,
  type ContractOrderType,
  type ContractPositionItem,
  type ContractQuote,
  type ContractSymbolRules,
  type ContractTradeItem,
} from '../../api/contract';
import type { ContractCatalogInstrument } from '../../api/tradingCatalog';
import { useContractKlineRealtime } from '../../hooks/useContractKlineRealtime';
import { useContractMarketRealtime } from '../../hooks/useContractMarketRealtime';
import { useDeferredScreenContent } from '../../hooks/useDeferredScreenContent';
import { useMarketScreenActive } from '../../hooks/useMarketScreenActive';
import { usePrivateTradingRealtime } from '../../hooks/usePrivateTradingRealtime';
import { isContractExecutionLeaseActive } from '../../realtime/contractExecutionLease';
import { getContractMarketRealtimeStore } from '../../realtime/contractMarketRealtime';
import { useAuth } from '../../store/authStore';
import { useLanguage } from '../../i18n';
import {
  findAuthoritativeContractOrdersForIntent,
  type ContractOrderIntentPayload,
  type PendingContractOrderIntent,
} from '../../services/contractOrderIntent';
import {
  clearPendingTradeIntent,
  createPendingTradeIntent,
  isPendingTradeIntentLoadError,
  isPotentiallyCommittedMutationError,
  loadPendingTradeIntent,
  recoverCorruptPendingTradeIntent,
  savePendingTradeIntent,
  type PendingTradeIntentLoadError,
} from '../../services/pendingTradeIntent';
import {
  loadContractCloseAllConfirmHidden,
  loadContractTradeConfirmHidden,
  saveContractCloseAllConfirmHidden,
  saveContractTradeConfirmHidden,
} from '../../services/contractTradeConfirmPreference';
import { colors, typography } from '../../theme';
import {
  MOBILE_FORM_PANEL_FLEX,
  MOBILE_ORDER_BOOK_PANEL_FLEX,
  MOBILE_TRADING_PANEL_GAP,
  MOBILE_TRADING_PANEL_HEIGHT,
} from '../../constants/tradingLayout';
import { resolveResponsiveLayout } from '../../constants/responsiveLayout';
import {
  formatOrderDecimal,
  getTradingErrorMessage,
  parsePositiveDecimal,
} from '../../utils/tradeOrder';

type RootNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Contract'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const KLINE_INTERVAL_SWITCH_DEBOUNCE_MS = 180;
const CONTRACT_MIN_LEVERAGE = 1;
const CONTRACT_PRIVATE_DATA_TTL_MS = 30_000;
const CONTRACT_PRIVATE_REFRESH_LEAD_MS = 10_000;
const CONTRACT_PENDING_INTENT_RECHECK_MS = 10_000;
const CONTRACT_PRIVATE_RETRY_MS = 5_000;
const PENDING_INTENT_MANUAL_REVIEW_DELAY_MS = 60_000;
const CONTRACT_ORDER_REVIEW_LIMIT = 100;
const CONTRACT_RECORD_PAGE_SIZE = 10;

type ContractPageInfo = Omit<ContractPage<unknown>, 'items'>;

const EMPTY_CONTRACT_PAGE_INFO: ContractPageInfo = {
  total: 0,
  page: 1,
  pageSize: CONTRACT_RECORD_PAGE_SIZE,
  hasMore: false,
  nextPage: null,
};

function appendUniqueContractRecords<T extends { id: string }>(
  current: T[],
  incoming: T[],
) {
  const seen = new Set(current.map(item => item.id));
  return current.concat(incoming.filter(item => !seen.has(item.id)));
}

type PendingReconciliationSnapshot = {
  version: number;
  updatedAtMs: number;
};

function clampContractLeverage(value: number, maxLeverage: number) {
  const safeMax =
    Number.isSafeInteger(maxLeverage) && maxLeverage >= CONTRACT_MIN_LEVERAGE
      ? maxLeverage
      : CONTRACT_MIN_LEVERAGE;
  if (!Number.isFinite(value)) return CONTRACT_MIN_LEVERAGE;
  return Math.min(safeMax, Math.max(CONTRACT_MIN_LEVERAGE, Math.trunc(value)));
}

type ContractExecutionAuthority = {
  ready: boolean;
  bid: number | null;
  ask: number | null;
  expiresAtMs: number | null;
  generation: number;
};

type ContractPrivateAuthority = {
  ready: boolean;
  symbol: string | null;
  expiresAtMs: number | null;
  generation: number;
};

type ContractCloseAllTarget = {
  side: ContractDirection;
  quantity: string;
  positionCount: number;
  positionIds: string[];
};

type ContractPositionCloseRequest = {
  positionId: string;
  symbol: string;
  side: ContractDirection;
  quantity: string;
};

function buildContractCloseAllTargets(
  positions: readonly ContractPositionItem[],
  quantityPrecision: number,
): ContractCloseAllTarget[] {
  return (['LONG', 'SHORT'] as const).flatMap(side => {
    const matched = positions.filter(position => position.side === side);
    const quantity = matched.reduce((total, position) => {
      const value = Number(position.quantity.replace(/,/g, ''));
      return Number.isFinite(value) && value > 0 ? total + value : total;
    }, 0);
    return quantity > 0
      ? [
          {
            side,
            quantity: formatOrderDecimal(quantity, quantityPrecision),
            positionCount: matched.length,
            positionIds: matched.map(position => position.id).sort(),
          },
        ]
      : [];
  });
}

function unavailableExecutionAuthority(): ContractExecutionAuthority {
  return {
    ready: false,
    bid: null,
    ask: null,
    expiresAtMs: null,
    generation: -1,
  };
}

function unavailablePrivateAuthority(
  generation = -1,
): ContractPrivateAuthority {
  return {
    ready: false,
    symbol: null,
    expiresAtMs: null,
    generation,
  };
}

export default function ContractScreen() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<RouteProp<MainTabParamList, 'Contract'>>();
  const { t } = useLanguage();
  const {
    fontScale,
    height: windowHeight,
    width: windowWidth,
  } = useWindowDimensions();
  const responsiveLayout = resolveResponsiveLayout(
    windowWidth,
    windowHeight,
    fontScale,
    'wide',
  );
  const tRef = useRef(t);
  tRef.current = t;
  const businessTabs = useMemo<ContractBusinessTab[]>(
    () => [{ key: 'contract', label: t('trading.contract') }],
    [t],
  );
  const instrument = useMemo(
    () => normalizeContractTradingRouteParams(route.params),
    [route.params],
  );
  const {
    baseAsset,
    displayLabel,
    logoUrl,
    marketCategory,
    quoteAsset,
    symbol,
  } = instrument;
  const localizedDisplayLabel = useMemo(
    () =>
      symbol.endsWith('_PERP')
        ? `${baseAsset}/${quoteAsset} ${t('trading.perpetual')}`
        : displayLabel,
    [baseAsset, displayLabel, quoteAsset, symbol, t],
  );
  const instrumentKey = `${symbol}|${baseAsset}|${quoteAsset}|${displayLabel}|${marketCategory}`;
  const { isLoggedIn, user } = useAuth();
  const orderIntentOwnerKey =
    isLoggedIn && user?.id !== undefined && user?.id !== null
      ? String(user.id)
      : null;
  const orderIntentScope = `${orderIntentOwnerKey || 'anonymous'}|${symbol}`;
  const marketScreenActive = useMarketScreenActive();
  const deferredScreenContentReady =
    useDeferredScreenContent(marketScreenActive);
  const [klineInterval, setKlineInterval] = useState<KlineInterval>('1m');
  const contractKline = useContractKlineRealtime(
    symbol,
    klineInterval,
    'contract-screen-kline',
    marketScreenActive,
  );
  const contractMarket = useContractMarketRealtime(
    symbol,
    'contract-screen',
    marketScreenActive,
  );
  const [activeBusiness, setActiveBusiness] = useState('contract');
  const [actionMode, setActionMode] = useState<ContractActionMode>('OPEN');
  const [direction, setDirection] = useState<ContractDirection>('LONG');
  const [orderType, setOrderType] = useState<ContractOrderType>('LIMIT');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [positionCloseRequest, setPositionCloseRequest] =
    useState<ContractPositionCloseRequest | null>(null);
  const [leverage, setLeverage] = useState(CONTRACT_MIN_LEVERAGE);
  const [symbolRules, setSymbolRules] = useState<ContractSymbolRules | null>(
    null,
  );
  const [account, setAccount] = useState<ContractAccountSummary | null>(null);
  const [positions, setPositions] = useState<ContractPositionItem[]>([]);
  const [currentOrders, setCurrentOrders] = useState<ContractOrderItem[]>([]);
  const [historyOrders, setHistoryOrders] = useState<ContractOrderItem[]>([]);
  const [myTrades, setMyTrades] = useState<ContractTradeItem[]>([]);
  const [currentOrdersPage, setCurrentOrdersPage] = useState<ContractPageInfo>(
    EMPTY_CONTRACT_PAGE_INFO,
  );
  const [historyOrdersPage, setHistoryOrdersPage] = useState<ContractPageInfo>(
    EMPTY_CONTRACT_PAGE_INFO,
  );
  const [myTradesPage, setMyTradesPage] = useState<ContractPageInfo>(
    EMPTY_CONTRACT_PAGE_INFO,
  );
  const [loadingMoreRecordTab, setLoadingMoreRecordTab] =
    useState<ContractRecordTab | null>(null);
  const [recordLoadMoreError, setRecordLoadMoreError] = useState<string | null>(
    null,
  );
  const [recordTab, setRecordTab] = useState<ContractRecordTab>('positions');
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [privateCriticalError, setPrivateCriticalError] = useState<
    string | null
  >(null);
  const [privateHistoryError, setPrivateHistoryError] = useState<string | null>(
    null,
  );
  const [privateFillsError, setPrivateFillsError] = useState<string | null>(
    null,
  );
  const [privateHistoryReady, setPrivateHistoryReady] = useState(false);
  const [privateHistoryUpdatedAtMs, setPrivateHistoryUpdatedAtMs] = useState<
    number | null
  >(null);
  const [privateCriticalUpdatedAtMs, setPrivateCriticalUpdatedAtMs] = useState<
    number | null
  >(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [marketSelectorOpen, setMarketSelectorOpen] = useState(false);
  const [tpSlPosition, setTpSlPosition] = useState<ContractPositionItem | null>(
    null,
  );
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [tpSlSaving, setTpSlSaving] = useState(false);
  const [tpSlError, setTpSlError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [waitingForExecutionLease, setWaitingForExecutionLease] =
    useState(false);
  const [orderConfirmVisible, setOrderConfirmVisible] = useState(false);
  const [contractConfirmHidden, setContractConfirmHidden] = useState(false);
  const [closeAllConfirmVisible, setCloseAllConfirmVisible] = useState(false);
  const [closeAllConfirmHidden, setCloseAllConfirmHidden] = useState(false);
  const [closingAllPositions, setClosingAllPositions] = useState(false);
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null);
  const [orderActionFeedback, setOrderActionFeedback] = useState<{
    tone: 'error' | 'success';
    text: string;
  } | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackTone, setFeedbackTone] = useState<'error' | 'success' | null>(
    null,
  );
  const [pendingOrderIntent, setPendingOrderIntent] =
    useState<PendingContractOrderIntent | null>(null);
  const [reviewingPendingIntent, setReviewingPendingIntent] = useState(false);
  const [orderIntentHydratedScope, setOrderIntentHydratedScope] = useState<
    string | null
  >(null);
  const [orderIntentLoadError, setOrderIntentLoadError] = useState<
    string | null
  >(null);
  const [orderIntentLoadFailure, setOrderIntentLoadFailure] =
    useState<PendingTradeIntentLoadError | null>(null);
  const submittingRef = useRef(false);
  const waitingForExecutionLeaseRef = useRef(false);
  const tpSlSavingRef = useRef(false);
  const positionClosePreparingRef = useRef(false);
  const closingAllPositionsRef = useRef(false);
  const screenScrollRef = useRef<ScrollView>(null);
  const confirmOpenRef = useRef(false);
  const skipNextOrderConfirmRef = useRef<{
    instrumentKey: string;
    orderIntentScope: string;
  } | null>(null);
  const activeOrderConfirmRef = useRef<{
    instrumentKey: string;
    orderIntentScope: string;
  } | null>(null);
  const skipNextCloseAllConfirmRef = useRef<{
    instrumentKey: string;
    orderIntentScope: string;
  } | null>(null);
  const activeCloseAllConfirmRef = useRef<{
    instrumentKey: string;
    orderIntentScope: string;
  } | null>(null);
  const cancelingOrderIdRef = useRef<number | null>(null);
  const cancelConfirmationOrderIdRef = useRef<number | null>(null);
  const screenMountedRef = useRef(true);
  const privateCriticalGenerationRef = useRef(0);
  const privateSecondaryGenerationRef = useRef(0);
  const rulesGenerationRef = useRef(0);
  const executionAuthorityRef = useRef<ContractExecutionAuthority>(
    unavailableExecutionAuthority(),
  );
  const privateAuthorityRef = useRef<ContractPrivateAuthority>(
    unavailablePrivateAuthority(),
  );
  const pendingOrderIntentRef = useRef<PendingContractOrderIntent | null>(null);
  const orderIntentLoadFailureRef = useRef<PendingTradeIntentLoadError | null>(
    null,
  );
  const currentOrdersRef = useRef<ContractOrderItem[]>([]);
  const historyOrdersRef = useRef<ContractOrderItem[]>([]);
  const positionsRef = useRef<ContractPositionItem[]>([]);
  const privateHistoryReadyRef = useRef(false);
  const privateHistoryUpdatedAtMsRef = useRef<number | null>(null);
  const privateDataInFlightRef = useRef<{
    scope: string;
    promise: Promise<void>;
  } | null>(null);
  const pendingReconcileInFlightRef = useRef<{
    scope: string;
    promise: Promise<PendingReconciliationSnapshot | null>;
  } | null>(null);
  const reviewingPendingIntentRef = useRef(false);
  const pendingReconciliationUpdatedAtMsRef = useRef<number | null>(null);
  const pendingReconciliationVersionRef = useRef(0);
  const pendingManualReviewGenerationRef = useRef(0);
  const manualUnlockCommitRef = useRef<{
    scope: string;
    intentId: string;
  } | null>(null);
  const marketScreenActiveRef = useRef(false);
  const executionLifecycleGenerationRef = useRef(0);
  const klineIntervalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingKlineIntervalRef = useRef<KlineInterval | null>(null);
  const activeInstrumentKeyRef = useRef(instrumentKey);
  const activeOrderIntentScopeRef = useRef(orderIntentScope);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadContractTradeConfirmHidden(),
      loadContractCloseAllConfirmHidden(),
    ]).then(([tradeHidden, closeAllHidden]) => {
      if (cancelled) return;
      setContractConfirmHidden(tradeHidden);
      setCloseAllConfirmHidden(closeAllHidden);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    activeInstrumentKeyRef.current = instrumentKey;
    executionLifecycleGenerationRef.current += 1;
    privateCriticalGenerationRef.current += 1;
    privateSecondaryGenerationRef.current += 1;
    rulesGenerationRef.current += 1;
    confirmOpenRef.current = false;
    skipNextOrderConfirmRef.current = null;
    activeOrderConfirmRef.current = null;
    skipNextCloseAllConfirmRef.current = null;
    activeCloseAllConfirmRef.current = null;
    setOrderConfirmVisible(false);
    setCloseAllConfirmVisible(false);
    setPositionCloseRequest(null);
    cancelConfirmationOrderIdRef.current = null;
    executionAuthorityRef.current = unavailableExecutionAuthority();
    privateAuthorityRef.current = unavailablePrivateAuthority(
      privateCriticalGenerationRef.current,
    );
    if (klineIntervalTimerRef.current !== null) {
      clearTimeout(klineIntervalTimerRef.current);
      klineIntervalTimerRef.current = null;
    }
    pendingKlineIntervalRef.current = null;
    setPrice('');
    setQuantity('');
    setLeverage(CONTRACT_MIN_LEVERAGE);
    setSymbolRules(null);
    setAccount(null);
    setPositions([]);
    positionsRef.current = [];
    setCurrentOrders([]);
    setHistoryOrders([]);
    setCurrentOrdersPage(EMPTY_CONTRACT_PAGE_INFO);
    setHistoryOrdersPage(EMPTY_CONTRACT_PAGE_INFO);
    setMyTradesPage(EMPTY_CONTRACT_PAGE_INFO);
    setLoadingMoreRecordTab(null);
    setRecordLoadMoreError(null);
    currentOrdersRef.current = [];
    historyOrdersRef.current = [];
    setMyTrades([]);
    setRulesError(null);
    setPrivateCriticalError(null);
    setPrivateHistoryError(null);
    setPrivateFillsError(null);
    privateHistoryReadyRef.current = false;
    privateHistoryUpdatedAtMsRef.current = null;
    pendingReconciliationUpdatedAtMsRef.current = null;
    pendingReconciliationVersionRef.current += 1;
    pendingManualReviewGenerationRef.current += 1;
    reviewingPendingIntentRef.current = false;
    setPrivateHistoryReady(false);
    setPrivateHistoryUpdatedAtMs(null);
    setReviewingPendingIntent(false);
    setPrivateCriticalUpdatedAtMs(null);
    setOrderActionFeedback(null);
    setCancelingOrderId(null);
    setFeedbackText('');
    setFeedbackTone(null);
    setClosingAllPositions(false);
    pendingOrderIntentRef.current = null;
    setPendingOrderIntent(null);
    setOrderIntentHydratedScope(null);
    setOrderIntentLoadError(null);
    setMoreOpen(false);
    tpSlSavingRef.current = false;
    setTpSlPosition(null);
    setTakeProfitPrice('');
    setStopLossPrice('');
    setTpSlSaving(false);
    setTpSlError(null);
  }, [instrumentKey]);

  useLayoutEffect(() => {
    if (activeOrderIntentScopeRef.current === orderIntentScope) return;
    activeOrderIntentScopeRef.current = orderIntentScope;
    executionLifecycleGenerationRef.current += 1;
    privateCriticalGenerationRef.current += 1;
    privateSecondaryGenerationRef.current += 1;
    confirmOpenRef.current = false;
    skipNextOrderConfirmRef.current = null;
    activeOrderConfirmRef.current = null;
    skipNextCloseAllConfirmRef.current = null;
    activeCloseAllConfirmRef.current = null;
    setOrderConfirmVisible(false);
    setCloseAllConfirmVisible(false);
    setPositionCloseRequest(null);
    cancelConfirmationOrderIdRef.current = null;
    privateAuthorityRef.current = unavailablePrivateAuthority(
      privateCriticalGenerationRef.current,
    );
    currentOrdersRef.current = [];
    historyOrdersRef.current = [];
    setAccount(null);
    setPositions([]);
    positionsRef.current = [];
    setCurrentOrders([]);
    setHistoryOrders([]);
    setMyTrades([]);
    setPrivateCriticalError(null);
    setPrivateHistoryError(null);
    setPrivateFillsError(null);
    privateHistoryReadyRef.current = false;
    privateHistoryUpdatedAtMsRef.current = null;
    pendingReconciliationUpdatedAtMsRef.current = null;
    pendingReconciliationVersionRef.current += 1;
    pendingManualReviewGenerationRef.current += 1;
    reviewingPendingIntentRef.current = false;
    setPrivateHistoryReady(false);
    setPrivateHistoryUpdatedAtMs(null);
    setReviewingPendingIntent(false);
    setPrivateCriticalUpdatedAtMs(null);
    setClosingAllPositions(false);
    tpSlSavingRef.current = false;
    setTpSlPosition(null);
    setTakeProfitPrice('');
    setStopLossPrice('');
    setTpSlSaving(false);
    setTpSlError(null);
  }, [orderIntentScope]);

  const marketView = contractMarket.marketView;
  const quote: ContractQuote | null = marketView?.quote ?? null;
  const deferredOrderBookView = useDeferredValue(marketView);
  const deferredOrderBookQuote = deferredOrderBookView?.quote ?? null;
  const asks: ContractOrderBookLevel[] = useMemo(
    () => deferredOrderBookView?.depth.asks ?? [],
    [deferredOrderBookView?.depth.asks],
  );
  const bids: ContractOrderBookLevel[] = useMemo(
    () => deferredOrderBookView?.depth.bids ?? [],
    [deferredOrderBookView?.depth.bids],
  );
  const trades: ContractMarketTrade[] = useMemo(
    () => deferredOrderBookView?.trades.slice(0, 20) ?? [],
    [deferredOrderBookView?.trades],
  );
  const klineStatusNote = contractKline.gapDetected
    ? t('contract.klineBackfill')
    : (contractKline.phase === 'connecting' ||
        contractKline.phase === 'reconnecting') &&
      contractKline.items.length > 0
    ? t('contract.realtimeReconnect')
    : contractKline.mode === 'REST_ONLY'
    ? t('contract.dailyRestFallback')
    : contractKline.subscriptionReady &&
      !contractKline.domainReady &&
      contractKline.items.length > 0
    ? t('contract.restFallback')
    : null;

  const pricePrecision =
    quote?.pricePrecision ?? symbolRules?.pricePrecision ?? 2;
  const quantityPrecision = symbolRules?.quantityPrecision ?? 6;
  const lastPrice = quote?.lastPrice ?? null;
  const markPrice = quote?.markPrice ?? quote?.lastPrice ?? null;
  const tpSlTriggerPriceType =
    symbolRules?.tpSlTriggerPriceType ?? 'MARK_PRICE';
  const tpSlReferencePrice =
    tpSlTriggerPriceType === 'LAST_PRICE'
      ? lastPrice ?? markPrice
      : markPrice;
  const orderBookLastPrice = deferredOrderBookQuote?.lastPrice ?? null;
  const orderBookMarkPrice =
    deferredOrderBookQuote?.markPrice ??
    deferredOrderBookQuote?.lastPrice ??
    null;
  const availableMargin = account?.availableMargin ?? null;
  const equity = account?.equity ?? null;
  const privateCriticalReady =
    isLoggedIn &&
    privateCriticalError === null &&
    privateCriticalUpdatedAtMs !== null &&
    privateCriticalUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS > Date.now();
  const privateSubmissionReady =
    privateCriticalReady &&
    privateHistoryReady &&
    privateHistoryError === null &&
    privateHistoryUpdatedAtMs !== null &&
    privateHistoryUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS > Date.now();
  const orderIntentReady = orderIntentHydratedScope === orderIntentScope;
  const orderIntentGuardMessage = !isLoggedIn
    ? null
    : !orderIntentReady
    ? t('contract.checkingPreviousOrder')
    : orderIntentLoadError
    ? orderIntentLoadError
    : pendingOrderIntent
    ? t('contract.pendingOrderProtection')
    : null;
  const guardErrorMessage = !isLoggedIn
    ? null
    : orderIntentLoadError
    ? orderIntentLoadError
    : pendingOrderIntent
    ? t('contract.pendingOrderProtection')
    : privateCriticalError
    ? t('contract.accountPositionsUnavailable')
    : privateHistoryError
    ? t('contract.orderHistoryUnavailable')
    : null;
  const leaseActive =
    marketScreenActive && isContractExecutionLeaseActive(contractMarket.lease);
  const quoteExecutionReady = isContractExecutionReady(quote, symbol);
  const executionReady = leaseActive && quoteExecutionReady;
  const marketStatusCode = quote?.marketStatus?.trim().toUpperCase() || '';
  const marketStatus =
    marketStatusCode === 'CLOSED'
      ? t('contract.marketClosed')
      : quoteExecutionReady
      ? marketStatusCode === 'OPEN'
        ? t('contract.tradable')
        : quote?.marketStatus || t('contract.tradable')
      : quote
      ? t('contract.displayOnly')
      : t('trading.contractMarket');
  const marketError = contractMarket.error;
  const executionAsk = executionReady
    ? contractMarket.lease?.executionAsk ?? null
    : null;
  const executionBid = executionReady
    ? contractMarket.lease?.executionBid ?? null
    : null;
  const useAsk =
    (actionMode === 'OPEN' && direction === 'LONG') ||
    (actionMode === 'CLOSE' && direction === 'SHORT');
  const executionReferencePrice = useAsk ? executionAsk : executionBid;
  const positionValuationPrice = useMemo(
    () =>
      resolveLiveContractPositionPrice({
        currentSymbol: symbol,
        marketSymbol: quote?.symbol,
        liveBestBid: executionBid,
        liveBestAsk: executionAsk,
        liveMarketUsable: executionReady,
      }),
    [executionAsk, executionBid, executionReady, quote?.symbol, symbol],
  );
  const displayPositions = useMemo(
    () =>
      applyLiveContractPositionValuations(
        positions,
        symbol,
        positionValuationPrice,
      ),
    [positionValuationPrice, positions, symbol],
  );
  const positionPriceLines = useMemo(
    () =>
      buildContractPositionPriceLines(positions, symbol, {
        entry: t('trading.position.entryPrice'),
        takeProfit: t('contract.takeProfit'),
        stopLoss: t('contract.stopLoss'),
      }),
    [positions, symbol, t],
  );
  const displayedTpSlPosition = useMemo(
    () =>
      tpSlPosition
        ? displayPositions.find(position => position.id === tpSlPosition.id) ??
          tpSlPosition
        : null,
    [displayPositions, tpSlPosition],
  );
  const orderSizingRef = useRef({
    actionMode,
    availableMargin,
    direction,
    executionReferencePrice,
    leverage,
    orderType,
    positions,
    price,
    pricePrecision,
    quantityPrecision,
  });
  orderSizingRef.current = {
    actionMode,
    availableMargin,
    direction,
    executionReferencePrice,
    leverage,
    orderType,
    positions,
    price,
    pricePrecision,
    quantityPrecision,
  };

  useLayoutEffect(() => {
    marketScreenActiveRef.current = marketScreenActive;
    if (!marketScreenActive) {
      executionAuthorityRef.current = unavailableExecutionAuthority();
    }
    return () => {
      marketScreenActiveRef.current = false;
      executionLifecycleGenerationRef.current += 1;
      executionAuthorityRef.current = unavailableExecutionAuthority();
      confirmOpenRef.current = false;
      skipNextOrderConfirmRef.current = null;
      activeOrderConfirmRef.current = null;
      skipNextCloseAllConfirmRef.current = null;
      activeCloseAllConfirmRef.current = null;
      setOrderConfirmVisible(false);
      setCloseAllConfirmVisible(false);
      setPositionCloseRequest(null);
      cancelConfirmationOrderIdRef.current = null;
    };
  }, [instrumentKey, marketScreenActive]);

  useLayoutEffect(() => {
    executionAuthorityRef.current = marketScreenActive
      ? {
          ready: executionReady,
          bid: executionBid,
          ask: executionAsk,
          expiresAtMs: contractMarket.lease?.expiresAtMs ?? null,
          generation: contractMarket.executionGeneration,
        }
      : unavailableExecutionAuthority();
  }, [
    contractMarket.lease?.expiresAtMs,
    contractMarket.executionGeneration,
    executionAsk,
    executionBid,
    executionReady,
    instrumentKey,
    marketScreenActive,
  ]);

  const loadSymbolRules = useCallback(async () => {
    const generation = ++rulesGenerationRef.current;
    setRulesLoading(true);
    try {
      const nextRules = await fetchContractSymbolRules(symbol);
      if (generation !== rulesGenerationRef.current) return;
      if (!nextRules) {
        throw new Error(tRef.current('contract.rulesNotFound'));
      }
      if (
        nextRules.baseAsset !== baseAsset ||
        nextRules.quoteAsset !== quoteAsset
      ) {
        throw new Error(tRef.current('contract.rulesMismatch'));
      }
      setSymbolRules(nextRules);
      setLeverage(currentLeverage =>
        clampContractLeverage(currentLeverage, nextRules.maxLeverage),
      );
      setRulesError(null);
    } catch (error) {
      if (generation !== rulesGenerationRef.current) return;
      setSymbolRules(null);
      setLeverage(CONTRACT_MIN_LEVERAGE);
      setRulesError(
        error instanceof Error
          ? error.message
          : tRef.current('contract.rulesLoadFailed'),
      );
    } finally {
      if (generation === rulesGenerationRef.current) {
        setRulesLoading(false);
      }
    }
  }, [baseAsset, quoteAsset, symbol]);

  const reconcilePendingOrderIntent = useCallback(
    async (
      nextCurrentOrders: readonly ContractOrderItem[],
      nextHistoryOrders: readonly ContractOrderItem[],
    ) => {
      const intent = pendingOrderIntentRef.current;
      if (!intent) return false;
      if (
        activeOrderIntentScopeRef.current !== orderIntentScope ||
        intent.ownerKey !== orderIntentOwnerKey ||
        intent.instrumentKey !== symbol
      ) {
        return false;
      }
      const verifiedOrders = findAuthoritativeContractOrdersForIntent(
        intent,
        nextCurrentOrders,
        nextHistoryOrders,
      );
      if (!verifiedOrders) return false;
      if (
        pendingOrderIntentRef.current?.id === intent.id &&
        activeInstrumentKeyRef.current === instrumentKey &&
        activeOrderIntentScopeRef.current === orderIntentScope
      ) {
        const identities = verifiedOrders
          .map(order => order.orderId)
          .filter((orderId): orderId is number => orderId !== null)
          .map(orderId => `#${orderId}`)
          .join('、');
        setFeedbackText(
          tRef.current('contract.possibleOrder', {
            identity: identities ? ` ${identities}` : '',
          }),
        );
        setFeedbackTone('error');
      }
      return true;
    },
    [instrumentKey, orderIntentOwnerKey, orderIntentScope, symbol],
  );

  const loadPrivateCriticalData = useCallback(
    async (preserveFreshSnapshot = false) => {
      const generation = ++privateCriticalGenerationRef.current;
      const previousAuthority = privateAuthorityRef.current;
      const nowMs = Date.now();
      const preserveCurrentAuthority =
        preserveFreshSnapshot &&
        previousAuthority.ready &&
        previousAuthority.symbol === symbol &&
        previousAuthority.expiresAtMs !== null &&
        previousAuthority.expiresAtMs > nowMs;
      let preservationTimer: ReturnType<typeof setTimeout> | null = null;
      if (preserveCurrentAuthority) {
        preservationTimer = setTimeout(() => {
          if (
            generation === privateCriticalGenerationRef.current &&
            privateAuthorityRef.current === previousAuthority
          ) {
            privateAuthorityRef.current =
              unavailablePrivateAuthority(generation);
            setPrivateCriticalUpdatedAtMs(null);
          }
        }, previousAuthority.expiresAtMs! - nowMs);
      } else {
        privateAuthorityRef.current = {
          ready: false,
          symbol,
          expiresAtMs: null,
          generation,
        };
        setPrivateCriticalUpdatedAtMs(null);
      }
      setPrivateCriticalError(null);

      if (!isLoggedIn) {
        setAccount(null);
        setPositions([]);
        positionsRef.current = [];
        setCurrentOrders([]);
        setCurrentOrdersPage(EMPTY_CONTRACT_PAGE_INFO);
        currentOrdersRef.current = [];
        setOrderActionFeedback(null);
        return false;
      }

      try {
        const [summary, nextPositions, currentPage] = await Promise.all([
          fetchContractAccountSummary(),
          fetchContractPositions(symbol),
          fetchContractOrdersPage({
            symbol,
            status: 'ACTIVE',
            pageSize: CONTRACT_ORDER_REVIEW_LIMIT,
          }),
        ]);
        if (generation !== privateCriticalGenerationRef.current) return false;
        const updatedAtMs = Date.now();
        setAccount(summary);
        setPositions(nextPositions);
        positionsRef.current = nextPositions;
        setCurrentOrders(currentPage.items);
        setCurrentOrdersPage(currentPage);
        currentOrdersRef.current = currentPage.items;
        setPrivateCriticalUpdatedAtMs(updatedAtMs);
        setPrivateCriticalError(null);
        privateAuthorityRef.current = {
          ready: true,
          symbol,
          expiresAtMs: updatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS,
          generation,
        };
        return true;
      } catch (error) {
        if (generation !== privateCriticalGenerationRef.current) return false;
        const previousAuthorityStillFresh =
          preserveCurrentAuthority &&
          privateAuthorityRef.current === previousAuthority &&
          previousAuthority.expiresAtMs !== null &&
          previousAuthority.expiresAtMs > Date.now();
        if (previousAuthorityStillFresh) {
          setPrivateCriticalError(null);
        } else {
          privateAuthorityRef.current = unavailablePrivateAuthority(generation);
          setPrivateCriticalUpdatedAtMs(null);
          setPrivateCriticalError(
            error instanceof Error
              ? error.message
              : tRef.current('contract.accountLoadFailed'),
          );
        }
        return false;
      } finally {
        if (preservationTimer !== null) clearTimeout(preservationTimer);
      }
    },
    [isLoggedIn, symbol],
  );

  const loadPrivateSecondaryData = useCallback(
    async (preserveFreshSnapshot = false) => {
      const generation = ++privateSecondaryGenerationRef.current;
      const previousHistoryUpdatedAtMs = privateHistoryUpdatedAtMsRef.current;
      const nowMs = Date.now();
      const preserveCurrentHistory =
        preserveFreshSnapshot &&
        privateHistoryReadyRef.current &&
        previousHistoryUpdatedAtMs !== null &&
        previousHistoryUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS > nowMs;
      let preservationTimer: ReturnType<typeof setTimeout> | null = null;
      if (preserveCurrentHistory) {
        preservationTimer = setTimeout(() => {
          if (
            generation === privateSecondaryGenerationRef.current &&
            privateHistoryReadyRef.current &&
            privateHistoryUpdatedAtMsRef.current === previousHistoryUpdatedAtMs
          ) {
            privateHistoryReadyRef.current = false;
            privateHistoryUpdatedAtMsRef.current = null;
            setPrivateHistoryReady(false);
            setPrivateHistoryUpdatedAtMs(null);
          }
        }, previousHistoryUpdatedAtMs! + CONTRACT_PRIVATE_DATA_TTL_MS - nowMs);
      } else {
        privateHistoryReadyRef.current = false;
        privateHistoryUpdatedAtMsRef.current = null;
        setPrivateHistoryReady(false);
        setPrivateHistoryUpdatedAtMs(null);
      }
      setPrivateHistoryError(null);
      setPrivateFillsError(null);
      if (!isLoggedIn) {
        setHistoryOrders([]);
        setHistoryOrdersPage(EMPTY_CONTRACT_PAGE_INFO);
        historyOrdersRef.current = [];
        setMyTrades([]);
        setMyTradesPage(EMPTY_CONTRACT_PAGE_INFO);
        privateHistoryReadyRef.current = false;
        privateHistoryUpdatedAtMsRef.current = null;
        setPrivateHistoryReady(false);
        setPrivateHistoryUpdatedAtMs(null);
        return;
      }

      const historyResultPromise = fetchContractOrdersPage({
        symbol,
        statusGroup: 'HISTORY',
        pageSize: CONTRACT_RECORD_PAGE_SIZE,
      }).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      );
      const fillsResultPromise = fetchContractTradesPage(
        symbol,
        CONTRACT_RECORD_PAGE_SIZE,
      ).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      );
      try {
        const historyResult = await historyResultPromise;
        if (generation !== privateSecondaryGenerationRef.current) return;
        if (historyResult.status === 'fulfilled') {
          const historyPage = historyResult.value;
          setHistoryOrders(historyPage.items);
          setHistoryOrdersPage(historyPage);
          historyOrdersRef.current = historyPage.items;
          const updatedAtMs = Date.now();
          privateHistoryReadyRef.current = true;
          privateHistoryUpdatedAtMsRef.current = updatedAtMs;
          setPrivateHistoryReady(true);
          setPrivateHistoryUpdatedAtMs(updatedAtMs);
          setPrivateHistoryError(null);
        } else {
          const previousHistoryStillFresh =
            preserveCurrentHistory &&
            privateHistoryReadyRef.current &&
            privateHistoryUpdatedAtMsRef.current ===
              previousHistoryUpdatedAtMs &&
            previousHistoryUpdatedAtMs !== null &&
            previousHistoryUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS >
              Date.now();
          if (previousHistoryStillFresh) {
            setPrivateHistoryError(null);
          } else {
            privateHistoryReadyRef.current = false;
            privateHistoryUpdatedAtMsRef.current = null;
            setPrivateHistoryReady(false);
            setPrivateHistoryUpdatedAtMs(null);
            setPrivateHistoryError(
              historyResult.reason instanceof Error
                ? historyResult.reason.message
                : tRef.current('contract.historyLoadFailed'),
            );
          }
        }
        const fillsResult = await fillsResultPromise;
        if (generation !== privateSecondaryGenerationRef.current) return;
        if (fillsResult.status === 'fulfilled') {
          setMyTrades(fillsResult.value.items);
          setMyTradesPage(fillsResult.value);
          setPrivateFillsError(null);
        } else {
          setPrivateFillsError(
            fillsResult.reason instanceof Error
              ? fillsResult.reason.message
              : tRef.current('contract.fillsLoadFailed'),
          );
        }
      } finally {
        if (preservationTimer !== null) clearTimeout(preservationTimer);
      }
    },
    [isLoggedIn, symbol],
  );

  const loadPrivateData = useCallback(
    (mode: 'blocking' | 'background' = 'blocking') => {
      const scope = orderIntentScope;
      if (manualUnlockCommitRef.current?.scope === scope) {
        return Promise.resolve();
      }
      if (reviewingPendingIntentRef.current && pendingOrderIntentRef.current) {
        return Promise.resolve();
      }
      const inFlight = privateDataInFlightRef.current;
      if (inFlight?.scope === scope) {
        if (mode === 'blocking') {
          privateAuthorityRef.current = unavailablePrivateAuthority(
            privateCriticalGenerationRef.current,
          );
          setPrivateCriticalUpdatedAtMs(null);
          privateHistoryReadyRef.current = false;
          privateHistoryUpdatedAtMsRef.current = null;
          setPrivateHistoryReady(false);
          setPrivateHistoryUpdatedAtMs(null);
        }
        return inFlight.promise;
      }
      const pendingReconcile = pendingReconcileInFlightRef.current;
      const promise = (async () => {
        if (pendingReconcile?.scope === scope) {
          await pendingReconcile.promise.catch(() => null);
        }
        if (pendingOrderIntentRef.current) {
          pendingReconciliationVersionRef.current += 1;
          pendingReconciliationUpdatedAtMsRef.current = null;
        }
        await Promise.all([
          loadPrivateCriticalData(mode === 'background'),
          loadPrivateSecondaryData(mode === 'background'),
        ]);
        if (
          activeOrderIntentScopeRef.current === scope &&
          privateAuthorityRef.current.ready &&
          privateHistoryReadyRef.current &&
          privateHistoryUpdatedAtMsRef.current !== null
        ) {
          pendingReconciliationUpdatedAtMsRef.current = Date.now();
          pendingReconciliationVersionRef.current += 1;
          await reconcilePendingOrderIntent(
            currentOrdersRef.current,
            historyOrdersRef.current,
          );
        }
      })();
      const entry = { scope, promise };
      privateDataInFlightRef.current = entry;
      promise.then(
        () => {
          if (privateDataInFlightRef.current === entry) {
            privateDataInFlightRef.current = null;
          }
        },
        () => {
          if (privateDataInFlightRef.current === entry) {
            privateDataInFlightRef.current = null;
          }
        },
      );
      return promise;
    },
    [
      loadPrivateCriticalData,
      loadPrivateSecondaryData,
      orderIntentScope,
      reconcilePendingOrderIntent,
    ],
  );

  const privateRealtimeEnabled =
    isLoggedIn &&
    marketScreenActive &&
    orderIntentHydratedScope === orderIntentScope;
  const privateRealtimeStatus = usePrivateTradingRealtime({
    market: 'CONTRACT',
    symbol,
    enabled: privateRealtimeEnabled,
    onInvalidate: () => {
      loadPrivateData().catch(() => undefined);
    },
  });
  const privateRealtimeNotice = !privateRealtimeEnabled
    ? null
    : privateRealtimeStatus === 'reconnecting'
    ? t('spot.realtimeRecovering')
    : privateRealtimeStatus === 'stopped'
    ? t('spot.realtimeUnavailable')
    : null;

  const loadPendingOrderReconciliationData = useCallback(
    (source: 'automatic' | 'manual' = 'automatic') => {
      const scope = orderIntentScope;
      if (manualUnlockCommitRef.current?.scope === scope) {
        return Promise.resolve(null);
      }
      if (
        source === 'automatic' &&
        reviewingPendingIntentRef.current &&
        pendingOrderIntentRef.current
      ) {
        return Promise.resolve(null);
      }
      const inFlight = pendingReconcileInFlightRef.current;
      if (inFlight?.scope === scope) return inFlight.promise;
      const fullRefresh = privateDataInFlightRef.current;
      if (fullRefresh?.scope === scope) {
        return fullRefresh.promise.then(() => null);
      }
      const criticalGeneration = privateCriticalGenerationRef.current;
      const secondaryGeneration = privateSecondaryGenerationRef.current;
      const promise = (async () => {
        if (!isLoggedIn || !pendingOrderIntentRef.current) return null;
        pendingReconciliationVersionRef.current += 1;
        pendingReconciliationUpdatedAtMsRef.current = null;
        try {
          // CURRENT must be observed before HISTORY. Contract order state only
          // moves from active to terminal, so this closes the gap between two
          // independently served endpoint snapshots.
          const currentPage = await fetchContractOrdersPage({
            symbol,
            status: 'ACTIVE',
            pageSize: CONTRACT_ORDER_REVIEW_LIMIT,
          });
          const historyPage = await fetchContractOrdersPage({
            symbol,
            statusGroup: 'HISTORY',
            pageSize: CONTRACT_ORDER_REVIEW_LIMIT,
          });
          if (
            criticalGeneration !== privateCriticalGenerationRef.current ||
            secondaryGeneration !== privateSecondaryGenerationRef.current ||
            activeOrderIntentScopeRef.current !== scope
          ) {
            return null;
          }
          if (currentPage.hasMore || historyPage.hasMore) {
            privateHistoryReadyRef.current = false;
            privateHistoryUpdatedAtMsRef.current = null;
            pendingReconciliationUpdatedAtMsRef.current = null;
            setPrivateHistoryReady(false);
            setPrivateHistoryUpdatedAtMs(null);
            setPrivateHistoryError(tRef.current('contract.recordsTooMany'));
            return null;
          }
          setCurrentOrders(currentPage.items);
          setCurrentOrdersPage(currentPage);
          currentOrdersRef.current = currentPage.items;
          setHistoryOrders(historyPage.items);
          setHistoryOrdersPage(historyPage);
          historyOrdersRef.current = historyPage.items;
          const updatedAtMs = Date.now();
          privateHistoryReadyRef.current = true;
          privateHistoryUpdatedAtMsRef.current = updatedAtMs;
          setPrivateHistoryReady(true);
          setPrivateHistoryUpdatedAtMs(updatedAtMs);
          setPrivateHistoryError(null);
          pendingReconciliationUpdatedAtMsRef.current = updatedAtMs;
          pendingReconciliationVersionRef.current += 1;
          await reconcilePendingOrderIntent(
            currentPage.items,
            historyPage.items,
          );
          return {
            version: pendingReconciliationVersionRef.current,
            updatedAtMs,
          };
        } catch (error) {
          if (
            criticalGeneration === privateCriticalGenerationRef.current &&
            secondaryGeneration === privateSecondaryGenerationRef.current &&
            activeOrderIntentScopeRef.current === scope
          ) {
            privateHistoryReadyRef.current = false;
            privateHistoryUpdatedAtMsRef.current = null;
            pendingReconciliationUpdatedAtMsRef.current = null;
            setPrivateHistoryReady(false);
            setPrivateHistoryUpdatedAtMs(null);
            setPrivateHistoryError(
              error instanceof Error
                ? error.message
                : tRef.current('contract.reconcileLoadFailed'),
            );
          }
          return null;
        }
      })();
      const entry = { scope, promise };
      pendingReconcileInFlightRef.current = entry;
      promise.then(
        () => {
          if (pendingReconcileInFlightRef.current === entry) {
            pendingReconcileInFlightRef.current = null;
          }
        },
        () => {
          if (pendingReconcileInFlightRef.current === entry) {
            pendingReconcileInFlightRef.current = null;
          }
        },
      );
      return promise;
    },
    [isLoggedIn, orderIntentScope, reconcilePendingOrderIntent, symbol],
  );

  const retryPersistedContractIntent = useCallback(
    (intent: PendingContractOrderIntent, scope: string) => {
      if (intent.version !== 2) return;
      const lifecycleGeneration = executionLifecycleGenerationRef.current;
      Alert.alert(
        tRef.current('contract.retryOriginalTitle'),
        tRef.current('contract.retryOriginalBody'),
        [
          { text: tRef.current('contract.retryLater'), style: 'cancel' },
          {
            text: tRef.current('contract.retryConfirm'),
            onPress: async () => {
              if (
                reviewingPendingIntentRef.current ||
                !screenMountedRef.current ||
                !marketScreenActiveRef.current ||
                activeOrderIntentScopeRef.current !== scope ||
                executionLifecycleGenerationRef.current !==
                  lifecycleGeneration ||
                pendingOrderIntentRef.current?.id !== intent.id
              ) {
                Alert.alert(
                  tRef.current('recovery.pageChangedTitle'),
                  tRef.current('contract.protectionPageChanged'),
                );
                return;
              }
              reviewingPendingIntentRef.current = true;
              setReviewingPendingIntent(true);
              let cleared = false;
              try {
                let message: string;
                if (intent.payload.action === 'OPEN') {
                  if (
                    intent.payload.leverage === null ||
                    intent.payload.leverage === undefined
                  ) {
                    throw new Error(
                      tRef.current('contract.intentLeverageInvalid'),
                    );
                  }
                  const result = await openContractOrder({
                    symbol: intent.payload.symbol,
                    position_side: intent.payload.positionSide,
                    order_type: intent.payload.orderType,
                    price:
                      intent.payload.orderType === 'LIMIT'
                        ? intent.payload.price
                        : undefined,
                    quantity: intent.payload.quantity,
                    leverage: intent.payload.leverage,
                    client_order_id: intent.clientOrderId,
                  });
                  const identity =
                    result.orderNo ||
                    (result.orderId > 0 ? '#' + result.orderId : '');
                  message = tRef.current('contract.confirmedResult', {
                    action: tRef.current('trading.action.open'),
                    identity: identity ? ` ${identity}` : '',
                    status: result.status,
                  });
                } else {
                  const result = await closeContractSummaryOrder({
                    symbol: intent.payload.symbol,
                    side: intent.payload.positionSide,
                    order_type: intent.payload.orderType,
                    price:
                      intent.payload.orderType === 'LIMIT'
                        ? intent.payload.price
                        : undefined,
                    quantity: intent.payload.quantity,
                    client_order_id: intent.clientOrderId,
                  });
                  const identity =
                    result.orderIds.length > 0
                      ? ' #' + result.orderIds.join(', #')
                      : '';
                  message = tRef.current('contract.confirmedResult', {
                    action: tRef.current('trading.action.close'),
                    identity,
                    status: result.status,
                  });
                }
                cleared = await clearPendingTradeIntent(intent);
                if (!cleared)
                  throw new Error(
                    tRef.current('contract.protectionStateChanged'),
                  );
                if (
                  screenMountedRef.current &&
                  activeOrderIntentScopeRef.current === scope &&
                  pendingOrderIntentRef.current?.id === intent.id
                ) {
                  pendingOrderIntentRef.current = null;
                  setPendingOrderIntent(null);
                  setQuantity('');
                  setFeedbackText(message);
                  setFeedbackTone('success');
                  Alert.alert(tRef.current('recovery.confirmedTitle'), message);
                  await loadPrivateData();
                }
              } catch (error) {
                const potentiallyCommitted =
                  isPotentiallyCommittedMutationError(error, {
                    invalidResponseCodes: [
                      'INVALID_CONTRACT_ORDER_RESPONSE',
                      'INVALID_CONTRACT_CLOSE_RESPONSE',
                    ],
                  });
                if (!potentiallyCommitted && !cleared) {
                  try {
                    cleared = await clearPendingTradeIntent(intent);
                  } catch {
                    cleared = false;
                  }
                }
                if (
                  cleared &&
                  screenMountedRef.current &&
                  activeOrderIntentScopeRef.current === scope &&
                  pendingOrderIntentRef.current?.id === intent.id
                ) {
                  pendingOrderIntentRef.current = null;
                  setPendingOrderIntent(null);
                }
                if (
                  potentiallyCommitted &&
                  screenMountedRef.current &&
                  activeOrderIntentScopeRef.current === scope
                ) {
                  await loadPendingOrderReconciliationData();
                }
                if (
                  screenMountedRef.current &&
                  activeOrderIntentScopeRef.current === scope
                ) {
                  const rawMessage =
                    error instanceof Error
                      ? error.message
                      : tRef.current('contract.retryFailed');
                  const message = potentiallyCommitted
                    ? rawMessage + tRef.current('contract.resultPendingSuffix')
                    : cleared
                    ? rawMessage +
                      tRef.current('contract.rejectedClearedSuffix')
                    : rawMessage + tRef.current('contract.protectionSuffix');
                  setFeedbackText(message);
                  setFeedbackTone('error');
                  Alert.alert(
                    tRef.current('recovery.retryIncomplete'),
                    message,
                  );
                }
              } finally {
                reviewingPendingIntentRef.current = false;
                if (screenMountedRef.current) setReviewingPendingIntent(false);
              }
            },
          },
        ],
      );
    },
    [loadPendingOrderReconciliationData, loadPrivateData],
  );

  const reviewCorruptContractIntent = useCallback(
    (failure: PendingTradeIntentLoadError, scope: string) => {
      if (reviewingPendingIntentRef.current) return;
      if (failure.kind !== 'CORRUPT') {
        Alert.alert(
          tRef.current(
            failure.kind === 'FUTURE_SCHEMA'
              ? 'recovery.upgradeApp'
              : 'recovery.temporarilyUnavailable',
          ),
          failure.message,
        );
        return;
      }
      if (!failure.token?.clientOrderId) {
        Alert.alert(
          tRef.current('contract.contactSupportTitle'),
          tRef.current('contract.incompleteLocalRecord'),
        );
        return;
      }
      const lifecycleGeneration = executionLifecycleGenerationRef.current;
      const canClear = () =>
        screenMountedRef.current &&
        marketScreenActiveRef.current &&
        activeOrderIntentScopeRef.current === scope &&
        orderIntentLoadFailureRef.current === failure &&
        executionLifecycleGenerationRef.current === lifecycleGeneration;
      Alert.alert(
        tRef.current('contract.queryOriginalTitle'),
        tRef.current('contract.queryOriginalBody'),
        [
          { text: tRef.current('contract.queryLater'), style: 'cancel' },
          {
            text: tRef.current('contract.queryStart'),
            onPress: async () => {
              if (!canClear() || reviewingPendingIntentRef.current) {
                Alert.alert(
                  tRef.current('recovery.pageChangedTitle'),
                  tRef.current('contract.protectionQueryPageChanged'),
                );
                return;
              }
              reviewingPendingIntentRef.current = true;
              setReviewingPendingIntent(true);
              try {
                const recovery = await recoverCorruptPendingTradeIntent(
                  failure,
                  canClear,
                );
                if (!canClear()) return;
                if (recovery.status === 'COMPLETED_CLEARED') {
                  orderIntentLoadFailureRef.current = null;
                  setOrderIntentLoadFailure(null);
                  setOrderIntentLoadError(null);
                  setFeedbackText(tRef.current('contract.originalConfirmed'));
                  setFeedbackTone('success');
                  Alert.alert(
                    tRef.current('contract.queryCompleteTitle'),
                    tRef.current('contract.queryCompleteBody'),
                  );
                  await loadPrivateData();
                  return;
                }
                const message =
                  recovery.status === 'PENDING'
                    ? tRef.current('contract.originalProcessing')
                    : recovery.status === 'NOT_FOUND'
                    ? tRef.current('contract.queryNotFound')
                    : recovery.status === 'SCOPE_MISMATCH'
                    ? tRef.current('contract.querySymbolMismatch')
                    : recovery.status === 'LOCK_CHANGED'
                    ? tRef.current('contract.queryStateChanged')
                    : tRef.current('contract.cannotAutoRecover');
                setFeedbackText(message);
                setFeedbackTone('error');
                Alert.alert(
                  tRef.current('contract.protectionNotReleasedTitle'),
                  message,
                );
              } catch (error) {
                if (!canClear()) return;
                const message =
                  (error instanceof Error
                    ? error.message
                    : tRef.current('contract.queryFailed')) +
                  tRef.current('contract.protectionSuffix');
                setFeedbackText(message);
                setFeedbackTone('error');
                Alert.alert(tRef.current('recovery.queryFailedTitle'), message);
              } finally {
                reviewingPendingIntentRef.current = false;
                if (screenMountedRef.current) setReviewingPendingIntent(false);
              }
            },
          },
        ],
      );
    },
    [loadPrivateData],
  );

  const handlePendingIntentReview = useCallback(async () => {
    if (reviewingPendingIntentRef.current) return;
    const intent = pendingOrderIntentRef.current;
    const scope = orderIntentScope;
    if (!intent) {
      const failure = orderIntentLoadFailureRef.current;
      if (failure) reviewCorruptContractIntent(failure, scope);
      return;
    }
    if (
      activeOrderIntentScopeRef.current !== scope ||
      intent.ownerKey !== orderIntentOwnerKey ||
      intent.instrumentKey !== symbol
    ) {
      return;
    }
    if (intent.version === 2) {
      retryPersistedContractIntent(intent, scope);
      return;
    }
    const remainingMs =
      PENDING_INTENT_MANUAL_REVIEW_DELAY_MS - (Date.now() - intent.createdAtMs);
    if (remainingMs > 0) {
      Alert.alert(
        tRef.current('recovery.checkLaterTitle'),
        tRef.current('contract.checkLaterSeconds', {
          seconds: Math.ceil(remainingMs / 1000),
        }),
      );
      return;
    }

    reviewingPendingIntentRef.current = true;
    setReviewingPendingIntent(true);
    const reviewGeneration = ++pendingManualReviewGenerationRef.current;
    try {
      const waitForScopeRefreshes = async () => {
        while (true) {
          const activeFullRefresh = privateDataInFlightRef.current;
          const activePendingRefresh = pendingReconcileInFlightRef.current;
          const waits: Promise<unknown>[] = [];
          if (activeFullRefresh?.scope === scope) {
            waits.push(activeFullRefresh.promise.catch(() => undefined));
          }
          if (activePendingRefresh?.scope === scope) {
            waits.push(activePendingRefresh.promise.catch(() => false));
          }
          if (waits.length === 0) break;
          await Promise.all(waits);
        }
      };
      await waitForScopeRefreshes();
      await loadPendingOrderReconciliationData('manual');
      await waitForScopeRefreshes();
      const reviewedSnapshot = await loadPendingOrderReconciliationData(
        'manual',
      );
      await waitForScopeRefreshes();
      if (
        !screenMountedRef.current ||
        activeOrderIntentScopeRef.current !== scope ||
        pendingOrderIntentRef.current?.id !== intent.id
      ) {
        return;
      }
      if (!reviewedSnapshot) {
        Alert.alert(
          tRef.current('contract.reviewFailedTitle'),
          tRef.current('contract.reviewFailedBody'),
        );
        return;
      }
      const reviewedSnapshotVersion = reviewedSnapshot.version;
      const reviewedSnapshotAtMs = reviewedSnapshot.updatedAtMs;
      const reviewedLifecycleGeneration =
        executionLifecycleGenerationRef.current;
      const reviewStillValid = () =>
        screenMountedRef.current &&
        marketScreenActiveRef.current &&
        pendingOrderIntentRef.current?.id === intent.id &&
        activeOrderIntentScopeRef.current === scope &&
        executionLifecycleGenerationRef.current ===
          reviewedLifecycleGeneration &&
        pendingManualReviewGenerationRef.current === reviewGeneration &&
        pendingReconciliationVersionRef.current === reviewedSnapshotVersion &&
        reviewedSnapshotAtMs !== null &&
        pendingReconciliationUpdatedAtMsRef.current === reviewedSnapshotAtMs &&
        reviewedSnapshotAtMs + CONTRACT_PRIVATE_DATA_TTL_MS > Date.now() &&
        privateDataInFlightRef.current?.scope !== scope &&
        pendingReconcileInFlightRef.current?.scope !== scope;
      setRecordTab('current');
      Alert.alert(
        tRef.current('contract.releaseProtectionTitle'),
        tRef.current('contract.releaseProtectionBody'),
        [
          { text: tRef.current('contract.backToReview'), style: 'cancel' },
          {
            text: tRef.current('contract.confirmNotFilledRelease'),
            style: 'destructive',
            onPress: async () => {
              if (!reviewStillValid()) {
                Alert.alert(
                  tRef.current('recovery.expiredTitle'),
                  tRef.current('contract.reviewExpiredBody'),
                );
                return;
              }
              const commit = { scope, intentId: intent.id };
              manualUnlockCommitRef.current = commit;
              reviewingPendingIntentRef.current = true;
              if (screenMountedRef.current) setReviewingPendingIntent(true);
              try {
                if (
                  manualUnlockCommitRef.current !== commit ||
                  !reviewStillValid()
                ) {
                  throw new Error(
                    tRef.current('contract.pageChangedProtected'),
                  );
                }
                const cleared = await clearPendingTradeIntent(intent);
                if (!cleared) {
                  throw new Error(tRef.current('contract.protectionChanged'));
                }
                pendingOrderIntentRef.current = null;
                pendingManualReviewGenerationRef.current += 1;
                setPendingOrderIntent(null);
                setQuantity('');
                setFeedbackText(tRef.current('contract.protectionReleased'));
                setFeedbackTone('success');
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : tRef.current('contract.releaseFailed');
                if (
                  screenMountedRef.current &&
                  activeOrderIntentScopeRef.current === scope
                ) {
                  const finalMessage =
                    message + tRef.current('contract.protectionSuffix');
                  setFeedbackText(finalMessage);
                  setFeedbackTone('error');
                  Alert.alert(
                    tRef.current('contract.releaseFailedTitle'),
                    finalMessage,
                  );
                }
              } finally {
                if (manualUnlockCommitRef.current === commit) {
                  manualUnlockCommitRef.current = null;
                }
                reviewingPendingIntentRef.current = false;
                if (screenMountedRef.current) setReviewingPendingIntent(false);
              }
            },
          },
        ],
      );
    } finally {
      reviewingPendingIntentRef.current = false;
      if (screenMountedRef.current) setReviewingPendingIntent(false);
    }
  }, [
    loadPendingOrderReconciliationData,
    orderIntentOwnerKey,
    orderIntentScope,
    reviewCorruptContractIntent,
    retryPersistedContractIntent,
    symbol,
  ]);

  useEffect(() => {
    let canceled = false;
    const scope = orderIntentScope;
    setOrderIntentHydratedScope(null);
    setOrderIntentLoadError(null);
    setOrderIntentLoadFailure(null);
    orderIntentLoadFailureRef.current = null;
    pendingOrderIntentRef.current = null;
    setPendingOrderIntent(null);

    if (!isLoggedIn || !orderIntentOwnerKey) {
      setOrderIntentHydratedScope(scope);
      return () => {
        canceled = true;
      };
    }

    loadPendingTradeIntent<ContractOrderIntentPayload>(
      'contract',
      orderIntentOwnerKey,
      symbol,
    )
      .then(intent => {
        if (
          canceled ||
          activeInstrumentKeyRef.current !== instrumentKey ||
          activeOrderIntentScopeRef.current !== scope
        ) {
          return;
        }
        const contractIntent = intent as PendingContractOrderIntent | null;
        pendingOrderIntentRef.current = contractIntent;
        setPendingOrderIntent(contractIntent);
        orderIntentLoadFailureRef.current = null;
        setOrderIntentLoadFailure(null);
        setOrderIntentHydratedScope(scope);
        if (contractIntent) {
          setFeedbackText(tRef.current('contract.lastOrderPending'));
          setFeedbackTone('error');
        }
      })
      .catch(error => {
        if (
          canceled ||
          activeInstrumentKeyRef.current !== instrumentKey ||
          activeOrderIntentScopeRef.current !== scope
        ) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : tRef.current('contract.lastOrderReadFailed');
        const loadFailure = isPendingTradeIntentLoadError(error) ? error : null;
        orderIntentLoadFailureRef.current = loadFailure;
        setOrderIntentLoadFailure(loadFailure);
        setOrderIntentLoadError(message);
        setOrderIntentHydratedScope(scope);
        setFeedbackText(message);
        setFeedbackTone('error');
      });

    return () => {
      canceled = true;
    };
  }, [
    instrumentKey,
    isLoggedIn,
    orderIntentOwnerKey,
    orderIntentScope,
    symbol,
  ]);

  useEffect(() => {
    loadSymbolRules();
    return () => {
      rulesGenerationRef.current += 1;
    };
  }, [loadSymbolRules]);

  useEffect(() => {
    if (marketScreenActive && orderIntentHydratedScope === orderIntentScope) {
      loadPrivateData();
    }
    return () => {
      privateCriticalGenerationRef.current += 1;
      privateSecondaryGenerationRef.current += 1;
      privateAuthorityRef.current = unavailablePrivateAuthority(
        privateCriticalGenerationRef.current,
      );
    };
  }, [
    loadPrivateData,
    marketScreenActive,
    orderIntentHydratedScope,
    orderIntentScope,
  ]);

  useEffect(() => {
    if (
      !marketScreenActive ||
      !pendingOrderIntent ||
      orderIntentHydratedScope !== orderIntentScope
    ) {
      return;
    }
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reconcile = async () => {
      await loadPendingOrderReconciliationData().catch(() => undefined);
      if (!canceled) {
        timer = setTimeout(reconcile, CONTRACT_PENDING_INTENT_RECHECK_MS);
      }
    };
    timer = setTimeout(reconcile, CONTRACT_PENDING_INTENT_RECHECK_MS);
    return () => {
      canceled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    loadPendingOrderReconciliationData,
    marketScreenActive,
    orderIntentHydratedScope,
    orderIntentScope,
    pendingOrderIntent,
  ]);

  useEffect(() => {
    if (
      !isLoggedIn ||
      !marketScreenActive ||
      orderIntentHydratedScope !== orderIntentScope
    ) {
      return;
    }
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const privateAuthority = privateAuthorityRef.current;
      const historyUpdatedAtMs = privateHistoryUpdatedAtMsRef.current;
      const freshUntilMs =
        privateAuthority.expiresAtMs === null || historyUpdatedAtMs === null
          ? null
          : Math.min(
              privateAuthority.expiresAtMs,
              historyUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS,
            );
      const freshRemainingMs =
        freshUntilMs === null ? null : Math.max(0, freshUntilMs - Date.now());
      const refreshDelayMs =
        !privateAuthority.ready || freshRemainingMs === null
          ? CONTRACT_PRIVATE_RETRY_MS
          : freshRemainingMs > CONTRACT_PRIVATE_REFRESH_LEAD_MS
          ? freshRemainingMs - CONTRACT_PRIVATE_REFRESH_LEAD_MS
          : Math.min(CONTRACT_PRIVATE_RETRY_MS, freshRemainingMs);
      timer = setTimeout(refresh, refreshDelayMs);
    };
    const refresh = async () => {
      await loadPrivateData('background').catch(() => undefined);
      if (!canceled) schedule();
    };
    schedule();
    return () => {
      canceled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    isLoggedIn,
    loadPrivateData,
    marketScreenActive,
    orderIntentHydratedScope,
    orderIntentScope,
    privateCriticalUpdatedAtMs,
    privateHistoryUpdatedAtMs,
  ]);

  useEffect(() => {
    screenMountedRef.current = true;
    return () => {
      screenMountedRef.current = false;
      cancelingOrderIdRef.current = null;
      cancelConfirmationOrderIdRef.current = null;
      activeOrderConfirmRef.current = null;
      activeCloseAllConfirmRef.current = null;
    };
  }, []);

  const clearFeedback = useCallback(() => {
    setFeedbackText('');
    setFeedbackTone(null);
  }, []);

  const executePositionCloseRequest = useCallback(
    async (request: ContractPositionCloseRequest) => {
      if (
        submittingRef.current ||
        tpSlSavingRef.current ||
        closingAllPositionsRef.current
      ) {
        return;
      }
      const preparationInstrumentKey = instrumentKey;
      const preparationOrderIntentScope = orderIntentScope;
      submittingRef.current = true;
      setSubmitting(true);
      setFeedbackText(tRef.current('contract.preparing'));
      setFeedbackTone(null);

      let activeIntent: PendingContractOrderIntent | null = null;
      let intentPersisted = false;
      let activeRequestConfirmed = false;
      try {
        await loadPrivateData();
        if (
          !screenMountedRef.current ||
          !marketScreenActiveRef.current ||
          activeInstrumentKeyRef.current !== preparationInstrumentKey ||
          activeOrderIntentScopeRef.current !== preparationOrderIntentScope
        ) {
          throw new Error(tRef.current('contract.notSentChanged'));
        }
        if (!orderIntentOwnerKey) {
          throw new Error(tRef.current('contract.loginNotReady'));
        }
        if (
          orderIntentHydratedScope !== orderIntentScope ||
          orderIntentLoadError ||
          pendingOrderIntentRef.current
        ) {
          throw new Error(
            orderIntentGuardMessage ||
              tRef.current('contract.orderPendingNoDuplicate'),
          );
        }

        const privateAuthority = privateAuthorityRef.current;
        const historyUpdatedAtMs = privateHistoryUpdatedAtMsRef.current;
        if (
          !privateAuthority.ready ||
          privateAuthority.symbol !== symbol ||
          privateAuthority.expiresAtMs === null ||
          privateAuthority.expiresAtMs <= Date.now() ||
          !privateHistoryReadyRef.current ||
          historyUpdatedAtMs === null ||
          historyUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS <= Date.now()
        ) {
          throw new Error(tRef.current('contract.privateDataStale'));
        }
        const executionAuthority = executionAuthorityRef.current;
        if (
          !executionAuthority.ready ||
          executionAuthority.expiresAtMs === null ||
          executionAuthority.expiresAtMs <= Date.now() ||
          executionAuthority.bid === null ||
          executionAuthority.ask === null ||
          executionAuthority.bid <= 0 ||
          executionAuthority.ask < executionAuthority.bid
        ) {
          throw new Error(tRef.current('contract.executionUnavailable'));
        }

        const latestPosition = positionsRef.current.find(
          item =>
            item.id === request.positionId &&
            item.side === request.side &&
            item.symbol.trim().toUpperCase() === request.symbol,
        );
        if (!latestPosition) {
          throw new Error(
            tRef.current('contract.noClosablePosition', {
              side: tRef.current(
                request.side === 'LONG'
                  ? 'trading.position.long'
                  : 'trading.position.short',
              ),
            }),
          );
        }
        const latestQuantityValue = Number(
          latestPosition.quantity.replace(/,/g, ''),
        );
        if (!Number.isFinite(latestQuantityValue) || latestQuantityValue <= 0) {
          throw new Error(tRef.current('contract.invalidQuantity'));
        }
        const latestQuantity = formatOrderDecimal(
          latestQuantityValue,
          quantityPrecision,
        );
        const lifecycleGeneration = executionLifecycleGenerationRef.current;
        const baselineIds = [
          ...currentOrdersRef.current,
          ...historyOrdersRef.current,
        ]
          .map(item => item.orderId)
          .filter(
            (orderId): orderId is number =>
              orderId !== null && Number.isSafeInteger(orderId) && orderId > 0,
          );
        const intent = createPendingTradeIntent({
          market: 'contract',
          ownerKey: orderIntentOwnerKey,
          instrumentKey: symbol,
          payload: {
            action: 'CLOSE',
            symbol,
            positionSide: request.side,
            orderType: 'MARKET',
            price: null,
            quantity: latestQuantity,
            leverage: null,
          } satisfies ContractOrderIntentPayload,
          baselineIds,
        });
        await savePendingTradeIntent(intent);
        activeIntent = intent;
        intentPersisted = true;
        pendingOrderIntentRef.current = intent;
        setPendingOrderIntent(intent);

        const safeToSend =
          screenMountedRef.current &&
          marketScreenActiveRef.current &&
          activeInstrumentKeyRef.current === preparationInstrumentKey &&
          activeOrderIntentScopeRef.current === preparationOrderIntentScope &&
          executionLifecycleGenerationRef.current === lifecycleGeneration;
        if (!safeToSend) {
          throw new Error(tRef.current('contract.notSentChanged'));
        }

        setFeedbackText(tRef.current('contract.submittingOrder'));
        const result = await closeContractSummaryOrder({
          symbol,
          side: request.side,
          order_type: 'MARKET',
          client_order_id: intent.clientOrderId,
          quantity: latestQuantity,
        });
        activeRequestConfirmed = true;
        if (result.status !== 'FILLED') {
          throw new Error(
            tRef.current('contract.closeAllNotFullyFilled', {
              side: tRef.current(
                request.side === 'LONG'
                  ? 'trading.position.long'
                  : 'trading.position.short',
              ),
              status: result.status,
              closed: result.closedQuantity,
              requested: result.requestedQuantity,
              asset: baseAsset,
            }),
          );
        }
        const cleared = await clearPendingTradeIntent(intent);
        if (!cleared) {
          throw new Error(tRef.current('contract.protectionStateChanged'));
        }
        activeIntent = null;
        intentPersisted = false;
        pendingOrderIntentRef.current = null;
        setPendingOrderIntent(null);

        const identity =
          result.orderIds.length > 0 ? ` #${result.orderIds.join(', #')}` : '';
        const message = tRef.current('contract.submittedResult', {
          action: tRef.current('trading.action.close'),
          identity,
          status: result.status,
        });
        setFeedbackText(message);
        setFeedbackTone('success');
        await loadPrivateData().catch(() => undefined);
        if (
          screenMountedRef.current &&
          activeInstrumentKeyRef.current === preparationInstrumentKey &&
          activeOrderIntentScopeRef.current === preparationOrderIntentScope
        ) {
          Alert.alert(tRef.current('contract.submittedTitle'), message);
        }
      } catch (error) {
        const potentiallyCommitted =
          activeRequestConfirmed ||
          isPotentiallyCommittedMutationError(error, {
            invalidResponseCodes: ['INVALID_CONTRACT_CLOSE_RESPONSE'],
          });
        let cleared = false;
        if (activeIntent && intentPersisted && !potentiallyCommitted) {
          try {
            cleared = await clearPendingTradeIntent(activeIntent);
          } catch {
            cleared = false;
          }
        }
        if (activeIntent && cleared) {
          pendingOrderIntentRef.current = null;
          setPendingOrderIntent(null);
        }
        if (activeIntent && potentiallyCommitted) {
          await loadPendingOrderReconciliationData();
        }
        const rawMessage = getTradingErrorMessage(
          error,
          tRef.current('contract.submitFailed'),
        );
        const message =
          activeIntent && !cleared
            ? rawMessage + tRef.current('contract.protectionSuffix')
            : rawMessage;
        setFeedbackText(message);
        setFeedbackTone('error');
        Alert.alert(
          potentiallyCommitted
            ? tRef.current('contract.resultPendingTitle')
            : tRef.current('contract.submitFailedTitle'),
          message,
        );
      } finally {
        submittingRef.current = false;
        if (screenMountedRef.current) setSubmitting(false);
      }
    },
    [
      baseAsset,
      instrumentKey,
      loadPendingOrderReconciliationData,
      loadPrivateData,
      orderIntentGuardMessage,
      orderIntentHydratedScope,
      orderIntentLoadError,
      orderIntentOwnerKey,
      orderIntentScope,
      quantityPrecision,
      symbol,
    ],
  );

  const handlePreparePositionClose = useCallback(
    async (position: ContractPositionItem) => {
      if (
        submittingRef.current ||
        tpSlSavingRef.current ||
        confirmOpenRef.current ||
        positionClosePreparingRef.current
      ) {
        return;
      }
      positionClosePreparingRef.current = true;
      const openingInstrumentKey = instrumentKey;
      const normalizedPositionSymbol = position.symbol.trim().toUpperCase();
      const rejectClosePreparation = (message: string) => {
        setFeedbackText(message);
        setFeedbackTone('error');
        Alert.alert(tRef.current('contract.cannotSubmit'), message);
      };

      try {
        const privateAuthority = privateAuthorityRef.current;
        const historyUpdatedAtMs = privateHistoryUpdatedAtMsRef.current;
        const snapshotFresh =
          privateAuthority.ready &&
          privateAuthority.symbol === symbol &&
          privateAuthority.expiresAtMs !== null &&
          privateAuthority.expiresAtMs > Date.now() &&
          privateHistoryReadyRef.current &&
          historyUpdatedAtMs !== null &&
          historyUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS > Date.now();

        if (!snapshotFresh) {
          setFeedbackText(tRef.current('trading.syncingAccountOrders'));
          setFeedbackTone(null);
          await loadPrivateData().catch(() => undefined);
        }

        if (
          !screenMountedRef.current ||
          !marketScreenActiveRef.current ||
          activeInstrumentKeyRef.current !== openingInstrumentKey ||
          activeOrderIntentScopeRef.current !== orderIntentScope
        ) {
          return;
        }

        const refreshedAuthority = privateAuthorityRef.current;
        const refreshedHistoryUpdatedAtMs =
          privateHistoryUpdatedAtMsRef.current;
        const refreshedSnapshotFresh =
          refreshedAuthority.ready &&
          refreshedAuthority.symbol === symbol &&
          refreshedAuthority.expiresAtMs !== null &&
          refreshedAuthority.expiresAtMs > Date.now() &&
          privateHistoryReadyRef.current &&
          refreshedHistoryUpdatedAtMs !== null &&
          refreshedHistoryUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS >
            Date.now();
        if (!refreshedSnapshotFresh) {
          rejectClosePreparation(tRef.current('contract.privateDataStale'));
          return;
        }

        const refreshedPosition = positionsRef.current.find(
          item =>
            item.id === position.id &&
            item.side === position.side &&
            item.symbol.trim().toUpperCase() === normalizedPositionSymbol,
        );
        if (!refreshedPosition) {
          rejectClosePreparation(
            tRef.current('contract.noClosablePosition', {
              side: tRef.current(
                position.side === 'LONG'
                  ? 'trading.position.long'
                  : 'trading.position.short',
              ),
            }),
          );
          return;
        }

        const positionQuantity = Number(
          refreshedPosition.quantity.replace(/,/g, ''),
        );
        if (!Number.isFinite(positionQuantity) || positionQuantity <= 0) {
          rejectClosePreparation(tRef.current('contract.invalidQuantity'));
          return;
        }
        const nextQuantity = formatOrderDecimal(
          positionQuantity,
          quantityPrecision,
        );
        if (!orderIntentOwnerKey) {
          rejectClosePreparation(tRef.current('contract.loginNotReady'));
          return;
        }
        if (
          orderIntentHydratedScope !== orderIntentScope ||
          orderIntentLoadError ||
          pendingOrderIntentRef.current
        ) {
          rejectClosePreparation(
            orderIntentGuardMessage ||
              tRef.current('contract.orderPendingNoDuplicate'),
          );
          return;
        }
        const executionAuthority = executionAuthorityRef.current;
        if (
          !executionAuthority.ready ||
          executionAuthority.expiresAtMs === null ||
          executionAuthority.expiresAtMs <= Date.now() ||
          executionAuthority.bid === null ||
          executionAuthority.ask === null ||
          executionAuthority.bid <= 0 ||
          executionAuthority.ask < executionAuthority.bid
        ) {
          rejectClosePreparation(tRef.current('contract.executionUnavailable'));
          return;
        }
        const closeRequest: ContractPositionCloseRequest = {
          positionId: refreshedPosition.id,
          symbol: refreshedPosition.symbol.trim().toUpperCase(),
          side: refreshedPosition.side,
          quantity: nextQuantity,
        };
        clearFeedback();
        if (contractConfirmHidden) {
          await executePositionCloseRequest(closeRequest);
          return;
        }
        setPositionCloseRequest(closeRequest);
        confirmOpenRef.current = true;
        activeOrderConfirmRef.current = { instrumentKey, orderIntentScope };
        setOrderConfirmVisible(true);
      } finally {
        positionClosePreparingRef.current = false;
      }
    },
    [
      clearFeedback,
      contractConfirmHidden,
      executePositionCloseRequest,
      instrumentKey,
      loadPrivateData,
      orderIntentGuardMessage,
      orderIntentHydratedScope,
      orderIntentLoadError,
      orderIntentOwnerKey,
      orderIntentScope,
      quantityPrecision,
      symbol,
    ],
  );

  const handleCloseAllPositions = useCallback(async () => {
    const skipConfirmation =
      skipNextCloseAllConfirmRef.current?.instrumentKey === instrumentKey &&
      skipNextCloseAllConfirmRef.current?.orderIntentScope === orderIntentScope;
    skipNextCloseAllConfirmRef.current = null;
    if (
      submittingRef.current ||
      tpSlSavingRef.current ||
      (confirmOpenRef.current && !skipConfirmation) ||
      positionClosePreparingRef.current ||
      closingAllPositionsRef.current
    ) {
      return;
    }
    closingAllPositionsRef.current = true;
    const preparationInstrumentKey = instrumentKey;
    const preparationOrderIntentScope = orderIntentScope;
    const reject = (message: string) => {
      setFeedbackText(message);
      setFeedbackTone('error');
      Alert.alert(tRef.current('contract.cannotSubmit'), message);
    };

    try {
      if (skipConfirmation || closeAllConfirmHidden) {
        setClosingAllPositions(true);
      }
      setFeedbackText(tRef.current('trading.syncingAccountOrders'));
      setFeedbackTone(null);
      await loadPrivateData();
      if (
        !screenMountedRef.current ||
        !marketScreenActiveRef.current ||
        activeInstrumentKeyRef.current !== preparationInstrumentKey ||
        activeOrderIntentScopeRef.current !== preparationOrderIntentScope
      ) {
        return;
      }
      if (!orderIntentOwnerKey) {
        reject(tRef.current('contract.loginNotReady'));
        return;
      }
      if (
        orderIntentHydratedScope !== orderIntentScope ||
        orderIntentLoadError ||
        pendingOrderIntentRef.current
      ) {
        reject(
          orderIntentGuardMessage ||
            tRef.current('contract.orderPendingNoDuplicate'),
        );
        return;
      }

      const privateAuthority = privateAuthorityRef.current;
      const historyUpdatedAtMs = privateHistoryUpdatedAtMsRef.current;
      if (
        !privateAuthority.ready ||
        privateAuthority.symbol !== symbol ||
        privateAuthority.expiresAtMs === null ||
        privateAuthority.expiresAtMs <= Date.now() ||
        !privateHistoryReadyRef.current ||
        historyUpdatedAtMs === null ||
        historyUpdatedAtMs + CONTRACT_PRIVATE_DATA_TTL_MS <= Date.now()
      ) {
        reject(tRef.current('contract.privateDataStale'));
        return;
      }
      const executionAuthority = executionAuthorityRef.current;
      if (
        !executionAuthority.ready ||
        executionAuthority.expiresAtMs === null ||
        executionAuthority.expiresAtMs <= Date.now() ||
        executionAuthority.bid === null ||
        executionAuthority.ask === null ||
        executionAuthority.bid <= 0 ||
        executionAuthority.ask < executionAuthority.bid
      ) {
        reject(tRef.current('contract.executionUnavailable'));
        return;
      }

      const targets = buildContractCloseAllTargets(
        positionsRef.current,
        quantityPrecision,
      );
      if (targets.length === 0) {
        reject(tRef.current('contract.closeAllNoPositions'));
        return;
      }
      if (!skipConfirmation && !closeAllConfirmHidden) {
        confirmOpenRef.current = true;
        activeCloseAllConfirmRef.current = {
          instrumentKey,
          orderIntentScope,
        };
        setCloseAllConfirmVisible(true);
        return;
      }

      confirmOpenRef.current = false;
      activeCloseAllConfirmRef.current = null;
      setCloseAllConfirmVisible(false);
      submittingRef.current = true;
      setSubmitting(true);
      setClosingAllPositions(true);
      setFeedbackText(tRef.current('contract.closeAllSubmitting'));
      setFeedbackTone(null);

      let completedTargets = 0;
      let activeIntent: PendingContractOrderIntent | null = null;
      let intentPersisted = false;
      let activeRequestConfirmed = false;
      try {
        for (const target of targets) {
          if (
            !screenMountedRef.current ||
            !marketScreenActiveRef.current ||
            activeInstrumentKeyRef.current !== preparationInstrumentKey ||
            activeOrderIntentScopeRef.current !== preparationOrderIntentScope
          ) {
            throw new Error(tRef.current('contract.notSentChanged'));
          }
          if (pendingOrderIntentRef.current) {
            throw new Error(tRef.current('contract.orderPendingNoDuplicate'));
          }

          const lifecycleGeneration = executionLifecycleGenerationRef.current;
          const baselineIds = [
            ...currentOrdersRef.current,
            ...historyOrdersRef.current,
          ]
            .map(item => item.orderId)
            .filter(
              (orderId): orderId is number =>
                orderId !== null &&
                Number.isSafeInteger(orderId) &&
                orderId > 0,
            );
          const intent = createPendingTradeIntent({
            market: 'contract',
            ownerKey: orderIntentOwnerKey,
            instrumentKey: symbol,
            payload: {
              action: 'CLOSE',
              symbol,
              positionSide: target.side,
              orderType: 'MARKET',
              price: null,
              quantity: target.quantity,
              leverage: null,
            } satisfies ContractOrderIntentPayload,
            baselineIds,
          });
          await savePendingTradeIntent(intent);
          activeIntent = intent;
          intentPersisted = true;
          activeRequestConfirmed = false;
          pendingOrderIntentRef.current = intent;
          setPendingOrderIntent(intent);

          const safeToSend =
            screenMountedRef.current &&
            marketScreenActiveRef.current &&
            activeInstrumentKeyRef.current === preparationInstrumentKey &&
            activeOrderIntentScopeRef.current === preparationOrderIntentScope &&
            executionLifecycleGenerationRef.current === lifecycleGeneration;
          if (!safeToSend) {
            throw new Error(tRef.current('contract.notSentChanged'));
          }

          const result = await closeContractSummaryOrder({
            symbol,
            side: target.side,
            order_type: 'MARKET',
            client_order_id: intent.clientOrderId,
            quantity: target.quantity,
          });
          activeRequestConfirmed = true;
          const targetFullyClosed = result.status === 'FILLED';
          if (!targetFullyClosed) {
            throw new Error(
              tRef.current('contract.closeAllNotFullyFilled', {
                side: tRef.current(
                  target.side === 'LONG'
                    ? 'trading.position.long'
                    : 'trading.position.short',
                ),
                status: result.status,
                closed: result.closedQuantity,
                requested: result.requestedQuantity,
                asset: baseAsset,
              }),
            );
          }
          completedTargets += 1;
          const cleared = await clearPendingTradeIntent(intent);
          if (!cleared) {
            throw new Error(tRef.current('contract.protectionStateChanged'));
          }
          activeIntent = null;
          intentPersisted = false;
          activeRequestConfirmed = false;
          pendingOrderIntentRef.current = null;
          setPendingOrderIntent(null);
        }

        await loadPrivateData();
        if (
          buildContractCloseAllTargets(positionsRef.current, quantityPrecision)
            .length > 0
        ) {
          const message = tRef.current('contract.closeAllRemainingPositions');
          setFeedbackText(message);
          setFeedbackTone('error');
          Alert.alert(tRef.current('contract.cannotSubmit'), message);
          return;
        }
        const message = tRef.current('contract.closeAllSuccess', {
          symbol: localizedDisplayLabel,
        });
        setFeedbackText(message);
        setFeedbackTone('success');
        Alert.alert(tRef.current('contract.submittedTitle'), message);
      } catch (error) {
        const potentiallyCommitted =
          activeRequestConfirmed ||
          isPotentiallyCommittedMutationError(error, {
            invalidResponseCodes: ['INVALID_CONTRACT_CLOSE_RESPONSE'],
          });
        let cleared = false;
        if (activeIntent && intentPersisted && !potentiallyCommitted) {
          try {
            cleared = await clearPendingTradeIntent(activeIntent);
          } catch {
            cleared = false;
          }
        }
        if (activeIntent && cleared) {
          pendingOrderIntentRef.current = null;
          setPendingOrderIntent(null);
        }
        if (activeIntent && potentiallyCommitted) {
          await loadPendingOrderReconciliationData();
        }
        const rawMessage = getTradingErrorMessage(
          error,
          tRef.current('contract.submitFailed'),
        );
        const protectedMessage =
          activeIntent && !cleared
            ? rawMessage + tRef.current('contract.protectionSuffix')
            : rawMessage;
        const message =
          completedTargets > 0
            ? tRef.current('contract.closeAllPartial', {
                completed: completedTargets,
                message: protectedMessage,
              })
            : protectedMessage;
        setFeedbackText(message);
        setFeedbackTone('error');
        Alert.alert(
          potentiallyCommitted
            ? tRef.current('contract.resultPendingTitle')
            : tRef.current('contract.submitFailedTitle'),
          message,
        );
      } finally {
        submittingRef.current = false;
        if (screenMountedRef.current) setSubmitting(false);
      }
    } finally {
      closingAllPositionsRef.current = false;
      if (screenMountedRef.current) setClosingAllPositions(false);
    }
  }, [
    baseAsset,
    closeAllConfirmHidden,
    instrumentKey,
    loadPendingOrderReconciliationData,
    loadPrivateData,
    localizedDisplayLabel,
    orderIntentGuardMessage,
    orderIntentHydratedScope,
    orderIntentLoadError,
    orderIntentOwnerKey,
    orderIntentScope,
    quantityPrecision,
    symbol,
  ]);

  const handleOpenPositionTpSl = useCallback(
    (position: ContractPositionItem) => {
      if (submittingRef.current || tpSlSavingRef.current) return;
      setTpSlPosition(position);
      setTakeProfitPrice(position.takeProfitPrice || '');
      setStopLossPrice(position.stopLossPrice || '');
      setTpSlError(null);
    },
    [],
  );

  const handleClosePositionTpSl = useCallback(() => {
    if (tpSlSavingRef.current) return;
    setTpSlPosition(null);
    setTakeProfitPrice('');
    setStopLossPrice('');
    setTpSlError(null);
  }, []);

  const handleSavePositionTpSl = useCallback(async () => {
    if (!tpSlPosition || tpSlSavingRef.current) return;
    const activePosition = positions.find(item => item.id === tpSlPosition.id);
    const privateAuthority = privateAuthorityRef.current;
    if (
      !activePosition ||
      activePosition.symbol !== symbol ||
      !privateAuthority.ready ||
      privateAuthority.symbol !== symbol ||
      privateAuthority.expiresAtMs === null ||
      privateAuthority.expiresAtMs <= Date.now()
    ) {
      setTpSlError(tRef.current('contract.privateDataStale'));
      return;
    }

    const parseOptionalPrice = (value: string) => {
      if (!value.trim()) return null;
      const parsed = parsePositiveDecimal(value);
      if (!parsed) throw new Error(tRef.current('contract.tpSlInvalidPrice'));
      if (parsed.decimalPlaces > pricePrecision) {
        throw new Error(
          tRef.current('contract.pricePrecision', {
            precision: pricePrecision,
          }),
        );
      }
      return parsed;
    };

    let parsedTakeProfit: ReturnType<typeof parseOptionalPrice>;
    let parsedStopLoss: ReturnType<typeof parseOptionalPrice>;
    try {
      parsedTakeProfit = parseOptionalPrice(takeProfitPrice);
      parsedStopLoss = parseOptionalPrice(stopLossPrice);
    } catch (error) {
      setTpSlError(
        error instanceof Error
          ? error.message
          : tRef.current('contract.tpSlInvalidPrice'),
      );
      return;
    }

    const snapshotMarkPrice = Number(
      activePosition.markPrice.replace(/,/g, ''),
    );
    const triggerPriceValue = tpSlReferencePrice ?? snapshotMarkPrice;
    if (!Number.isFinite(triggerPriceValue) || triggerPriceValue <= 0) {
      setTpSlError(tRef.current('contract.privateDataStale'));
      return;
    }
    const relationValid =
      activePosition.side === 'LONG'
        ? (parsedTakeProfit === null ||
            parsedTakeProfit.value > triggerPriceValue) &&
          (parsedStopLoss === null || parsedStopLoss.value < triggerPriceValue)
        : (parsedTakeProfit === null ||
            parsedTakeProfit.value < triggerPriceValue) &&
          (parsedStopLoss === null || parsedStopLoss.value > triggerPriceValue);
    if (!relationValid) {
      setTpSlError(tRef.current('contract.tpSlRelationInvalid'));
      return;
    }

    tpSlSavingRef.current = true;
    setTpSlSaving(true);
    setTpSlError(null);
    try {
      const result = await updateContractPositionTpSl(activePosition, {
        take_profit_price: parsedTakeProfit?.text ?? null,
        stop_loss_price: parsedStopLoss?.text ?? null,
      });
      if (
        !screenMountedRef.current ||
        activeInstrumentKeyRef.current !== instrumentKey
      ) {
        return;
      }
      setPositions(previous => {
        const nextPositions = previous.map(item =>
          item.id === activePosition.id
            ? {
                ...item,
                markPrice: result.markPrice,
                takeProfitPrice: result.takeProfitPrice,
                stopLossPrice: result.stopLossPrice,
              }
            : item,
        );
        positionsRef.current = nextPositions;
        return nextPositions;
      });
      setTpSlPosition(null);
      setTakeProfitPrice('');
      setStopLossPrice('');
      setFeedbackText(tRef.current('contract.tpSlUpdated'));
      setFeedbackTone('success');
      await loadPrivateData();
      if (
        screenMountedRef.current &&
        activeInstrumentKeyRef.current === instrumentKey
      ) {
        Alert.alert(tRef.current('contract.tpSlUpdated'));
      }
    } catch (error) {
      if (
        !screenMountedRef.current ||
        activeInstrumentKeyRef.current !== instrumentKey
      ) {
        return;
      }
      setTpSlError(
        getTradingErrorMessage(
          error,
          tRef.current('contract.tpSlUpdateFailed'),
        ),
      );
    } finally {
      tpSlSavingRef.current = false;
      if (screenMountedRef.current) setTpSlSaving(false);
    }
  }, [
    instrumentKey,
    loadPrivateData,
    positions,
    pricePrecision,
    stopLossPrice,
    symbol,
    takeProfitPrice,
    tpSlReferencePrice,
    tpSlPosition,
  ]);

  const handleActionModeChange = useCallback(
    (nextMode: ContractActionMode) => {
      clearFeedback();
      setActionMode(currentMode => {
        if (currentMode !== nextMode) {
          setDirection(currentDirection =>
            currentDirection === 'LONG' ? 'SHORT' : 'LONG',
          );
        }
        return nextMode;
      });
    },
    [clearFeedback],
  );

  const handleDirectionChange = useCallback(
    (nextDirection: ContractDirection) => {
      clearFeedback();
      setDirection(nextDirection);
    },
    [clearFeedback],
  );

  const handleOrderTypeChange = useCallback(
    (nextOrderType: ContractOrderType) => {
      clearFeedback();
      setOrderType(nextOrderType);
    },
    [clearFeedback],
  );

  const handlePriceChange = useCallback(
    (nextPrice: string) => {
      clearFeedback();
      setPrice(nextPrice);
    },
    [clearFeedback],
  );

  const handleQuantityChange = useCallback(
    (nextQuantity: string) => {
      clearFeedback();
      setQuantity(nextQuantity);
    },
    [clearFeedback],
  );

  const handleLeverageChange = useCallback(
    (nextLeverage: number) => {
      if (
        submittingRef.current ||
        confirmOpenRef.current ||
        symbolRules === null
      ) {
        return;
      }
      clearFeedback();
      setLeverage(clampContractLeverage(nextLeverage, symbolRules.maxLeverage));
    },
    [clearFeedback, symbolRules],
  );

  const openLogin = useCallback(() => {
    navigation.navigate('Auth', { screen: 'Login' });
  }, [navigation]);

  const openMarketSelector = useCallback(() => {
    setMarketSelectorOpen(true);
  }, []);

  const handleSelectMarket = useCallback(
    (item: ContractCatalogInstrument) => {
      setMarketSelectorOpen(false);
      navigation.navigate('Contract', {
        symbol: item.symbol,
        baseAsset: item.baseAsset,
        quoteAsset: item.quoteAsset,
        displayLabel: item.displayName,
        marketCategory: item.marketCategory,
        ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
      });
    },
    [navigation],
  );

  const handleBusinessChange = useCallback((key: string) => {
    setActiveBusiness(key);
  }, []);

  const handleBboPress = useCallback(() => {
    clearFeedback();
    const currentSizing = orderSizingRef.current;
    const currentReferencePrice = currentSizing.executionReferencePrice;
    if (currentReferencePrice !== null) {
      setPrice(
        formatOrderDecimal(currentReferencePrice, currentSizing.pricePrecision),
      );
    }
  }, [clearFeedback]);

  const handlePercentPress = useCallback(
    (percent: number) => {
      clearFeedback();
      const currentSizing = orderSizingRef.current;
      if (currentSizing.actionMode === 'CLOSE') {
        const matched = currentSizing.positions.filter(
          item => item.side === currentSizing.direction,
        );
        const totalQuantity = matched.reduce((sum, item) => {
          const value = Number(item.quantity);
          return Number.isFinite(value) ? sum + value : sum;
        }, 0);
        if (totalQuantity > 0) {
          setQuantity(
            formatOrderDecimal(
              (totalQuantity * percent) / 100,
              currentSizing.quantityPrecision,
            ),
          );
        }
        return;
      }

      const referencePrice =
        currentSizing.orderType === 'MARKET'
          ? currentSizing.executionReferencePrice
          : Number(currentSizing.price.replace(/,/g, ''));
      if (!currentSizing.availableMargin || !referencePrice) return;
      const notional =
        (currentSizing.availableMargin * percent * currentSizing.leverage) /
        100;
      setQuantity(
        formatOrderDecimal(
          notional / referencePrice,
          currentSizing.quantityPrecision,
        ),
      );
    },
    [clearFeedback],
  );

  const acquireFreshExecutionAuthority = useCallback(
    async (
      expectedLifecycleGeneration: number,
      expectedInstrumentKey: string,
    ): Promise<ContractExecutionAuthority | null> => {
      const currentAuthority = executionAuthorityRef.current;
      if (
        currentAuthority.ready &&
        currentAuthority.expiresAtMs !== null &&
        currentAuthority.expiresAtMs > Date.now() &&
        currentAuthority.bid !== null &&
        currentAuthority.ask !== null &&
        currentAuthority.bid > 0 &&
        currentAuthority.ask >= currentAuthority.bid
      ) {
        return currentAuthority;
      }
      if (waitingForExecutionLeaseRef.current) return null;

      waitingForExecutionLeaseRef.current = true;
      setWaitingForExecutionLease(true);
      try {
        const grant = await getContractMarketRealtimeStore(
          symbol,
        ).waitForExecutionLease();
        if (
          !grant ||
          !screenMountedRef.current ||
          !marketScreenActiveRef.current ||
          executionLifecycleGenerationRef.current !==
            expectedLifecycleGeneration ||
          activeInstrumentKeyRef.current !== expectedInstrumentKey ||
          grant.lease.expiresAtMs <= Date.now()
        ) {
          return null;
        }
        return {
          ready: true,
          bid: grant.lease.executionBid,
          ask: grant.lease.executionAsk,
          expiresAtMs: grant.lease.expiresAtMs,
          generation: grant.executionGeneration,
        };
      } finally {
        waitingForExecutionLeaseRef.current = false;
        if (screenMountedRef.current) setWaitingForExecutionLease(false);
      }
    },
    [symbol],
  );

  const handleSubmit = useCallback(async () => {
    const skipConfirmation =
      skipNextOrderConfirmRef.current?.instrumentKey === instrumentKey &&
      skipNextOrderConfirmRef.current?.orderIntentScope === orderIntentScope;
    skipNextOrderConfirmRef.current = null;
    if (
      submittingRef.current ||
      waitingForExecutionLeaseRef.current ||
      (confirmOpenRef.current && !skipConfirmation)
    ) {
      return;
    }

    const reject = (message: string) => {
      setFeedbackText(message);
      setFeedbackTone('error');
      Alert.alert(tRef.current('contract.cannotSubmit'), message);
    };
    if (!orderIntentOwnerKey) {
      reject(tRef.current('contract.loginNotReady'));
      return;
    }
    if (
      orderIntentHydratedScope !== orderIntentScope ||
      orderIntentLoadError ||
      pendingOrderIntentRef.current
    ) {
      reject(
        orderIntentGuardMessage ||
          tRef.current('contract.orderPendingNoDuplicate'),
      );
      return;
    }
    if (!symbolRules) {
      reject(tRef.current('contract.rulesNotLoaded'));
      return;
    }
    if (
      !privateHistoryReadyRef.current ||
      privateHistoryUpdatedAtMsRef.current === null ||
      privateHistoryUpdatedAtMsRef.current + CONTRACT_PRIVATE_DATA_TTL_MS <=
        Date.now()
    ) {
      reject(tRef.current('contract.historyNotSynced'));
      return;
    }
    const openingPrivateAuthority = privateAuthorityRef.current;
    if (
      !privateCriticalReady ||
      !openingPrivateAuthority.ready ||
      openingPrivateAuthority.symbol !== symbol ||
      openingPrivateAuthority.expiresAtMs === null ||
      openingPrivateAuthority.expiresAtMs <= Date.now()
    ) {
      reject(tRef.current('contract.privateDataStale'));
      return;
    }
    const openingLifecycleGeneration = executionLifecycleGenerationRef.current;
    const openingOrderIntentScope = orderIntentScope;
    const openingInstrumentKey = instrumentKey;
    let openingAuthority = executionAuthorityRef.current;
    if (
      !marketScreenActiveRef.current ||
      !openingAuthority.ready ||
      openingAuthority.expiresAtMs === null ||
      openingAuthority.expiresAtMs <= Date.now()
    ) {
      openingAuthority =
        (await acquireFreshExecutionAuthority(
          openingLifecycleGeneration,
          openingInstrumentKey,
        )) || unavailableExecutionAuthority();
      if (!openingAuthority.ready) {
        reject(tRef.current('contract.executionUnavailable'));
        return;
      }
    }
    if (!Number.isSafeInteger(leverage) || leverage < CONTRACT_MIN_LEVERAGE) {
      reject(tRef.current('contract.invalidLeverage'));
      return;
    }
    if (leverage > symbolRules.maxLeverage) {
      reject(
        tRef.current('contract.maxLeverage', {
          leverage: symbolRules.maxLeverage,
        }),
      );
      return;
    }
    const openingRulesGeneration = rulesGenerationRef.current;

    const parsedQuantity = parsePositiveDecimal(quantity);
    if (!parsedQuantity) {
      reject(tRef.current('contract.invalidQuantity'));
      return;
    }
    if (parsedQuantity.decimalPlaces > symbolRules.quantityPrecision) {
      reject(
        tRef.current('contract.quantityPrecision', {
          precision: symbolRules.quantityPrecision,
        }),
      );
      return;
    }
    if (
      actionMode === 'OPEN' &&
      parsedQuantity.value < symbolRules.minQuantity
    ) {
      reject(
        tRef.current('contract.minOpenQuantity', {
          quantity: formatOrderDecimal(
            symbolRules.minQuantity,
            symbolRules.quantityPrecision,
          ),
          asset: baseAsset,
        }),
      );
      return;
    }
    if (
      actionMode === 'OPEN' &&
      symbolRules.maxQuantity > 0 &&
      parsedQuantity.value > symbolRules.maxQuantity
    ) {
      reject(
        tRef.current('contract.maxOpenQuantity', {
          quantity: formatOrderDecimal(
            symbolRules.maxQuantity,
            symbolRules.quantityPrecision,
          ),
          asset: baseAsset,
        }),
      );
      return;
    }

    const parsedPrice =
      orderType === 'LIMIT' ? parsePositiveDecimal(price) : null;
    if (orderType === 'LIMIT' && !parsedPrice) {
      reject(tRef.current('contract.invalidLimitPrice'));
      return;
    }
    if (parsedPrice && parsedPrice.decimalPlaces > pricePrecision) {
      reject(
        tRef.current('contract.pricePrecision', {
          precision: pricePrecision,
        }),
      );
      return;
    }

    if (
      openingAuthority.bid === null ||
      openingAuthority.ask === null ||
      openingAuthority.bid <= 0 ||
      openingAuthority.ask <= 0 ||
      openingAuthority.ask < openingAuthority.bid
    ) {
      reject(tRef.current('contract.bboUnavailable'));
      return;
    }

    const referencePrice =
      orderType === 'LIMIT'
        ? parsedPrice?.value ?? null
        : useAsk
        ? openingAuthority.ask
        : openingAuthority.bid;
    if (
      referencePrice === null ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      reject(tRef.current('contract.referenceUnavailable'));
      return;
    }

    const notional = referencePrice * parsedQuantity.value;
    const estimatedMargin = notional / leverage;
    if (
      !Number.isFinite(notional) ||
      !Number.isFinite(estimatedMargin) ||
      notional <= 0 ||
      estimatedMargin <= 0
    ) {
      reject(tRef.current('contract.calculationFailed'));
      return;
    }

    let closableQuantity = 0;
    if (actionMode === 'OPEN') {
      if (availableMargin === null) {
        reject(tRef.current('contract.accountNotLoaded'));
        return;
      }
      if (
        estimatedMargin >
        availableMargin + Math.max(availableMargin * 1e-12, 1e-10)
      ) {
        reject(tRef.current('contract.insufficientMargin'));
        return;
      }
    } else {
      closableQuantity = positions
        .filter(item => item.side === direction)
        .reduce((sum, item) => {
          const value = Number(item.quantity.replace(/,/g, ''));
          return Number.isFinite(value) && value > 0 ? sum + value : sum;
        }, 0);
      if (closableQuantity <= 0) {
        reject(
          tRef.current('contract.noClosablePosition', {
            side: tRef.current(
              direction === 'LONG'
                ? 'trading.position.long'
                : 'trading.position.short',
            ),
          }),
        );
        return;
      }
      if (
        parsedQuantity.value >
        closableQuantity + Math.max(closableQuantity * 1e-12, 1e-10)
      ) {
        reject(tRef.current('contract.closeExceedsPosition'));
        return;
      }
    }

    if (!skipConfirmation && !contractConfirmHidden) {
      confirmOpenRef.current = true;
      activeOrderConfirmRef.current = { instrumentKey, orderIntentScope };
      setOrderConfirmVisible(true);
      return;
    }

    confirmOpenRef.current = false;
    setOrderConfirmVisible(false);
    (async () => {
      if (submittingRef.current) return;
      const refAuthority = executionAuthorityRef.current;
      const currentAuthority =
        refAuthority.ready &&
        refAuthority.expiresAtMs !== null &&
        refAuthority.expiresAtMs > Date.now()
          ? refAuthority
          : openingAuthority;
      const lifecycleCurrent =
        marketScreenActiveRef.current &&
        executionLifecycleGenerationRef.current ===
          openingLifecycleGeneration &&
        activeInstrumentKeyRef.current === openingInstrumentKey &&
        activeOrderIntentScopeRef.current === openingOrderIntentScope &&
        rulesGenerationRef.current === openingRulesGeneration &&
        privateHistoryReadyRef.current &&
        privateHistoryUpdatedAtMsRef.current !== null &&
        privateHistoryUpdatedAtMsRef.current + CONTRACT_PRIVATE_DATA_TTL_MS >
          Date.now();
      if (!lifecycleCurrent) {
        return;
      }
      const currentPrivateAuthority = privateAuthorityRef.current;
      const privateAuthorityReady =
        currentPrivateAuthority.ready &&
        currentPrivateAuthority.symbol === symbol &&
        currentPrivateAuthority.expiresAtMs !== null &&
        currentPrivateAuthority.expiresAtMs > Date.now();
      if (!privateAuthorityReady) {
        const message = tRef.current('contract.privateChangedDuringConfirm');
        setFeedbackText(message);
        setFeedbackTone('error');
        Alert.alert(tRef.current('contract.cannotSubmit'), message);
        return;
      }
      const currentAuthorityReady =
        currentAuthority.ready &&
        currentAuthority.expiresAtMs !== null &&
        currentAuthority.expiresAtMs > Date.now() &&
        currentAuthority.bid !== null &&
        currentAuthority.ask !== null &&
        currentAuthority.bid > 0 &&
        currentAuthority.ask > 0 &&
        currentAuthority.ask >= currentAuthority.bid;
      if (!currentAuthorityReady) {
        const message = tRef.current('contract.quoteChangedDuringConfirm');
        setFeedbackText(message);
        setFeedbackTone('error');
        Alert.alert(tRef.current('contract.cannotSubmit'), message);
        return;
      }
      submittingRef.current = true;
      setSubmitting(true);
      setFeedbackText(tRef.current('contract.preparing'));
      setFeedbackTone(null);
      const baselineIds = [
        ...currentOrdersRef.current,
        ...historyOrdersRef.current,
      ]
        .map(item => item.orderId)
        .filter(
          (orderId): orderId is number =>
            orderId !== null && Number.isSafeInteger(orderId) && orderId > 0,
        );
      const intentPayload: ContractOrderIntentPayload = {
        action: actionMode,
        symbol,
        positionSide: direction,
        orderType,
        price: orderType === 'LIMIT' ? parsedPrice!.text : null,
        quantity: parsedQuantity.text,
        leverage: actionMode === 'OPEN' ? leverage : null,
      };
      const intent = createPendingTradeIntent({
        market: 'contract',
        ownerKey: orderIntentOwnerKey,
        instrumentKey: symbol,
        payload: intentPayload,
        baselineIds,
      });
      let intentPersisted = false;
      try {
        await savePendingTradeIntent(intent);
        intentPersisted = true;
        const stillSafeToSend =
          screenMountedRef.current &&
          marketScreenActiveRef.current &&
          executionLifecycleGenerationRef.current ===
            openingLifecycleGeneration &&
          activeInstrumentKeyRef.current === openingInstrumentKey &&
          activeOrderIntentScopeRef.current === openingOrderIntentScope &&
          rulesGenerationRef.current === openingRulesGeneration;
        if (!stillSafeToSend) {
          let localLockCleared = false;
          try {
            localLockCleared = await clearPendingTradeIntent(intent);
          } catch {
            localLockCleared = false;
          }
          if (
            screenMountedRef.current &&
            activeInstrumentKeyRef.current === openingInstrumentKey &&
            activeOrderIntentScopeRef.current === openingOrderIntentScope &&
            executionLifecycleGenerationRef.current ===
              openingLifecycleGeneration
          ) {
            if (!localLockCleared) {
              pendingOrderIntentRef.current = intent;
              setPendingOrderIntent(intent);
            }
            const message = localLockCleared
              ? tRef.current('contract.notSentChanged')
              : tRef.current('contract.notSentProtected');
            setFeedbackText(message);
            setFeedbackTone('error');
            Alert.alert(tRef.current('contract.notSentTitle'), message);
          }
          return;
        }
        pendingOrderIntentRef.current = intent;
        setPendingOrderIntent(intent);
        setFeedbackText(tRef.current('contract.submittingOrder'));
        let message = '';
        if (actionMode === 'OPEN') {
          const result = await openContractOrder({
            symbol,
            position_side: direction,
            order_type: orderType,
            client_order_id: intent.clientOrderId,
            price: orderType === 'LIMIT' ? parsedPrice!.text : undefined,
            quantity: parsedQuantity.text,
            leverage,
          });
          const identity =
            result.orderNo || (result.orderId > 0 ? `#${result.orderId}` : '');
          message = tRef.current('contract.submittedResult', {
            action: tRef.current('trading.action.open'),
            identity: identity ? ` ${identity}` : '',
            status: result.status,
          });
        } else {
          const result = await closeContractSummaryOrder({
            symbol,
            side: direction,
            order_type: orderType,
            client_order_id: intent.clientOrderId,
            price: orderType === 'LIMIT' ? parsedPrice!.text : undefined,
            quantity: parsedQuantity.text,
          });
          const identity =
            result.orderIds.length > 0
              ? ` #${result.orderIds.join(', #')}`
              : '';
          message = tRef.current('contract.submittedResult', {
            action: tRef.current('trading.action.close'),
            identity,
            status: result.status,
          });
        }

        try {
          const cleared = await clearPendingTradeIntent(intent);
          if (cleared && pendingOrderIntentRef.current?.id === intent.id) {
            pendingOrderIntentRef.current = null;
            setPendingOrderIntent(null);
          }
        } catch {
          // The response is authoritative. Keep the lock fail-closed if
          // local persistence cannot be cleared, then reconcile below.
        }

        if (
          !screenMountedRef.current ||
          !marketScreenActiveRef.current ||
          executionLifecycleGenerationRef.current !==
            openingLifecycleGeneration ||
          activeInstrumentKeyRef.current !== openingInstrumentKey
        ) {
          return;
        }
        setQuantity('');
        setFeedbackText(message);
        setFeedbackTone('success');
        await loadPrivateData();
        if (
          screenMountedRef.current &&
          marketScreenActiveRef.current &&
          executionLifecycleGenerationRef.current ===
            openingLifecycleGeneration &&
          activeInstrumentKeyRef.current === openingInstrumentKey
        ) {
          Alert.alert(tRef.current('contract.submittedTitle'), message);
        }
      } catch (error) {
        if (!intentPersisted) {
          if (
            screenMountedRef.current &&
            marketScreenActiveRef.current &&
            executionLifecycleGenerationRef.current ===
              openingLifecycleGeneration &&
            activeInstrumentKeyRef.current === openingInstrumentKey
          ) {
            const message = tRef.current('contract.preparationFailed');
            setFeedbackText(message);
            setFeedbackTone('error');
            Alert.alert(tRef.current('contract.notSentTitle'), message);
          }
          return;
        }

        const potentiallyCommitted = isPotentiallyCommittedMutationError(
          error,
          {
            invalidResponseCodes: [
              'INVALID_CONTRACT_ORDER_RESPONSE',
              'INVALID_CONTRACT_CLOSE_RESPONSE',
            ],
          },
        );
        if (!potentiallyCommitted) {
          try {
            const cleared = await clearPendingTradeIntent(intent);
            if (cleared && pendingOrderIntentRef.current?.id === intent.id) {
              pendingOrderIntentRef.current = null;
              setPendingOrderIntent(null);
            }
          } catch {
            // Keep the lock fail-closed if persistence cannot be cleared.
          }
        } else if (
          screenMountedRef.current &&
          marketScreenActiveRef.current &&
          executionLifecycleGenerationRef.current ===
            openingLifecycleGeneration &&
          activeInstrumentKeyRef.current === openingInstrumentKey &&
          activeOrderIntentScopeRef.current === openingOrderIntentScope
        ) {
          await loadPendingOrderReconciliationData();
        }

        if (
          !screenMountedRef.current ||
          !marketScreenActiveRef.current ||
          executionLifecycleGenerationRef.current !==
            openingLifecycleGeneration ||
          activeInstrumentKeyRef.current !== openingInstrumentKey
        ) {
          return;
        }
        if (potentiallyCommitted) {
          if (pendingOrderIntentRef.current?.id !== intent.id) {
            setQuantity('');
            Alert.alert(
              tRef.current('recovery.confirmedTitle'),
              tRef.current('contract.confirmedAndReleased'),
            );
            return;
          }
          const message = tRef.current('contract.possiblyAccepted');
          setFeedbackText(message);
          setFeedbackTone('error');
          Alert.alert(tRef.current('contract.resultPendingTitle'), message);
          return;
        }
        const message = getTradingErrorMessage(
          error,
          tRef.current('contract.submitFailed'),
        );
        const lockRetained = pendingOrderIntentRef.current?.id === intent.id;
        const finalMessage = lockRetained
          ? tRef.current('contract.submitProtected', { message })
          : message;
        setFeedbackText(finalMessage);
        setFeedbackTone('error');
        Alert.alert(tRef.current('contract.submitFailedTitle'), finalMessage);
      } finally {
        submittingRef.current = false;
        if (screenMountedRef.current) setSubmitting(false);
      }
    })().catch(() => undefined);
  }, [
    actionMode,
    acquireFreshExecutionAuthority,
    availableMargin,
    baseAsset,
    contractConfirmHidden,
    direction,
    instrumentKey,
    leverage,
    loadPrivateData,
    loadPendingOrderReconciliationData,
    orderIntentGuardMessage,
    orderIntentHydratedScope,
    orderIntentLoadError,
    orderIntentOwnerKey,
    orderIntentScope,
    orderType,
    positions,
    price,
    pricePrecision,
    privateCriticalReady,
    quantity,
    symbolRules,
    symbol,
    useAsk,
  ]);

  useEffect(
    () => () => {
      if (klineIntervalTimerRef.current !== null) {
        clearTimeout(klineIntervalTimerRef.current);
      }
    },
    [],
  );

  const handleCancelOrder = useCallback(
    (order: ContractOrderItem) => {
      if (
        !canCancelContractOrder(order) ||
        cancelingOrderIdRef.current !== null ||
        cancelConfirmationOrderIdRef.current !== null
      ) {
        return;
      }
      const orderId = order.orderId;
      if (orderId === null) return;
      if (order.symbol.trim().toUpperCase() !== symbol) {
        Alert.alert(
          tRef.current('spot.cannotCancelTitle'),
          tRef.current('contract.wrongSymbolCancel'),
        );
        return;
      }

      const openingLifecycleGeneration =
        executionLifecycleGenerationRef.current;
      const openingInstrumentKey = instrumentKey;
      cancelConfirmationOrderIdRef.current = orderId;
      const orderQuantityValue = Number(order.quantity);
      const filledQuantity = Number(order.filledQuantity);
      const remainingQuantity =
        Number.isFinite(orderQuantityValue) && Number.isFinite(filledQuantity)
          ? Math.max(orderQuantityValue - filledQuantity, 0)
          : null;
      const remainingText =
        remainingQuantity === null
          ? order.quantity
          : formatOrderDecimal(remainingQuantity, 18) || '0';
      Alert.alert(
        tRef.current('spot.confirmCancelTitle'),
        [
          `${order.symbol} ${order.action} ${order.positionSide}`,
          tRef.current('contract.cancelPrice', { price: order.price }),
          tRef.current('contract.cancelRemaining', { amount: remainingText }),
          '',
          tRef.current('contract.cancelConfirmHint'),
        ].join('\n'),
        [
          {
            text: tRef.current('common.cancel'),
            style: 'cancel',
            onPress: () => {
              if (cancelConfirmationOrderIdRef.current === orderId) {
                cancelConfirmationOrderIdRef.current = null;
              }
            },
          },
          {
            text: tRef.current('spot.confirmCancel'),
            style: 'destructive',
            onPress: async () => {
              if (
                cancelConfirmationOrderIdRef.current !== orderId ||
                cancelingOrderIdRef.current !== null ||
                !canCancelContractOrder(order) ||
                !marketScreenActiveRef.current ||
                executionLifecycleGenerationRef.current !==
                  openingLifecycleGeneration ||
                activeInstrumentKeyRef.current !== openingInstrumentKey
              ) {
                return;
              }
              cancelConfirmationOrderIdRef.current = null;
              cancelingOrderIdRef.current = orderId;
              setCancelingOrderId(orderId);
              setOrderActionFeedback(null);
              try {
                const result = await cancelContractOrder(orderId);
                if (
                  !screenMountedRef.current ||
                  !marketScreenActiveRef.current ||
                  executionLifecycleGenerationRef.current !==
                    openingLifecycleGeneration ||
                  activeInstrumentKeyRef.current !== openingInstrumentKey
                ) {
                  return;
                }
                await loadPrivateData();
                if (
                  !screenMountedRef.current ||
                  !marketScreenActiveRef.current ||
                  executionLifecycleGenerationRef.current !==
                    openingLifecycleGeneration ||
                  activeInstrumentKeyRef.current !== openingInstrumentKey
                ) {
                  return;
                }
                const message = tRef.current('contract.cancelResult', {
                  id: result.orderId,
                  status: result.status,
                });
                setOrderActionFeedback({ tone: 'success', text: message });
                Alert.alert(
                  tRef.current('contract.cancelSuccessTitle'),
                  message,
                );
              } catch (error) {
                if (
                  !screenMountedRef.current ||
                  !marketScreenActiveRef.current ||
                  executionLifecycleGenerationRef.current !==
                    openingLifecycleGeneration ||
                  activeInstrumentKeyRef.current !== openingInstrumentKey
                ) {
                  return;
                }
                const message = getTradingErrorMessage(
                  error,
                  tRef.current('contract.cancelFailed'),
                );
                setOrderActionFeedback({ tone: 'error', text: message });
                Alert.alert(
                  tRef.current('contract.cancelFailedTitle'),
                  message,
                );
              } finally {
                cancelingOrderIdRef.current = null;
                if (screenMountedRef.current) {
                  setCancelingOrderId(null);
                }
              }
            },
          },
        ],
        {
          cancelable: true,
          onDismiss: () => {
            if (cancelConfirmationOrderIdRef.current === orderId) {
              cancelConfirmationOrderIdRef.current = null;
            }
          },
        },
      );
    },
    [instrumentKey, loadPrivateData, symbol],
  );

  const handleKlineIntervalChange = useCallback(
    (nextInterval: KlineInterval) => {
      if (klineIntervalTimerRef.current !== null) {
        clearTimeout(klineIntervalTimerRef.current);
        klineIntervalTimerRef.current = null;
      }
      pendingKlineIntervalRef.current = nextInterval;
      if (nextInterval === klineInterval) {
        pendingKlineIntervalRef.current = null;
        return;
      }
      klineIntervalTimerRef.current = setTimeout(() => {
        klineIntervalTimerRef.current = null;
        const pending = pendingKlineIntervalRef.current;
        pendingKlineIntervalRef.current = null;
        if (pending) setKlineInterval(pending);
      }, KLINE_INTERVAL_SWITCH_DEBOUNCE_MS);
    },
    [klineInterval],
  );

  const handleOpenChart = useCallback(() => {
    navigation.navigate('MarketDetail', {
      market: 'contract',
      symbol,
      baseAsset,
      quoteAsset,
      displayLabel: localizedDisplayLabel,
      marketCategory,
      initialInterval: klineInterval,
      ...(contractKline.items.length > 0
        ? { initialKlines: contractKline.items.slice(-48) }
        : {}),
      ...(positionPriceLines.length > 0
        ? { referencePriceLines: positionPriceLines }
        : {}),
    });
  }, [
    baseAsset,
    contractKline.items,
    klineInterval,
    localizedDisplayLabel,
    marketCategory,
    navigation,
    positionPriceLines,
    quoteAsset,
    symbol,
  ]);

  const handleOpenMore = useCallback(() => setMoreOpen(true), []);
  const handleCloseMore = useCallback(() => setMoreOpen(false), []);

  const handleMoreAction = useCallback(
    (action: ContractMoreAction) => {
      setMoreOpen(false);
      if (action === 'orders') {
        setRecordTab('current');
        return;
      }
      if (action === 'assets') {
        navigation.navigate('Assets');
        return;
      }
      if (action === 'deposit') {
        navigation.navigate('AssetDeposit');
        return;
      }
      if (action === 'withdraw') {
        navigation.navigate('AssetWithdraw');
        return;
      }
      if (action === 'transfer') {
        navigation.navigate('AssetTransfer');
        return;
      }
      navigation.navigate('AssetHistory');
    },
    [navigation],
  );

  const handleRecordTabChange = useCallback((tab: ContractRecordTab) => {
    setRecordTab(tab);
    setRecordLoadMoreError(null);
  }, []);

  const handleRetryRecords = useCallback(() => {
    setRecordLoadMoreError(null);
    loadPrivateData().catch(() => undefined);
  }, [loadPrivateData]);

  const handleLoadMoreRecords = useCallback(async () => {
    if (loadingMoreRecordTab !== null) return;
    const tab = recordTab;
    const pageInfo =
      tab === 'current'
        ? currentOrdersPage
        : tab === 'history'
        ? historyOrdersPage
        : tab === 'fills'
        ? myTradesPage
        : null;
    if (!pageInfo?.hasMore || pageInfo.nextPage === null) return;
    const requestedPage = pageInfo.nextPage;
    const requestInstrumentKey = instrumentKey;
    const requestGeneration = privateSecondaryGenerationRef.current;
    setLoadingMoreRecordTab(tab);
    setRecordLoadMoreError(null);
    try {
      if (tab === 'current' || tab === 'history') {
        const next = await fetchContractOrdersPage({
          symbol,
          status: tab === 'current' ? 'ACTIVE' : undefined,
          statusGroup: tab === 'history' ? 'HISTORY' : undefined,
          page: requestedPage,
          pageSize: pageInfo.pageSize,
        });
        if (
          next.page !== requestedPage ||
          next.pageSize !== pageInfo.pageSize
        ) {
          throw new Error(tRef.current('contract.orderPaginationInvalid'));
        }
        if (
          activeInstrumentKeyRef.current !== requestInstrumentKey ||
          privateSecondaryGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        if (tab === 'current') {
          setCurrentOrders(previous => {
            const combined = appendUniqueContractRecords(previous, next.items);
            currentOrdersRef.current = combined;
            return combined;
          });
          setCurrentOrdersPage(next);
        } else {
          setHistoryOrders(previous => {
            const combined = appendUniqueContractRecords(previous, next.items);
            historyOrdersRef.current = combined;
            return combined;
          });
          setHistoryOrdersPage(next);
        }
      } else if (tab === 'fills') {
        const next = await fetchContractTradesPage(
          symbol,
          pageInfo.pageSize,
          requestedPage,
        );
        if (
          next.page !== requestedPage ||
          next.pageSize !== pageInfo.pageSize
        ) {
          throw new Error(tRef.current('contract.fillPaginationInvalid'));
        }
        if (
          activeInstrumentKeyRef.current !== requestInstrumentKey ||
          privateSecondaryGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setMyTrades(previous =>
          appendUniqueContractRecords(previous, next.items),
        );
        setMyTradesPage(next);
      }
    } catch (error) {
      setRecordLoadMoreError(
        error instanceof Error
          ? error.message
          : tRef.current('spot.loadMoreFailed'),
      );
    } finally {
      if (
        activeInstrumentKeyRef.current === requestInstrumentKey &&
        privateSecondaryGenerationRef.current === requestGeneration
      ) {
        setLoadingMoreRecordTab(null);
      }
    }
  }, [
    currentOrdersPage,
    historyOrdersPage,
    instrumentKey,
    loadingMoreRecordTab,
    myTradesPage,
    recordTab,
    symbol,
  ]);

  const activeRecordPage =
    recordTab === 'current'
      ? currentOrdersPage
      : recordTab === 'history'
      ? historyOrdersPage
      : recordTab === 'fills'
      ? myTradesPage
      : null;
  const parsedOrderConfirmQuantity = parsePositiveDecimal(quantity);
  const parsedPositionCloseConfirmQuantity = positionCloseRequest
    ? parsePositiveDecimal(positionCloseRequest.quantity)
    : null;
  const parsedOrderConfirmLimitPrice =
    orderType === 'LIMIT' ? parsePositiveDecimal(price) : null;
  const orderConfirmReferencePrice = positionCloseRequest
    ? executionReady
      ? positionCloseRequest.side === 'LONG'
        ? executionBid
        : executionAsk
      : null
    : orderType === 'LIMIT'
    ? parsedOrderConfirmLimitPrice?.value ?? null
    : executionReferencePrice;
  const orderConfirmClosableQuantity = positionCloseRequest
    ? parsedPositionCloseConfirmQuantity?.value ?? null
    : actionMode === 'CLOSE'
    ? positions.reduce((total, item) => {
        if (item.side !== direction) return total;
        const value = Number(item.quantity.replace(/,/g, ''));
        return Number.isFinite(value) && value > 0 ? total + value : total;
      }, 0)
    : null;
  const closeAllConfirmTargets = buildContractCloseAllTargets(
    positions,
    quantityPrecision,
  ).map(target => ({
    side: target.side,
    quantity: target.quantity,
    referencePrice:
      executionReady && target.side === 'LONG'
        ? executionBid
        : executionReady
        ? executionAsk
        : null,
  }));
  const handleOrderConfirmCancel = () => {
    confirmOpenRef.current = false;
    activeOrderConfirmRef.current = null;
    setPositionCloseRequest(null);
    setOrderConfirmVisible(false);
  };
  const handleOrderConfirm = () => {
    if (submittingRef.current) return;
    const activeConfirmation = activeOrderConfirmRef.current;
    const directPositionCloseRequest = positionCloseRequest;
    confirmOpenRef.current = false;
    activeOrderConfirmRef.current = null;
    setPositionCloseRequest(null);
    setOrderConfirmVisible(false);
    if (
      !screenMountedRef.current ||
      !marketScreenActiveRef.current ||
      activeConfirmation?.instrumentKey !== instrumentKey ||
      activeConfirmation.orderIntentScope !== orderIntentScope
    ) {
      return;
    }
    if (directPositionCloseRequest) {
      return executePositionCloseRequest(directPositionCloseRequest).catch(
        () => undefined,
      );
    }
    skipNextOrderConfirmRef.current = { instrumentKey, orderIntentScope };
    handleSubmit();
  };
  const handleContractConfirmHiddenChange = (checked: boolean) => {
    setContractConfirmHidden(checked);
    saveContractTradeConfirmHidden(checked).catch(() => undefined);
  };
  const handleCloseAllConfirmCancel = () => {
    confirmOpenRef.current = false;
    activeCloseAllConfirmRef.current = null;
    setCloseAllConfirmVisible(false);
  };
  const handleCloseAllConfirm = () => {
    if (submittingRef.current || closingAllPositionsRef.current) return;
    const activeConfirmation = activeCloseAllConfirmRef.current;
    confirmOpenRef.current = false;
    activeCloseAllConfirmRef.current = null;
    setCloseAllConfirmVisible(false);
    if (
      !screenMountedRef.current ||
      !marketScreenActiveRef.current ||
      activeConfirmation?.instrumentKey !== instrumentKey ||
      activeConfirmation.orderIntentScope !== orderIntentScope
    ) {
      return;
    }
    setClosingAllPositions(true);
    setFeedbackText(tRef.current('contract.closeAllSubmitting'));
    setFeedbackTone(null);
    skipNextCloseAllConfirmRef.current = { instrumentKey, orderIntentScope };
    handleCloseAllPositions().catch(() => undefined);
  };
  const handleCloseAllConfirmHiddenChange = (checked: boolean) => {
    setCloseAllConfirmHidden(checked);
    saveContractCloseAllConfirmHidden(checked).catch(() => undefined);
  };
  const runtimeNotice = marketError || privateRealtimeNotice;
  const stackTradingPanels =
    marketCategory === 'crypto' && responsiveLayout.shouldStackTradingPanels;

  return (
    <AppScreen contentWidth="wide" scrollRef={screenScrollRef}>
      <ContractTopTabs
        activeKey={activeBusiness}
        tabs={businessTabs}
        onChange={handleBusinessChange}
      />
      <ContractSymbolHeader
        baseAsset={baseAsset}
        changePercent={quote?.changePercent ?? null}
        lastPrice={lastPrice}
        logoUrl={logoUrl}
        marketStatus={runtimeNotice || marketStatus}
        markPrice={markPrice}
        pricePrecision={pricePrecision}
        symbolLabel={localizedDisplayLabel}
        onOpenChart={handleOpenChart}
        onOpenMore={handleOpenMore}
        onSymbolPress={openMarketSelector}
      />
      {rulesError ? (
        <Pressable
          accessibilityLabel={t('contract.retryRuleA11y', {
            message: rulesError,
          })}
          accessibilityRole="button"
          accessibilityState={{ disabled: rulesLoading }}
          android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
          disabled={rulesLoading}
          onPress={loadSymbolRules}
          style={({ pressed }) => [
            styles.rulesErrorButton,
            pressed && styles.rulesErrorButtonPressed,
          ]}
        >
          <Text style={styles.rulesErrorText}>{rulesError}</Text>
          <Text style={styles.rulesErrorAction}>
            {rulesLoading ? t('contract.retrying') : t('contract.tapToRetry')}
          </Text>
        </Pressable>
      ) : null}
      <View
        style={[
          styles.tradeMain,
          stackTradingPanels ? styles.tradeMainStacked : null,
        ]}
      >
        <View
          style={[
            styles.formPanelWrap,
            marketCategory !== 'crypto' ? styles.formPanelWrapFull : null,
            stackTradingPanels ? styles.panelWrapStacked : null,
          ]}
        >
          <ContractOrderForm
            actionMode={actionMode}
            availableMargin={availableMargin}
            baseAsset={baseAsset}
            direction={direction}
            equity={equity}
            feedbackText={feedbackText || guardErrorMessage || ''}
            feedbackTone={
              feedbackText
                ? feedbackTone
                : guardErrorMessage
                ? 'error'
                : feedbackTone
            }
            isLoggedIn={isLoggedIn}
            lastPrice={orderType === 'MARKET' ? executionReferencePrice : null}
            leverage={leverage}
            maxLeverage={symbolRules?.maxLeverage ?? null}
            markPrice={orderType === 'MARKET' ? executionReferencePrice : null}
            orderType={orderType}
            pendingIntentReviewBusy={reviewingPendingIntent}
            pendingIntentReviewLabel={
              orderIntentLoadFailure
                ? t('trading.restoreOrder')
                : t('trading.viewOrder')
            }
            pendingIntentReviewVisible={Boolean(
              isLoggedIn && (pendingOrderIntent || orderIntentLoadFailure),
            )}
            price={price}
            pricePrecision={pricePrecision}
            quantity={quantity}
            quoteAsset={quoteAsset}
            spreadFeePrice={quote?.spreadFeePrice}
            submitDisabled={
              (!executionReady && !contractMarket.executionRecovering) ||
              !privateSubmissionReady ||
              Boolean(orderIntentGuardMessage)
            }
            submitting={submitting || waitingForExecutionLease}
            onActionModeChange={handleActionModeChange}
            onBboPress={handleBboPress}
            onDirectionChange={handleDirectionChange}
            onLoginPress={openLogin}
            onLeverageChange={handleLeverageChange}
            onOrderTypeChange={handleOrderTypeChange}
            onPercentPress={handlePercentPress}
            onPendingIntentReviewPress={handlePendingIntentReview}
            onPriceChange={handlePriceChange}
            onQuantityChange={handleQuantityChange}
            onSubmitPress={handleSubmit}
          />
        </View>
        {marketCategory === 'crypto' ? (
          <View
            style={[
              styles.orderBookPanelWrap,
              stackTradingPanels ? styles.panelWrapStacked : null,
            ]}
          >
            <ContractOrderBook
              asks={asks}
              baseAsset={baseAsset}
              bids={bids}
              lastPrice={orderBookLastPrice}
              markPrice={orderBookMarkPrice}
              pricePrecision={pricePrecision}
              quoteAsset={quoteAsset}
              trades={trades}
              onPricePress={handlePriceChange}
            />
          </View>
        ) : null}
      </View>

      {deferredScreenContentReady ? (
        <>
          <View style={styles.chartCard}>
            <View style={styles.chartHeader}>
              <Text style={styles.chartTitle}>
                {t('trading.contractChartTitle')}
              </Text>
              <Pressable
                accessibilityLabel={t('trading.contractFullscreenA11y')}
                accessibilityRole="button"
                android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                hitSlop={{ top: 6, bottom: 6 }}
                style={({ pressed }) => [
                  styles.chartActionButton,
                  pressed ? styles.pressed : null,
                ]}
                onPress={handleOpenChart}
              >
                <Text style={styles.chartAction}>
                  {t('trading.fullscreen')}
                </Text>
              </Pressable>
            </View>
            <MobileKlineChart
              currentPrice={lastPrice ?? markPrice}
              error={contractKline.error}
              height={158}
              interval={klineInterval}
              items={contractKline.items}
              loading={contractKline.loading}
              pricePrecision={pricePrecision}
              referencePriceLines={positionPriceLines}
              statusNote={klineStatusNote}
              visibleCount={36}
              onIntervalChange={handleKlineIntervalChange}
            />
          </View>

          <ContractBottomTabs
            activeTab={recordTab}
            cancelingOrderId={cancelingOrderId}
            closeAllPositionsDisabled={
              closingAllPositions ||
              submitting ||
              !executionReady ||
              Boolean(orderIntentGuardMessage)
            }
            closingAllPositions={closingAllPositions}
            currentOrders={currentOrders}
            error={
              recordTab === 'history'
                ? privateHistoryError
                : recordTab === 'fills'
                ? privateFillsError
                : privateCriticalError
            }
            fills={myTrades}
            historyOrders={historyOrders}
            hasMore={activeRecordPage?.hasMore ?? false}
            isLoggedIn={isLoggedIn}
            loadingMore={loadingMoreRecordTab === recordTab}
            loadMoreError={recordLoadMoreError}
            orderActionFeedback={orderActionFeedback}
            pricePrecision={pricePrecision}
            positions={displayPositions}
            quantityPrecision={quantityPrecision}
            onChange={handleRecordTabChange}
            onCancelOrder={handleCancelOrder}
            onCloseAllPositions={handleCloseAllPositions}
            onClosePosition={handlePreparePositionClose}
            onEditPositionTpSl={handleOpenPositionTpSl}
            onLoadMore={handleLoadMoreRecords}
            onLoginPress={openLogin}
            onRetryPress={handleRetryRecords}
          />
        </>
      ) : null}

      <ContractMoreSheet
        visible={moreOpen}
        onActionPress={handleMoreAction}
        onClose={handleCloseMore}
      />
      <ContractOrderConfirmModal
        actionMode={positionCloseRequest ? 'CLOSE' : actionMode}
        baseAsset={baseAsset}
        closableQuantity={orderConfirmClosableQuantity}
        direction={positionCloseRequest?.side ?? direction}
        leverage={leverage}
        orderType={positionCloseRequest ? 'MARKET' : orderType}
        pricePrecision={pricePrecision}
        quantity={
          positionCloseRequest
            ? parsedPositionCloseConfirmQuantity?.value ?? null
            : parsedOrderConfirmQuantity?.value ?? null
        }
        quantityText={
          positionCloseRequest
            ? parsedPositionCloseConfirmQuantity?.text ??
              positionCloseRequest.quantity
            : parsedOrderConfirmQuantity?.text ?? quantity
        }
        quoteAsset={quoteAsset}
        referencePrice={orderConfirmReferencePrice}
        submitting={submitting}
        suppressChecked={contractConfirmHidden}
        visible={orderConfirmVisible}
        onCancel={handleOrderConfirmCancel}
        onConfirm={handleOrderConfirm}
        onSuppressChange={handleContractConfirmHiddenChange}
      />
      <ContractCloseAllConfirmModal
        baseAsset={baseAsset}
        pricePrecision={pricePrecision}
        quoteAsset={quoteAsset}
        submitting={closingAllPositions}
        suppressChecked={closeAllConfirmHidden}
        targets={closeAllConfirmTargets}
        visible={closeAllConfirmVisible}
        onCancel={handleCloseAllConfirmCancel}
        onConfirm={handleCloseAllConfirm}
        onSuppressChange={handleCloseAllConfirmHiddenChange}
      />
      <ContractMarketSelectorSheet
        initialCategory={marketCategory}
        visible={marketSelectorOpen}
        onClose={() => setMarketSelectorOpen(false)}
        onSelect={handleSelectMarket}
      />
      <ContractPositionTpSlSheet
        error={tpSlError}
        position={displayedTpSlPosition}
        pricePrecision={pricePrecision}
        referencePrice={tpSlPosition ? tpSlReferencePrice : null}
        referencePriceType={tpSlTriggerPriceType}
        saving={tpSlSaving}
        stopLossPrice={stopLossPrice}
        takeProfitPrice={takeProfitPrice}
        visible={tpSlPosition !== null}
        onClose={handleClosePositionTpSl}
        onSave={handleSavePositionTpSl}
        onStopLossPriceChange={value => {
          setStopLossPrice(value);
          setTpSlError(null);
        }}
        onTakeProfitPriceChange={value => {
          setTakeProfitPrice(value);
          setTpSlError(null);
        }}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  rulesErrorButton: {
    minHeight: 44,
    marginTop: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rulesErrorButtonPressed: {
    opacity: 0.76,
  },
  rulesErrorText: {
    flex: 1,
    color: colors.gold,
    fontSize: 12,
  },
  rulesErrorAction: {
    marginLeft: 10,
    color: colors.gold,
    fontSize: 11,
    fontWeight: '700',
  },
  tradeMain: {
    marginTop: 8,
    height: MOBILE_TRADING_PANEL_HEIGHT,
    flexDirection: 'row',
    gap: MOBILE_TRADING_PANEL_GAP,
  },
  tradeMainStacked: {
    height: MOBILE_TRADING_PANEL_HEIGHT * 2 + MOBILE_TRADING_PANEL_GAP,
    flexDirection: 'column',
  },
  formPanelWrap: {
    flex: MOBILE_FORM_PANEL_FLEX,
    height: '100%',
    minWidth: 0,
  },
  formPanelWrapFull: {
    flex: 1,
  },
  orderBookPanelWrap: {
    flex: MOBILE_ORDER_BOOK_PANEL_FLEX,
    height: '100%',
    minWidth: 0,
  },
  panelWrapStacked: {
    flex: 0,
    width: '100%',
    height: MOBILE_TRADING_PANEL_HEIGHT,
  },
  chartCard: {
    marginTop: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 8,
  },
  chartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  chartTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  chartAction: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  chartActionButton: {
    minWidth: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
});
