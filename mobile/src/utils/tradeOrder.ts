import {ApiClientError} from '../api/client';

export type ParsedPositiveDecimal = {
  text: string;
  value: number;
  decimalPlaces: number;
};

export function parsePositiveDecimal(value: string): ParsedPositiveDecimal | null {
  const compact = String(value || '').replace(/,/g, '').trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(compact)) return null;

  const [rawWhole = '0', rawFraction = ''] = compact.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/, '') || '0';
  const fraction = rawFraction.replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : whole;
  const number = Number(text);

  if (!Number.isFinite(number) || number <= 0) return null;
  return {
    text,
    value: number,
    decimalPlaces: fraction.length,
  };
}

export function formatOrderDecimal(value: number, precision = 18) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const safePrecision = Math.max(0, Math.min(18, Math.floor(precision)));
  const fixed = value.toFixed(safePrecision);
  const [whole, fraction = ''] = fixed.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

export function getTradingErrorMessage(error: unknown, fallback: string) {
  const code =
    error instanceof ApiClientError
      ? error.code.toUpperCase()
      : '';
  const message = error instanceof Error ? error.message.trim() : '';
  const combined = `${code} ${message}`.toUpperCase();

  if (
    combined.includes('UNAUTHORIZED') ||
    combined.includes('MISSING ACCESS TOKEN') ||
    combined.includes('LOGIN EXPIRED')
  ) {
    return '登录状态已失效，请重新登录';
  }
  if (
    combined.includes('INSUFFICIENT_CONTRACT_MARGIN') ||
    combined.includes('INSUFFICIENT MARGIN')
  ) {
    return '可用保证金不足';
  }
  if (
    combined.includes('INSUFFICIENT BALANCE') ||
    combined.includes('BALANCE NOT ENOUGH') ||
    combined.includes('AVAILABLE NOT ENOUGH')
  ) {
    return '可用余额不足';
  }
  if (
    combined.includes('CONTRACT_QUOTE') ||
    combined.includes('EXECUTION_UNAVAILABLE') ||
    combined.includes('MARKET PRICE UNAVAILABLE')
  ) {
    return '当前行情不可执行，请刷新后重试';
  }
  if (combined.includes('POSITION_NOT_OPEN')) {
    return '当前方向没有可平持仓';
  }
  if (combined.includes('CLOSE_QUANTITY_EXCEEDS_POSITION')) {
    return '平仓数量超过当前可平数量';
  }
  if (combined.includes('QUANTITY_BELOW_MIN')) {
    return '下单数量低于该合约最小数量';
  }
  if (combined.includes('QUANTITY_ABOVE_MAX')) {
    return '下单数量超过该合约最大数量';
  }
  if (combined.includes('LEVERAGE_EXCEEDS_LIMIT')) {
    return '杠杆倍数超过该合约上限';
  }
  if (combined.includes('MIN_NOTIONAL') || combined.includes('MIN NOTIONAL')) {
    return '交易额低于该交易对的最小成交额';
  }
  if (combined.includes('MIN_AMOUNT') || combined.includes('MIN AMOUNT')) {
    return '下单数量低于该交易对的最小数量';
  }
  if (combined.includes('PRECISION')) {
    return '价格或数量精度不符合交易规则';
  }
  if (combined.includes('MARKET CLOSED')) {
    return '当前市场已休市';
  }

  return message && /[\u3400-\u9fff]/.test(message) ? message : fallback;
}
