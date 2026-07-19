'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  closeContractOrder,
  closeContractSummaryOrder,
  openContractOrder,
  type ContractMarketViewDetail,
  type ContractQuoteDisplayStatus,
  type ContractOrderType,
  type ContractPositionItem,
  type ContractPositionSide,
  type ContractPositionSummaryItem,
  type ContractQuote,
  type ContractTpSlTriggerPriceType,
} from '@/lib/api/modules/contract';
import {
  formatNumber,
  friendlyContractError,
  toNumber,
} from './contractFormat';
import ContractLeverageModal from './ContractLeverageModal';
import TradingConfirmModal from '@/components/common/TradingConfirmModal';
import { formatPrice, formatRawPrice } from '@/lib/marketPrecision';
import PercentageSlider from '@/components/spot/form/PercentageSlider';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  calculateContractSliderAmount,
  formatContractAmountOnBlur,
  isPositiveContractAmountAtPrecision,
  normalizeContractAmountPrecision,
  normalizeContractDecimalInput,
  resolveContractOpenEntryReference,
} from './contractTradingForm.utils';
import {
  normalizeContractMarketViewDisplayState,
  readContractMarketViewAuthority,
  resolveContractMarketViewAuthorityPresentation,
} from './contractMarketView.utils';
import {
  resolveContractExecutionPrice,
  type ContractPriceAuthorityV1,
} from './contractPriceAuthority';
import {
  buildContractTradingFormLegacyMarketRead,
  resolveContractTradingFormMarketRead,
} from './ContractTradingFormMarketRead';
import { useContractTradingFormStoreSnapshot } from './hooks/contractMarketStoreAdapter';

type PositionMode = 'ONEWAY';
type TradeTab = 'OPEN' | 'CLOSE';
type FormFeedback = {
  type: 'success' | 'error' | 'info';
  message: string;
};
type QuoteUnavailableReason =
  | 'MARKET_VIEW_EXPIRED'
  | 'MARKET_VIEW_DISPLAY_ONLY'
  | 'MARKET_VIEW_UNAVAILABLE'
  | 'NON_TRADING_SESSION'
  | null;
type PendingContractOrder = {
  action: 'OPEN' | 'CLOSE';
  side: ContractPositionSide;
};

type ContractTradingFormProps = {
  symbol: string;
  quote: ContractQuote | null;
  marketView?: ContractMarketViewDetail | null;
  positions?: ContractPositionItem[];
  positionSummaries?: ContractPositionSummaryItem[];
  selectedPrice?: string | null;
  bestBid?: string | number | null;
  bestAsk?: string | number | null;
  executionBid?: string | number | null;
  executionAsk?: string | number | null;
  executable?: boolean | null;
  reasonCode?: string | null;
  priceAuthority: ContractPriceAuthorityV1;
  pricePrecision: number;
  amountPrecision?: number | null;
  quantityUnit?: string;
  maxLeverage?: number;
  availableMargin?: string | null;
  isLoggedIn: boolean;
  disabled?: boolean;
  quoteLoading?: boolean;
  marketUiState?: {
    label: string;
    isLoading: boolean;
    isTradable: boolean;
    isRealtime: boolean;
    reason: string;
    status: ContractQuoteDisplayStatus;
  };
  onSuccess: () => Promise<void> | void;
  tpSlTriggerPriceType?: ContractTpSlTriggerPriceType | string | null;
};

const DEFAULT_MAX_LEVERAGE = 200;
const TP_SL_STEP = 1;
const CONTRACT_TRADE_CONFIRM_HIDDEN_KEY = 'contract_trade_confirm_hidden';
type ContractTranslator = (key: string, namespace?: 'contracts' | 'common') => string;

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
    // localStorage can be disabled in restricted browser contexts.
  }
}

function displaySymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}

function displayMoney(value: number | null, digits = 6) {
  return value === null ? '--' : `${formatNumber(value, digits)} USDT`;
}

function formatInputPrice(value: number, precision: number) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value.toFixed(precision);
}

function formatDisplayPrice(value: string | number | null | undefined, precision: number) {
  const num = toNumber(value);
  return num > 0 ? formatPrice(num, precision) : '--';
}

function getDefaultTpSlPrice(
  side: ContractPositionSide,
  type: 'TAKE_PROFIT' | 'STOP_LOSS',
  referencePrice: number,
  precision: number,
) {
  if (referencePrice <= 0) return '';
  const multiplier = side === 'LONG'
    ? (type === 'TAKE_PROFIT' ? 1.02 : 0.99)
    : (type === 'TAKE_PROFIT' ? 0.98 : 1.01);
  return formatInputPrice(referencePrice * multiplier, precision);
}

function adjustTpSlPrice(value: string, delta: number, precision: number) {
  const next = Math.max(0, (toNumber(value) || 0) + delta);
  return formatInputPrice(next, precision);
}

function isNonTradingMarketViewState(value?: string | null) {
  const state = normalizeContractMarketViewDisplayState(value);
  return state === 'PRE_MARKET'
    || state === 'AFTER_HOURS'
    || state === 'CLOSED'
    || state === 'MARKET_CLOSED'
    || state === 'HOLIDAY'
    || state === 'CLOSED_LAST_GOOD_TRADABLE'
    || state === 'CLOSED_LAST_GOOD_DISPLAY_ONLY';
}

function getMarketViewUnavailableReason(
  marketView?: ContractMarketViewDetail | null,
  executable?: boolean | null,
  reasonCode?: string | null,
): QuoteUnavailableReason {
  const unavailableByReason = isUnavailableExecutionReason(reasonCode ?? marketView?.reason_code);
  const unavailableByExecutable = (executable ?? marketView?.executable ?? null) === false;
  const state = normalizeContractMarketViewDisplayState(marketView?.display_state);
  const reason = String(reasonCode ?? marketView?.reason_code ?? '').trim().toUpperCase();
  if (isNonTradingMarketViewState(state)) return 'NON_TRADING_SESSION';
  if (reason.includes('NON_TRADING') || reason.includes('CLOSED') || reason.includes('HOLIDAY')) {
    return 'NON_TRADING_SESSION';
  }
  if (state === 'EXPIRED') return 'MARKET_VIEW_EXPIRED';
  if (reason.includes('EXPIRED') || reason.includes('STALE') || reason.includes('NOT_LIVE')) {
    return 'MARKET_VIEW_EXPIRED';
  }
  if (state === 'CLOSED_LAST_GOOD_DISPLAY_ONLY') return 'MARKET_VIEW_DISPLAY_ONLY';
  if (reason.includes('DIAGNOSTIC_ONLY')) return 'MARKET_VIEW_DISPLAY_ONLY';
  if (!unavailableByExecutable && !unavailableByReason) return null;
  return 'MARKET_VIEW_UNAVAILABLE';
}

function isUnavailableExecutionReason(reasonCode?: string | null) {
  const normalized = String(reasonCode || '').trim().toUpperCase();
  if (!normalized || normalized === 'LIVE_BBO') return false;
  return normalized.includes('UNAVAILABLE')
    || normalized.includes('EXPIRED')
    || normalized.includes('STALE')
    || normalized.includes('DISABLED')
    || normalized.includes('NON_TRADING')
    || normalized.includes('CLOSED')
    || normalized.includes('HOLIDAY')
    || normalized.includes('UNKNOWN')
    || normalized.includes('NO_MARKET_DATA')
    || normalized.includes('NOT_LIVE')
    || normalized.includes('DIAGNOSTIC_ONLY');
}

function sideText(side: ContractPositionSide, t: ContractTranslator) {
  return side === 'LONG' ? t('longPosition', 'contracts') : t('shortPosition', 'contracts');
}

function sideTone(side: ContractPositionSide) {
  return side === 'LONG' ? 'text-[#00c087]' : 'text-[#f6465d]';
}

function contractActionText(action: PendingContractOrder['action'], side: ContractPositionSide, t: ContractTranslator) {
  if (action === 'OPEN') return side === 'LONG' ? t('openLong', 'contracts') : t('openShort', 'contracts');
  return side === 'LONG' ? t('closeLong', 'contracts') : t('closeShort', 'contracts');
}

