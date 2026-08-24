const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:\d{1,48}(?:\.\d{0,36})?|\.\d{1,36})$/;

type ParsedDecimal = {
  digits: bigint;
  scale: number;
};

export function normalizeNonNegativeDecimalText(value: unknown) {
  const parsed = parseNonNegativeDecimal(value);
  return parsed ? formatScaledDecimal(parsed.digits, parsed.scale) : null;
}

export function isPositiveDecimalText(value: unknown) {
  const parsed = parseNonNegativeDecimal(value);
  return Boolean(parsed && parsed.digits > 0n);
}

export function compareNonNegativeDecimalText(left: unknown, right: unknown) {
  const first = parseNonNegativeDecimal(left);
  const second = parseNonNegativeDecimal(right);
  if (!first || !second) return null;
  const scale = Math.max(first.scale, second.scale);
  const firstDigits = first.digits * 10n ** BigInt(scale - first.scale);
  const secondDigits = second.digits * 10n ** BigInt(scale - second.scale);
  return firstDigits === secondDigits ? 0 : firstDigits > secondDigits ? 1 : -1;
}

export function multiplyDecimalTextByPercent(value: unknown, percent: number) {
  const parsed = parseNonNegativeDecimal(value);
  if (
    !parsed ||
    !Number.isSafeInteger(percent) ||
    percent < 0 ||
    percent > 100
  ) {
    return null;
  }
  return formatScaledDecimal(parsed.digits * BigInt(percent), parsed.scale + 2);
}

function parseNonNegativeDecimal(value: unknown): ParsedDecimal | null {
  const raw = String(value ?? '').trim();
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(raw)) return null;
  const [wholeRaw = '0', fractionRaw = ''] = raw.split('.');
  const whole = (wholeRaw || '0').replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  return {
    digits: BigInt(`${whole}${fraction}` || '0'),
    scale: fraction.length,
  };
}

function formatScaledDecimal(digits: bigint, scale: number) {
  const raw = digits.toString().padStart(scale + 1, '0');
  if (scale === 0) return raw;
  const whole = raw.slice(0, -scale) || '0';
  const fraction = raw.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
