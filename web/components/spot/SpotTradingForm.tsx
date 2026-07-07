'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  createSpotOrder,
  getSpotFeeSettings,
  getSpotMarketTickers,
  type CreateSpotOrderResponse,
  type CreateSpotOrderPayload,
  type SpotFeeSettings,
  type SpotAccountBalanceItem,
  type SpotDepthLevel,
  type SpotOrderSide,
} from '@/lib/api/modules/spot';
import { getVipFeePreference, getVipOverview } from '@/lib/api/modules/vip';
import TradingConfirmModal from '@/components/common/TradingConfirmModal';
import PercentageSlider from './form/PercentageSlider';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  getSpotBboAvailabilityLabel,
  getSpotBboBasisLabel,
  resolveSpotMarketStatus,
  spotMarketStatusBadgeClass,
} from './spotMarketStatus';
import {
  getSpotPriceStep,
  normalizeSpotPriceInput,
} from './spotPricePrecision';

interface SpotTradingFormProps {
  symbol: string;
  baseAsset?: string | null;
  quoteAsset?: string | null;
  marketPrice: string;
  selectedPrice?: string;
  pricePrecision: number;
  amountPrecision?: number | null;
  accountBalances?: SpotAccountBalanceItem[];
  asks?: SpotDepthLevel[];
  bids?: SpotDepthLevel[];
  depthSource?: string | null;
  depthFreshness?: string | null;
  dataSource?: string | null;
  latestTradePrice?: string | number | null;
  latestTradeAt?: number | null;
  marketDataLoading?: boolean;
  onPriceChange?: (price: string) => void;
  priceSelectNonce?: number;
  onOrderSuccess?: (order?: CreateSpotOrderResponse) => void;
  isLoggedIn?: boolean;
  authLoading?: boolean;
  authChecked?: boolean;
  userId?: number | string | null;
}

type PendingSpotOrder = {
  payload: CreateSpotOrderPayload;
  submitPrice: string;
};

type FeeHintTone = 'neutral' | 'success' | 'warning';

type EstimatedFeeInfo = {
  display: string;
  payment: string;
  hintTitle: string;
  hintSubtitle: string;
  hintDetails: string[];
  hintTone: FeeHintTone;
  rcbReady: boolean;
  showOpenLink: boolean;
};

type SummaryRow = {
  key: string;
  label: string;
  value: string;
};

const SPOT_TRADE_CONFIRM_HIDDEN_KEY = 'spot_trade_confirm_hidden';
const DEFAULT_AMOUNT_PRECISION = 4;
const QUOTE_PRECISION = 2;
const RCB_FEE_PRECISION = 6;
const MAX_DECIMAL_PRECISION = 12;
const SUMMARY_TINY_AMOUNT = 0.000001;
const PERCENT_TICKS = new Set([0, 25, 50, 75, 100]);
const SUCCESS_MESSAGE_DURATION_MS = 4000;
const MIN_SUBMIT_LOADING_MS = 600;
const SPOT_FEE_SETTINGS_CACHE_TTL_MS = 120_000;
const LATEST_TRADE_LABEL = String.fromCharCode(26368, 26032, 25104, 20132);

let cachedSpotFeeSettings: { settings: SpotFeeSettings; fetchedAt: number } | null = null;
let spotFeeSettingsRequest: Promise<SpotFeeSettings> | null = null;

function loadSpotFeeSettingsCached(): Promise<SpotFeeSettings> {
  const now = Date.now();
  if (cachedSpotFeeSettings && now - cachedSpotFeeSettings.fetchedAt < SPOT_FEE_SETTINGS_CACHE_TTL_MS) {
    return Promise.resolve(cachedSpotFeeSettings.settings);
  }

  if (spotFeeSettingsRequest) {
    return spotFeeSettingsRequest;
  }

  spotFeeSettingsRequest = getSpotFeeSettings()
    .then((settings) => {
      cachedSpotFeeSettings = {
        settings,
        fetchedAt: Date.now(),
      };
      return settings;
    })
    .finally(() => {
      spotFeeSettingsRequest = null;
    });

  return spotFeeSettingsRequest;
}

type SpotFormCopy = {
  buy: string
  sell: string
  limit: string
  market: string
  limitOrder: string
  marketOrder: string
  price: string
  amount: string
  buyAmount: string
  sellAmount: string
  symbol: string
  type: string
  orderPrice: string
  available: string
  total: string
  estimatedBaseAmount: string
  payAmount: string
  estimatedQuoteAmount: string
  enterPrice: string
  enterBuyPrice: string
  enterSellPrice: string
  enterAmount: string
  enterBuyAmount: string
  enterAmountWithAsset: string
  enterBuyAmountWithAsset: string
  marketByBook: string
  bboTooltip: string
  increasePrice: string
  decreasePrice: string
  orderSubmitted: string
  submitting: string
  checkingLogin: string
  insufficientBalance: string
  noMarketPrice: string
  quoteAmountTooSmall: string
  insufficientAskLiquidity: string
  insufficientBidLiquidity: string
  loginExpired: string
  orderFailedFallback: string
  estimatedFee: string
  feePayment: string
  openRcbFee: string
  confirmBuyTitle: string
  confirmSellTitle: string
  confirmBuy: string
  confirmSell: string
  marketConfirmDescription: string
  limitConfirmDescription: string
  side: string
  estimatedTradePrice: string
  usdtFeeTitle: string
  rcbDisabled: string
  rcbEnableHint: string
  rcbPriceUnavailable: string
  rcbUnavailable: string
  rcbPayment: string
  rcbEnabledHint: string
  rcbEstimatedDeduct: string
  rcbInsufficient: string
  rcbNeed: string
  rcbAvailable: string
  orderFilledSuccess: string
  orderPartiallyFilled: string
  limitOrderSubmitted: string
  marketOrderSubmitted: string
  genericOrderSubmitted: string
  noAskLiquidity: string
  noBidLiquidity: string
  bookLiquidityInsufficient: string
  marketBuyAmountInsufficient: string
  marketSellAmountInsufficient: string
  orderAmountBelowMin: string
  orderAmountBelowMinFallback: string
  marketClosed: string
  invalidQuantity: string
  invalidPrice: string
  networkError: string
  login: string
  register: string
};

type AssetTranslator = (key: string, namespace?: 'asset') => string;