export default function ContractTradingForm({
  symbol,
  quote,
  marketView,
  positions = [],
  positionSummaries = [],
  selectedPrice,
  priceAuthority,
  pricePrecision,
  amountPrecision,
  quantityUnit = 'BTC',
  maxLeverage = DEFAULT_MAX_LEVERAGE,
  availableMargin,
  isLoggedIn,
  disabled = false,
  quoteLoading = false,
  onSuccess,
  tpSlTriggerPriceType,
}: ContractTradingFormProps) {
  const { t } = useLocaleContext();
  const [positionMode] = useState<PositionMode>('ONEWAY');
  const [tradeTab, setTradeTab] = useState<TradeTab>('OPEN');
  const [positionSide, setPositionSide] = useState<ContractPositionSide>('LONG');
  const [closeSide, setCloseSide] = useState<ContractPositionSide>('LONG');
  const [orderType, setOrderType] = useState<ContractOrderType>('LIMIT');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [closeQuantity, setCloseQuantity] = useState('');
  const [leverage, setLeverage] = useState(10);
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [tpSlEnabled, setTpSlEnabled] = useState(false);
  const [takeProfitTouched, setTakeProfitTouched] = useState(false);
  const [stopLossTouched, setStopLossTouched] = useState(false);
  const [leverageOpen, setLeverageOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingContractOrder, setPendingContractOrder] = useState<PendingContractOrder | null>(null);
  const [pendingContractError, setPendingContractError] = useState('');
  const [contractConfirmHidden, setContractConfirmHidden] = useState(() => readLocalStorageFlag(CONTRACT_TRADE_CONFIRM_HIDDEN_KEY));
  const [feedback, setFeedback] = useState<FormFeedback | null>(null);
  const [openPercent, setOpenPercent] = useState(0);
  const [closePercent, setClosePercent] = useState(0);
  const safeAmountPrecision = useMemo(
    () => normalizeContractAmountPrecision(amountPrecision),
    [amountPrecision],
  );
  const effectiveMaxLeverage = useMemo(() => {
    const next = Math.floor(Number(maxLeverage));
    return Number.isFinite(next) && next > 0 ? next : DEFAULT_MAX_LEVERAGE;
  }, [maxLeverage]);

  useEffect(() => {
    if (orderType !== 'LIMIT') return;
    const normalized = String(selectedPrice || '').replace(/,/g, '').trim();
    if (normalized && Number.isFinite(Number(normalized))) {
      setPrice(formatRawPrice(normalized, pricePrecision));
    }
  }, [orderType, pricePrecision, selectedPrice]);

  useEffect(() => {
    if (!feedback) return undefined;
    const timer = window.setTimeout(
      () => setFeedback(null),
      feedback.type === 'success' ? 3000 : 5000,
    );
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    setFeedback(null);
    setPendingContractOrder(null);
    setPendingContractError('');
    setOpenPercent(0);
    setClosePercent(0);
  }, [symbol, tradeTab, orderType]);

  useEffect(() => {
    setLeverage((previous) => Math.min(previous, effectiveMaxLeverage));
  }, [effectiveMaxLeverage]);

  function showFeedback(type: FormFeedback['type'], message: string) {
    setFeedback({ type, message });
  }

  const openPositions = useMemo(
    () => positions.filter((item) => item.status === 'OPEN' && toNumber(item.quantity) > 0),
    [positions],
  );
  const longPosition = openPositions.find((item) => item.side === 'LONG') || null;
  const shortPosition = openPositions.find((item) => item.side === 'SHORT') || null;
  const selectedClosePosition = closeSide === 'LONG' ? longPosition : shortPosition;
  const normalizedSymbol = symbol.toUpperCase();
  const currentPositionSummaries = useMemo(
    () => positionSummaries.filter((item) => (
      String(item.symbol || '').trim().toUpperCase() === normalizedSymbol &&
      toNumber(item.quantity) > 0
    )),
    [normalizedSymbol, positionSummaries],
  );
  const longSummary = currentPositionSummaries.find((item) => item.side === 'LONG') || null;
  const shortSummary = currentPositionSummaries.find((item) => item.side === 'SHORT') || null;
  const selectedCloseSummary = closeSide === 'LONG' ? longSummary : shortSummary;
  const selectedCloseQuantity = selectedCloseSummary?.quantity || selectedClosePosition?.quantity || '0';
  const selectedCloseEntryPrice = selectedCloseSummary?.avg_entry_price || selectedClosePosition?.entry_price || null;

  const availableMarginNumber = toNumber(availableMargin);
  const quantityForOrder = formatContractAmountOnBlur(quantity, safeAmountPrecision);
  const closeQuantityForOrder = closeQuantity.trim()
    ? formatContractAmountOnBlur(closeQuantity, safeAmountPrecision)
    : '';
  const quantityNumber = toNumber(quantityForOrder);
  const closeQuantityNumber = toNumber(closeQuantityForOrder || selectedCloseQuantity);

  const quoteSingleSideSpreadFeePrice = toNumber(quote?.single_side_spread_fee_price)
    || (toNumber(quote?.effective_total_spread) > 0 ? toNumber(quote?.effective_total_spread) / 2 : 0);
  const tradingFormStoreSnapshot = useContractTradingFormStoreSnapshot(symbol);
  const legacyDisplayMarketRead = useMemo(
    () => buildContractTradingFormLegacyMarketRead({
      quote,
      marketView,
      loading: quoteLoading && !marketView,
    }),
    [marketView, quote, quoteLoading],
  );
  const displayMarketRead = useMemo(
    () => resolveContractTradingFormMarketRead(
      tradingFormStoreSnapshot,
      legacyDisplayMarketRead,
    ),
    [legacyDisplayMarketRead, tradingFormStoreSnapshot],
  );
  const marketViewAuthority = useMemo(
    () => readContractMarketViewAuthority(marketView),
    [marketView],
  );
  const marketViewPresentation = useMemo(
    () => resolveContractMarketViewAuthorityPresentation({
      marketView,
      loading: quoteLoading && !marketView,
    }),
    [marketView, quoteLoading],
  );
  const executionPrices = useMemo(() => ({
    openLong: resolveContractExecutionPrice({
      authority: priceAuthority,
      intent: 'OPEN_LONG',
      expectedSymbol: symbol,
    }),
    openShort: resolveContractExecutionPrice({
      authority: priceAuthority,
      intent: 'OPEN_SHORT',
      expectedSymbol: symbol,
    }),
    closeLong: resolveContractExecutionPrice({
      authority: priceAuthority,
      intent: 'CLOSE_LONG',
      expectedSymbol: symbol,
    }),
    closeShort: resolveContractExecutionPrice({
      authority: priceAuthority,
      intent: 'CLOSE_SHORT',
      expectedSymbol: symbol,
    }),
  }), [priceAuthority, symbol]);
  const resolvedExecutable = marketViewAuthority.executable;
  const resolvedReasonCode = marketViewAuthority.reasonCode;
  const reasonCodeUnavailable = isUnavailableExecutionReason(resolvedReasonCode);
  const quoteUnavailable = !marketViewPresentation.isTradable || reasonCodeUnavailable;
  const quoteStatusLoading = marketViewPresentation.isLoading;
  const quoteUnavailableReason: QuoteUnavailableReason = quoteUnavailable && !quoteStatusLoading
    ? getMarketViewUnavailableReason(marketView, resolvedExecutable, resolvedReasonCode)
      || 'MARKET_VIEW_UNAVAILABLE'
    : null;
  const quoteLoadingFeedback = quoteStatusLoading ? t('marketDataLoadingLabel', 'contracts') : null;
  const quoteUnavailableFeedback = quoteUnavailableReason === 'NON_TRADING_SESSION'
    ? '当前非交易时段，暂不可下单'
    : quoteUnavailableReason === 'MARKET_VIEW_EXPIRED'
      ? t('quoteUnavailableTradingHint', 'contracts')
    : quoteUnavailableReason === 'MARKET_VIEW_DISPLAY_ONLY'
      ? t('quoteUnavailableTradingHint', 'contracts')
    : quoteUnavailableReason === 'MARKET_VIEW_UNAVAILABLE'
      ? t('quoteUnavailableTradingHint', 'contracts')
      : null;
  const currentActionExecution = tradeTab === 'CLOSE'
    ? (closeSide === 'LONG' ? executionPrices.closeLong : executionPrices.closeShort)
    : (positionSide === 'LONG' ? executionPrices.openLong : executionPrices.openShort);

  const longOpenPrice = orderType === 'LIMIT' ? toNumber(price) : executionPrices.openLong.price ?? 0;
  const shortOpenPrice = orderType === 'LIMIT' ? toNumber(price) : executionPrices.openShort.price ?? 0;
  const longNotional = quantityNumber > 0 && longOpenPrice > 0 ? quantityNumber * longOpenPrice : null;
  const shortNotional = quantityNumber > 0 && shortOpenPrice > 0 ? quantityNumber * shortOpenPrice : null;
  const longMargin = longNotional !== null && leverage > 0 ? longNotional / leverage : null;
  const shortMargin = shortNotional !== null && leverage > 0 ? shortNotional / leverage : null;

  const spreadCostHint = useMemo(() => {
    if (quoteSingleSideSpreadFeePrice <= 0 || quantityNumber <= 0) return null;
    return quoteSingleSideSpreadFeePrice * quantityNumber;
  }, [quantityNumber, quoteSingleSideSpreadFeePrice]);

  const closeSpreadCostHint = useMemo(() => {
    if (quoteSingleSideSpreadFeePrice <= 0 || closeQuantityNumber <= 0) return null;
    return quoteSingleSideSpreadFeePrice * closeQuantityNumber;
  }, [closeQuantityNumber, quoteSingleSideSpreadFeePrice]);

  const limitPriceNumber = toNumber(price);
  const estimatedExecutionPrice = useMemo(() => {
    if (!currentActionExecution.executable || currentActionExecution.price === null) {
      return null;
    }
    if (orderType === 'MARKET') {
      return currentActionExecution.price;
    }
    if (limitPriceNumber <= 0) return null;

    if (tradeTab === 'CLOSE') {
      if (closeSide === 'LONG') {
        return executionPrices.closeLong.price !== null
          && limitPriceNumber <= executionPrices.closeLong.price
          ? executionPrices.closeLong.price
          : limitPriceNumber;
      }
      return executionPrices.closeShort.price !== null
        && limitPriceNumber >= executionPrices.closeShort.price
        ? executionPrices.closeShort.price
        : limitPriceNumber;
    }

    if (positionSide === 'LONG') {
      return executionPrices.openLong.price !== null
        && limitPriceNumber >= executionPrices.openLong.price
        ? executionPrices.openLong.price
        : limitPriceNumber;
    }
    return executionPrices.openShort.price !== null
      && limitPriceNumber <= executionPrices.openShort.price
      ? executionPrices.openShort.price
      : limitPriceNumber;
  }, [
    closeSide,
    currentActionExecution.executable,
    currentActionExecution.price,
    executionPrices.closeLong.price,
    executionPrices.closeShort.price,
    executionPrices.openLong.price,
    executionPrices.openShort.price,
    limitPriceNumber,
    orderType,
    positionSide,
    tradeTab,
  ]);
  const executionPriceMissing = !currentActionExecution.executable
    || currentActionExecution.price === null;
  const executionPriceFeedback = executionPriceMissing
    ? t('marketDataUnavailable', 'contracts')
    : null;
  const displayFeedback = quoteLoadingFeedback
    ? { type: 'info' as const, message: quoteLoadingFeedback }
    : quoteUnavailableFeedback
    ? { type: 'error' as const, message: quoteUnavailableFeedback }
    : executionPriceFeedback
    ? { type: 'error' as const, message: executionPriceFeedback }
    : feedback;

  const spreadHintText = t('spreadCostHelp', 'contracts');
  const normalizedTpSlTriggerPriceType = normalizeTpSlTriggerPriceType(tpSlTriggerPriceType);
  const tpSlTriggerPriceTypeHint = normalizedTpSlTriggerPriceType === 'LAST_PRICE'
    ? t('tpSlLastPriceTrigger', 'contracts')
    : t('tpSlMarkPriceTrigger', 'contracts');
  const currentOpenExecution = positionSide === 'LONG'
    ? executionPrices.openLong
    : executionPrices.openShort;
  const currentTpSlReferencePrice = resolveContractOpenEntryReference({
    side: positionSide,
    orderType,
    limitPrice: price,
    executionPrice: currentOpenExecution.price,
    executable: currentOpenExecution.executable,
  }) ?? 0;

  useEffect(() => {
    if (!tpSlEnabled || tradeTab !== 'OPEN' || currentTpSlReferencePrice <= 0) return;
    if (!takeProfitTouched) {
      setTakeProfitPrice(getDefaultTpSlPrice(positionSide, 'TAKE_PROFIT', currentTpSlReferencePrice, pricePrecision));
    }
    if (!stopLossTouched) {
      setStopLossPrice(getDefaultTpSlPrice(positionSide, 'STOP_LOSS', currentTpSlReferencePrice, pricePrecision));
    }
  }, [
    currentTpSlReferencePrice,
    positionSide,
    pricePrecision,
    stopLossTouched,
    takeProfitTouched,
    tpSlEnabled,
    tradeTab,
  ]);

  const closeEstimate = useMemo(() => {
    if (!selectedCloseSummary && !selectedClosePosition) return 0;
    const qty = closeQuantityNumber;
    const entry = toNumber(selectedCloseEntryPrice);
    const closePrice = estimatedExecutionPrice;
    if (!qty || !entry || !closePrice) return 0;
    return closeSide === 'LONG'
      ? (closePrice - entry) * qty
      : (entry - closePrice) * qty;
  }, [closeQuantityNumber, closeSide, estimatedExecutionPrice, selectedCloseEntryPrice, selectedClosePosition, selectedCloseSummary]);

  const submitDisabled = disabled
    || submitting
    || !isLoggedIn
    || quoteStatusLoading
    || quoteUnavailable
    || executionPriceMissing;
  const openSubmitDisabled = submitDisabled || availableMarginNumber <= 0 || quantityNumber <= 0;
  const closeQuantityInvalid = closeQuantity.trim() !== '' && closeQuantityNumber <= 0;
  const closeDisabled = submitDisabled
    || (!selectedCloseSummary && !selectedClosePosition)
    || closeQuantityInvalid;

  function currentBboPrice() {
    return currentActionExecution.price;
  }

  function currentBboPriceText() {
    const next = currentBboPrice();
    return next !== null ? String(next) : '';
  }

  function fillBboPrice() {
    const next = String(currentBboPriceText() || '').replace(/,/g, '').trim();
    if (next && Number.isFinite(Number(next)) && Number(next) > 0) {
      setPrice(formatRawPrice(next, pricePrecision));
    }
  }

  function adjustLimitPrice(delta: number) {
    const base = toNumber(price) || currentBboPrice() || 0;
    setPrice(formatInputPrice(Math.max(0, base + delta), pricePrecision));
  }

  function handleTpSlEnabledChange(enabled: boolean) {
    setTpSlEnabled(enabled);
    setTakeProfitTouched(false);
    setStopLossTouched(false);
  }

  function handleTakeProfitPriceChange(value: string) {
    setTakeProfitTouched(true);
    setTakeProfitPrice(value);
  }

  function handleStopLossPriceChange(value: string) {
    setStopLossTouched(true);
    setStopLossPrice(value);
  }

  function stepTakeProfitPrice(delta: number) {
    setTakeProfitTouched(true);
    setTakeProfitPrice((current) => adjustTpSlPrice(current, delta, pricePrecision));
  }

  function stepStopLossPrice(delta: number) {
    setStopLossTouched(true);
    setStopLossPrice((current) => adjustTpSlPrice(current, delta, pricePrecision));
  }

  function handleQuantityInputChange(value: string) {
    const normalized = normalizeContractDecimalInput(value);
    if (normalized === null) return;
    setQuantity(normalized);
    setOpenPercent(0);
    setFeedback(null);
  }

  function handleQuantityBlur() {
    if (!quantity) return;
    setQuantity(formatContractAmountOnBlur(quantity, safeAmountPrecision));
  }

  function handleCloseQuantityInputChange(value: string) {
    const normalized = normalizeContractDecimalInput(value);
    if (normalized === null) return;
    setCloseQuantity(normalized);
    setClosePercent(0);
    setFeedback(null);
  }

  function handleCloseQuantityBlur() {
    if (!closeQuantity) return;
    setCloseQuantity(formatContractAmountOnBlur(closeQuantity, safeAmountPrecision));
  }

  function applyOpenPercent(percent: number) {
    const referencePrice = positionSide === 'LONG' ? longOpenPrice : shortOpenPrice;
    if (availableMarginNumber <= 0 || leverage <= 0 || referencePrice <= 0) return;
    const maximumQuantity = (availableMarginNumber * leverage) / referencePrice;
    setQuantity(calculateContractSliderAmount(maximumQuantity, percent, safeAmountPrecision));
  }

  function handleOpenPercentChange(percent: number) {
    setOpenPercent(percent);
    applyOpenPercent(percent);
  }

  function applyClosePercent(percent: number) {
    const maxQuantity = closeSide === 'LONG'
      ? toNumber(longSummary?.quantity || longPosition?.quantity || '0')
      : toNumber(shortSummary?.quantity || shortPosition?.quantity || '0');
    setCloseQuantity(calculateContractSliderAmount(maxQuantity, percent, safeAmountPrecision));
  }

  function handleClosePercentChange(percent: number) {
    setClosePercent(percent);
    applyClosePercent(percent);
  }

  function openReferencePrice(side: ContractPositionSide) {
    const execution = side === 'LONG' ? executionPrices.openLong : executionPrices.openShort;
    return resolveContractOpenEntryReference({
      side,
      orderType,
      limitPrice: price,
      executionPrice: execution.price,
      executable: execution.executable,
    }) ?? 0;
  }

  function validateTpSl(side: ContractPositionSide) {
    if (!tpSlEnabled) return null;
    const tp = toNumber(takeProfitPrice);
    const sl = toNumber(stopLossPrice);
    if (!tp && !sl) return t('enterTakeProfitOrStopLoss', 'contracts');
    const referencePrice = openReferencePrice(side);
    if (referencePrice <= 0) return t('enterValidOpenPriceFirst', 'contracts');
    if (side === 'LONG') {
      if (tp && tp <= referencePrice) return t('longTakeProfitAboveEntry', 'contracts');
      if (sl && sl >= referencePrice) return t('longStopLossBelowEntry', 'contracts');
    } else {
      if (tp && tp >= referencePrice) return t('shortTakeProfitBelowEntry', 'contracts');
      if (sl && sl <= referencePrice) return t('shortStopLossAboveEntry', 'contracts');
    }
    return null;
  }

  function validateOpen(side: ContractPositionSide) {
    if (!isLoggedIn) return t('loginToTradeContracts', 'contracts');
    if (availableMarginNumber <= 0) return t('transferMarginFirst', 'contracts');
    if (quoteStatusLoading) return t('marketDataLoadingLabel', 'contracts');
    if (quoteUnavailableFeedback) return quoteUnavailableFeedback;
    const execution = side === 'LONG' ? executionPrices.openLong : executionPrices.openShort;
    if (!execution.executable || execution.price === null) {
      return t('marketDataUnavailable', 'contracts');
    }
    if (!quantity.trim()) return t('enterQuantity', 'contracts');
    if (!isPositiveContractAmountAtPrecision(quantity, safeAmountPrecision)) {
      return t('enterValidOpenQuantity', 'contracts');
    }
    if (leverage <= 0) return t('enterValidLeverage', 'contracts');
    if (orderType === 'LIMIT' && toNumber(price) <= 0) return t('enterValidLimitPrice', 'contracts');
    if (leverage > effectiveMaxLeverage) {
      return `${t('maxLeverageSupportedPrefix', 'contracts')} ${effectiveMaxLeverage}x ${t('maxLeverageSupportedSuffix', 'contracts')}`;
    }
    const tpSlError = validateTpSl(side);
    if (tpSlError) return tpSlError;
    setPositionSide(side);
    return null;
  }

  function validateClose(side: ContractPositionSide, position: ContractPositionItem | null, maxQuantity: string) {
    if (!isLoggedIn) return t('loginToTradeContracts', 'contracts');
    if (!selectedCloseSummary && !position) return t('noClosablePosition', 'contracts');
    if (quoteStatusLoading) return t('marketDataLoadingLabel', 'contracts');
    if (quoteUnavailableFeedback) return quoteUnavailableFeedback;
    const execution = side === 'LONG' ? executionPrices.closeLong : executionPrices.closeShort;
    if (!execution.executable || execution.price === null) {
      return t('marketDataUnavailable', 'contracts');
    }
    const qty = toNumber(closeQuantityForOrder || maxQuantity);
    if (qty <= 0) return t('enterValidCloseQuantity', 'contracts');
    if (qty > toNumber(maxQuantity)) return t('closeQuantityExceedsMax', 'contracts');
    if (orderType === 'LIMIT' && toNumber(price) <= 0) return t('enterValidLimitPrice', 'contracts');
    return null;
  }

  async function submitOpen(side: ContractPositionSide, confirmed = false) {
    if (submitting) return;
    const formError = validateOpen(side);
    if (formError) {
      if (confirmed) {
        setPendingContractError(formError);
      } else {
        showFeedback('error', formError);
      }
      return;
    }

    if (!confirmed && !contractConfirmHidden) {
      setPendingContractError('');
      setPendingContractOrder({ action: 'OPEN', side });
      return;
    }

    setSubmitting(true);
    setPendingContractError('');
    showFeedback('info', orderType === 'LIMIT' ? t('submittingOpenLimit', 'contracts') : t('submittingOpenMarket', 'contracts'));
    try {
      await openContractOrder({
        symbol,
        position_side: side,
        order_type: orderType,
        price: orderType === 'LIMIT' ? price : null,
        quantity: quantityForOrder,
        leverage,
        take_profit_price: tpSlEnabled && takeProfitPrice ? takeProfitPrice : null,
        stop_loss_price: tpSlEnabled && stopLossPrice ? stopLossPrice : null,
      });
      if (confirmed) {
        setPendingContractOrder(null);
        setPendingContractError('');
      }
      showFeedback('success', orderType === 'LIMIT' ? t('openLimitSubmitted', 'contracts') : t('openMarketSuccess', 'contracts'));
      await onSuccess();
    } catch (error) {
      const message = friendlyContractError(error, t);
      if (confirmed) {
        setPendingContractError(message);
      } else {
        showFeedback('error', message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function submitClose(side: ContractPositionSide, confirmed = false) {
    if (submitting) return;
    const position = side === 'LONG' ? longPosition : shortPosition;
    const summary = side === 'LONG' ? longSummary : shortSummary;
    const maxQuantity = summary?.quantity || position?.quantity || '0';
    if (confirmed && !summary && !position) {
      setPendingContractOrder(null);
      setPendingContractError('');
      showFeedback('error', t('positionUpdatedRetry', 'contracts'));
      await onSuccess();
      return;
    }

    const formError = validateClose(side, position, maxQuantity);
    if (formError) {
      if (confirmed) {
        setPendingContractError(formError);
        return;
      }
      showFeedback('error', formError);
      return;
    }
    if (!confirmed && !contractConfirmHidden) {
      setPendingContractError('');
      setPendingContractOrder({ action: 'CLOSE', side });
      return;
    }

    setSubmitting(true);
    setPendingContractError('');
    showFeedback('info', orderType === 'LIMIT' ? t('submittingCloseLimit', 'contracts') : t('submittingCloseMarket', 'contracts'));
    try {
      if (summary) {
        await closeContractSummaryOrder({
          symbol,
          side,
          order_type: orderType,
          price: orderType === 'LIMIT' ? price : null,
          quantity: closeQuantityForOrder || null,
        });
      } else {
        await closeContractOrder({
          position_id: position!.id,
          order_type: orderType,
          price: orderType === 'LIMIT' ? price : null,
          quantity: closeQuantityForOrder || null,
        });
      }
      if (confirmed) {
        setPendingContractOrder(null);
        setPendingContractError('');
      }
      showFeedback('success', orderType === 'LIMIT' ? t('closeLimitSubmitted', 'contracts') : t('closeMarketSuccess', 'contracts'));
      await onSuccess();
    } catch (error) {
      const message = friendlyContractError(error, t);
      if (confirmed) {
        setPendingContractError(message);
      } else {
        showFeedback('error', message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const pendingContractConfirmTitle =
    pendingContractOrder?.action === 'CLOSE' ? t('confirmCloseTitle', 'contracts') : t('confirmOpenTitle', 'contracts');
  const pendingContractConfirmText =
    pendingContractOrder
      ? (pendingContractOrder.action === 'OPEN' ? t('confirmOpenAction', 'contracts') : t('confirmCloseAction', 'contracts'))
      : t('confirmAction', 'contracts');
  const pendingContractConfirmDescription =
    orderType === 'MARKET'
      ? t('marketOrderConfirmDesc', 'contracts')
      : t('confirmLimitOrderDesc', 'contracts');
  const pendingContractConfirmDanger = pendingContractOrder?.side === 'SHORT';
  const pendingContractConfirmDetails = useMemo(() => {
    if (!pendingContractOrder) return [];

    const isOpen = pendingContractOrder.action === 'OPEN';
    const side = pendingContractOrder.side;
    const confirmQuantity = isOpen
      ? quantityForOrder
      : closeQuantityForOrder || selectedCloseQuantity;
    const confirmMargin = isOpen
      ? (side === 'LONG' ? longMargin : shortMargin)
      : toNumber(selectedCloseSummary?.margin_amount || selectedClosePosition?.margin_amount || null);
    const confirmSpreadCost = isOpen ? spreadCostHint : closeSpreadCostHint;
    const confirmLeverage = isOpen
      ? leverage
      : toNumber(selectedClosePosition?.leverage || leverage);

    return [
      { label: t('pair', 'contracts'), value: displaySymbol(symbol) },
      { label: t('direction', 'contracts'), value: contractActionText(pendingContractOrder.action, side, t) },
      { label: t('type', 'contracts'), value: orderType === 'LIMIT' ? t('limit', 'contracts') : t('market', 'contracts') },
      { label: t('quantity', 'contracts'), value: `${formatNumber(confirmQuantity, 8)} ${quantityUnit}` },
      {
        label: t('price', 'contracts'),
        value: orderType === 'LIMIT' ? `${formatDisplayPrice(price, pricePrecision)} USDT` : t('market', 'contracts'),
      },
      {
        label: t('estimatedExecutionPrice', 'contracts'),
        value: estimatedExecutionPrice === null ? '--' : `${formatDisplayPrice(estimatedExecutionPrice, pricePrecision)} USDT`,
      },
      { label: t('leverage', 'contracts'), value: `${confirmLeverage || leverage}x` },
      { label: t('margin', 'contracts'), value: displayMoney(confirmMargin, 6) },
      { label: t('spreadCost', 'contracts'), value: confirmSpreadCost === null ? '--' : `≈ ${formatPrice(confirmSpreadCost, 2)} USDT` },
    ];
  }, [
    closeQuantityForOrder,
    closeSpreadCostHint,
    estimatedExecutionPrice,
    leverage,
    longMargin,
    orderType,
    pendingContractOrder,
    price,
    pricePrecision,
    quantityForOrder,
    quantityUnit,
    selectedClosePosition,
    selectedCloseQuantity,
    selectedCloseSummary,
    shortMargin,
    spreadCostHint,
    symbol,
    t,
  ]);

  function handleContractConfirmHiddenChange(checked: boolean) {
    setContractConfirmHidden(checked);
    writeLocalStorageFlag(CONTRACT_TRADE_CONFIRM_HIDDEN_KEY, checked);
  }

  const contractRedirect = `/contract?symbol=${symbol}`;
  const contractLoginHref = `/login?redirect=${encodeURIComponent(contractRedirect)}`;
  const contractRegisterHref = `/register?redirect=${encodeURIComponent(contractRedirect)}`;

  return (
    <div
      className="tabular-nums flex min-h-full min-w-0 flex-col overflow-x-hidden text-sm text-white"
      data-display-market-authority={displayMarketRead.authority}
      data-display-market-symbol={displayMarketRead.symbol || undefined}
      data-market-status={displayMarketRead.marketStatus || undefined}
      data-market-executable={displayMarketRead.executable ?? undefined}
      data-display-source={displayMarketRead.source || undefined}
      data-display-freshness={displayMarketRead.freshness || undefined}
      data-display-stale={displayMarketRead.stale || undefined}
      data-provider-generation={displayMarketRead.authority === 'STORE'
        ? tradingFormStoreSnapshot?.providerGeneration ?? undefined
        : undefined}
    >
      <div className="flex flex-1 flex-col gap-2 overflow-visible xl:gap-2.5 [@media(max-height:850px)]:gap-1.5">
        <div className="grid grid-cols-3 gap-1">
          <ModeButton
            label={t('marginMode', 'contracts')}
            value={t('isolatedMargin', 'contracts')}
            title={t('isolatedMarginHelp', 'contracts')}
            disabled
          />
          <ModeButton label={t('leverage', 'contracts')} value={`${leverage}x`} onClick={() => setLeverageOpen(true)} />
          <ModeButton label={t('positionMode', 'contracts')} value={positionMode === 'ONEWAY' ? t('oneWay', 'contracts') : t('hedge', 'contracts')} disabled />
        </div>

        <div className="grid grid-cols-2 rounded-xl border border-white/[0.06] bg-[#0b1016] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <TabButton active={tradeTab === 'OPEN'} onClick={() => setTradeTab('OPEN')}>{t('openPosition', 'contracts')}</TabButton>
          <TabButton active={tradeTab === 'CLOSE'} onClick={() => setTradeTab('CLOSE')}>{t('closePosition', 'contracts')}</TabButton>
        </div>

        <div className="inline-flex rounded-lg border border-white/[0.05] bg-white/[0.03] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          {(['LIMIT', 'MARKET'] as ContractOrderType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setOrderType(type)}
              className={`rounded-md px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                orderType === type ? 'bg-white/[0.1] text-white' : 'text-white/45 hover:text-white/75'
              }`}
            >
              {type === 'LIMIT' ? t('limit', 'contracts') : t('market', 'contracts')}
            </button>
          ))}
        </div>

        {tradeTab === 'OPEN' ? (
          <OpenPanel
            orderType={orderType}
            price={price}
            quantity={quantity}
            positionSide={positionSide}
            leverage={leverage}
            availableMargin={availableMarginNumber}
            longNotional={longNotional}
            shortNotional={shortNotional}
            longMargin={longMargin}
            shortMargin={shortMargin}
            estimatedExecutionPrice={estimatedExecutionPrice}
            spreadCostHint={spreadCostHint}
            spreadHintText={spreadHintText}
            takeProfitPrice={takeProfitPrice}
            stopLossPrice={stopLossPrice}
            tpSlEnabled={tpSlEnabled}
            submitDisabled={openSubmitDisabled}
            setPrice={setPrice}
            setQuantity={handleQuantityInputChange}
            onQuantityBlur={handleQuantityBlur}
            setPositionSide={(next) => {
              setFeedback(null);
              setPositionSide(next);
            }}
            setTakeProfitPrice={handleTakeProfitPriceChange}
            setStopLossPrice={handleStopLossPriceChange}
            setTpSlEnabled={handleTpSlEnabledChange}
            stepTakeProfitPrice={stepTakeProfitPrice}
            stepStopLossPrice={stepStopLossPrice}
            fillBboPrice={fillBboPrice}
            bboDisabled={currentBboPrice() === null}
            pricePrecision={pricePrecision}
            quantityUnit={quantityUnit}
            adjustLimitPrice={adjustLimitPrice}
            percentValue={openPercent}
            onPercentChange={handleOpenPercentChange}
            submitting={submitting}
            submitOpen={submitOpen}
            tpSlTriggerPriceTypeHint={tpSlTriggerPriceTypeHint}
            isLoggedIn={isLoggedIn}
            loginHref={contractLoginHref}
            registerHref={contractRegisterHref}
          />
        ) : (
          <ClosePanel
            orderType={orderType}
            price={price}
            closeQuantity={closeQuantity}
            closeSide={closeSide}
            selectedPosition={selectedClosePosition}
            selectedSummary={selectedCloseSummary}
            maxCloseQuantity={selectedCloseQuantity}
            avgEntryPrice={selectedCloseEntryPrice}
            closeEstimate={closeEstimate}
            estimatedExecutionPrice={estimatedExecutionPrice}
            closeDisabled={closeDisabled}
            setPrice={setPrice}
            setCloseQuantity={handleCloseQuantityInputChange}
            onCloseQuantityBlur={handleCloseQuantityBlur}
            setCloseSide={(next) => {
              setFeedback(null);
              setCloseSide(next);
            }}
            fillBboPrice={fillBboPrice}
            bboDisabled={currentBboPrice() === null}
            pricePrecision={pricePrecision}
            quantityUnit={quantityUnit}
            adjustLimitPrice={adjustLimitPrice}
            percentValue={closePercent}
            onPercentChange={handleClosePercentChange}
            submitting={submitting}
            submitClose={submitClose}
            isLoggedIn={isLoggedIn}
            loginHref={contractLoginHref}
            registerHref={contractRegisterHref}
          />
        )}

        {displayFeedback ? <FormFeedbackBox feedback={displayFeedback} /> : null}

      </div>

      {leverageOpen ? (
        <ContractLeverageModal
          open={leverageOpen}
          symbol={displaySymbol(symbol)}
          marginModeLabel={t('isolatedMargin', 'contracts')}
          value={leverage}
          maxLeverage={effectiveMaxLeverage}
          onCancel={() => setLeverageOpen(false)}
          onConfirm={(next) => {
            setLeverage(next);
            setLeverageOpen(false);
          }}
        />
      ) : null}
      <TradingConfirmModal
        open={pendingContractOrder !== null}
        title={pendingContractConfirmTitle}
        description={pendingContractConfirmDescription}
        confirmText={pendingContractConfirmText}
        danger={pendingContractConfirmDanger}
        loading={submitting}
        error={pendingContractError}
        details={pendingContractConfirmDetails}
        suppressChecked={contractConfirmHidden}
        onSuppressChange={handleContractConfirmHiddenChange}
        onCancel={() => {
          if (!submitting) {
            setPendingContractError('');
            setPendingContractOrder(null);
          }
        }}
        onConfirm={() => {
          if (!pendingContractOrder || submitting) {
            return;
          }
          if (pendingContractOrder.action === 'OPEN') {
            void submitOpen(pendingContractOrder.side, true);
          } else {
            void submitClose(pendingContractOrder.side, true);
          }
        }}
      />
    </div>
  );
}

function normalizeTpSlTriggerPriceType(value: unknown): ContractTpSlTriggerPriceType {
  return String(value || '').trim().toUpperCase() === 'LAST_PRICE' ? 'LAST_PRICE' : 'MARK_PRICE';
}

function FormFeedbackBox({ feedback }: { feedback: FormFeedback }) {
  const className = feedback.type === 'success'
    ? 'border-[#00c087]/25 bg-[#00c087]/10 text-[#00c087]'
    : feedback.type === 'info'
      ? 'border-[#f0b90b]/25 bg-[#f0b90b]/10 text-[#f0b90b]'
      : 'border-[#f6465d]/25 bg-[#f6465d]/10 text-[#f6465d]';

  return (
    <div className={`rounded-xl border px-2.5 py-1.5 text-[12px] leading-5 ${className}`}>
      {feedback.message}
    </div>
  );
}

function ContractLoginActions({
  loginHref,
  registerHref,
}: {
  loginHref: string;
  registerHref: string;
}) {
  const { t } = useLocaleContext();
  return (
    <div className="flex flex-col gap-2.5">
      <Link
        href={loginHref}
        className="w-full rounded-lg border border-white/10 bg-white/5 py-2.5 text-center text-[13px] font-semibold text-white transition-colors hover:bg-white/10"
      >
        {t('login', 'common')}
      </Link>
      <Link
        href={registerHref}
        className="w-full rounded-lg bg-white py-2.5 text-center text-[13px] font-semibold text-black transition-colors hover:bg-white/90"
      >
        {t('register', 'common')}
      </Link>
    </div>
  );
}

function OpenPanel({
  orderType,
  price,
  quantity,
  positionSide,
  leverage,
  availableMargin,
  longNotional,
  shortNotional,
  longMargin,
  shortMargin,
  estimatedExecutionPrice,
  spreadCostHint,
  spreadHintText,
  pricePrecision,
  quantityUnit,
  takeProfitPrice,
  stopLossPrice,
  tpSlEnabled,
  submitDisabled,
  setPrice,
  setQuantity,
  onQuantityBlur,
  setPositionSide,
  setTakeProfitPrice,
  setStopLossPrice,
  setTpSlEnabled,
  stepTakeProfitPrice,
  stepStopLossPrice,
  fillBboPrice,
  bboDisabled,
  adjustLimitPrice,
  percentValue,
  onPercentChange,
  submitting,
  submitOpen,
  tpSlTriggerPriceTypeHint,
  isLoggedIn,
  loginHref,
  registerHref,
}: {
  orderType: ContractOrderType;
  price: string;
  quantity: string;
  positionSide: ContractPositionSide;
  leverage: number;
  availableMargin: number;
  longNotional: number | null;
  shortNotional: number | null;
  longMargin: number | null;
  shortMargin: number | null;
  estimatedExecutionPrice: number | null;
  spreadCostHint: number | null;
  spreadHintText: string;
  pricePrecision: number;
  quantityUnit: string;
  takeProfitPrice: string;
  stopLossPrice: string;
  tpSlEnabled: boolean;
  submitDisabled: boolean;
  setPrice: (value: string) => void;
  setQuantity: (value: string) => void;
  onQuantityBlur: () => void;
  setPositionSide: (value: ContractPositionSide) => void;
  setTakeProfitPrice: (value: string) => void;
  setStopLossPrice: (value: string) => void;
  setTpSlEnabled: (value: boolean) => void;
  stepTakeProfitPrice: (delta: number) => void;
  stepStopLossPrice: (delta: number) => void;
  fillBboPrice: () => void;
  bboDisabled: boolean;
  adjustLimitPrice: (delta: number) => void;
  percentValue: number;
  onPercentChange: (percent: number) => void;
  submitting: boolean;
  submitOpen: (side: ContractPositionSide) => Promise<void>;
  tpSlTriggerPriceTypeHint: string;
  isLoggedIn: boolean;
  loginHref: string;
  registerHref: string;
}) {
  const { t } = useLocaleContext();
  const isLong = positionSide === 'LONG';
  const buttonToneClass = isLong ? 'bg-[#00c087]' : 'bg-[#f6465d]';
  const buttonText = isLong ? t('confirmBuy', 'contracts') : t('confirmSell', 'contracts');

  return (
    <div className="flex min-h-full flex-col gap-2.5 [@media(max-height:850px)]:gap-1.5">
      <SideSwitcher value={positionSide} onChange={setPositionSide} longText={t('buyOrder', 'contracts')} shortText={t('sellOrder', 'contracts')} />

      <div className="flex items-center justify-between text-[11px] text-white/45">
        <span>{t('availableShort', 'contracts')}</span>
        <span className={!isLoggedIn ? 'text-white/45' : availableMargin > 0 ? 'text-white/72' : 'text-[#f6465d]'}>
          {isLoggedIn ? `${formatNumber(availableMargin, 2)} USDT` : '--'}
        </span>
      </div>

      {orderType === 'LIMIT' ? (
        <PriceField
          value={price}
          onChange={setPrice}
          placeholder={t('clickOrderBookOrEnterPrice', 'contracts')}
          suffix="USDT"
          bboDisabled={bboDisabled}
          pricePrecision={pricePrecision}
          onBboClick={fillBboPrice}
          onStep={adjustLimitPrice}
        />
      ) : (
        <ReadonlyField label={t('price', 'contracts')} value={t('market', 'contracts')} />
      )}
      <Field
        label={t('quantity', 'contracts')}
        value={quantity}
        onChange={setQuantity}
        onBlur={onQuantityBlur}
        placeholder={t('enterQuantity', 'contracts')}
        suffix={quantityUnit}
      />
      <div className="shrink-0 px-2" data-testid="contract-trading-form-percentage-slider">
        <PercentageSlider
          value={percentValue}
          side={isLong ? 'buy' : 'sell'}
          onChange={onPercentChange}
          disabled={!isLoggedIn || availableMargin <= 0}
        />
      </div>

      <div className="shrink-0 rounded-xl border border-white/[0.06] bg-[#0b1016] p-2.5 text-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] [@media(max-height:850px)]:p-1.5">
        <SummaryRow label={t('estimatedExecutionPrice', 'contracts')} value={estimatedExecutionPrice === null ? '--' : `${formatDisplayPrice(estimatedExecutionPrice, pricePrecision)} USDT`} />
        <SummaryDualRow label={t('estimatedOpenValue', 'contracts')} longValue={displayMoney(longNotional, 4)} shortValue={displayMoney(shortNotional, 4)} activeSide={positionSide} />
        <SummaryDualRow label={t('estimatedMargin', 'contracts')} longValue={displayMoney(longMargin, 6)} shortValue={displayMoney(shortMargin, 6)} activeSide={positionSide} />
        <SummaryRow label={t('spreadCost', 'contracts')} value={spreadCostHint === null ? '--' : `≈ ${formatPrice(spreadCostHint, 2)} USDT`} muted title={spreadHintText} />
        <SummaryRow label={t('currentLeverage', 'contracts')} value={`${leverage}x`} />
      </div>

        <div
          className="flex shrink-0 flex-col rounded-xl border border-white/[0.06] bg-[#0b1016] p-2.5 text-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] [@media(max-height:850px)]:p-1.5"
          data-testid="contract-trading-form-tp-sl-region"
        >
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-white/75">
            <input type="checkbox" checked={tpSlEnabled} onChange={(event) => setTpSlEnabled(event.target.checked)} className="h-3.5 w-3.5 accent-[#f0b90b]" />
            {t('takeProfitStopLossShort', 'contracts')}
          </label>
          {tpSlEnabled ? (
            <div
              className="mt-1.5 space-y-1.5"
              data-testid="contract-trading-form-tp-sl-scroll"
            >
              <TriggerPriceField
                label={t('takeProfitTriggerPrice', 'contracts')}
                value={takeProfitPrice}
                onChange={setTakeProfitPrice}
                onStep={stepTakeProfitPrice}
                placeholder={t('takeProfitPlaceholder', 'contracts')}
                pricePrecision={pricePrecision}
                suffix="USDT"
              />
              <TriggerPriceField
                label={t('stopLossTriggerPrice', 'contracts')}
                value={stopLossPrice}
                onChange={setStopLossPrice}
                onStep={stepStopLossPrice}
                placeholder={t('stopLossPlaceholder', 'contracts')}
                pricePrecision={pricePrecision}
                suffix="USDT"
              />
              <div className="text-[11px] leading-4 text-white/50">{tpSlTriggerPriceTypeHint}</div>
              <div className="text-[11px] leading-4 text-white/38">{t('tpSlMarketCloseDesc', 'contracts')}</div>
            </div>
          ) : null}
        </div>

      {isLoggedIn && availableMargin <= 0 ? (
        <div className="rounded-xl border border-[#f6465d]/20 bg-[#f6465d]/10 px-2 py-1 text-[12px] text-[#f6465d]">
          {t('transferMarginFirst', 'contracts')}
        </div>
      ) : null}

      <div className="mt-auto shrink-0 pt-2 [@media(max-height:850px)]:pt-1" data-testid="contract-trading-form-submit-dock">
        {isLoggedIn ? (
          <button type="button" disabled={submitDisabled} onClick={() => submitOpen(positionSide)} className={`w-full rounded-xl ${buttonToneClass} py-2.5 text-[14px] font-semibold text-white shadow-[0_12px_28px_rgba(0,0,0,0.28)] transition-opacity disabled:cursor-not-allowed disabled:opacity-45 [@media(max-height:850px)]:py-2`}>
            {submitting ? t('openSubmitting', 'contracts') : buttonText}
          </button>
        ) : (
          <ContractLoginActions loginHref={loginHref} registerHref={registerHref} />
        )}
      </div>
    </div>
  );
}

function ClosePanel({
  orderType,
  price,
  closeQuantity,
  closeSide,
  selectedPosition,
  selectedSummary,
  maxCloseQuantity,
  avgEntryPrice,
  closeEstimate,
  estimatedExecutionPrice,
  pricePrecision,
  quantityUnit,
  closeDisabled,
  setPrice,
  setCloseQuantity,
  onCloseQuantityBlur,
  setCloseSide,
  fillBboPrice,
  bboDisabled,
  adjustLimitPrice,
  percentValue,
  onPercentChange,
  submitting,
  submitClose,
  isLoggedIn,
  loginHref,
  registerHref,
}: {
  orderType: ContractOrderType;
  price: string;
  closeQuantity: string;
  closeSide: ContractPositionSide;
  selectedPosition: ContractPositionItem | null;
  selectedSummary: ContractPositionSummaryItem | null;
  maxCloseQuantity: string;
  avgEntryPrice: string | null;
  closeEstimate: number;
  estimatedExecutionPrice: number | null;
  pricePrecision: number;
  quantityUnit: string;
  closeDisabled: boolean;
  setPrice: (value: string) => void;
  setCloseQuantity: (value: string) => void;
  onCloseQuantityBlur: () => void;
  setCloseSide: (value: ContractPositionSide) => void;
  fillBboPrice: () => void;
  bboDisabled: boolean;
  adjustLimitPrice: (delta: number) => void;
  percentValue: number;
  onPercentChange: (percent: number) => void;
  submitting: boolean;
  submitClose: (side: ContractPositionSide) => Promise<void>;
  isLoggedIn: boolean;
  loginHref: string;
  registerHref: string;
}) {
  const { t } = useLocaleContext();
  const isLong = closeSide === 'LONG';
  const buttonToneClass = isLong ? 'bg-[#00c087]' : 'bg-[#f6465d]';
  const buttonText = t('closePositionAction', 'contracts');

  return (
    <div className="flex min-h-full flex-col gap-2.5 [@media(max-height:850px)]:gap-1.5">
      <SideSwitcher value={closeSide} onChange={setCloseSide} longText={t('buyOrder', 'contracts')} shortText={t('sellOrder', 'contracts')} />

      {orderType === 'LIMIT' ? (
        <PriceField
          value={price}
          onChange={setPrice}
          placeholder={t('clickOrderBookOrEnterPrice', 'contracts')}
          suffix="USDT"
          bboDisabled={bboDisabled}
          pricePrecision={pricePrecision}
          onBboClick={fillBboPrice}
          onStep={adjustLimitPrice}
        />
      ) : (
        <ReadonlyField label={t('price', 'contracts')} value={t('market', 'contracts')} />
      )}
      <ReadonlyField label={t('closeableQuantity', 'contracts')} value={`${formatNumber(maxCloseQuantity, 8)} ${quantityUnit}`} />
      <Field
        label={t('closeQuantity', 'contracts')}
        value={closeQuantity}
        onChange={setCloseQuantity}
        onBlur={onCloseQuantityBlur}
        placeholder={selectedPosition ? t('emptyMeansCloseAll', 'contracts') : t('noClosablePosition', 'contracts')}
        suffix={quantityUnit}
      />
      <div className="shrink-0 px-2" data-testid="contract-trading-form-percentage-slider">
        <PercentageSlider
          value={percentValue}
          side={isLong ? 'sell' : 'buy'}
          onChange={onPercentChange}
          disabled={!isLoggedIn || (!selectedSummary && !selectedPosition)}
        />
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-[#0b1016] p-2.5 text-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] [@media(max-height:850px)]:p-1.5">
        <SummaryRow label={t('positionSide', 'contracts')} value={selectedSummary || selectedPosition ? sideText(closeSide, t) : '--'} valueClassName={sideTone(closeSide)} />
        <SummaryRow label={t('avgEntryPrice', 'contracts')} value={avgEntryPrice ? `${formatDisplayPrice(avgEntryPrice, pricePrecision)} USDT` : '--'} />
        <SummaryRow label={t('estimatedExecutionPrice', 'contracts')} value={estimatedExecutionPrice === null ? '--' : `${formatDisplayPrice(estimatedExecutionPrice, pricePrecision)} USDT`} />
        <SummaryRow
          label={t('estimatedPnl', 'contracts')}
          value={`${closeEstimate >= 0 ? '+' : ''}${formatNumber(closeEstimate, 6)} USDT`}
          valueClassName={closeEstimate > 0 ? 'text-[#00c087]' : closeEstimate < 0 ? 'text-[#f6465d]' : 'text-white/90'}
        />
      </div>

      {isLoggedIn && !selectedPosition ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] text-white/50">
          {t('noClosablePosition', 'contracts')}
        </div>
      ) : null}

      <div className="mt-auto shrink-0 pt-2 [@media(max-height:850px)]:pt-1" data-testid="contract-trading-form-submit-dock">
        {isLoggedIn ? (
          <button type="button" disabled={closeDisabled} onClick={() => submitClose(closeSide)} className={`w-full rounded-xl ${buttonToneClass} py-2.5 text-[14px] font-semibold text-white shadow-[0_12px_28px_rgba(0,0,0,0.28)] transition-opacity disabled:cursor-not-allowed disabled:opacity-45 [@media(max-height:850px)]:py-2`}>
            {submitting ? t('closeSubmitting', 'contracts') : buttonText}
          </button>
        ) : (
          <ContractLoginActions loginHref={loginHref} registerHref={registerHref} />
        )}
      </div>
    </div>
  );
}

function ModeButton({
  label,
  value,
  title,
  disabled = false,
  onClick,
}: {
  label: string;
  value: string;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} title={title} className="min-w-0 rounded-lg border border-white/[0.08] bg-[#0b0e11] px-2 py-1.5 text-left transition-colors hover:border-white/[0.14] disabled:cursor-default disabled:hover:border-white/[0.08] [@media(max-height:850px)]:px-1.5 [@media(max-height:850px)]:py-1">
      <span className="block truncate text-[10px] leading-3.5 text-white/38">{label}</span>
      <span className="block truncate text-[12px] font-semibold leading-4 text-white">{value}</span>
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={`rounded-lg py-1.5 text-[14px] font-semibold transition-all [@media(max-height:850px)]:py-1 ${active ? 'bg-white text-black' : 'text-white/46 hover:text-white/78'}`}>
      {children}
    </button>
  );
}

function SideSwitcher({
  value,
  onChange,
  longText,
  shortText,
}: {
  value: ContractPositionSide;
  onChange: (value: ContractPositionSide) => void;
  longText?: string;
  shortText?: string;
}) {
  const { t } = useLocaleContext();
  const resolvedLongText = longText ?? t('openLong', 'contracts');
  const resolvedShortText = shortText ?? t('openShort', 'contracts');

  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/[0.06] bg-[#0b1016] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <button type="button" onClick={() => onChange('LONG')} className={`rounded-lg py-1.5 text-[14px] font-semibold transition-all [@media(max-height:850px)]:py-1 ${value === 'LONG' ? 'bg-[#00c087] text-white shadow-[0_10px_24px_rgba(22,163,74,0.22)]' : 'text-white/46 hover:text-white/78'}`}>
        {resolvedLongText}
      </button>
      <button type="button" onClick={() => onChange('SHORT')} className={`rounded-lg py-1.5 text-[14px] font-semibold transition-all [@media(max-height:850px)]:py-1 ${value === 'SHORT' ? 'bg-[#f6465d] text-white shadow-[0_10px_24px_rgba(220,38,38,0.22)]' : 'text-white/46 hover:text-white/78'}`}>
        {resolvedShortText}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  suffix,
  actions,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  suffix?: string;
  actions?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-white/42">{label}</span>
      <div className="flex h-10 items-center rounded-lg border border-white/[0.08] bg-[#0d1218] px-3 transition-all hover:border-white/[0.14] focus-within:border-white/[0.18] focus-within:bg-[#10161d] focus-within:ring-1 focus-within:ring-white/10 [@media(max-height:850px)]:h-9">
        <input
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium tabular-nums text-white outline-none placeholder:text-white/20"
          placeholder={placeholder}
        />
        {suffix ? <span className="ml-2 shrink-0 text-[11px] text-white/35">{suffix}</span> : null}
        {actions}
      </div>
    </label>
  );
}

function TriggerPriceField({
  label,
  value,
  onChange,
  onStep,
  placeholder,
  pricePrecision,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onStep: (delta: number) => void;
  placeholder: string;
  pricePrecision: number;
  suffix?: string;
}) {
  const { t } = useLocaleContext();
  function normalizePrice() {
    const num = toNumber(value);
    if (num > 0) onChange(formatInputPrice(num, pricePrecision));
  }

  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-white/42">{label}</span>
      <div className="flex h-9 items-center rounded-lg border border-white/[0.08] bg-[#0d1218] px-2.5 transition-colors hover:border-white/[0.14] focus-within:border-white/[0.2]">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={normalizePrice}
          inputMode="decimal"
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium tabular-nums text-white outline-none placeholder:text-white/20"
          placeholder={placeholder}
        />
        {suffix ? <span className="ml-2 shrink-0 text-[11px] text-white/35">{suffix}</span> : null}
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onStep(-TP_SL_STEP)}
            className="flex h-5 w-5 items-center justify-center rounded border border-white/[0.08] text-[12px] text-white/50 transition-colors hover:border-white/[0.18] hover:text-white"
            title={t('reduceOne', 'contracts')}
          >
            -
          </button>
          <button
            type="button"
            onClick={() => onStep(TP_SL_STEP)}
            className="flex h-5 w-5 items-center justify-center rounded border border-white/[0.08] text-[12px] text-white/50 transition-colors hover:border-white/[0.18] hover:text-white"
            title={t('increaseOne', 'contracts')}
          >
            +
          </button>
        </div>
      </div>
    </label>
  );
}

function PriceField({
  value,
  onChange,
  placeholder,
  suffix,
  bboDisabled,
  pricePrecision,
  onBboClick,
  onStep,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suffix?: string;
  bboDisabled: boolean;
  pricePrecision: number;
  onBboClick: () => void;
  onStep: (delta: number) => void;
}) {
  const { t } = useLocaleContext();
  const priceStep = 1 / (10 ** pricePrecision);

  function normalizePrice() {
    const num = toNumber(value);
    if (num > 0) onChange(formatInputPrice(num, pricePrecision));
  }

  return (
    <div>
      <div className="mb-1 text-[11px] text-gray-400">
        {t('price', 'contracts')}{suffix ? ` (${suffix})` : ''}
      </div>
      <div className="flex items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={normalizePrice}
            inputMode="decimal"
            className="w-full rounded-xl border border-white/[0.08] bg-[#0d1218] px-3 py-2 pr-10 text-[13px] font-medium tabular-nums text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] outline-none transition-colors placeholder:text-white/20 hover:border-white/[0.14] focus:border-white/[0.18] focus:bg-[#10161d] focus:ring-1 focus:ring-white/10 [@media(max-height:850px)]:py-1.5"
            placeholder={placeholder}
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col">
            <button
              type="button"
              onClick={() => onStep(priceStep)}
              className="flex h-4 w-6 items-center justify-center rounded text-[10px] text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white"
              title={t('increasePrice', 'contracts')}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => onStep(-priceStep)}
              className="mt-0.5 flex h-4 w-6 items-center justify-center rounded text-[10px] text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white"
              title={t('decreasePrice', 'contracts')}
            >
              -
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onBboClick}
          disabled={bboDisabled}
          title={bboDisabled ? t('noOrderBookPrice', 'contracts') : t('fillBestOrderBookPrice', 'contracts')}
          className={`shrink-0 rounded-xl border px-3 text-[11px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-colors ${
            bboDisabled
              ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] text-white/24'
              : 'border-white/[0.08] bg-[#0d1218] text-white/70 hover:border-white/[0.16] hover:bg-[#121922] hover:text-white'
          }`}
        >
          BBO
        </button>
      </div>
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] text-white/42">{label}</span>
      <div className="flex h-9 items-center justify-between rounded-lg border border-white/[0.08] bg-[#0d1218] px-2.5 text-[13px] font-medium tabular-nums text-white/75">
        {value}
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  muted = false,
  valueClassName,
  title,
}: {
  label: string;
  value: string;
  muted?: boolean;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-[12px] [@media(max-height:850px)]:py-px">
      <span className="min-w-0 shrink-0 text-white/42" title={title}>{label}</span>
      <span className={`min-w-0 truncate text-right font-medium ${valueClassName || (muted ? 'text-white/62' : 'text-white/90')}`}>
        {value}
      </span>
    </div>
  );
}

function SummaryDualRow({
  label,
  longValue,
  shortValue,
  activeSide,
  muted = false,
}: {
  label: string;
  longValue: string;
  shortValue: string;
  activeSide: ContractPositionSide;
  muted?: boolean;
}) {
  const longClass = activeSide === 'LONG' ? 'text-[#00c087]' : muted ? 'text-white/50' : 'text-white/78';
  const shortClass = activeSide === 'SHORT' ? 'text-[#f6465d]' : muted ? 'text-white/50' : 'text-white/78';
  return (
    <div className="flex items-center justify-between gap-2 py-px text-[12px]">
      <span className="min-w-0 shrink-0 text-white/42">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">
        <span className={longClass}>{longValue}</span>
        <span className="px-1 text-white/28">/</span>
        <span className={shortClass}>{shortValue}</span>
      </span>
    </div>
  );
}
