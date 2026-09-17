import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Pressable,
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
import MobileKlineChart from '../../components/trade/MobileKlineChart';
import TradeBottomTabs, {
  getCancelableSpotOrderId,
  type TradeRecordTab,
} from '../../components/trade/TradeBottomTabs';
import TradeMoreSheet, {
  type TradeMoreAction,
} from '../../components/trade/TradeMoreSheet';
import TradeOrderBook from '../../components/trade/TradeOrderBook';
import TradeOrderForm, {
  type TradeOrderType,
  type TradeSide,
} from '../../components/trade/TradeOrderForm';
import TradeSymbolHeader from '../../components/trade/TradeSymbolHeader';
import TradeTopTabs, {
  type TradeBusinessTab,
} from '../../components/trade/TradeTopTabs';
import type { KlineInterval } from '../../components/trade/kline.utils';
import { normalizeSpotTradingRouteParams } from '../../navigation/tradingRoute';
import type {
  MainTabParamList,
  RootStackParamList,
} from '../../navigation/types';
import {
  cancelSpotOrder,
  createSpotOrder,
  fetchSpotBalances,
  fetchSpotCurrentOrdersPage,
  fetchSpotFeeRates,
  fetchSpotHistoryOrdersPage,
  fetchSpotKlines,
  fetchSpotMyTradesPage,
  formatSpotNumber,
  type CreateSpotOrderPayload,
  type SpotCursorPage,
  type SpotKline,
  type SpotFeeRates,
  type SpotMyTradeItem,
  type SpotOrderItem,
} from '../../api/spot';
import { useMarketScreenActive } from '../../hooks/useMarketScreenActive';
import { useDeferredScreenContent } from '../../hooks/useDeferredScreenContent';
import { usePrivateTradingRealtime } from '../../hooks/usePrivateTradingRealtime';
import { useSpotMarketRealtime } from '../../hooks/useSpotMarketRealtime';
import { isSpotExecutionAuthorityUsable } from '../../realtime/spotMarketRealtime';
import { useAuth } from '../../store/authStore';
import { useLanguage, type Translator } from '../../i18n';
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
import {
  calculateSpotEstimatedFee,
  estimateSpotFeePayment,
} from '../../utils/spotFee';
import { formatFixedPrice } from '../../utils/format';
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
  findAuthoritativeSpotOrderForIntent,
  type PendingSpotOrderIntent,
} from '../../services/spotOrderIntent';

type RootNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Trade'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const SPOT_ACTIVE_ORDER_LIMIT = 100;
const SPOT_HISTORY_ORDER_LIMIT = 100;
const SPOT_TRADE_FILL_LIMIT = 20;
const SPOT_PRIVATE_REFRESH_MS = 30_000;
const SPOT_PENDING_INTENT_RECHECK_MS = 10_000;
const PENDING_INTENT_MANUAL_REVIEW_DELAY_MS = 60_000;

type PendingReconciliationSnapshot = {
  version: number;
  updatedAtMs: number;
};

type SpotPageInfo = Omit<SpotCursorPage<never>, 'items'>;

const EMPTY_SPOT_PAGE_INFO: SpotPageInfo = {
  hasMore: false,
  nextCursor: null,
  paginationSupported: false,
};

function getSpotPageInfo(page: SpotPageInfo): SpotPageInfo {
  return {
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    paginationSupported: page.paginationSupported,
  };
}

function appendUniqueSpotRecords<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
) {
  const seen = new Set(current.map(item => item.id));
  const next = [...current];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    next.push(item);
  }
  return next;
}