function buildSpotFormCopy(t: AssetTranslator): SpotFormCopy {
  return {
    buy: t('spotFormBuy', 'asset'),
    sell: t('spotFormSell', 'asset'),
    limit: t('spotFormLimit', 'asset'),
    market: t('spotFormMarket', 'asset'),
    limitOrder: t('spotFormLimitOrder', 'asset'),
    marketOrder: t('spotFormMarketOrder', 'asset'),
    price: t('spotFormPrice', 'asset'),
    amount: t('spotFormAmount', 'asset'),
    buyAmount: t('spotFormBuyAmount', 'asset'),
    sellAmount: t('spotFormSellAmount', 'asset'),
    symbol: t('spotFormSymbol', 'asset'),
    type: t('spotFormType', 'asset'),
    orderPrice: t('spotFormOrderPrice', 'asset'),
    available: t('spotFormAvailable', 'asset'),
    total: t('spotFormTotal', 'asset'),
    estimatedBaseAmount: t('spotFormEstimatedBaseAmount', 'asset'),
    payAmount: t('spotFormPayAmount', 'asset'),
    estimatedQuoteAmount: t('spotFormEstimatedQuoteAmount', 'asset'),
    enterPrice: t('spotFormEnterPrice', 'asset'),
    enterBuyPrice: t('spotFormEnterBuyPrice', 'asset'),
    enterSellPrice: t('spotFormEnterSellPrice', 'asset'),
    enterAmount: t('spotFormEnterAmount', 'asset'),
    enterBuyAmount: t('spotFormEnterBuyAmount', 'asset'),
    enterAmountWithAsset: t('spotFormEnterAmountWithAsset', 'asset'),
    enterBuyAmountWithAsset: t('spotFormEnterBuyAmountWithAsset', 'asset'),
    marketByBook: t('spotFormMarketByBook', 'asset'),
    bboTooltip: t('spotFormBboTooltip', 'asset'),
    increasePrice: t('spotFormIncreasePrice', 'asset'),
    decreasePrice: t('spotFormDecreasePrice', 'asset'),
    orderSubmitted: t('spotFormOrderSubmitted', 'asset'),
    submitting: t('spotFormSubmitting', 'asset'),
    checkingLogin: t('spotFormCheckingLogin', 'asset'),
    insufficientBalance: t('spotFormInsufficientBalance', 'asset'),
    noMarketPrice: t('spotFormNoMarketPrice', 'asset'),
    quoteAmountTooSmall: t('spotFormQuoteAmountTooSmall', 'asset'),
    insufficientAskLiquidity: t('spotFormInsufficientAskLiquidity', 'asset'),
    insufficientBidLiquidity: t('spotFormInsufficientBidLiquidity', 'asset'),
    loginExpired: t('spotFormLoginExpired', 'asset'),
    orderFailedFallback: t('spotFormOrderFailedFallback', 'asset'),
    estimatedFee: t('spotFormEstimatedFee', 'asset'),
    feePayment: t('spotFormFeePayment', 'asset'),
    openRcbFee: t('spotFormOpenRcbFee', 'asset'),
    confirmBuyTitle: t('spotFormConfirmBuyTitle', 'asset'),
    confirmSellTitle: t('spotFormConfirmSellTitle', 'asset'),
    confirmBuy: t('spotFormConfirmBuy', 'asset'),
    confirmSell: t('spotFormConfirmSell', 'asset'),
    marketConfirmDescription: t('spotFormMarketConfirmDescription', 'asset'),
    limitConfirmDescription: t('spotFormLimitConfirmDescription', 'asset'),
    side: t('spotFormSide', 'asset'),
    estimatedTradePrice: t('spotFormEstimatedTradePrice', 'asset'),
    usdtFeeTitle: t('spotFormUsdtFeeTitle', 'asset'),
    rcbDisabled: t('spotFormRcbDisabled', 'asset'),
    rcbEnableHint: t('spotFormRcbEnableHint', 'asset'),
    rcbPriceUnavailable: t('spotFormRcbPriceUnavailable', 'asset'),
    rcbUnavailable: t('spotFormRcbUnavailable', 'asset'),
    rcbPayment: t('spotFormRcbPayment', 'asset'),
    rcbEnabledHint: t('spotFormRcbEnabledHint', 'asset'),
    rcbEstimatedDeduct: t('spotFormRcbEstimatedDeduct', 'asset'),
    rcbInsufficient: t('spotFormRcbInsufficient', 'asset'),
    rcbNeed: t('spotFormRcbNeed', 'asset'),
    rcbAvailable: t('spotFormRcbAvailable', 'asset'),
    orderFilledSuccess: t('spotFormOrderFilledSuccess', 'asset'),
    orderPartiallyFilled: t('spotFormOrderPartiallyFilled', 'asset'),
    limitOrderSubmitted: t('spotFormLimitOrderSubmitted', 'asset'),
    marketOrderSubmitted: t('spotFormMarketOrderSubmitted', 'asset'),
    genericOrderSubmitted: t('spotFormGenericOrderSubmitted', 'asset'),
    noAskLiquidity: t('spotFormNoAskLiquidity', 'asset'),
    noBidLiquidity: t('spotFormNoBidLiquidity', 'asset'),
    bookLiquidityInsufficient: t('spotFormBookLiquidityInsufficient', 'asset'),
    marketBuyAmountInsufficient: t('spotFormMarketBuyAmountInsufficient', 'asset'),
    marketSellAmountInsufficient: t('spotFormMarketSellAmountInsufficient', 'asset'),
    orderAmountBelowMin: t('spotFormOrderAmountBelowMin', 'asset'),
    orderAmountBelowMinFallback: t('spotFormOrderAmountBelowMinFallback', 'asset'),
    marketClosed: t('spotFormMarketClosed', 'asset'),
    invalidQuantity: t('spotFormInvalidQuantity', 'asset'),
    invalidPrice: t('spotFormInvalidPrice', 'asset'),
    networkError: t('spotFormNetworkError', 'asset'),
    login: t('spotFormLogin', 'asset'),
    register: t('spotFormRegister', 'asset'),
  };
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
    // localStorage may be unavailable in private or restricted contexts.
  }
}

function getSpotTradeConfirmHiddenKey(userId?: number | string | null): string | null {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return null;
  return `${SPOT_TRADE_CONFIRM_HIDDEN_KEY}:${normalizedUserId}`;
}

function readSpotConfirmHiddenForUser(userId?: number | string | null): boolean {
  const key = getSpotTradeConfirmHiddenKey(userId);
  return key ? readLocalStorageFlag(key) : false;
}

function writeSpotConfirmHiddenForUser(userId: number | string | null | undefined, value: boolean) {
  const key = getSpotTradeConfirmHiddenKey(userId);
  if (!key) return;
  writeLocalStorageFlag(key, value);
}

function normalizeDecimalInput(value: string): string | null {
  if (!/^\d*\.?\d*$/.test(value)) {
    return null;
  }

  return value;
}

function floorToPrecision(value: number, precision: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const factor = Math.pow(10, precision);
  return Math.floor(value * factor) / factor;
}

function clampPercentValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(Math.round(value), 0), 100);
}

function formatDecimal(value: string | number, precision: number): string {
  if (value === '' || value === '--' || value === null || value === undefined) {
    return '';
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '';
  }

  return floorToPrecision(num, precision).toFixed(precision);
}

function formatPrice(value: string | number, precision: number): string {
  return normalizeSpotPriceInput(value, precision);
}

function formatLatestTradeTime(value?: number | null): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';

  return new Date(num).toLocaleTimeString('zh-CN', {
    hour12: false,
  });
}

function normalizePrecision(value: unknown, fallback: number): number {
  const nextValue = Number(value);
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= MAX_DECIMAL_PRECISION) {
    return nextValue;
  }
  return fallback;
}

function formatAmount(value: string | number, precision: number): string {
  return formatDecimal(value, precision);
}

function formatQuoteAmount(value: string | number): string {
  return formatDecimal(value, QUOTE_PRECISION);
}

function formatRcbAmount(value: string | number): string {
  return formatDecimal(value, RCB_FEE_PRECISION);
}

function stripTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function formatSummarySmallAmount(value: string | number, precision = 8): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return '';
  }

  if (num < SUMMARY_TINY_AMOUNT) {
    return '<0.000001';
  }

  const floored = floorToPrecision(num, precision);
  if (floored <= 0) {
    return '<0.000001';
  }

  return stripTrailingZeros(floored.toFixed(precision));
}

function formatSummaryFeeAmount(value: string | number): string {
  return formatSummarySmallAmount(value, 8);
}

function formatSummaryQuoteTotal(value: string | number): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return '';
  }

  if (num >= 0.01) {
    return floorToPrecision(num, QUOTE_PRECISION).toFixed(QUOTE_PRECISION);
  }

  return formatSummarySmallAmount(num, 8);
}

function parseTradingPair(symbol: string): { baseAsset: string; quoteAsset: string } {
  const upperSymbol = (symbol || '').trim().toUpperCase();
  const quoteCandidates = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];

  for (const quoteAsset of quoteCandidates) {
    if (upperSymbol.endsWith(quoteAsset) && upperSymbol.length > quoteAsset.length) {
      return {
        baseAsset: upperSymbol.slice(0, -quoteAsset.length),
        quoteAsset,
      };
    }
  }

  return {
    baseAsset: upperSymbol,
    quoteAsset: '',
  };
}

function formatCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

function toFiniteNumber(value: string | number | undefined | null): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isPositiveDecimalInput(value: string): boolean {
  const num = Number(value);
  return Number.isFinite(num) && num > 0;
}

function parseFeeRate(value: string | null | undefined): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parsePositiveRatio(value: string | number | null | undefined, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 && num <= 1 ? num : fallback;
}

function formatFeeRatioPercent(value: number): string {
  const percent = value * 100;
  if (!Number.isFinite(percent) || percent <= 0) {
    return '--';
  }
  const fixed = percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2);
  return stripTrailingZeros(fixed);
}

function readTickerPrice(item: Record<string, unknown> | null | undefined): number {
  const raw =
    item?.last_price ??
    item?.price ??
    item?.last ??
    item?.close ??
    item?.lastPrice;
  return toFiniteNumber(typeof raw === 'string' || typeof raw === 'number' ? raw : null);
}

function getAskLiquidityQuoteAmount(levels: SpotDepthLevel[]): number {
  return levels.reduce((sum, level) => {
    const price = toFiniteNumber(level.price);
    const amount = toFiniteNumber(level.amount);
    if (price <= 0 || amount <= 0) {
      return sum;
    }
    return sum + price * amount;
  }, 0);
}

function getBidLiquidityAmount(levels: SpotDepthLevel[]): number {
  return levels.reduce((sum, level) => {
    const amount = toFiniteNumber(level.amount);
    if (amount <= 0) {
      return sum;
    }
    return sum + amount;
  }, 0);
}

function isAuthErrorText(text: string): boolean {
  const normalized = (text || '').toLowerCase();

  return (
    normalized.includes('401') ||
    normalized.includes('unauthorized') ||
    normalized.includes('missing access token') ||
    normalized.includes('token expired') ||
    normalized.includes('token invalid') ||
    normalized.includes('invalid token') ||
    normalized.includes('access token expired')
  );
}

const zhBackendMessage = (...codes: number[]) => String.fromCharCode(...codes);

