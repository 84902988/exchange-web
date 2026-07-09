import { ApiError } from '@/lib/api';

export type ContractErrorTranslator = (key: string, namespace?: 'contracts') => string;

const CONTRACT_ERROR_FALLBACKS = {
  contractErrorLoginRequired: '请先登录后再交易合约',
  contractErrorUnavailable: '合约暂不可用',
  contractErrorPriceChanged: '价格已变化，请重试',
  contractErrorInsufficientMargin: '可用保证金不足',
  contractErrorQuoteNotLive: '当前行情暂不可成交，请稍后重试',
  contractErrorLeverageExceedsLimit: '杠杆超过当前合约上限',
  contractErrorQuantityBelowMin: '下单数量低于最小值',
  contractErrorQuantityAboveMax: '下单数量超过最大值',
  contractErrorInvalidPrice: '请输入有效价格',
  contractErrorInvalidQuantity: '请输入有效数量',
  contractErrorInvalidPayload: '参数格式无效，请检查止盈止损价格',
  contractErrorInvalidReferencePrice: '开仓价格暂不可用，请刷新后重试',
  contractErrorTakeProfitAboveEntry: '止盈价必须高于开仓价',
  contractErrorStopLossBelowEntry: '止损价必须低于开仓价',
  contractErrorTakeProfitBelowEntry: '止盈价必须低于开仓价',
  contractErrorStopLossAboveEntry: '止损价必须高于开仓价',
  contractErrorPositionHasOpenCloseOrder: '该仓位已有未成交平仓委托',
  contractErrorNoClosablePosition: '未找到可平仓仓位',
  contractErrorCloseQuantityExceedsPosition: '平仓数量不能超过可平数量',
  contractErrorPositionQuantityNotEnough: '仓位数量不足',
  contractErrorOrderNotFound: '订单不存在',
  contractErrorOrderNotCancelable: '当前订单不可取消',
  contractErrorNetwork: '网络异常，请稍后重试',
  contractErrorFallback: '操作失败，请稍后重试',
} as const;

type ContractErrorKey = keyof typeof CONTRACT_ERROR_FALLBACKS;

function contractErrorText(key: ContractErrorKey, t?: ContractErrorTranslator) {
  if (!t) return CONTRACT_ERROR_FALLBACKS[key];
  const translated = t(key, 'contracts');
  return translated && translated !== key ? translated : CONTRACT_ERROR_FALLBACKS[key];
}

export function toNumber(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return 0;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatNumber(value?: string | number | null, digits = 4) {
  const num = toNumber(value);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(num);
}

export function formatFixedNumber(value?: string | number | null, digits = 4) {
  const num = toNumber(value);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(num);
}

export function formatTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function friendlyContractError(error: unknown, t?: ContractErrorTranslator) {
  if (error instanceof ApiError) {
    const code = (error.code || '').toUpperCase();
    const message = error.message || '';
    const normalized = `${code} ${message}`.toLowerCase();

    if (code.includes('UNAUTHORIZED') || code.includes('401')) return contractErrorText('contractErrorLoginRequired', t);
    if (
      code.includes('CONTRACT_SYMBOL_NOT_ENABLED') ||
      code.includes('CONTRACT_SYMBOL_NOT_FOUND') ||
      normalized.includes('contract symbol not found') ||
      normalized.includes('symbol not found')
    ) {
      return contractErrorText('contractErrorUnavailable', t);
    }
    if (
      code.includes('CONTRACT_QUOTE_UNAVAILABLE') ||
      code.includes('ITICK_QUOTE_UNAVAILABLE') ||
      normalized.includes('quote unavailable') ||
      normalized.includes('price unavailable')
    ) {
      return contractErrorText('contractErrorPriceChanged', t);
    }
    if (code.includes('CONTRACT_QUOTE_NOT_LIVE')) return contractErrorText('contractErrorQuoteNotLive', t);
    if (normalized.includes('insufficient') || normalized.includes('balance') || normalized.includes('margin') || message.includes('\u4e0d\u8db3')) {
      return contractErrorText('contractErrorInsufficientMargin', t);
    }
    if (code.includes('LEVERAGE_EXCEEDS_LIMIT')) return contractErrorText('contractErrorLeverageExceedsLimit', t);
    if (code.includes('QUANTITY_BELOW_MIN')) return contractErrorText('contractErrorQuantityBelowMin', t);
    if (code.includes('QUANTITY_ABOVE_MAX')) return contractErrorText('contractErrorQuantityAboveMax', t);
    if (code.includes('PRICE_MUST_BE_POSITIVE') || code.includes('INVALID_PRICE')) return contractErrorText('contractErrorInvalidPrice', t);
    if (code.includes('QUANTITY_MUST_BE_POSITIVE') || code.includes('INVALID_QUANTITY')) return contractErrorText('contractErrorInvalidQuantity', t);
    if (code.includes('VALIDATION_ERROR')) return contractErrorText('contractErrorInvalidPayload', t);
    if (code.includes('INVALID_REFERENCE_PRICE')) return contractErrorText('contractErrorInvalidReferencePrice', t);
    if (code.includes('TAKE_PROFIT_MUST_BE_ABOVE_ENTRY')) return contractErrorText('contractErrorTakeProfitAboveEntry', t);
    if (code.includes('STOP_LOSS_MUST_BE_BELOW_ENTRY')) return contractErrorText('contractErrorStopLossBelowEntry', t);
    if (code.includes('TAKE_PROFIT_MUST_BE_BELOW_ENTRY')) return contractErrorText('contractErrorTakeProfitBelowEntry', t);
    if (code.includes('STOP_LOSS_MUST_BE_ABOVE_ENTRY')) return contractErrorText('contractErrorStopLossAboveEntry', t);
    if (code.includes('POSITION_HAS_OPEN_CLOSE_ORDER')) return contractErrorText('contractErrorPositionHasOpenCloseOrder', t);
    if (code.includes('POSITION_NOT_FOUND') || normalized.includes('position not found')) return contractErrorText('contractErrorNoClosablePosition', t);
    if (code.includes('POSITION_NOT_OPEN')) return contractErrorText('contractErrorNoClosablePosition', t);
    if (code.includes('CLOSE_QUANTITY_EXCEEDS_POSITION')) return contractErrorText('contractErrorCloseQuantityExceedsPosition', t);
    if (code.includes('POSITION_QUANTITY_NOT_ENOUGH')) return contractErrorText('contractErrorPositionQuantityNotEnough', t);
    if (code.includes('ORDER_NOT_FOUND') || normalized.includes('order not found')) return contractErrorText('contractErrorOrderNotFound', t);
    if (
      code.includes('ORDER_CANNOT_CANCEL') ||
      code.includes('CONTRACT_ORDER_CANNOT_CANCEL') ||
      code.includes('ORDER_NOT_CANCELABLE') ||
      normalized.includes('order not cancelable')
    ) {
      return contractErrorText('contractErrorOrderNotCancelable', t);
    }
    if (normalized.includes('network') || normalized.includes('fetch failed') || normalized.includes('timeout')) {
      return contractErrorText('contractErrorNetwork', t);
    }
    return contractErrorText('contractErrorFallback', t);
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('network') || message.includes('fetch failed') || message.includes('timeout')) {
      return contractErrorText('contractErrorNetwork', t);
    }
  }

  return contractErrorText('contractErrorFallback', t);
}