export default function TradeScreen() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<RouteProp<MainTabParamList, 'Trade'>>();
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
  const businessTabs = useMemo<TradeBusinessTab[]>(
    () => [{ key: 'spot', label: t('trading.spot') }],
    [t],
  );
  const instrument = useMemo(
    () => normalizeSpotTradingRouteParams(route.params),
    [route.params],
  );
  const { baseAsset, displayLabel, logoUrl, quoteAsset, symbol } = instrument;
  const instrumentKey = `${symbol}|${baseAsset}|${quoteAsset}|${displayLabel}`;
  const { isLoggedIn, user } = useAuth();
  const orderIntentOwnerKey =
    isLoggedIn && user?.id !== undefined && user?.id !== null
      ? String(user.id)
      : null;
  const orderIntentScope = `${orderIntentOwnerKey || 'anonymous'}|${symbol}`;
  const marketScreenActive = useMarketScreenActive();
  const deferredScreenContentReady =
    useDeferredScreenContent(marketScreenActive);
  const realtime = useSpotMarketRealtime(
    symbol,
    'TradeScreen',
    marketScreenActive,
  );
  const [activeBusiness, setActiveBusiness] = useState('spot');
  const [side, setSide] = useState<TradeSide>('BUY');
  const [orderType, setOrderType] = useState<TradeOrderType>('LIMIT');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [klines, setKlines] = useState<SpotKline[]>([]);
  const [availableBase, setAvailableBase] = useState<number | null>(null);
  const [availableQuote, setAvailableQuote] = useState<number | null>(null);
  const [currentOrders, setCurrentOrders] = useState<SpotOrderItem[]>([]);
  const [historyOrders, setHistoryOrders] = useState<SpotOrderItem[]>([]);
  const [myTrades, setMyTrades] = useState<SpotMyTradeItem[]>([]);
  const [currentOrdersPage, setCurrentOrdersPage] =
    useState<SpotPageInfo>(EMPTY_SPOT_PAGE_INFO);
  const [historyOrdersPage, setHistoryOrdersPage] =
    useState<SpotPageInfo>(EMPTY_SPOT_PAGE_INFO);
  const [myTradesPage, setMyTradesPage] =
    useState<SpotPageInfo>(EMPTY_SPOT_PAGE_INFO);
  const [loadingMoreTab, setLoadingMoreTab] = useState<TradeRecordTab | null>(
    null,
  );
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [recordTab, setRecordTab] = useState<TradeRecordTab>('current');
  const [klineError, setKlineError] = useState<string | null>(null);
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [fillsError, setFillsError] = useState<string | null>(null);
  const [criticalPrivateReady, setCriticalPrivateReady] = useState(false);
  const [historyPrivateReady, setHistoryPrivateReady] = useState(false);
  const [feeRates, setFeeRates] = useState<SpotFeeRates | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [feeRetryNonce, setFeeRetryNonce] = useState(0);
  const [publicLoading, setPublicLoading] = useState(true);
  const [klineInterval, setKlineInterval] = useState<KlineInterval>('1m');
  const [moreOpen, setMoreOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelingOrderIds, setCancelingOrderIds] = useState<number[]>([]);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackTone, setFeedbackTone] = useState<'error' | 'success' | null>(
    null,
  );
  const [pendingOrderIntent, setPendingOrderIntent] =
    useState<PendingSpotOrderIntent | null>(null);
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
  const confirmOpenRef = useRef(false);
  const deferredPrivateRefreshRef = useRef(false);
  const cancelingOrderIdsRef = useRef(new Set<number>());
  const cancelConfirmationIdsRef = useRef(new Set<number>());
  const mountedRef = useRef(true);
  const klineGenerationRef = useRef(0);
  const privateGenerationRef = useRef(0);
  const feeGenerationRef = useRef(0);
  const marketAuthorityRef = useRef({
    active: false,
    executable: false,
    bid: null as number | null,
    ask: null as number | null,
    expiresAtMs: null as number | null,
  });
  const marketScreenActiveRef = useRef(false);
  const executionLifecycleGenerationRef = useRef(0);
  const activeInstrumentKeyRef = useRef(instrumentKey);
  const activeOrderIntentScopeRef = useRef(orderIntentScope);
  const pendingOrderIntentRef = useRef<PendingSpotOrderIntent | null>(null);
  const orderIntentLoadFailureRef = useRef<PendingTradeIntentLoadError | null>(
    null,
  );
  const previousMarketScreenActiveRef = useRef(marketScreenActive);
  const criticalPrivateReadyRef = useRef(false);
  const historyPrivateReadyRef = useRef(false);
  const reviewingPendingIntentRef = useRef(false);
  const pendingReconciliationUpdatedAtMsRef = useRef<number | null>(null);
  const pendingReconciliationVersionRef = useRef(0);
  const pendingManualReviewGenerationRef = useRef(0);
  const manualUnlockCommitRef = useRef<{
    scope: string;
    intentId: string;
  } | null>(null);
  const privateDataInFlightRef = useRef<{
    scope: string;
    promise: Promise<boolean>;
  } | null>(null);
  const pendingReconcileInFlightRef = useRef<{
    scope: string;
    promise: Promise<PendingReconciliationSnapshot | null>;
  } | null>(null);

  useLayoutEffect(() => {
    activeInstrumentKeyRef.current = instrumentKey;
    executionLifecycleGenerationRef.current += 1;
    klineGenerationRef.current += 1;
    privateGenerationRef.current += 1;
    confirmOpenRef.current = false;
    deferredPrivateRefreshRef.current = false;
    cancelConfirmationIdsRef.current.clear();
    marketAuthorityRef.current = {
      active: false,
      executable: false,
      bid: null,
      ask: null,
      expiresAtMs: null,
    };
    setPrice('');
    setAmount('');
    setKlines([]);
    setAvailableBase(null);
    setAvailableQuote(null);
    setCurrentOrders([]);
    setHistoryOrders([]);
    setMyTrades([]);
    setCurrentOrdersPage(EMPTY_SPOT_PAGE_INFO);
    setHistoryOrdersPage(EMPTY_SPOT_PAGE_INFO);
    setMyTradesPage(EMPTY_SPOT_PAGE_INFO);
    setLoadingMoreTab(null);
    setLoadMoreError(null);
    setKlineError(null);
    setPrivateError(null);
    setHistoryError(null);
    setFillsError(null);
    criticalPrivateReadyRef.current = false;
    historyPrivateReadyRef.current = false;
    pendingReconciliationUpdatedAtMsRef.current = null;
    pendingReconciliationVersionRef.current += 1;
    pendingManualReviewGenerationRef.current += 1;
    reviewingPendingIntentRef.current = false;
    setCriticalPrivateReady(false);
    setHistoryPrivateReady(false);
    setPublicLoading(true);
    setCancelingOrderIds([]);
    setFeedbackText('');
    setFeedbackTone(null);
    pendingOrderIntentRef.current = null;
    setPendingOrderIntent(null);
    setReviewingPendingIntent(false);
    setOrderIntentHydratedScope(null);
    setOrderIntentLoadError(null);
    setMoreOpen(false);
  }, [instrumentKey]);

  useLayoutEffect(() => {
    if (activeOrderIntentScopeRef.current === orderIntentScope) return;
    activeOrderIntentScopeRef.current = orderIntentScope;
    executionLifecycleGenerationRef.current += 1;
    privateGenerationRef.current += 1;
    confirmOpenRef.current = false;
    cancelConfirmationIdsRef.current.clear();
    criticalPrivateReadyRef.current = false;
    historyPrivateReadyRef.current = false;
    pendingReconciliationUpdatedAtMsRef.current = null;
    pendingReconciliationVersionRef.current += 1;
    pendingManualReviewGenerationRef.current += 1;
    setCriticalPrivateReady(false);
    setHistoryPrivateReady(false);
    setAvailableBase(null);
    setAvailableQuote(null);
    setCurrentOrders([]);
    setHistoryOrders([]);
    setMyTrades([]);
    setCurrentOrdersPage(EMPTY_SPOT_PAGE_INFO);
    setHistoryOrdersPage(EMPTY_SPOT_PAGE_INFO);
    setMyTradesPage(EMPTY_SPOT_PAGE_INFO);
    setLoadingMoreTab(null);
    setLoadMoreError(null);
    setPrivateError(null);
    setHistoryError(null);
    setFillsError(null);
    reviewingPendingIntentRef.current = false;
    setReviewingPendingIntent(false);
  }, [orderIntentScope]);

  useEffect(() => {
    const cancelConfirmationIds = cancelConfirmationIdsRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelConfirmationIds.clear();
    };
  }, []);

  const ticker = realtime.ticker;
  const asks = useMemo(
    () => realtime.depth.asks.slice(0, 10),
    [realtime.depth.asks],
  );
  const bids = useMemo(
    () => realtime.depth.bids.slice(0, 10),
    [realtime.depth.bids],
  );
  const trades = useMemo(() => realtime.trades.slice(0, 20), [realtime.trades]);
  const currentMarketAuthority = {
    active: marketScreenActive,
    executable: realtime.executable,
    bid: realtime.executionBid,
    ask: realtime.executionAsk,
    expiresAtMs: realtime.executionExpiresAtMs,
  };
  const marketExecutable = isSpotExecutionAuthorityUsable(
    currentMarketAuthority,
  );
  useLayoutEffect(() => {
    const cancelConfirmationIds = cancelConfirmationIdsRef.current;
    marketScreenActiveRef.current = marketScreenActive;
    if (!marketScreenActive) {
      cancelConfirmationIds.clear();
      marketAuthorityRef.current = {
        active: false,
        executable: false,
        bid: null,
        ask: null,
        expiresAtMs: null,
      };
    }
    return () => {
      marketScreenActiveRef.current = false;
      executionLifecycleGenerationRef.current += 1;
      marketAuthorityRef.current = {
        active: false,
        executable: false,
        bid: null,
        ask: null,
        expiresAtMs: null,
      };
      confirmOpenRef.current = false;
      cancelConfirmationIds.clear();
    };
  }, [instrumentKey, marketScreenActive]);
  useLayoutEffect(() => {
    marketAuthorityRef.current = marketScreenActive
      ? {
          active: true,
          executable: realtime.executable,
          bid: realtime.executionBid,
          ask: realtime.executionAsk,
          expiresAtMs: realtime.executionExpiresAtMs,
        }
      : {
          active: false,
          executable: false,
          bid: null,
          ask: null,
          expiresAtMs: null,
        };
  }, [
    marketScreenActive,
    realtime.executable,
    realtime.executionAsk,
    realtime.executionBid,
    realtime.executionExpiresAtMs,
    instrumentKey,
  ]);

  const pricePrecision = ticker?.pricePrecision ?? 2;
  const displayPricePrecision = ticker?.displayPricePrecision ?? pricePrecision;
  const amountPrecision = ticker?.amountPrecision ?? 6;
  const lastPrice = ticker?.lastPrice ?? null;
  const changePercent = ticker?.changePercent ?? null;
  const marketReferencePrice =
    side === 'BUY' ? asks[0]?.price ?? lastPrice : bids[0]?.price ?? lastPrice;
  const marketExecutionPrice =
    side === 'BUY' ? realtime.executionAsk : realtime.executionBid;
  const publicError = realtime.error || klineError;
  const availableText =
    side === 'BUY'
      ? `${formatSpotNumber(availableQuote, 2)} ${quoteAsset}`
      : `${formatSpotNumber(availableBase, 6)} ${baseAsset}`;
  const estimatedFee = useMemo(
    () =>
      feeRates
        ? calculateSpotEstimatedFee({
            amount,
            lastPrice: marketReferencePrice,
            makerRate: feeRates.makerRate,
            orderType,
            price,
            takerRate: feeRates.takerRate,
          })
        : null,
    [amount, feeRates, marketReferencePrice, orderType, price],
  );
  const estimatedFeeLabel = t('trading.estimatedFee');
  const estimatedPayment =
    estimatedFee && feeRates
      ? estimateSpotFeePayment({
          feeUsdt: estimatedFee.fee,
          context: feeRates.payment,
          symbol,
          side,
          amount: Number(amount),
          executionPrice:
            orderType === 'MARKET'
              ? marketReferencePrice
              : Number(price.replace(/,/g, '')),
        })
      : null;
  const estimatedFeeText = !isLoggedIn
    ? t('trading.loginToView')
    : feeLoading
    ? t('trading.feeLoading')
    : feeError || !feeRates
    ? t('trading.feeRetrying')
    : estimatedPayment
    ? `≈ ${formatSpotNumber(estimatedPayment.fee, 8)} ${estimatedPayment.asset}`
    : '--';
  const estimatedFeeHint =
    !isLoggedIn || feeLoading || feeError || !estimatedPayment
      ? undefined
      : t(`spot.feePayment.${estimatedPayment.reason}`);
  const orderIntentReady = orderIntentHydratedScope === orderIntentScope;
  const orderIntentBlockingMessage = !orderIntentReady
    ? t('trading.restoringOrder')
    : orderIntentLoadError
    ? orderIntentLoadError
    : pendingOrderIntent
    ? t('trading.previousOrderPending')
    : null;
  const privateSubmissionBlockingMessage = !criticalPrivateReady
    ? privateError || t('trading.syncingAccountOrders')
    : !historyPrivateReady
    ? historyError || t('trading.syncingOrderHistory')
    : null;
  const submissionBlockingMessage = !isLoggedIn
    ? null
    : orderIntentBlockingMessage || privateSubmissionBlockingMessage;
  const submissionGuardError = !isLoggedIn
    ? null
    : orderIntentLoadError
    ? orderIntentLoadError
    : pendingOrderIntent
    ? t('trading.previousOrderPending')
    : privateError || historyError;
  const marketSubmissionBlockingMessage =
    isLoggedIn && orderType === 'MARKET' && !marketExecutable
      ? t('spot.marketNotExecutable')
      : null;
  const visibleSubmissionBlockingMessage =
    submissionGuardError ||
    submissionBlockingMessage ||
    marketSubmissionBlockingMessage;
  const recordError =
    recordTab === 'current'
      ? privateError
      : recordTab === 'history'
      ? historyError
      : fillsError;
  const activeRecordPage =
    recordTab === 'current'
      ? currentOrdersPage
      : recordTab === 'history'
      ? historyOrdersPage
      : myTradesPage;

  const loadPublicKlines = useCallback(async () => {
    const generation = ++klineGenerationRef.current;
    setPublicLoading(true);
    try {
      const nextKlines = await fetchSpotKlines(symbol, klineInterval, 80);
      if (generation !== klineGenerationRef.current) return;
      setKlines(nextKlines);
      setKlineError(null);
    } catch (error) {
      if (generation !== klineGenerationRef.current) return;
      setKlineError(
        error instanceof Error
          ? error.message
          : tRef.current('trading.klineLoadFailed'),
      );
    } finally {
      if (generation === klineGenerationRef.current) {
        setPublicLoading(false);
      }
    }
  }, [klineInterval, symbol]);

  const reconcilePendingOrderIntent = useCallback(
    async (
      nextCurrentOrders: readonly SpotOrderItem[],
      nextHistoryOrders: readonly SpotOrderItem[],
    ) => {
      const intent = pendingOrderIntentRef.current;
      if (
        !intent ||
        activeOrderIntentScopeRef.current !== orderIntentScope ||
        intent.ownerKey !== orderIntentOwnerKey ||
        intent.instrumentKey !== symbol
      ) {
        return false;
      }
      const verifiedOrder = findAuthoritativeSpotOrderForIntent(
        intent,
        nextCurrentOrders,
        nextHistoryOrders,
      );
      if (!verifiedOrder) return false;
      if (
        pendingOrderIntentRef.current?.id === intent.id &&
        activeOrderIntentScopeRef.current === orderIntentScope
      ) {
        setFeedbackText(
          tRef.current('spot.possibleOrder', {
            id: String(verifiedOrder.orderId),
          }),
        );
        setFeedbackTone('error');
      }
      return true;
    },
    [orderIntentOwnerKey, orderIntentScope, symbol],
  );

  const performPrivateDataLoad = useCallback(async () => {
    if (pendingOrderIntentRef.current) {
      pendingReconciliationVersionRef.current += 1;
      pendingReconciliationUpdatedAtMsRef.current = null;
    }
    const generation = ++privateGenerationRef.current;
    setLoadingMoreTab(null);
    setLoadMoreError(null);
    if (!isLoggedIn) {
      setAvailableBase(null);
      setAvailableQuote(null);
      setCurrentOrders([]);
      setHistoryOrders([]);
      setMyTrades([]);
      setCurrentOrdersPage(EMPTY_SPOT_PAGE_INFO);
      setHistoryOrdersPage(EMPTY_SPOT_PAGE_INFO);
      setMyTradesPage(EMPTY_SPOT_PAGE_INFO);
      setLoadingMoreTab(null);
      setLoadMoreError(null);
      setPrivateError(null);
      setHistoryError(null);
      setFillsError(null);
      criticalPrivateReadyRef.current = false;
      historyPrivateReadyRef.current = false;
      setCriticalPrivateReady(false);
      setHistoryPrivateReady(false);
      return true;
    }

    // A new critical refresh invalidates the previous balance snapshot for
    // order-entry purposes until balances + current orders both succeed.
    setAvailableBase(null);
    setAvailableQuote(null);
    criticalPrivateReadyRef.current = false;
    historyPrivateReadyRef.current = false;
    setCriticalPrivateReady(false);
    setHistoryPrivateReady(false);
    const historyResultPromise = fetchSpotHistoryOrdersPage(
      symbol,
      SPOT_HISTORY_ORDER_LIMIT,
    ).then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    );
    const fillsResultPromise = fetchSpotMyTradesPage(
      symbol,
      SPOT_TRADE_FILL_LIMIT,
    ).then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    );
    try {
      const [balances, current] = await Promise.all([
        fetchSpotBalances(symbol),
        fetchSpotCurrentOrdersPage(symbol, SPOT_ACTIVE_ORDER_LIMIT),
      ]);
      const base = balances.find(item => item.coinSymbol === baseAsset);
      const quote = balances.find(item => item.coinSymbol === quoteAsset);
      if (generation !== privateGenerationRef.current) return false;
      setAvailableBase(base?.availableAmount ?? null);
      setAvailableQuote(quote?.availableAmount ?? null);
      setCurrentOrders(current.items);
      setCurrentOrdersPage(getSpotPageInfo(current));
      setLoadMoreError(null);
      setPrivateError(null);
      criticalPrivateReadyRef.current = true;
      setCriticalPrivateReady(true);

      const historyResult = await historyResultPromise;
      if (generation !== privateGenerationRef.current) return false;
      let history: SpotOrderItem[] | null = null;
      if (historyResult.status === 'fulfilled') {
        history = historyResult.value.items;
        setHistoryOrders(history);
        setHistoryOrdersPage(getSpotPageInfo(historyResult.value));
        setHistoryError(null);
        pendingReconciliationUpdatedAtMsRef.current = Date.now();
        pendingReconciliationVersionRef.current += 1;
        historyPrivateReadyRef.current = true;
        setHistoryPrivateReady(true);
      } else {
        historyPrivateReadyRef.current = false;
        setHistoryPrivateReady(false);
        setHistoryError(
          historyResult.reason instanceof Error
            ? historyResult.reason.message
            : tRef.current('spot.historyLoadFailed'),
        );
      }
      const fillsResult = await fillsResultPromise;
      if (generation !== privateGenerationRef.current) return false;
      if (fillsResult.status === 'fulfilled') {
        setMyTrades(fillsResult.value.items);
        setMyTradesPage(getSpotPageInfo(fillsResult.value));
        setFillsError(null);
      } else {
        setFillsError(
          fillsResult.reason instanceof Error
            ? fillsResult.reason.message
            : tRef.current('spot.fillsLoadFailed'),
        );
      }
      if (history) await reconcilePendingOrderIntent(current.items, history);
      return true;
    } catch (error) {
      if (generation === privateGenerationRef.current) {
        criticalPrivateReadyRef.current = false;
        historyPrivateReadyRef.current = false;
        setCriticalPrivateReady(false);
        setHistoryPrivateReady(false);
        setAvailableBase(null);
        setAvailableQuote(null);
        setCurrentOrders([]);
        setCurrentOrdersPage(EMPTY_SPOT_PAGE_INFO);
        setPrivateError(
          error instanceof Error
            ? error.message
            : tRef.current('spot.criticalLoadFailed'),
        );
      }
      await Promise.all([historyResultPromise, fillsResultPromise]);
      return false;
    }
  }, [baseAsset, isLoggedIn, quoteAsset, reconcilePendingOrderIntent, symbol]);

  const loadPrivateData = useCallback(() => {
    const scope = orderIntentScope;
    if (manualUnlockCommitRef.current?.scope === scope) {
      return Promise.resolve(false);
    }
    if (reviewingPendingIntentRef.current && pendingOrderIntentRef.current) {
      return Promise.resolve(false);
    }
    const inFlight = privateDataInFlightRef.current;
    if (inFlight?.scope === scope) return inFlight.promise;
    const pendingReconcile = pendingReconcileInFlightRef.current;
    const promise =
      pendingReconcile?.scope === scope
        ? pendingReconcile.promise
            .catch(() => null)
            .then(() => performPrivateDataLoad())
        : performPrivateDataLoad();
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
  }, [orderIntentScope, performPrivateDataLoad]);

  const privateRealtimeEnabled =
    isLoggedIn &&
    marketScreenActive &&
    orderIntentHydratedScope === orderIntentScope;
  const privateRealtimeStatus = usePrivateTradingRealtime({
    market: 'SPOT',
    symbol,
    enabled: privateRealtimeEnabled,
    onInvalidate: () => {
      if (confirmOpenRef.current || submittingRef.current) {
        deferredPrivateRefreshRef.current = true;
        return;
      }
      loadPrivateData().catch(() => undefined);
      setFeeRetryNonce(current => current + 1);
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
      const generation = privateGenerationRef.current;
      const promise = (async () => {
        if (!isLoggedIn || !pendingOrderIntentRef.current) return null;
        pendingReconciliationVersionRef.current += 1;
        pendingReconciliationUpdatedAtMsRef.current = null;
        try {
          // CURRENT must be observed before HISTORY. Order state is monotonic
          // (active -> terminal), so this closes the gap between two independently
          // served endpoint snapshots.
          const current = await fetchSpotCurrentOrdersPage(
            symbol,
            SPOT_ACTIVE_ORDER_LIMIT,
          );
          const history = await fetchSpotHistoryOrdersPage(
            symbol,
            SPOT_HISTORY_ORDER_LIMIT,
          );
          if (
            generation !== privateGenerationRef.current ||
            activeOrderIntentScopeRef.current !== scope
          ) {
            return null;
          }
          if (
            (current.paginationSupported
              ? current.hasMore
              : current.items.length >= SPOT_ACTIVE_ORDER_LIMIT) ||
            (history.paginationSupported
              ? history.hasMore
              : history.items.length >= SPOT_HISTORY_ORDER_LIMIT)
          ) {
            historyPrivateReadyRef.current = false;
            pendingReconciliationUpdatedAtMsRef.current = null;
            setHistoryPrivateReady(false);
            setHistoryError(tRef.current('spot.recordsTooMany'));
            return null;
          }
          setCurrentOrders(current.items);
          setCurrentOrdersPage(getSpotPageInfo(current));
          setHistoryOrders(history.items);
          setHistoryOrdersPage(getSpotPageInfo(history));
          setHistoryError(null);
          const updatedAtMs = Date.now();
          pendingReconciliationUpdatedAtMsRef.current = updatedAtMs;
          pendingReconciliationVersionRef.current += 1;
          historyPrivateReadyRef.current = true;
          setHistoryPrivateReady(true);
          await reconcilePendingOrderIntent(current.items, history.items);
          return {
            version: pendingReconciliationVersionRef.current,
            updatedAtMs,
          };
        } catch (error) {
          if (
            generation === privateGenerationRef.current &&
            activeOrderIntentScopeRef.current === scope
          ) {
            setHistoryError(
              error instanceof Error
                ? error.message
                : tRef.current('spot.recordsLoadFailed'),
            );
            historyPrivateReadyRef.current = false;
            pendingReconciliationUpdatedAtMsRef.current = null;
            setHistoryPrivateReady(false);
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

  const retryPersistedSpotIntent = useCallback(
    (intent: PendingSpotOrderIntent, scope: string) => {
      if (intent.version !== 2) return;
      const lifecycleGeneration = executionLifecycleGenerationRef.current;
      Alert.alert(
        tRef.current('recovery.retryTitle'),
        tRef.current('recovery.retryBody'),
        [
          { text: tRef.current('recovery.later'), style: 'cancel' },
          {
            text: tRef.current('recovery.retry'),
            onPress: async () => {
              if (
                reviewingPendingIntentRef.current ||
                !mountedRef.current ||
                !marketScreenActiveRef.current ||
                activeOrderIntentScopeRef.current !== scope ||
                executionLifecycleGenerationRef.current !==
                  lifecycleGeneration ||
                pendingOrderIntentRef.current?.id !== intent.id
              ) {
                Alert.alert(
                  tRef.current('recovery.pageChangedTitle'),
                  tRef.current('recovery.reenterAndConfirm'),
                );
                return;
              }
              reviewingPendingIntentRef.current = true;
              setReviewingPendingIntent(true);
              let cleared = false;
              try {
                const result = await createSpotOrder({
                  ...intent.payload,
                  client_order_id: intent.clientOrderId,
                });
                cleared = await clearPendingTradeIntent(intent);
                if (!cleared) {
                  throw new Error(tRef.current('recovery.recordsChanged'));
                }
                if (
                  mountedRef.current &&
                  activeOrderIntentScopeRef.current === scope &&
                  pendingOrderIntentRef.current?.id === intent.id
                ) {
                  pendingOrderIntentRef.current = null;
                  setPendingOrderIntent(null);
                  setAmount('');
                  const identity =
                    result.orderNo || (result.id > 0 ? '#' + result.id : '');
                  const statusText =
                    result.status === 'FILLED'
                      ? tRef.current('trading.status.filled')
                      : result.status === 'PARTIALLY_FILLED'
                      ? tRef.current('trading.status.partial')
                      : tRef.current('trading.status.placed');
                  const message = tRef.current('spot.orderResult', {
                    identity: identity ? ` ${identity}` : '',
                    status: statusText,
                  });
                  setFeedbackText(message);
                  setFeedbackTone('success');
                  setFeeRetryNonce(current => current + 1);
                  Alert.alert(tRef.current('recovery.confirmedTitle'), message);
                  await loadPrivateData();
                }
              } catch (error) {
                const potentiallyCommitted =
                  isPotentiallyCommittedMutationError(error, {
                    invalidResponseCodes: ['INVALID_SPOT_ORDER_RESPONSE'],
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
                  mountedRef.current &&
                  activeOrderIntentScopeRef.current === scope &&
                  pendingOrderIntentRef.current?.id === intent.id
                ) {
                  pendingOrderIntentRef.current = null;
                  setPendingOrderIntent(null);
                }
                if (
                  potentiallyCommitted &&
                  mountedRef.current &&
                  activeOrderIntentScopeRef.current === scope
                ) {
                  await loadPendingOrderReconciliationData();
                }
                if (
                  mountedRef.current &&
                  activeOrderIntentScopeRef.current === scope
                ) {
                  const rawMessage =
                    error instanceof Error
                      ? error.message
                      : tRef.current('recovery.confirmFailed');
                  const message = potentiallyCommitted
                    ? rawMessage + tRef.current('recovery.resultPendingSuffix')
                    : cleared
                    ? rawMessage + tRef.current('recovery.notSubmittedSuffix')
                    : rawMessage + tRef.current('recovery.reviewOrdersSuffix');
                  setFeedbackText(message);
                  setFeedbackTone('error');
                  Alert.alert(
                    tRef.current('recovery.retryIncomplete'),
                    message,
                  );
                }
              } finally {
                reviewingPendingIntentRef.current = false;
                if (mountedRef.current) setReviewingPendingIntent(false);
              }
            },
          },
        ],
      );
    },
    [loadPendingOrderReconciliationData, loadPrivateData],
  );

  const reviewCorruptSpotIntent = useCallback(
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
          tRef.current('recovery.pendingTitle'),
          tRef.current('recovery.incompleteRecord'),
        );
        return;
      }
      const lifecycleGeneration = executionLifecycleGenerationRef.current;
      const canClear = () =>
        mountedRef.current &&
        marketScreenActiveRef.current &&
        activeOrderIntentScopeRef.current === scope &&
        orderIntentLoadFailureRef.current === failure &&
        executionLifecycleGenerationRef.current === lifecycleGeneration;
      Alert.alert(
        tRef.current('recovery.queryTitle'),
        tRef.current('recovery.queryBody'),
        [
          { text: tRef.current('recovery.queryLater'), style: 'cancel' },
          {
            text: tRef.current('recovery.queryNow'),
            onPress: async () => {
              if (!canClear() || reviewingPendingIntentRef.current) {
                Alert.alert(
                  tRef.current('recovery.pageChangedTitle'),
                  tRef.current('recovery.reenterAndQuery'),
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
                  setFeedbackText(tRef.current('recovery.canContinue'));
                  setFeedbackTone('success');
                  Alert.alert(
                    tRef.current('recovery.restoredTitle'),
                    tRef.current('recovery.restoredBody'),
                  );
                  await loadPrivateData();
                  return;
                }
                const message =
                  recovery.status === 'PENDING'
                    ? tRef.current('recovery.stillProcessing')
                    : recovery.status === 'NOT_FOUND'
                    ? tRef.current('recovery.notFound')
                    : recovery.status === 'SCOPE_MISMATCH'
                    ? tRef.current('recovery.symbolMismatch')
                    : recovery.status === 'LOCK_CHANGED'
                    ? tRef.current('recovery.pageChangedDuringQuery')
                    : tRef.current('recovery.cannotAutoRestore');
                setFeedbackText(message);
                setFeedbackTone('error');
                Alert.alert(tRef.current('recovery.pendingTitle'), message);
              } catch (error) {
                if (!canClear()) return;
                const message =
                  (error instanceof Error
                    ? error.message
                    : tRef.current('recovery.queryFailed')) +
                  tRef.current('recovery.retryNoDuplicateSuffix');
                setFeedbackText(message);
                setFeedbackTone('error');
                Alert.alert(tRef.current('recovery.queryFailedTitle'), message);
              } finally {
                reviewingPendingIntentRef.current = false;
                if (mountedRef.current) setReviewingPendingIntent(false);
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
      if (failure) reviewCorruptSpotIntent(failure, scope);
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
      retryPersistedSpotIntent(intent, scope);
      return;
    }
    const remainingMs =
      PENDING_INTENT_MANUAL_REVIEW_DELAY_MS - (Date.now() - intent.createdAtMs);
    if (remainingMs > 0) {
      Alert.alert(
        tRef.current('recovery.checkLaterTitle'),
        tRef.current('recovery.checkLaterSeconds', {
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
            waits.push(activeFullRefresh.promise.catch(() => false));
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
        !mountedRef.current ||
        activeOrderIntentScopeRef.current !== scope ||
        pendingOrderIntentRef.current?.id !== intent.id
      ) {
        return;
      }
      if (!reviewedSnapshot) {
        Alert.alert(
          tRef.current('recovery.syncFailedTitle'),
          tRef.current('recovery.syncFailedBody'),
        );
        return;
      }
      const reviewedSnapshotVersion = reviewedSnapshot.version;
      const reviewedSnapshotAtMs = reviewedSnapshot.updatedAtMs;
      const reviewedLifecycleGeneration =
        executionLifecycleGenerationRef.current;
      const reviewStillValid = () =>
        mountedRef.current &&
        marketScreenActiveRef.current &&
        pendingOrderIntentRef.current?.id === intent.id &&
        activeOrderIntentScopeRef.current === scope &&
        executionLifecycleGenerationRef.current ===
          reviewedLifecycleGeneration &&
        pendingManualReviewGenerationRef.current === reviewGeneration &&
        pendingReconciliationVersionRef.current === reviewedSnapshotVersion &&
        reviewedSnapshotAtMs !== null &&
        pendingReconciliationUpdatedAtMsRef.current === reviewedSnapshotAtMs &&
        reviewedSnapshotAtMs + SPOT_PRIVATE_REFRESH_MS > Date.now() &&
        privateDataInFlightRef.current?.scope !== scope &&
        pendingReconcileInFlightRef.current?.scope !== scope;
      setRecordTab('current');
      Alert.alert(
        tRef.current('recovery.continueTitle'),
        tRef.current('recovery.continueBody'),
        [
          { text: tRef.current('recovery.backToReview'), style: 'cancel' },
          {
            text: tRef.current('recovery.confirmNoOrder'),
            style: 'destructive',
            onPress: async () => {
              if (!reviewStillValid()) {
                Alert.alert(
                  tRef.current('recovery.expiredTitle'),
                  tRef.current('recovery.expiredBody'),
                );
                return;
              }
              const commit = { scope, intentId: intent.id };
              manualUnlockCommitRef.current = commit;
              reviewingPendingIntentRef.current = true;
              if (mountedRef.current) setReviewingPendingIntent(true);
              try {
                if (
                  manualUnlockCommitRef.current !== commit ||
                  !reviewStillValid()
                ) {
                  throw new Error(tRef.current('recovery.pageChangedReview'));
                }
                const cleared = await clearPendingTradeIntent(intent);
                if (!cleared) {
                  throw new Error(tRef.current('recovery.orderChangedReview'));
                }
                pendingOrderIntentRef.current = null;
                pendingManualReviewGenerationRef.current += 1;
                setPendingOrderIntent(null);
                setAmount('');
                setFeedbackText(tRef.current('recovery.resumed'));
                setFeedbackTone('success');
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : tRef.current('recovery.restoreFailed');
                if (
                  mountedRef.current &&
                  activeOrderIntentScopeRef.current === scope
                ) {
                  const finalMessage =
                    message + tRef.current('recovery.reviewOrdersSuffixShort');
                  setFeedbackText(finalMessage);
                  setFeedbackTone('error');
                  Alert.alert(
                    tRef.current('recovery.restoreFailedTitle'),
                    finalMessage,
                  );
                }
              } finally {
                if (manualUnlockCommitRef.current === commit) {
                  manualUnlockCommitRef.current = null;
                }
                reviewingPendingIntentRef.current = false;
                if (mountedRef.current) setReviewingPendingIntent(false);
              }
            },
          },
        ],
      );
    } finally {
      reviewingPendingIntentRef.current = false;
      if (mountedRef.current) setReviewingPendingIntent(false);
    }
  }, [
    loadPendingOrderReconciliationData,
    orderIntentOwnerKey,
    orderIntentScope,
    reviewCorruptSpotIntent,
    retryPersistedSpotIntent,
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

    loadPendingTradeIntent<CreateSpotOrderPayload>(
      'spot',
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
        const spotIntent = intent as PendingSpotOrderIntent | null;
        pendingOrderIntentRef.current = spotIntent;
        setPendingOrderIntent(spotIntent);
        orderIntentLoadFailureRef.current = null;
        setOrderIntentLoadFailure(null);
        setOrderIntentHydratedScope(scope);
        if (spotIntent) {
          setFeedbackText(tRef.current('trading.previousOrderPending'));
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
            : tRef.current('recovery.statusReadFailed');
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
    if (!marketScreenActive) return;
    loadPublicKlines();
    return () => {
      klineGenerationRef.current += 1;
    };
  }, [loadPublicKlines, marketScreenActive]);

  useEffect(() => {
    if (!marketScreenActive || orderIntentHydratedScope !== orderIntentScope) {
      return;
    }
    loadPrivateData();
    return () => {
      privateGenerationRef.current += 1;
    };
  }, [
    loadPrivateData,
    marketScreenActive,
    orderIntentHydratedScope,
    orderIntentScope,
  ]);

  useEffect(() => {
    const wasActive = previousMarketScreenActiveRef.current;
    previousMarketScreenActiveRef.current = marketScreenActive;
    if (
      marketScreenActive &&
      !wasActive &&
      orderIntentHydratedScope === orderIntentScope
    ) {
      loadPrivateData();
    }
  }, [
    loadPrivateData,
    marketScreenActive,
    orderIntentHydratedScope,
    orderIntentScope,
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
    const refresh = async () => {
      if (confirmOpenRef.current || submittingRef.current) {
        deferredPrivateRefreshRef.current = true;
      } else {
        deferredPrivateRefreshRef.current = false;
        await loadPrivateData().catch(() => undefined);
      }
      if (!canceled) {
        timer = setTimeout(
          refresh,
          confirmOpenRef.current || submittingRef.current
            ? 1_000
            : SPOT_PRIVATE_REFRESH_MS,
        );
      }
    };
    timer = setTimeout(refresh, SPOT_PRIVATE_REFRESH_MS);
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
  ]);

  useEffect(() => {
    if (
      !isLoggedIn ||
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
        timer = setTimeout(reconcile, SPOT_PENDING_INTENT_RECHECK_MS);
      }
    };
    timer = setTimeout(reconcile, SPOT_PENDING_INTENT_RECHECK_MS);
    return () => {
      canceled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    isLoggedIn,
    loadPendingOrderReconciliationData,
    marketScreenActive,
    orderIntentHydratedScope,
    orderIntentScope,
    pendingOrderIntent,
  ]);

  useEffect(() => {
    const generation = ++feeGenerationRef.current;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!isLoggedIn) {
      setFeeRates(null);
      setFeeLoading(false);
      setFeeError(null);
      return;
    }
    if (!marketScreenActive) {
      setFeeLoading(false);
      return;
    }
    setFeeRates(null);
    setFeeLoading(true);
    setFeeError(null);
    fetchSpotFeeRates({ signal: controller.signal })
      .then(nextRates => {
        if (generation !== feeGenerationRef.current) return;
        setFeeRates(nextRates);
        setFeeError(null);
        retryTimer = setTimeout(() => {
          if (generation === feeGenerationRef.current)
            setFeeRetryNonce(current => current + 1);
        }, 30_000);
      })
      .catch(() => {
        if (generation !== feeGenerationRef.current) return;
        setFeeRates(null);
        setFeeError(tRef.current('spot.feeLoadFailed'));
        retryTimer = setTimeout(() => {
          if (generation === feeGenerationRef.current) {
            setFeeRetryNonce(current => current + 1);
          }
        }, 5000);
      })
      .finally(() => {
        if (generation === feeGenerationRef.current) {
          setFeeLoading(false);
        }
      });
    return () => {
      controller.abort();
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (feeGenerationRef.current === generation) {
        feeGenerationRef.current += 1;
      }
    };
  }, [feeRetryNonce, isLoggedIn, marketScreenActive, user?.id]);

  const clearFeedback = useCallback(() => {
    setFeedbackText('');
    setFeedbackTone(null);
  }, []);

  const handleSideChange = useCallback(
    (nextSide: TradeSide) => {
      clearFeedback();
      setSide(nextSide);
    },
    [clearFeedback],
  );

  const handleOrderTypeChange = useCallback(
    (nextOrderType: TradeOrderType) => {
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

  const handleAmountChange = useCallback(
    (nextAmount: string) => {
      clearFeedback();
      setAmount(nextAmount);
    },
    [clearFeedback],
  );

  const handleBusinessChange = useCallback((key: string) => {
    setActiveBusiness(key);
  }, []);

  const handlePercentPress = useCallback(
    (percent: number) => {
      clearFeedback();
      const referencePrice =
        orderType === 'MARKET'
          ? marketExecutionPrice
          : Number(price.replace(/,/g, ''));
      if (side === 'BUY') {
        if (!availableQuote || !referencePrice) return;
        setAmount(
          formatOrderDecimal(
            (availableQuote * percent) / 100 / referencePrice,
            amountPrecision,
          ),
        );
        return;
      }
      if (!availableBase) return;
      setAmount(
        formatOrderDecimal((availableBase * percent) / 100, amountPrecision),
      );
    },
    [
      amountPrecision,
      availableBase,
      availableQuote,
      clearFeedback,
      marketExecutionPrice,
      orderType,
      price,
      side,
    ],
  );

  const handleBboPress = useCallback(() => {
    clearFeedback();
    if (marketExecutionPrice !== null) {
      setPrice(formatOrderDecimal(marketExecutionPrice, pricePrecision));
    }
  }, [clearFeedback, marketExecutionPrice, pricePrecision]);

  const openLogin = useCallback(() => {
    navigation.navigate('Auth', { screen: 'Login' });
  }, [navigation]);

  const openMarketSelector = useCallback(() => {
    navigation.navigate('Markets', { category: 'crypto' });
  }, [navigation]);

  const handleSubmit = useCallback(() => {
    if (submittingRef.current || confirmOpenRef.current) return;

    const reject = (message: string) => {
      setFeedbackText(message);
      setFeedbackTone('error');
      Alert.alert(tRef.current('spot.cannotSubmit'), message);
    };
    if (!orderIntentReady) {
      reject(tRef.current('trading.restoringOrder'));
      return;
    }
    if (orderIntentLoadError) {
      reject(orderIntentLoadError);
      return;
    }
    if (pendingOrderIntentRef.current) {
      reject(tRef.current('trading.previousOrderPending'));
      return;
    }
    if (!orderIntentOwnerKey) {
      reject(tRef.current('spot.loginNotReady'));
      return;
    }
    if (!criticalPrivateReadyRef.current) {
      reject(privateError || tRef.current('spot.accountSyncPending'));
      loadPrivateData().catch(() => undefined);
      return;
    }
    if (!historyPrivateReadyRef.current) {
      reject(historyError || tRef.current('spot.historySyncPending'));
      loadPrivateData().catch(() => undefined);
      return;
    }
    const parsedAmount = parsePositiveDecimal(amount);
    if (!parsedAmount) {
      reject(tRef.current('spot.invalidQuantity'));
      return;
    }
    if (parsedAmount.decimalPlaces > amountPrecision) {
      reject(
        tRef.current('spot.quantityPrecision', { precision: amountPrecision }),
      );
      return;
    }

    const parsedPrice =
      orderType === 'LIMIT' ? parsePositiveDecimal(price) : null;
    if (orderType === 'LIMIT' && !parsedPrice) {
      reject(tRef.current('spot.invalidLimitPrice'));
      return;
    }
    if (parsedPrice && parsedPrice.decimalPlaces > pricePrecision) {
      reject(
        tRef.current('spot.pricePrecision', { precision: pricePrecision }),
      );
      return;
    }
    const openingLifecycleGeneration = executionLifecycleGenerationRef.current;
    const openingPrivateGeneration = privateGenerationRef.current;
    const openingInstrumentKey = instrumentKey;
    const openingOrderIntentScope = orderIntentScope;
    if (!marketScreenActiveRef.current) {
      reject(tRef.current('spot.screenInactive'));
      return;
    }
    const initialAuthority =
      orderType === 'MARKET' ? marketAuthorityRef.current : null;
    const initialAuthorityUsable =
      initialAuthority !== null &&
      isSpotExecutionAuthorityUsable(initialAuthority);
    if (orderType === 'MARKET' && !initialAuthorityUsable) {
      reject(tRef.current('spot.marketNotExecutable'));
      return;
    }

    const referencePrice =
      orderType === 'LIMIT'
        ? parsedPrice?.value ?? null
        : side === 'BUY'
        ? initialAuthority?.ask ?? null
        : initialAuthority?.bid ?? null;
    if (
      referencePrice === null ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      reject(tRef.current('spot.referenceUnavailable'));
      return;
    }

    const estimatedQuote = referencePrice * parsedAmount.value;
    if (!Number.isFinite(estimatedQuote) || estimatedQuote <= 0) {
      reject(tRef.current('spot.valueCalculationFailed'));
      return;
    }

    const minAmount = ticker?.minAmount;
    const minNotional = ticker?.minNotional;
    if (
      minAmount === null ||
      minAmount === undefined ||
      minAmount < 0 ||
      minNotional === null ||
      minNotional === undefined ||
      minNotional < 0
    ) {
      reject(tRef.current('spot.rulesLoadFailed'));
      return;
    }
    if (orderType !== 'MARKET' || side === 'SELL') {
      if (parsedAmount.value < minAmount) {
        reject(
          tRef.current('spot.minQuantity', {
            amount: formatOrderDecimal(minAmount, amountPrecision),
            asset: baseAsset,
          }),
        );
        return;
      }
    }
    if (
      (orderType !== 'MARKET' || side === 'BUY') &&
      estimatedQuote < minNotional
    ) {
      reject(
        tRef.current('spot.minNotional', {
          amount: formatOrderDecimal(minNotional, 18),
          asset: quoteAsset,
        }),
      );
      return;
    }

    if (side === 'BUY') {
      if (availableQuote === null) {
        reject(tRef.current('spot.balanceLoading'));
        return;
      }
      if (
        estimatedQuote >
        availableQuote + Math.max(availableQuote * 1e-12, 1e-10)
      ) {
        reject(tRef.current('spot.insufficientBalance', { asset: quoteAsset }));
        return;
      }
    } else {
      if (availableBase === null) {
        reject(tRef.current('spot.balanceLoading'));
        return;
      }
      if (
        parsedAmount.value >
        availableBase + Math.max(availableBase * 1e-12, 1e-10)
      ) {
        reject(tRef.current('spot.insufficientBalance', { asset: baseAsset }));
        return;
      }
    }

    const payload: CreateSpotOrderPayload =
      orderType === 'LIMIT'
        ? {
            symbol,
            side,
            order_type: orderType,
            price: parsedPrice!.text,
            amount: parsedAmount.text,
          }
        : side === 'BUY'
        ? {
            symbol,
            side,
            order_type: orderType,
            quote_amount: formatOrderDecimal(estimatedQuote, 18),
          }
        : {
            symbol,
            side,
            order_type: orderType,
            amount: parsedAmount.text,
          };
    const sideText = tRef.current(
      side === 'BUY' ? 'trading.buy' : 'trading.sell',
    );
    const priceText =
      orderType === 'LIMIT'
        ? `${parsedPrice!.text} ${quoteAsset}`
        : tRef.current('spot.marketReference', {
            price: `${formatFixedPrice(
              referencePrice,
              pricePrecision,
            )} ${quoteAsset}`,
          });
    const confirmation = [
      tRef.current('spot.confirmLineTitle', {
        type: tRef.current(
          orderType === 'LIMIT' ? 'trading.limit' : 'trading.market',
        ),
        side: sideText,
        asset: baseAsset,
      }),
      tRef.current('spot.confirmPrice', { price: priceText }),
      tRef.current('spot.confirmQuantity', {
        amount: parsedAmount.text,
        asset: baseAsset,
      }),
      tRef.current('spot.confirmValue', {
        amount: formatSpotNumber(estimatedQuote, 2),
        asset: quoteAsset,
      }),
    ].join('\n');

    confirmOpenRef.current = true;
    Alert.alert(
      tRef.current('spot.confirmTitle', { side: sideText, asset: baseAsset }),
      confirmation,
      [
        {
          text: tRef.current('common.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmOpenRef.current = false;
            if (deferredPrivateRefreshRef.current) {
              deferredPrivateRefreshRef.current = false;
              loadPrivateData().catch(() => undefined);
            }
          },
        },
        {
          text: tRef.current('spot.confirmAction', { side: sideText }),
          onPress: async () => {
            confirmOpenRef.current = false;
            if (submittingRef.current) return;
            const privateSnapshotChanged =
              privateGenerationRef.current !== openingPrivateGeneration;
            if (
              !marketScreenActiveRef.current ||
              executionLifecycleGenerationRef.current !==
                openingLifecycleGeneration ||
              privateSnapshotChanged ||
              !criticalPrivateReadyRef.current ||
              !historyPrivateReadyRef.current ||
              activeInstrumentKeyRef.current !== openingInstrumentKey ||
              activeOrderIntentScopeRef.current !== openingOrderIntentScope
            ) {
              if (
                privateSnapshotChanged &&
                mountedRef.current &&
                marketScreenActiveRef.current &&
                activeInstrumentKeyRef.current === openingInstrumentKey &&
                activeOrderIntentScopeRef.current === openingOrderIntentScope
              ) {
                reject(tRef.current('spot.stateChanged'));
              }
              return;
            }
            const currentAuthority = marketAuthorityRef.current;
            let finalPayload = payload;
            if (orderType === 'MARKET') {
              const currentAuthorityUsable =
                isSpotExecutionAuthorityUsable(currentAuthority);
              const currentReferencePrice =
                side === 'BUY' ? currentAuthority.ask : currentAuthority.bid;
              if (
                !currentAuthorityUsable ||
                currentReferencePrice !== referencePrice
              ) {
                reject(tRef.current('spot.quoteChanged'));
                return;
              }
              if (side === 'BUY') {
                finalPayload = {
                  symbol,
                  side,
                  order_type: orderType,
                  quote_amount: formatOrderDecimal(
                    currentReferencePrice * parsedAmount.value,
                    18,
                  ),
                };
              }
            }
            submittingRef.current = true;
            setSubmitting(true);
            setFeedbackText(tRef.current('spot.preparing'));
            setFeedbackTone(null);
            const baselineIds = [...currentOrders, ...historyOrders]
              .map(order => order.orderId)
              .filter(
                (orderId): orderId is number =>
                  orderId !== null &&
                  Number.isSafeInteger(orderId) &&
                  orderId > 0,
              );
            const intent = createPendingTradeIntent({
              market: 'spot',
              ownerKey: orderIntentOwnerKey,
              instrumentKey: symbol,
              payload: finalPayload,
              baselineIds,
            });
            let intentPersisted = false;
            try {
              await savePendingTradeIntent(intent);
              intentPersisted = true;
              const authorityAfterPersist = marketAuthorityRef.current;
              const stillSafeToSend =
                mountedRef.current &&
                marketScreenActiveRef.current &&
                executionLifecycleGenerationRef.current ===
                  openingLifecycleGeneration &&
                privateGenerationRef.current === openingPrivateGeneration &&
                criticalPrivateReadyRef.current &&
                historyPrivateReadyRef.current &&
                activeInstrumentKeyRef.current === openingInstrumentKey &&
                activeOrderIntentScopeRef.current === openingOrderIntentScope &&
                (orderType !== 'MARKET' ||
                  (isSpotExecutionAuthorityUsable(authorityAfterPersist) &&
                    (side === 'BUY'
                      ? authorityAfterPersist.ask
                      : authorityAfterPersist.bid) === referencePrice));
              if (!stillSafeToSend) {
                let localLockCleared = false;
                try {
                  localLockCleared = await clearPendingTradeIntent(intent);
                } catch {
                  localLockCleared = false;
                }
                if (
                  mountedRef.current &&
                  activeInstrumentKeyRef.current === openingInstrumentKey &&
                  activeOrderIntentScopeRef.current ===
                    openingOrderIntentScope &&
                  executionLifecycleGenerationRef.current ===
                    openingLifecycleGeneration
                ) {
                  if (!localLockCleared) {
                    pendingOrderIntentRef.current = intent;
                    setPendingOrderIntent(intent);
                  }
                  const message = localLockCleared
                    ? tRef.current('spot.notSentChanged')
                    : tRef.current('spot.notSentReview');
                  setFeedbackText(message);
                  setFeedbackTone('error');
                  Alert.alert(tRef.current('spot.notSentTitle'), message);
                }
                return;
              }
              pendingOrderIntentRef.current = intent;
              setPendingOrderIntent(intent);
              setFeedbackText(tRef.current('spot.submitting'));
              const result = await createSpotOrder({
                ...finalPayload,
                client_order_id: intent.clientOrderId,
              });
              try {
                const cleared = await clearPendingTradeIntent(intent);
                if (
                  cleared &&
                  pendingOrderIntentRef.current?.id === intent.id &&
                  activeOrderIntentScopeRef.current === openingOrderIntentScope
                ) {
                  pendingOrderIntentRef.current = null;
                  setPendingOrderIntent(null);
                }
              } catch {
                // The authoritative response is known, but retaining the lock
                // is safer than allowing a duplicate after a storage failure.
              }
              if (
                !mountedRef.current ||
                !marketScreenActiveRef.current ||
                executionLifecycleGenerationRef.current !==
                  openingLifecycleGeneration ||
                activeInstrumentKeyRef.current !== openingInstrumentKey ||
                activeOrderIntentScopeRef.current !== openingOrderIntentScope
              ) {
                return;
              }
              const identity =
                result.orderNo || (result.id > 0 ? `#${result.id}` : '');
              const message = tRef.current('spot.orderResult', {
                identity: identity ? ` ${identity}` : '',
                status:
                  result.status === 'FILLED'
                    ? tRef.current('trading.status.filled')
                    : result.status === 'PARTIALLY_FILLED'
                    ? tRef.current('trading.status.partial')
                    : tRef.current('trading.status.placed'),
              });
              setAmount('');
              setFeedbackText(message);
              setFeedbackTone('success');
              setFeeRetryNonce(current => current + 1);
              await loadPrivateData();
              if (
                mountedRef.current &&
                marketScreenActiveRef.current &&
                executionLifecycleGenerationRef.current ===
                  openingLifecycleGeneration &&
                activeInstrumentKeyRef.current === openingInstrumentKey
              ) {
                Alert.alert(tRef.current('spot.submittedTitle'), message);
              }
            } catch (error) {
              if (!intentPersisted) {
                if (
                  mountedRef.current &&
                  marketScreenActiveRef.current &&
                  executionLifecycleGenerationRef.current ===
                    openingLifecycleGeneration &&
                  activeInstrumentKeyRef.current === openingInstrumentKey
                ) {
                  const message = tRef.current('spot.preparationFailed');
                  setFeedbackText(message);
                  setFeedbackTone('error');
                  Alert.alert(tRef.current('spot.notSentTitle'), message);
                }
                return;
              }

              const potentiallyCommitted = isPotentiallyCommittedMutationError(
                error,
                {
                  invalidResponseCodes: ['INVALID_SPOT_ORDER_RESPONSE'],
                },
              );
              if (!potentiallyCommitted) {
                try {
                  const cleared = await clearPendingTradeIntent(intent);
                  if (
                    cleared &&
                    pendingOrderIntentRef.current?.id === intent.id &&
                    activeOrderIntentScopeRef.current ===
                      openingOrderIntentScope
                  ) {
                    pendingOrderIntentRef.current = null;
                    setPendingOrderIntent(null);
                  }
                } catch {
                  // Keep the lock fail-closed if persistence cannot be cleared.
                }
              } else if (
                mountedRef.current &&
                marketScreenActiveRef.current &&
                executionLifecycleGenerationRef.current ===
                  openingLifecycleGeneration &&
                activeInstrumentKeyRef.current === openingInstrumentKey &&
                activeOrderIntentScopeRef.current === openingOrderIntentScope
              ) {
                await loadPendingOrderReconciliationData();
              }

              if (
                !mountedRef.current ||
                !marketScreenActiveRef.current ||
                executionLifecycleGenerationRef.current !==
                  openingLifecycleGeneration ||
                activeInstrumentKeyRef.current !== openingInstrumentKey ||
                activeOrderIntentScopeRef.current !== openingOrderIntentScope
              ) {
                return;
              }
              if (potentiallyCommitted) {
                if (pendingOrderIntentRef.current?.id !== intent.id) {
                  setAmount('');
                  Alert.alert(
                    tRef.current('recovery.confirmedTitle'),
                    tRef.current('spot.foundOrder'),
                  );
                  return;
                }
                const message = tRef.current('spot.pendingResult');
                setFeedbackText(message);
                setFeedbackTone('error');
                Alert.alert(tRef.current('recovery.pendingTitle'), message);
                return;
              }
              const message = getTradingErrorMessage(
                error,
                tRef.current('spot.submitFailed'),
              );
              const lockRetained =
                pendingOrderIntentRef.current?.id === intent.id;
              setFeedbackText(
                lockRetained
                  ? tRef.current('spot.reviewNoDuplicate', { message })
                  : message,
              );
              setFeedbackTone('error');
              Alert.alert(
                tRef.current('spot.submitFailedTitle'),
                lockRetained
                  ? tRef.current('spot.reviewNoDuplicate', { message })
                  : message,
              );
            } finally {
              submittingRef.current = false;
              if (mountedRef.current) setSubmitting(false);
              if (deferredPrivateRefreshRef.current) {
                deferredPrivateRefreshRef.current = false;
                loadPrivateData().catch(() => undefined);
              }
            }
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          confirmOpenRef.current = false;
          if (deferredPrivateRefreshRef.current && !submittingRef.current) {
            deferredPrivateRefreshRef.current = false;
            loadPrivateData().catch(() => undefined);
          }
        },
      },
    );
  }, [
    amount,
    amountPrecision,
    availableBase,
    availableQuote,
    baseAsset,
    currentOrders,
    historyOrders,
    historyError,
    instrumentKey,
    loadPrivateData,
    loadPendingOrderReconciliationData,
    orderIntentLoadError,
    orderIntentOwnerKey,
    orderIntentReady,
    orderIntentScope,
    orderType,
    price,
    pricePrecision,
    privateError,
    quoteAsset,
    side,
    symbol,
    ticker?.minAmount,
    ticker?.minNotional,
  ]);

  const handleCancelOrder = useCallback(
    (order: SpotOrderItem) => {
      const orderId = getCancelableSpotOrderId(order);
      if (orderId === null) {
        Alert.alert(
          tRef.current('spot.cannotCancelTitle'),
          tRef.current('spot.invalidCancelOrder'),
        );
        return;
      }
      if (order.symbol.trim().toUpperCase() !== symbol) {
        Alert.alert(
          tRef.current('spot.cannotCancelTitle'),
          tRef.current('spot.wrongSymbolCancel'),
        );
        return;
      }
      if (
        cancelingOrderIdsRef.current.has(orderId) ||
        cancelConfirmationIdsRef.current.has(orderId)
      ) {
        return;
      }

      const openingLifecycleGeneration =
        executionLifecycleGenerationRef.current;
      const openingInstrumentKey = instrumentKey;
      cancelConfirmationIdsRef.current.add(orderId);
      Alert.alert(
        tRef.current('spot.confirmCancelTitle'),
        [
          tRef.current('spot.cancelOrderSide', {
            side: tRef.current(
              order.side === 'SELL' ? 'trading.sell' : 'trading.buy',
            ),
            symbol: order.symbol,
          }),
          tRef.current('spot.cancelPrice', { price: order.price }),
          tRef.current('spot.cancelFilled', {
            filled: order.filledAmount,
            amount: order.amount,
          }),
          '',
          tRef.current('spot.cancelReleaseHint'),
        ].join('\n'),
        [
          {
            text: tRef.current('spot.keepOrder'),
            style: 'cancel',
            onPress: () => {
              cancelConfirmationIdsRef.current.delete(orderId);
            },
          },
          {
            text: tRef.current('spot.confirmCancel'),
            style: 'destructive',
            onPress: async () => {
              cancelConfirmationIdsRef.current.delete(orderId);
              if (
                !marketScreenActiveRef.current ||
                executionLifecycleGenerationRef.current !==
                  openingLifecycleGeneration ||
                activeInstrumentKeyRef.current !== openingInstrumentKey ||
                cancelingOrderIdsRef.current.has(orderId)
              ) {
                return;
              }

              cancelingOrderIdsRef.current.add(orderId);
              setCancelingOrderIds(current =>
                current.includes(orderId) ? current : [...current, orderId],
              );

              let succeeded = false;
              let reloaded = false;
              let failureMessage = '';
              let canceledOrderIdentity = `#${orderId}`;
              try {
                const result = await cancelSpotOrder(orderId);
                canceledOrderIdentity = result.orderNo || canceledOrderIdentity;
                succeeded = true;
              } catch (error) {
                failureMessage = getSpotCancelErrorMessage(error, tRef.current);
              } finally {
                if (
                  mountedRef.current &&
                  marketScreenActiveRef.current &&
                  executionLifecycleGenerationRef.current ===
                    openingLifecycleGeneration &&
                  activeInstrumentKeyRef.current === openingInstrumentKey
                ) {
                  reloaded = await loadPrivateData();
                }
                cancelingOrderIdsRef.current.delete(orderId);
                if (mountedRef.current) {
                  setCancelingOrderIds(current =>
                    current.filter(item => item !== orderId),
                  );
                }
              }

              if (
                !mountedRef.current ||
                !marketScreenActiveRef.current ||
                executionLifecycleGenerationRef.current !==
                  openingLifecycleGeneration ||
                activeInstrumentKeyRef.current !== openingInstrumentKey
              ) {
                return;
              }
              const cancelFeedback = succeeded
                ? reloaded
                  ? tRef.current('spot.cancelSuccess', {
                      identity: canceledOrderIdentity,
                    })
                  : tRef.current('spot.cancelSuccessRefreshFailed', {
                      identity: canceledOrderIdentity,
                    })
                : failureMessage;
              setFeedbackText(cancelFeedback);
              setFeedbackTone(succeeded && reloaded ? 'success' : 'error');
              Alert.alert(
                tRef.current(
                  succeeded
                    ? 'spot.cancelSuccessTitle'
                    : 'spot.cancelIncompleteTitle',
                ),
                succeeded
                  ? reloaded
                    ? tRef.current('spot.canceledAndRefreshed')
                    : tRef.current('spot.canceledRefreshFailed')
                  : failureMessage,
              );
            },
          },
        ],
        {
          cancelable: true,
          onDismiss: () => {
            cancelConfirmationIdsRef.current.delete(orderId);
          },
        },
      );
    },
    [instrumentKey, loadPrivateData, symbol],
  );

  const handleOpenChart = useCallback(() => {
    navigation.navigate('MarketDetail', {
      market: 'spot',
      symbol,
      baseAsset,
      quoteAsset,
      displayLabel,
      initialInterval: klineInterval,
      ...(klines.length > 0 ? { initialKlines: klines.slice(-48) } : {}),
    });
  }, [
    baseAsset,
    displayLabel,
    klineInterval,
    klines,
    navigation,
    quoteAsset,
    symbol,
  ]);

  const handleRecordsRetry = useCallback(() => {
    loadPrivateData().catch(() => undefined);
  }, [loadPrivateData]);

  const handleRecordTabChange = useCallback((nextTab: TradeRecordTab) => {
    setRecordTab(nextTab);
    setLoadMoreError(null);
  }, []);

  const handleLoadMoreRecords = useCallback(async () => {
    if (
      !isLoggedIn ||
      loadingMoreTab !== null ||
      !activeRecordPage.paginationSupported ||
      !activeRecordPage.hasMore ||
      activeRecordPage.nextCursor === null
    ) {
      return;
    }
    const tab = recordTab;
    const cursor = activeRecordPage.nextCursor;
    const generation = privateGenerationRef.current;
    const scope = orderIntentScope;
    setLoadingMoreTab(tab);
    setLoadMoreError(null);
    try {
      const page =
        tab === 'current'
          ? await fetchSpotCurrentOrdersPage(
              symbol,
              SPOT_ACTIVE_ORDER_LIMIT,
              cursor,
            )
          : tab === 'history'
          ? await fetchSpotHistoryOrdersPage(
              symbol,
              SPOT_HISTORY_ORDER_LIMIT,
              cursor,
            )
          : await fetchSpotMyTradesPage(symbol, SPOT_TRADE_FILL_LIMIT, cursor);
      if (
        generation !== privateGenerationRef.current ||
        activeOrderIntentScopeRef.current !== scope
      ) {
        return;
      }
      if (!page.paginationSupported) {
        throw new Error(tRef.current('spot.paginationUnsupported'));
      }
      if (
        page.hasMore &&
        (page.nextCursor === null || page.nextCursor >= cursor)
      ) {
        throw new Error(tRef.current('spot.paginationInvalid'));
      }
      if (tab === 'current') {
        setCurrentOrders(current =>
          appendUniqueSpotRecords(current, page.items as SpotOrderItem[]),
        );
        setCurrentOrdersPage(getSpotPageInfo(page));
      } else if (tab === 'history') {
        setHistoryOrders(current =>
          appendUniqueSpotRecords(current, page.items as SpotOrderItem[]),
        );
        setHistoryOrdersPage(getSpotPageInfo(page));
      } else {
        setMyTrades(current =>
          appendUniqueSpotRecords(current, page.items as SpotMyTradeItem[]),
        );
        setMyTradesPage(getSpotPageInfo(page));
      }
    } catch (error) {
      if (
        generation === privateGenerationRef.current &&
        activeOrderIntentScopeRef.current === scope
      ) {
        setLoadMoreError(
          error instanceof Error
            ? error.message
            : tRef.current('spot.loadMoreFailed'),
        );
      }
    } finally {
      if (
        generation === privateGenerationRef.current &&
        activeOrderIntentScopeRef.current === scope
      ) {
        setLoadingMoreTab(null);
      }
    }
  }, [
    activeRecordPage,
    isLoggedIn,
    loadingMoreTab,
    orderIntentScope,
    recordTab,
    symbol,
  ]);

  const handleKlineIntervalChange = useCallback(
    (nextInterval: KlineInterval) => {
      setKlineInterval(nextInterval);
      setKlines([]);
      setKlineError(null);
    },
    [],
  );

  const handleOpenMore = useCallback(() => setMoreOpen(true), []);
  const handleCloseMore = useCallback(() => setMoreOpen(false), []);

  const handleMoreAction = useCallback(
    (action: TradeMoreAction) => {
      setMoreOpen(false);
      if (action === 'orders') {
        setRecordTab('current');
        return;
      }
      if (action === 'assets') {
        navigation.navigate('Assets');
        return;
      }
      if (action === 'rcbFee') {
        navigation.navigate('VipCenter');
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

  return (
    <AppScreen contentWidth="wide">
      <TradeTopTabs
        activeKey={activeBusiness}
        tabs={businessTabs}
        onChange={handleBusinessChange}
      />
      <TradeSymbolHeader
        baseAsset={baseAsset}
        changePercent={changePercent}
        lastPrice={lastPrice}
        logoUrl={logoUrl}
        pricePrecision={displayPricePrecision}
        symbolLabel={displayLabel}
        onOpenChart={handleOpenChart}
        onOpenMore={handleOpenMore}
        onSymbolPress={openMarketSelector}
      />
      {privateRealtimeNotice ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.realtimeNotice}
        >
          {privateRealtimeNotice}
        </Text>
      ) : null}
      {publicError ? <Text style={styles.error}>{publicError}</Text> : null}
      <View
        style={[
          styles.tradeMain,
          responsiveLayout.shouldStackTradingPanels
            ? styles.tradeMainStacked
            : null,
        ]}
      >
        <View
          style={[
            styles.formPanelWrap,
            responsiveLayout.shouldStackTradingPanels
              ? styles.panelWrapStacked
              : null,
          ]}
        >
          <TradeOrderForm
            amount={amount}
            availableText={availableText}
            baseAsset={baseAsset}
            feedbackText={visibleSubmissionBlockingMessage || feedbackText}
            feedbackTone={
              visibleSubmissionBlockingMessage
                ? submissionGuardError || marketSubmissionBlockingMessage
                  ? 'error'
                  : null
                : feedbackTone
            }
            estimatedFeeLabel={estimatedFeeLabel}
            estimatedFeeText={estimatedFeeText}
            isLoggedIn={isLoggedIn}
            lastPrice={orderType === 'MARKET' ? marketExecutionPrice : null}
            orderType={orderType}
            pendingIntentReviewBusy={reviewingPendingIntent}
            pendingIntentReviewLabel={
              orderIntentLoadFailure
                ? t('trading.restoreOrder')
                : t('trading.viewOrder')
            }
            pendingIntentReviewVisible={Boolean(
              pendingOrderIntent || orderIntentLoadFailure,
            )}
            price={price}
            quoteAsset={quoteAsset}
            side={side}
            submitDisabled={
              Boolean(submissionBlockingMessage) ||
              (orderType === 'MARKET' && !marketExecutable)
            }
            submitting={submitting}
            onAmountChange={handleAmountChange}
            onBboPress={handleBboPress}
            onLoginPress={openLogin}
            onOrderTypeChange={handleOrderTypeChange}
            onPercentPress={handlePercentPress}
            onPendingIntentReviewPress={handlePendingIntentReview}
            onPriceChange={handlePriceChange}
            onSideChange={handleSideChange}
            onSubmitPress={handleSubmit}
          />
        </View>
        <View
          style={[
            styles.orderBookPanelWrap,
            responsiveLayout.shouldStackTradingPanels
              ? styles.panelWrapStacked
              : null,
          ]}
        >
          <TradeOrderBook
            amountPrecision={amountPrecision}
            asks={asks}
            baseAsset={baseAsset}
            bids={bids}
            lastPrice={lastPrice}
            pricePrecision={displayPricePrecision}
            quoteAsset={quoteAsset}
            trades={trades}
            onPricePress={handlePriceChange}
          />
        </View>
      </View>

      {estimatedFeeHint ? (
        <Text testID="spot-fee-payment-hint" style={styles.feePaymentHint}>
          {estimatedFeeHint}
        </Text>
      ) : null}

      {deferredScreenContentReady ? (
        <>
          <View style={styles.chartCard}>
            <View style={styles.chartHeader}>
              <Text style={styles.chartTitle}>{t('trading.chartTitle')}</Text>
              <Pressable
                accessibilityLabel={t('trading.spotFullscreenA11y')}
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
              error={publicError}
              height={176}
              interval={klineInterval}
              items={klines}
              loading={publicLoading}
              pricePrecision={displayPricePrecision}
              visibleCount={36}
              onIntervalChange={handleKlineIntervalChange}
            />
          </View>

          <TradeBottomTabs
            activeTab={recordTab}
            amountPrecision={amountPrecision}
            baseAsset={baseAsset}
            cancelingOrderIds={cancelingOrderIds}
            currentOrders={currentOrders}
            error={recordError}
            fills={myTrades}
            hasMore={
              activeRecordPage.paginationSupported && activeRecordPage.hasMore
            }
            historyOrders={historyOrders}
            isLoggedIn={isLoggedIn}
            loadMoreError={loadMoreError}
            loadingMore={loadingMoreTab === recordTab}
            pricePrecision={displayPricePrecision}
            quoteAsset={quoteAsset}
            symbolLabel={displayLabel}
            onChange={handleRecordTabChange}
            onCancelPress={handleCancelOrder}
            onLoadMore={handleLoadMoreRecords}
            onLoginPress={openLogin}
            onRetryPress={handleRecordsRetry}
          />
        </>
      ) : null}

      <TradeMoreSheet
        visible={moreOpen}
        onActionPress={handleMoreAction}
        onClose={handleCloseMore}
      />
    </AppScreen>
  );
}

function getSpotCancelErrorMessage(error: unknown, t: Translator) {
  const raw = error instanceof Error ? error.message.trim() : '';
  const normalized = raw.toUpperCase();
  if (
    normalized.includes('ORDER NOT FOUND') ||
    normalized.includes('ORDER CANNOT BE CANCELED') ||
    normalized.includes('NO REMAINING AMOUNT TO CANCEL') ||
    normalized.includes('ALREADY FILLED') ||
    normalized.includes('ALREADY CANCELED')
  ) {
    return t('trading.cancelStatusChanged');
  }
  return getTradingErrorMessage(error, t('trading.cancelFailed'));
}

const styles = StyleSheet.create({
  feePaymentHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    padding: 10,
    backgroundColor: colors.card,
    borderRadius: 8,
  },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  realtimeNotice: {
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.2)',
    backgroundColor: 'rgba(214, 168, 50, 0.08)',
    color: colors.textMuted,
    fontSize: 11,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  error: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    color: colors.gold,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
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
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  chartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  chartTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
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