const SPOT_BACKEND_MESSAGES = {
  noAskLiquidity: zhBackendMessage(24403, 21069, 26080, 21487, 25104, 20132, 21334, 30424),
  noBidLiquidity: zhBackendMessage(24403, 21069, 26080, 21487, 25104, 20132, 20080, 30424),
  bookLiquidityInsufficient: zhBackendMessage(24403, 21069, 30424, 21475, 27969, 21160, 24615, 19981, 36275),
  marketBuyAmountInsufficient: zhBackendMessage(24066, 20215, 20080, 20837, 37329, 39069, 19981, 36275),
  marketSellAmountInsufficient: zhBackendMessage(24066, 20215, 21334, 20986, 25968, 37327, 19981, 36275),
  askBalanceInsufficient: zhBackendMessage(21334, 30424, 20313, 39069, 19981, 36275),
  bidBalanceInsufficient: zhBackendMessage(20080, 30424, 20313, 39069, 19981, 36275),
  insufficientBalance: zhBackendMessage(20313, 39069, 19981, 36275),
  availableInsufficientBalance: zhBackendMessage(21487, 29992, 20313, 39069, 19981, 36275),
};

function normalizeSubmitError(err: unknown, copy: SpotFormCopy, defaultQuoteAsset = 'USDT'): string {
  const rawMessage =
    typeof err === 'string'
      ? err
      : typeof (err as { message?: unknown })?.message === 'string'
      ? ((err as { message?: string }).message || '')
      : '';
  const rawCode =
    typeof (err as { code?: unknown })?.code === 'string'
      ? ((err as { code?: string }).code || '')
      : '';

  const mapOrderError = (message: string, code = '') => {
    const normalized = message.trim().toLowerCase();
    const normalizedCode = code.trim().toLowerCase();
    const combined = `${normalizedCode} ${normalized}`.trim();

    if (!combined) {
      return copy.orderFailedFallback;
    }

    if (
      isAuthErrorText(combined) ||
      combined.includes('invalid credential') ||
      combined.includes('invalid credentials') ||
      combined.includes('unauthorized') ||
      combined.includes('login expired')
    ) {
      return copy.loginExpired;
    }

    const readableBackendMessages = [
      { match: SPOT_BACKEND_MESSAGES.noAskLiquidity, text: copy.noAskLiquidity },
      { match: SPOT_BACKEND_MESSAGES.noBidLiquidity, text: copy.noBidLiquidity },
      { match: SPOT_BACKEND_MESSAGES.bookLiquidityInsufficient, text: copy.bookLiquidityInsufficient },
      { match: SPOT_BACKEND_MESSAGES.marketBuyAmountInsufficient, text: copy.marketBuyAmountInsufficient },
      { match: SPOT_BACKEND_MESSAGES.marketSellAmountInsufficient, text: copy.marketSellAmountInsufficient },
      { match: SPOT_BACKEND_MESSAGES.askBalanceInsufficient, text: copy.insufficientBalance },
      { match: SPOT_BACKEND_MESSAGES.bidBalanceInsufficient, text: copy.insufficientBalance },
    ];
    const readableBackendMessage = readableBackendMessages.find((item) => message.includes(item.match));
    if (readableBackendMessage) {
      return readableBackendMessage.text;
    }

    if (combined.includes('min_notional') || combined.includes('min notional')) {
      const minNotional = message.match(/min[_\s-]?notional[^\d]*(\d+(?:\.\d+)?)/i)?.[1];
      return minNotional
        ? formatCopy(copy.orderAmountBelowMin, { min: minNotional, asset: defaultQuoteAsset || 'USDT' })
        : copy.orderAmountBelowMinFallback;
    }

    if (
      combined.includes('insufficient balance') ||
      combined.includes('balance not enough') ||
      combined.includes('available not enough') ||
      combined.includes(SPOT_BACKEND_MESSAGES.insufficientBalance) ||
      combined.includes(SPOT_BACKEND_MESSAGES.availableInsufficientBalance)
    ) {
      return copy.insufficientBalance;
    }

    if (combined.includes('market closed') || combined.includes('market is closed')) {
      return copy.marketClosed;
    }

    if (
      combined.includes('market buy requires quote_amount') ||
      combined.includes('quote_amount must be greater than 0')
    ) {
      return copy.marketBuyAmountInsufficient;
    }

    if (
      combined.includes('market sell requires amount') ||
      combined.includes('amount must be greater than 0')
    ) {
      return copy.marketSellAmountInsufficient;
    }

    if (combined.includes('insufficient liquidity for market buy')) {
      return copy.noAskLiquidity;
    }

    if (combined.includes('insufficient liquidity for market sell')) {
      return copy.noBidLiquidity;
    }

    if (combined.includes('insufficient liquidity')) {
      return copy.bookLiquidityInsufficient;
    }

    if (combined.includes('insufficient ask liquidity')) {
      return copy.insufficientAskLiquidity;
    }

    if (combined.includes('insufficient bid liquidity')) {
      return copy.insufficientBidLiquidity;
    }

    if (
      combined.includes('invalid quantity') ||
      combined.includes('quantity invalid') ||
      combined.includes('invalid amount') ||
      combined.includes('amount invalid')
    ) {
      return copy.invalidQuantity;
    }

    if (
      combined.includes('invalid price') ||
      combined.includes('precision') ||
      combined.includes('price') && combined.includes('invalid')
    ) {
      return copy.invalidPrice;
    }

    if (
      combined.includes('network') ||
      combined.includes('timeout') ||
      combined.includes('fetch failed') ||
      combined.includes('failed to fetch')
    ) {
      return copy.networkError;
    }

    return copy.orderFailedFallback;
  };

  if (isAuthErrorText(rawMessage)) {
    return copy.loginExpired;
  }

  const jsonStartIndex = rawMessage.indexOf('{');
  if (jsonStartIndex >= 0) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStartIndex));
      const backendCode = String(parsed?.error?.code || parsed?.code || '');
      const backendMessage = String(parsed?.error?.message || parsed?.message || '');

      if (isAuthErrorText(backendCode) || isAuthErrorText(backendMessage)) {
        return copy.loginExpired;
      }

      if (backendCode.trim() || backendMessage.trim()) {
        return mapOrderError(backendMessage, backendCode);
      }
    } catch {
      // ignore malformed trailing payloads and continue to other fallbacks
    }
  }

  const tailMessage = rawMessage.match(/failed:\s*\d+\s*(.+)$/i)?.[1]?.trim();
  if (tailMessage && !tailMessage.startsWith('{')) {
    return mapOrderError(tailMessage, rawCode);
  }

  return mapOrderError(rawMessage, rawCode);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildOrderSuccessMessage(
  order: CreateSpotOrderResponse,
  payload: CreateSpotOrderPayload,
  copy: SpotFormCopy,
): string {
  const status = String(order?.status || '').trim().toUpperCase();
  const orderType = String(order?.order_type || payload.order_type || '').trim().toUpperCase();
  const side = String(order?.side || payload.side || '').trim().toUpperCase();
  const sideText = side === 'SELL' ? copy.sell : copy.buy;

  if (status === 'FILLED') {
    return formatCopy(copy.orderFilledSuccess, { side: sideText });
  }

  if (status === 'PARTIALLY_FILLED') {
    return copy.orderPartiallyFilled;
  }

  if (orderType === 'LIMIT' || status === 'OPEN' || status === 'NEW' || status === 'PENDING') {
    return copy.limitOrderSubmitted;
  }

  if (orderType === 'MARKET') {
    return formatCopy(copy.marketOrderSubmitted, { side: sideText });
  }

  return copy.genericOrderSubmitted;
}

export default function SpotTradingForm({
  symbol,
  baseAsset: pairBaseAsset,
  quoteAsset: pairQuoteAsset,
  marketPrice,
  selectedPrice = '',
  pricePrecision,
  amountPrecision,
  accountBalances = [],
  asks = [],
  bids = [],
  depthSource,
  depthFreshness,
  dataSource,
  latestTradePrice = null,
  latestTradeAt = null,
  marketDataLoading = false,
  onPriceChange,
  priceSelectNonce = 0,
  onOrderSuccess,
  isLoggedIn = false,
  authLoading = false,
  authChecked = true,
  userId = null,
}: SpotTradingFormProps) {
  const { t: localeT } = useLocaleContext();
  const copy = useMemo(() => buildSpotFormCopy(localeT), [localeT]);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingMarketOrder, setPendingMarketOrder] = useState<PendingSpotOrder | null>(null);
  const [pendingMarketOrderError, setPendingMarketOrderError] = useState('');
  const [selectedPercent, setSelectedPercent] = useState<number | null>(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [priceError, setPriceError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [quoteAmountError, setQuoteAmountError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [spotConfirmHidden, setSpotConfirmHidden] = useState(false);
  const [spotConfirmSuppressChecked, setSpotConfirmSuppressChecked] = useState(false);
  const [vipMakerFeeRate, setVipMakerFeeRate] = useState<string | null>(null);
  const [vipTakerFeeRate, setVipTakerFeeRate] = useState<string | null>(null);
  const [useRcbFee, setUseRcbFee] = useState(false);
  const [rcbUsdtPrice, setRcbUsdtPrice] = useState<number | null>(null);
  const [spotFeeSettings, setSpotFeeSettings] = useState<SpotFeeSettings>({
    spot_rcb_fee_enabled: true,
    rcb_fee_discount_rate: '0.75',
    min_rcb_fee_amount: '0',
  });

  const handledPriceSelectNonceRef = useRef(priceSelectNonce);
  const sliderFrameRef = useRef<number | null>(null);
  const pendingSliderValueRef = useRef<number | null>(null);
  const lastAppliedSliderValueRef = useRef<number | null>(null);

  const { baseAsset, quoteAsset } = useMemo(() => {
    const metaBaseAsset = String(pairBaseAsset || '').trim().toUpperCase();
    const metaQuoteAsset = String(pairQuoteAsset || '').trim().toUpperCase();
    if (metaBaseAsset || metaQuoteAsset) {
      return {
        baseAsset: metaBaseAsset,
        quoteAsset: metaQuoteAsset,
      };
    }
    return parseTradingPair(symbol);
  }, [pairBaseAsset, pairQuoteAsset, symbol]);
  const displaySymbol = useMemo(() => formatSpotDisplaySymbol(symbol), [symbol]);
  const safeAmountPrecision = useMemo(
    () => normalizePrecision(amountPrecision, DEFAULT_AMOUNT_PRECISION),
    [amountPrecision],
  );

  useEffect(() => {
    if (handledPriceSelectNonceRef.current === priceSelectNonce) {
      return;
    }

    handledPriceSelectNonceRef.current = priceSelectNonce;

    if (orderType !== 'limit') {
      return;
    }

    const formatted = formatPrice(selectedPrice, pricePrecision);
    if (!formatted) {
      return;
    }

    setPrice(formatted);
    setSelectedPercent(null);
    setPriceError('');
  }, [orderType, pricePrecision, priceSelectNonce, selectedPrice]);

  useEffect(() => {
    return () => {
      if (sliderFrameRef.current !== null) {
        window.cancelAnimationFrame(sliderFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const hidden = isLoggedIn ? readSpotConfirmHiddenForUser(userId) : false;
    setSpotConfirmHidden(hidden);
    setSpotConfirmSuppressChecked(hidden);
  }, [isLoggedIn, userId]);

  useEffect(() => {
    if (selectedPercent === null) {
      lastAppliedSliderValueRef.current = null;
      pendingSliderValueRef.current = null;
    }
  }, [selectedPercent]);

  useEffect(() => {
    setPrice('');
    setAmount('');
    setQuoteAmount('');
    setSelectedPercent(null);
    setSuccessMessage('');
    setPriceError('');
    setAmountError('');
    setQuoteAmountError('');
    setSubmitError('');
    setPendingMarketOrder(null);
    setPendingMarketOrderError('');
  }, [symbol]);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      try {
        const settings = await loadSpotFeeSettingsCached();
        if (!alive) return;
        setSpotFeeSettings(settings);
      } catch (error) {
        if (!alive) return;
        console.error('Failed to load spot fee settings:', error);
        setSpotFeeSettings({
          spot_rcb_fee_enabled: true,
          rcb_fee_discount_rate: '0.75',
          min_rcb_fee_amount: '0',
        });
      }
    };

    run();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;

    if (!isLoggedIn) {
      setVipMakerFeeRate(null);
      setVipTakerFeeRate(null);
      setUseRcbFee(false);
      return () => {
        alive = false;
      };
    }

    const run = async () => {
      try {
        const [overview, preference] = await Promise.all([
          getVipOverview(),
          getVipFeePreference(),
        ]);
        if (!alive) return;
        setVipMakerFeeRate(overview.user_summary?.effective_spot_maker_fee ?? null);
        setVipTakerFeeRate(overview.user_summary?.effective_spot_taker_fee ?? null);
        setUseRcbFee(Boolean(preference.use_rcb_fee));
      } catch (error) {
        if (!alive) return;
        console.error('Failed to load VIP fee estimate data:', error);
        setVipMakerFeeRate(null);
        setVipTakerFeeRate(null);
        setUseRcbFee(false);
      }
    };

    run();

    return () => {
      alive = false;
    };
  }, [isLoggedIn]);

  useEffect(() => {
    let alive = true;

    if (!isLoggedIn || !spotFeeSettings.spot_rcb_fee_enabled || !useRcbFee) {
      setRcbUsdtPrice(null);
      return () => {
        alive = false;
      };
    }

    const run = async () => {
      try {
        const tickers = await getSpotMarketTickers('RCBUSDT');
        if (!alive) return;

        const ticker =
          tickers.find((item) => String(item.symbol || '').toUpperCase() === 'RCBUSDT') ||
          tickers[0];
        const price = readTickerPrice(ticker as Record<string, unknown> | undefined);
        setRcbUsdtPrice(price > 0 ? price : null);
      } catch (error) {
        if (!alive) return;
        console.error('Failed to load RCBUSDT price:', error);
        setRcbUsdtPrice(null);
      }
    };

    run();

    return () => {
      alive = false;
    };
  }, [isLoggedIn, spotFeeSettings.spot_rcb_fee_enabled, useRcbFee]);

  useEffect(() => {
    setAmount('');
    setQuoteAmount('');
    setSelectedPercent(null);
    setPriceError('');
    setAmountError('');
    setQuoteAmountError('');
    setSubmitError('');
    setPendingMarketOrder(null);
    setPendingMarketOrderError('');
  }, [side, orderType]);

  useEffect(() => {
    if (!successMessage) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setSuccessMessage('');
    }, SUCCESS_MESSAGE_DURATION_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [successMessage]);

  const spotBalanceMap = useMemo(() => {
    const map = new Map<string, { available: number; frozen: number }>();

    for (const item of accountBalances) {
      if ((item.account_key || '').toLowerCase() !== 'spot') {
        continue;
      }

      const assetSymbol = (item.symbol || '').toUpperCase();
      map.set(assetSymbol, {
        available: Number(item.available || 0),
        frozen: Number(item.frozen || 0),
      });
    }

    return map;
  }, [accountBalances]);

  const quoteSpotAvailable = spotBalanceMap.get(quoteAsset)?.available ?? 0;
  const baseSpotAvailable = spotBalanceMap.get(baseAsset)?.available ?? 0;
  const rcbSpotAvailable = spotBalanceMap.get('RCB')?.available ?? 0;
  const rcbFeeDiscountRate = parsePositiveRatio(spotFeeSettings.rcb_fee_discount_rate, 0.75);
  const minRcbFeeAmount = Math.max(toFiniteNumber(spotFeeSettings.min_rcb_fee_amount), 0);
  const rcbFeeDiscountPercentText = formatFeeRatioPercent(rcbFeeDiscountRate);

  const currentPriceNumber = useMemo(() => {
    if (marketDataLoading) {
      return 0;
    }
    const num = Number(marketPrice || price || 0);
    return Number.isFinite(num) ? num : 0;
  }, [marketDataLoading, marketPrice, price]);

  const askLiquidityQuoteAmount = useMemo(() => getAskLiquidityQuoteAmount(asks), [asks]);
  const bidLiquidityAmount = useMemo(() => getBidLiquidityAmount(bids), [bids]);

  const total = useMemo(() => {
    if (orderType === 'market' && side === 'buy') {
      const totalNumber = Number(quoteAmount || 0);
      return Number.isFinite(totalNumber) && totalNumber > 0 ? totalNumber : 0;
    }

    const priceNumber = orderType === 'market' ? currentPriceNumber : Number(price || 0);
    const amountNumber = Number(amount || 0);

    if (
      !Number.isFinite(priceNumber) ||
      !Number.isFinite(amountNumber) ||
      priceNumber <= 0 ||
      amountNumber <= 0
    ) {
      return 0;
    }

    return priceNumber * amountNumber;
  }, [amount, currentPriceNumber, orderType, price, quoteAmount, side]);

  const estimatedFeeInfo = useMemo<EstimatedFeeInfo>(() => {
    const rate = parseFeeRate(orderType === 'limit' ? vipMakerFeeRate : vipTakerFeeRate);
    if (!isLoggedIn || rate === null || total <= 0) {
      return {
        display: '--',
        payment: '--',
        hintTitle: copy.usdtFeeTitle,
        hintSubtitle: '',
        hintDetails: [],
        hintTone: 'neutral',
        rcbReady: false,
        showOpenLink: false,
      };
    }

    const feeUsdt = total * rate;
    if (!Number.isFinite(feeUsdt) || feeUsdt <= 0) {
      return {
        display: '--',
        payment: '--',
        hintTitle: copy.usdtFeeTitle,
        hintSubtitle: '',
        hintDetails: [],
        hintTone: 'neutral',
        rcbReady: false,
        showOpenLink: false,
      };
    }

    const feeUsdtDisplay = `${formatSummaryFeeAmount(feeUsdt)} USDT`;

    if (!spotFeeSettings.spot_rcb_fee_enabled) {
      return {
        display: feeUsdtDisplay,
        payment: 'USDT',
        hintTitle: copy.usdtFeeTitle,
        hintSubtitle: copy.rcbDisabled,
        hintDetails: [],
        hintTone: 'neutral',
        rcbReady: false,
        showOpenLink: false,
      };
    }

    if (!useRcbFee) {
      return {
        display: feeUsdtDisplay,
        payment: 'USDT',
        hintTitle: copy.usdtFeeTitle,
        hintSubtitle: formatCopy(copy.rcbEnableHint, { percent: rcbFeeDiscountPercentText }),
        hintDetails: [],
        hintTone: 'neutral',
        rcbReady: false,
        showOpenLink: true,
      };
    }

    if (!rcbUsdtPrice || rcbUsdtPrice <= 0) {
      return {
        display: feeUsdtDisplay,
        payment: 'USDT',
        hintTitle: copy.rcbPriceUnavailable,
        hintSubtitle: '',
        hintDetails: [],
        hintTone: 'warning',
        rcbReady: false,
        showOpenLink: false,
      };
    }

    const calculatedRcb = (feeUsdt * rcbFeeDiscountRate) / rcbUsdtPrice;
    const requiredRcb = minRcbFeeAmount > 0 ? Math.max(calculatedRcb, minRcbFeeAmount) : calculatedRcb;
    if (!Number.isFinite(requiredRcb) || requiredRcb <= 0) {
      return {
        display: feeUsdtDisplay,
        payment: 'USDT',
        hintTitle: copy.rcbUnavailable,
        hintSubtitle: '',
        hintDetails: [],
        hintTone: 'warning',
        rcbReady: false,
        showOpenLink: false,
      };
    }

    const requiredRcbDisplay = `${formatSummaryFeeAmount(requiredRcb)} RCB`;

    if (rcbSpotAvailable >= requiredRcb) {
      return {
        display: requiredRcbDisplay,
        payment: copy.rcbPayment,
        hintTitle: formatCopy(copy.rcbEnabledHint, { percent: rcbFeeDiscountPercentText }),
        hintSubtitle: '',
        hintDetails: [formatCopy(copy.rcbEstimatedDeduct, { amount: requiredRcbDisplay })],
        hintTone: 'success',
        rcbReady: true,
        showOpenLink: false,
      };
    }

    return {
      display: feeUsdtDisplay,
      payment: 'USDT',
      hintTitle: copy.rcbInsufficient,
      hintSubtitle: copy.usdtFeeTitle,
      hintDetails: [
        formatCopy(copy.rcbNeed, { amount: requiredRcbDisplay }),
        formatCopy(copy.rcbAvailable, { amount: formatRcbAmount(rcbSpotAvailable) }),
      ],
      hintTone: 'warning',
      rcbReady: false,
      showOpenLink: false,
    };
  }, [
    copy,
    isLoggedIn,
    orderType,
    rcbFeeDiscountPercentText,
    rcbFeeDiscountRate,
    rcbSpotAvailable,
    rcbUsdtPrice,
    minRcbFeeAmount,
    spotFeeSettings.spot_rcb_fee_enabled,
    total,
    useRcbFee,
    vipMakerFeeRate,
    vipTakerFeeRate,
  ]);

  const estimatedFeeDisplay = estimatedFeeInfo.display;
  const displayedFeePaymentDisplay = estimatedFeeInfo.payment;
  const displayedFeeHintTitle = estimatedFeeInfo.hintTitle;
  const displayedFeeHintSubtitle = estimatedFeeInfo.hintSubtitle;
  const displayedFeeHintDetails = estimatedFeeInfo.hintDetails;
  const displayedFeeHintTone = estimatedFeeInfo.hintTone;
  const displayedFeeHintShowOpenLink = estimatedFeeInfo.showOpenLink;

  const estimatedBaseAmount = useMemo(() => {
    if (!Number.isFinite(currentPriceNumber) || currentPriceNumber <= 0) {
      return '0.0000';
    }

    if (orderType === 'market' && side === 'buy') {
      return formatAmount(Number(quoteAmount || 0) / currentPriceNumber, safeAmountPrecision) || '0.0000';
    }

    return formatAmount(amount || 0, safeAmountPrecision) || '0.0000';
  }, [amount, currentPriceNumber, orderType, quoteAmount, safeAmountPrecision, side]);

  const estimatedQuoteAmount = useMemo(() => {
    if (!Number.isFinite(currentPriceNumber) || currentPriceNumber <= 0) {
      return '0.00';
    }

    return formatSummaryQuoteTotal(Number(amount || 0) * currentPriceNumber) || '0.00';
  }, [amount, currentPriceNumber]);

  const orderPriceDisplay = useMemo(() => {
    return price || '--';
  }, [price]);

  const liquidityError = useMemo(() => {
    if (orderType !== 'market') {
      return '';
    }

    if (side === 'buy') {
      const requestedQuoteAmount = Number(quoteAmount || 0);
      if (requestedQuoteAmount > 0 && requestedQuoteAmount > askLiquidityQuoteAmount) {
        return copy.insufficientAskLiquidity;
      }
      return '';
    }

    const requestedAmount = Number(amount || 0);
    if (requestedAmount > 0 && requestedAmount > bidLiquidityAmount) {
      return copy.insufficientBidLiquidity;
    }

    return '';
  }, [amount, askLiquidityQuoteAmount, bidLiquidityAmount, copy, orderType, quoteAmount, side]);

  const syncPriceToParent = (nextPrice: string) => {
    onPriceChange?.(nextPrice);
  };

  const handlePriceInputChange = (value: string) => {
    const nextValue = normalizeDecimalInput(value);
    if (nextValue === null) {
      return;
    }

    setPrice(nextValue);
    setSelectedPercent(null);
    setPriceError('');

    if (nextValue === '') {
      onPriceChange?.('');
    }
  };

  const handlePriceBlur = () => {
    if (!price) {
      return;
    }

    const formatted = formatPrice(price, pricePrecision);
    setPrice(formatted);
    syncPriceToParent(formatted);

    if (Number(formatted || 0) > 0) {
      setPriceError('');
    }
  };

  const handlePriceStep = (direction: 'up' | 'down') => {
    if (marketDataLoading && !price) {
      return;
    }
    const step = Number(getSpotPriceStep(pricePrecision));
    const current = Number(price || marketPrice || 0);
    const safeCurrent = Number.isFinite(current) ? current : 0;

    const next =
      direction === 'up' ? safeCurrent + step : Math.max(safeCurrent - step, 0);

    const formatted = normalizeSpotPriceInput(next, pricePrecision);
    setPrice(formatted);
    syncPriceToParent(formatted);
    setSelectedPercent(null);
    setPriceError('');
  };

  const handlePriceStepPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    direction: 'up' | 'down',
  ) => {
    event.preventDefault();
    handlePriceStep(direction);
  };

  const handleAmountChange = (value: string) => {
    const nextValue = normalizeDecimalInput(value);
    if (nextValue === null) {
      return;
    }

    setAmount(nextValue);
    setSelectedPercent(null);
    setAmountError('');
    setSubmitError('');
  };

  const handleAmountBlur = () => {
    if (!amount) {
      return;
    }

    const formatted = formatAmount(amount, safeAmountPrecision);
    setAmount(formatted);

    if (Number(formatted || 0) > 0) {
      setAmountError('');
    }
  };

  const handleQuoteAmountChange = (value: string) => {
    const nextValue = normalizeDecimalInput(value);
    if (nextValue === null) {
      return;
    }

    setQuoteAmount(nextValue);
    setSelectedPercent(null);
    setQuoteAmountError('');
    setSubmitError('');
  };

  const handleQuoteAmountBlur = () => {
    if (!quoteAmount) {
      return;
    }

    const formatted = formatQuoteAmount(quoteAmount);
    setQuoteAmount(formatted);

    if (Number(formatted || 0) > 0) {
      setQuoteAmountError('');
    }
  };

  const applyPercentSelection = (percentValue: number) => {
    const safePercentValue = clampPercentValue(percentValue);
    const percent = safePercentValue / 100;

    if (orderType === 'market' && side === 'buy') {
      setQuoteAmount(formatQuoteAmount(quoteSpotAvailable * percent));
      setSelectedPercent(percent);
      lastAppliedSliderValueRef.current = safePercentValue;
      setQuoteAmountError('');
      setSubmitError('');
      return;
    }

    const effectivePrice =
      orderType === 'market' ? currentPriceNumber : Number(price || 0);

    if (side === 'buy') {
      if (!Number.isFinite(effectivePrice) || effectivePrice <= 0) {
        return;
      }

      const quantity = (quoteSpotAvailable * percent) / effectivePrice;
      setAmount(formatAmount(quantity, safeAmountPrecision));
      setSelectedPercent(percent);
      lastAppliedSliderValueRef.current = safePercentValue;
      setAmountError('');
      setSubmitError('');
      return;
    }

    setAmount(formatAmount(baseSpotAvailable * percent, safeAmountPrecision));
    setSelectedPercent(percent);
    lastAppliedSliderValueRef.current = safePercentValue;
    setAmountError('');
    setSubmitError('');
  };

  const handleSubmit = async (): Promise<void> => {
    if (loading) return;

    setSuccessMessage('');
    setSubmitError('');
    setPendingMarketOrderError('');
    setPriceError('');
    setAmountError('');
    setQuoteAmountError('');

    if (authLoading || !authChecked) {
      setSubmitError(copy.checkingLogin);
      return;
    }

    if (marketDataLoading) {
      return;
    }

    if (!isLoggedIn) {
      setSubmitError(copy.loginExpired);
      return;
    }

    const submitSide: SpotOrderSide = side === 'buy' ? 'BUY' : 'SELL';
    const payloadOrderType = orderType === 'limit' ? 'LIMIT' : 'MARKET';

    if (liquidityError) {
      setSubmitError(liquidityError);
      return;
    }

    let submitPrice = '';
    let submitAmount = '';
    let submitQuoteAmount = '';

    if (orderType === 'limit') {
      if (!isPositiveDecimalInput(price)) {
        setPriceError(copy.enterPrice);
        return;
      }

      if (!isPositiveDecimalInput(amount)) {
        setAmountError(copy.enterAmount);
        return;
      }

      submitPrice = formatPrice(price, pricePrecision);
      submitAmount = formatAmount(amount, safeAmountPrecision);

      if (side === 'buy') {
        const submitTotal = floorToPrecision(
          Number(submitPrice) * Number(submitAmount),
          QUOTE_PRECISION,
        );

        if (submitTotal > quoteSpotAvailable) {
          setSubmitError(copy.insufficientBalance);
          return;
        }
      } else if (Number(submitAmount) > baseSpotAvailable) {
        setSubmitError(copy.insufficientBalance);
        return;
      }
    } else if (side === 'buy') {
      if (!isPositiveDecimalInput(quoteAmount)) {
        setQuoteAmountError(copy.enterBuyAmount);
        return;
      }

      if (!Number.isFinite(currentPriceNumber) || currentPriceNumber <= 0) {
        setSubmitError(copy.noMarketPrice);
        return;
      }

      submitQuoteAmount = formatQuoteAmount(quoteAmount);

      if (Number(submitQuoteAmount) > quoteSpotAvailable) {
        setSubmitError(copy.insufficientBalance);
        return;
      }

      const derivedAmount = Number(submitQuoteAmount) / currentPriceNumber;
      submitAmount = formatAmount(derivedAmount, safeAmountPrecision);

      if (!submitAmount || Number(submitAmount) <= 0) {
        setQuoteAmountError(copy.quoteAmountTooSmall);
        return;
      }
    } else {
      if (!isPositiveDecimalInput(amount)) {
        setAmountError(copy.enterAmount);
        return;
      }

      submitAmount = formatAmount(amount, safeAmountPrecision);

      if (Number(submitAmount) > baseSpotAvailable) {
        setSubmitError(copy.insufficientBalance);
        return;
      }
    }

    const payload = {
      symbol,
      side: submitSide,
      order_type: payloadOrderType,
      ...(orderType === 'limit'
        ? {
            price: submitPrice,
            amount: submitAmount,
          }
        : side === 'buy'
        ? {
            quote_amount: submitQuoteAmount,
          }
        : {
            amount: submitAmount,
          }),
    } as CreateSpotOrderPayload;

    const pendingOrder = { payload, submitPrice };

    if (spotConfirmHidden) {
      await submitSpotOrder(pendingOrder);
      return;
    }

    setPendingMarketOrderError('');
    setSpotConfirmSuppressChecked(false);
    setPendingMarketOrder(pendingOrder);
  };

  async function submitSpotOrder(order: PendingSpotOrder): Promise<void> {
    if (loading) return;
    const startedAt = Date.now();

    try {
      setLoading(true);
      setPendingMarketOrderError('');

      const result = await createSpotOrder(order.payload);
      console.log('Order response:', result);

      setSuccessMessage(buildOrderSuccessMessage(result, order.payload, copy));
      setAmount('');
      setQuoteAmount('');
      setSelectedPercent(null);
      setPendingMarketOrder(null);

      if (order.payload.order_type === 'LIMIT') {
        const formatted = formatPrice(order.submitPrice, pricePrecision);
        setPrice(formatted);
        syncPriceToParent(formatted);
      }

      onOrderSuccess?.(result);
    } catch (err: unknown) {
      const message = normalizeSubmitError(err, copy, quoteAsset || 'USDT');
      if (pendingMarketOrder) {
        setPendingMarketOrderError(message);
      } else {
        setSubmitError(message);
      }
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_SUBMIT_LOADING_MS) {
        await wait(MIN_SUBMIT_LOADING_MS - elapsed);
      }
      setLoading(false);
    }
  }

  const isMarketBuy = orderType === 'market' && side === 'buy';
  const isMarketSell = orderType === 'market' && side === 'sell';
  const isLimitOrder = orderType === 'limit';

  const showPriceInput = isLimitOrder;
  const showAmountInput = isLimitOrder || side === 'sell';
  const showQuoteAmountInput = isMarketBuy;
  const isAuthChecking = authLoading || !authChecked;
  const submitDisabled = loading || marketDataLoading || Boolean(liquidityError) || isAuthChecking;
  const submitButtonText = isAuthChecking
    ? copy.checkingLogin
    : loading
      ? copy.submitting
      : `${side === 'buy' ? copy.buy : copy.sell} ${displaySymbol}`;

  const amountInputLabel = isMarketSell ? copy.sellAmount : copy.amount;
  const amountInputUnit = baseAsset || symbol;
  const quoteAmountInputUnit = quoteAsset || 'USDT';
  const sliderValue = selectedPercent !== null ? Math.round(selectedPercent * 100) : 0;

  const bestAskPrice = useMemo(() => {
    const nextAsk = asks.find((item) => Number(item.price) > 0);
    if (!nextAsk) {
      return '';
    }
    return formatPrice(nextAsk.price, pricePrecision);
  }, [asks, pricePrecision]);

  const bestBidPrice = useMemo(() => {
    const nextBid = bids.find((item) => Number(item.price) > 0);
    if (!nextBid) {
      return '';
    }
    return formatPrice(nextBid.price, pricePrecision);
  }, [bids, pricePrecision]);

  const bboPrice = marketDataLoading ? '' : side === 'buy' ? bestAskPrice : bestBidPrice;
  const bboDisabled = marketDataLoading || !bboPrice;
  const bboStatus = useMemo(
    () => resolveSpotMarketStatus({
      source: depthSource,
      freshness: depthFreshness,
      dataSource,
      isLoading: marketDataLoading,
    }),
    [dataSource, depthFreshness, depthSource, marketDataLoading],
  );
  const bboBasisLabel = getSpotBboBasisLabel(side);
  const bboAvailabilityLabel = getSpotBboAvailabilityLabel(bboStatus, Boolean(bboPrice));
  const latestTradePriceDisplay =
    latestTradePrice !== null && latestTradePrice !== undefined && String(latestTradePrice).trim() !== ''
      ? String(latestTradePrice)
      : '--';
  const latestTradeTimeDisplay = formatLatestTradeTime(latestTradeAt);

  const handleSliderChange = (nextValue: number) => {
    const safeValue = clampPercentValue(nextValue);
    if (
      safeValue === lastAppliedSliderValueRef.current ||
      safeValue === pendingSliderValueRef.current
    ) {
      return;
    }

    if (PERCENT_TICKS.has(safeValue)) {
      if (sliderFrameRef.current !== null) {
        window.cancelAnimationFrame(sliderFrameRef.current);
        sliderFrameRef.current = null;
      }
      pendingSliderValueRef.current = null;
      applyPercentSelection(safeValue);
      return;
    }

    pendingSliderValueRef.current = safeValue;

    if (sliderFrameRef.current !== null) {
      return;
    }

    sliderFrameRef.current = window.requestAnimationFrame(() => {
      sliderFrameRef.current = null;
      const pendingValue = pendingSliderValueRef.current;
      pendingSliderValueRef.current = null;

      if (pendingValue === null || pendingValue === lastAppliedSliderValueRef.current) {
        return;
      }

      applyPercentSelection(pendingValue);
    });
  };

  const handleBboClick = () => {
    if (marketDataLoading || !bboPrice) {
      return;
    }

    setPrice(bboPrice);
    syncPriceToParent(bboPrice);
    setSelectedPercent(null);
    setPriceError('');
    setSubmitError('');
  };

  const summaryRows = useMemo(() => {
    const rows: SummaryRow[] = [
      { key: 'symbol', label: copy.symbol, value: displaySymbol },
      { key: 'order-type', label: copy.type, value: isLimitOrder ? copy.limitOrder : copy.marketOrder },
    ];

    if (isLimitOrder) {
      rows.push({
        key: 'order-price',
        label: copy.orderPrice,
        value: orderPriceDisplay,
      });
      rows.push({
        key: 'total',
        label: copy.total,
        value: `${formatSummaryQuoteTotal(total) || '0.00'} ${quoteAsset || 'USDT'}`,
      });
      rows.push({
        key: 'estimated-fee',
        label: copy.estimatedFee,
        value: estimatedFeeDisplay,
      });
      rows.push({
        key: 'fee-payment',
        label: copy.feePayment,
        value: displayedFeePaymentDisplay,
      });
      return rows;
    }

    if (isMarketBuy) {
      rows.push({
        key: 'estimated-base-amount',
        label: copy.estimatedBaseAmount,
        value: `${estimatedBaseAmount} ${baseAsset || symbol}`,
      });
      rows.push({
        key: 'pay-amount',
        label: copy.payAmount,
        value: `${formatSummaryQuoteTotal(quoteAmount || 0) || '0.00'} ${quoteAsset || 'USDT'}`,
      });
      rows.push({
        key: 'estimated-fee',
        label: copy.estimatedFee,
        value: estimatedFeeDisplay,
      });
      rows.push({
        key: 'fee-payment',
        label: copy.feePayment,
        value: displayedFeePaymentDisplay,
      });
      return rows;
    }

    rows.push({
      key: 'sell-amount',
      label: copy.sellAmount,
      value: `${formatAmount(amount || 0, safeAmountPrecision) || '0.0000'} ${baseAsset || symbol}`,
    });
    rows.push({
      key: 'estimated-quote-amount',
      label: copy.estimatedQuoteAmount,
      value: `${estimatedQuoteAmount} ${quoteAsset || 'USDT'}`,
    });
    rows.push({
      key: 'estimated-fee',
      label: copy.estimatedFee,
      value: estimatedFeeDisplay,
    });
    rows.push({
      key: 'fee-payment',
      label: copy.feePayment,
      value: displayedFeePaymentDisplay,
    });

    return rows;
  }, [
    baseAsset,
    amount,
    copy,
    displaySymbol,
    estimatedBaseAmount,
    estimatedFeeDisplay,
    estimatedQuoteAmount,
    displayedFeePaymentDisplay,
    isLimitOrder,
    isMarketBuy,
    orderPriceDisplay,
    quoteAmount,
    quoteAsset,
    symbol,
    total,
    safeAmountPrecision,
  ]);

  const pendingSpotSide = pendingMarketOrder?.payload.side === 'SELL' ? 'sell' : 'buy';
  const pendingSpotType = pendingMarketOrder?.payload.order_type === 'MARKET' ? 'market' : 'limit';
  const pendingSpotConfirmTitle = pendingSpotSide === 'buy' ? copy.confirmBuyTitle : copy.confirmSellTitle;
  const pendingSpotConfirmText = pendingSpotSide === 'buy' ? copy.confirmBuy : copy.confirmSell;
  const pendingSpotConfirmDescription =
    pendingSpotType === 'market'
      ? copy.marketConfirmDescription
      : copy.limitConfirmDescription;
  const pendingSpotConfirmDetails = useMemo(() => {
    if (!pendingMarketOrder) return [];

    const payload = pendingMarketOrder.payload;
    const isMarket = payload.order_type === 'MARKET';
    const isBuy = payload.side === 'BUY';
    const rows = [
      { label: copy.symbol, value: displaySymbol },
      { label: copy.side, value: isBuy ? copy.buy : copy.sell },
      { label: copy.type, value: isMarket ? copy.market : copy.limit },
    ];

    if (isMarket && isBuy) {
      const estimatedAmount =
        currentPriceNumber > 0
          ? formatAmount(Number(payload.quote_amount || 0) / currentPriceNumber, safeAmountPrecision)
          : '';
      rows.push({
        label: copy.amount,
        value: `${estimatedAmount || '--'} ${baseAsset || symbol}`,
      });
      rows.push({
        label: copy.payAmount,
        value: `${formatSummaryQuoteTotal(payload.quote_amount || 0) || '0.00'} ${quoteAsset || 'USDT'}`,
      });
    } else {
      rows.push({
        label: copy.amount,
        value: `${formatAmount(payload.amount || 0, safeAmountPrecision) || '0.0000'} ${baseAsset || symbol}`,
      });
    }

    if (isMarket) {
      rows.push({ label: copy.price, value: copy.market });
      rows.push({
        label: copy.estimatedTradePrice,
        value: currentPriceNumber > 0 ? `${formatPrice(currentPriceNumber, pricePrecision)} ${quoteAsset || 'USDT'}` : '--',
      });
    } else {
      rows.push({
        label: copy.price,
        value: `${formatPrice(payload.price || pendingMarketOrder.submitPrice, pricePrecision)} ${quoteAsset || 'USDT'}`,
      });
    }

    return rows;
  }, [
    baseAsset,
    copy,
    currentPriceNumber,
    displaySymbol,
    pendingMarketOrder,
    pricePrecision,
    quoteAsset,
    safeAmountPrecision,
    symbol,
  ]);

  function handleSpotConfirmHiddenChange(checked: boolean) {
    setSpotConfirmSuppressChecked(checked);
  }

  function persistSpotConfirmHidden(value: boolean) {
    setSpotConfirmHidden(value);
    writeSpotConfirmHiddenForUser(userId, value);
  }

  return (
    <div className="tabular-nums space-y-1 xl:space-y-1.5">
      <div
        className={
          isLoggedIn || isAuthChecking ? '' : 'opacity-50'
        }
      >
        <div className="grid grid-cols-2 rounded-xl border border-white/[0.06] bg-[#0b1016] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] xl:p-1">
        <button
          type="button"
          onClick={() => setSide('buy')}
          className={`rounded-lg py-1 text-[14px] font-semibold transition-all xl:py-1.5 ${
            side === 'buy'
              ? 'bg-[#16a34a] text-white shadow-[0_10px_24px_rgba(22,163,74,0.22)]'
              : 'text-white/46 hover:text-white/78'
          }`}
        >
          {copy.buy}
        </button>
        <button
          type="button"
          onClick={() => setSide('sell')}
          className={`rounded-lg py-1 text-[14px] font-semibold transition-all xl:py-1.5 ${
            side === 'sell'
              ? 'bg-[#dc2626] text-white shadow-[0_10px_24px_rgba(220,38,38,0.22)]'
              : 'text-white/46 hover:text-white/78'
          }`}
        >
          {copy.sell}
        </button>
        </div>

        <div className="inline-flex rounded-lg border border-white/[0.05] bg-white/[0.03] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <button
            type="button"
            onClick={() => setOrderType('limit')}
            className={`rounded-md px-2.5 py-0.5 text-[12px] font-medium transition-colors xl:px-3 xl:py-1 ${
              orderType === 'limit'
                ? 'bg-white/[0.08] text-white'
                : 'text-white/44 hover:text-white/72'
            }`}
          >
            {copy.limit}
          </button>
          <button
            type="button"
            onClick={() => setOrderType('market')}
            className={`rounded-md px-2.5 py-0.5 text-[12px] font-medium transition-colors xl:px-3 xl:py-1 ${
              orderType === 'market'
                ? 'bg-white/[0.08] text-white'
                : 'text-white/44 hover:text-white/72'
            }`}
          >
            {copy.market}
          </button>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#0b1016] px-2.5 py-2 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-white/46">{bboBasisLabel}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 font-semibold ${spotMarketStatusBadgeClass(bboStatus.kind)}`}>
              {bboStatus.label}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-white/36">
            <span className="min-w-0 truncate">{bboPrice || '--'}</span>
            <span className={bboStatus.isFresh && bboPrice ? 'text-emerald-200/78' : 'text-white/34'}>
              {bboAvailabilityLabel}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-white/36">
            <span className="min-w-0 truncate">{LATEST_TRADE_LABEL}</span>
            <span className="min-w-0 truncate text-right text-white/62">
              {latestTradePriceDisplay}
              {latestTradeTimeDisplay ? (
                <span className="ml-1 text-white/34">{latestTradeTimeDisplay}</span>
              ) : null}
            </span>
          </div>
        </div>

        <div className="space-y-2.5 xl:space-y-3">
          {showPriceInput ? (
            <div>
              <div className="mb-1 text-[11px] text-gray-400 xl:mb-1.5">
                {copy.price} ({quoteAsset || 'USDT'})
              </div>

            <div className="flex items-stretch gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  value={price}
                  onChange={(e) => handlePriceInputChange(e.target.value)}
                  onBlur={handlePriceBlur}
                  inputMode="decimal"
                  className="w-full rounded-xl border border-white/[0.08] bg-[#0d1218] px-3 py-1.5 pr-10 text-[12px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] outline-none transition-colors placeholder:text-white/20 hover:border-white/[0.14] focus:border-white/[0.18] focus:bg-[#10161d] focus:ring-1 focus:ring-white/10 xl:py-2"
                  placeholder={side === 'buy' ? copy.enterBuyPrice : copy.enterSellPrice}
                />

                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col">
                  <button
                    type="button"
                    onPointerDown={(event) => handlePriceStepPointerDown(event, 'up')}
                    onClick={(event) => event.preventDefault()}
                    aria-label={copy.increasePrice}
                    className="relative z-10 flex h-4 w-6 items-center justify-center rounded text-[10px] text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white"
                    title={copy.increasePrice}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onPointerDown={(event) => handlePriceStepPointerDown(event, 'down')}
                    onClick={(event) => event.preventDefault()}
                    aria-label={copy.decreasePrice}
                    className="relative z-10 mt-0.5 flex h-4 w-6 items-center justify-center rounded text-[10px] text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white"
                    title={copy.decreasePrice}
                  >
                    -
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={handleBboClick}
                disabled={bboDisabled}
                title={copy.bboTooltip}
                className={`shrink-0 rounded-xl border px-3 text-[11px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-colors ${
                  bboDisabled
                    ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] text-white/24'
                    : 'border-white/[0.08] bg-[#0d1218] text-white/70 hover:border-white/[0.16] hover:bg-[#121922] hover:text-white'
                }`}
              >
                BBO
              </button>
            </div>

            {priceError ? (
              <div className="mt-2 text-xs text-red-400">{priceError}</div>
            ) : null}
          </div>
        ) : (
          <div>
            <div className="mb-1 text-[11px] text-gray-400 xl:mb-1.5">
              {copy.price} ({quoteAsset || 'USDT'})
            </div>
            <div className="w-full rounded-xl border border-white/[0.08] bg-[#0d1218] px-3 py-1.5 text-[12px] text-white/34 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] xl:py-2">
              {copy.marketByBook}
            </div>
          </div>
        )}

        {showAmountInput ? (
          <div>
            <div className="mb-1 text-[11px] text-gray-400 xl:mb-1.5">
              {amountInputLabel} ({amountInputUnit})
            </div>
            <input
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              onBlur={handleAmountBlur}
              inputMode="decimal"
              className="w-full rounded-xl border border-white/[0.08] bg-[#0d1218] px-3 py-1.5 text-[12px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] outline-none transition-colors placeholder:text-white/20 hover:border-white/[0.14] focus:border-white/[0.18] focus:bg-[#10161d] focus:ring-1 focus:ring-white/10 xl:py-2"
              placeholder={formatCopy(copy.enterAmountWithAsset, { asset: amountInputUnit })}
            />
            {amountError ? (
              <div className="mt-2 text-xs text-red-400">{amountError}</div>
            ) : null}
          </div>
        ) : null}

        {showQuoteAmountInput ? (
          <div>
            <div className="mb-1 text-[11px] text-gray-400 xl:mb-1.5">
              {copy.buyAmount} ({quoteAmountInputUnit})
            </div>
            <input
              value={quoteAmount}
              onChange={(e) => handleQuoteAmountChange(e.target.value)}
              onBlur={handleQuoteAmountBlur}
              inputMode="decimal"
              className="w-full rounded-xl border border-white/[0.08] bg-[#0d1218] px-3 py-1.5 text-[12px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] outline-none transition-colors placeholder:text-white/20 hover:border-white/[0.14] focus:border-white/[0.18] focus:bg-[#10161d] focus:ring-1 focus:ring-white/10 xl:py-2"
              placeholder={formatCopy(copy.enterBuyAmountWithAsset, { asset: quoteAmountInputUnit })}
            />
            {quoteAmountError ? (
              <div className="mt-2 text-xs text-red-400">{quoteAmountError}</div>
            ) : null}
          </div>
        ) : null}

        <PercentageSlider
          value={sliderValue}
          side={side}
          onChange={handleSliderChange}
        />

        <div className="rounded-xl border border-white/[0.06] bg-[#0b1016] p-2 text-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] xl:p-2.5">
          {summaryRows.map((row, index) => (
            <div
              key={row.key}
              className={`${
                index === summaryRows.length - 1
                  ? 'flex items-center justify-between gap-2'
                  : 'mb-1 flex items-center justify-between gap-2'
              }`}
            >
              <span className="min-w-0 shrink-0 text-white/42">{row.label}</span>
              <span className="min-w-0 truncate text-right font-medium text-white/90">{row.value}</span>
            </div>
          ))}
          <div
            className={`mt-2 rounded-lg border px-2.5 py-2 text-[11px] leading-snug ${
              displayedFeeHintTone === 'success'
                ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                : displayedFeeHintTone === 'warning'
                ? 'border-amber-400/22 bg-amber-400/10 text-amber-100'
                : 'border-white/[0.06] bg-white/[0.03] text-white/52'
            }`}
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0 flex-1 whitespace-normal break-words">
                <div className="font-medium">{displayedFeeHintTitle}</div>
                {displayedFeeHintSubtitle ? (
                  <div
                    className={`mt-0.5 ${
                      displayedFeeHintTone === 'success'
                        ? 'text-emerald-200/80'
                        : displayedFeeHintTone === 'warning'
                        ? 'text-amber-100/80'
                        : 'text-white/40'
                    }`}
                  >
                    {displayedFeeHintSubtitle}
                  </div>
                ) : null}
              </div>
              {displayedFeeHintShowOpenLink ? (
                <Link
                  href="/user"
                  className="shrink-0 cursor-pointer text-emerald-300 transition-colors hover:text-emerald-200 hover:underline"
                >
                  {copy.openRcbFee}
                </Link>
              ) : null}
            </div>
            {displayedFeeHintDetails.length > 0 ? (
              <div
                className={`mt-2 space-y-0.5 whitespace-normal break-words ${
                  displayedFeeHintTone === 'success'
                    ? 'text-emerald-200/70'
                    : displayedFeeHintTone === 'warning'
                    ? 'text-amber-100/70'
                    : 'text-white/36'
                }`}
              >
                {displayedFeeHintDetails.map((detail) => (
                  <div key={detail}>{detail}</div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

          {isLoggedIn || isAuthChecking ? (
            <>
              {submitError ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-2 py-1 text-[12px] text-red-400 xl:px-2.5 xl:py-1.5">
                  {submitError}
                </div>
              ) : null}

              {!submitError && liquidityError ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-2 py-1 text-[12px] text-red-400 xl:px-2.5 xl:py-1.5">
                  {liquidityError}
                </div>
              ) : null}

              {successMessage ? (
                <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-2 py-1 text-[12px] text-green-400 xl:px-2.5 xl:py-1.5">
                  {successMessage}
                </div>
              ) : null}

              <button
                type="button"
                disabled={submitDisabled}
                onClick={handleSubmit}
                className={`w-full rounded-xl py-2.5 text-[14px] font-semibold tracking-wide text-white shadow-[0_12px_28px_rgba(0,0,0,0.28)] transition-all xl:py-3 ${
                  side === 'buy'
                    ? 'bg-gradient-to-b from-[#22c55e] to-[#16a34a] hover:from-[#22c55e] hover:to-[#15803d]'
                    : 'bg-gradient-to-b from-[#ef4444] to-[#dc2626] hover:from-[#ef4444] hover:to-[#b91c1c]'
                } ${submitDisabled ? 'cursor-not-allowed opacity-50' : 'hover:-translate-y-[1px]'}`}
              >
                {submitButtonText}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {!isLoggedIn && !isAuthChecking ? (
        <div className="mt-2 flex flex-col gap-2">
          <Link
            href="/login?redirect=/trade/spot"
            className="w-full rounded-xl border border-white/10 bg-white/5 py-2 text-center text-[13px] font-semibold text-white hover:bg-white/10 transition-colors"
          >
            {copy.login}
          </Link>
          <Link
            href="/register?redirect=/trade/spot"
            className="w-full rounded-xl bg-white text-center text-[13px] font-semibold text-black py-2 hover:bg-white/90 transition-colors"
          >
            {copy.register}
          </Link>
        </div>
      ) : null}
      <TradingConfirmModal
        open={pendingMarketOrder !== null}
        title={pendingSpotConfirmTitle}
        description={pendingSpotConfirmDescription}
        confirmText={pendingSpotConfirmText}
        danger={pendingSpotSide === 'sell'}
        loading={loading}
        error={pendingMarketOrderError}
        details={pendingSpotConfirmDetails}
        suppressChecked={spotConfirmSuppressChecked}
        onSuppressChange={handleSpotConfirmHiddenChange}
        onCancel={() => {
          if (!loading) {
            setPendingMarketOrderError('');
            setSpotConfirmSuppressChecked(spotConfirmHidden);
            setPendingMarketOrder(null);
          }
        }}
        onConfirm={() => {
          if (pendingMarketOrder && !loading) {
            persistSpotConfirmHidden(spotConfirmSuppressChecked);
            void submitSpotOrder(pendingMarketOrder);
          }
        }}
      />
    </div>
  );
}
