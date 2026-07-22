export function formatFeeRate(value: string | null): string {
  if (value === null) return "--";

  const percent = Number(value) * 100;
  if (!Number.isFinite(percent)) return "--";

  return `${percent.toFixed(2)}%`;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

export function formatDiscountRate(value: string | null): string {
  if (value === null) return "--";

  const percent = Number(value) * 100;
  if (!Number.isFinite(percent)) return "--";

  return `-${trimTrailingZeros(percent.toFixed(2))}%`;
}

function parsePercent(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.min(Math.max(percent, 0), 100);
}

export function formatRcbDiscountPercent(value: string | number | null | undefined): string {
  const percent = parsePercent(value);
  if (percent === null) return "--";
  return `${trimTrailingZeros(percent.toFixed(2))}%`;
}

export function resolveRcbFeePayPercent(
  payPercent: string | number | null | undefined,
  discountPercent: string | number | null | undefined,
): number | null {
  const directPayPercent = parsePercent(payPercent);
  if (directPayPercent !== null) return directPayPercent;

  const legacyDiscountPercent = parsePercent(discountPercent);
  if (legacyDiscountPercent === null) return null;
  return 100 - legacyDiscountPercent;
}

export function formatRcbFeePayPercent(value: string | number | null | undefined): string {
  const percent = parsePercent(value);
  if (percent === null) return "--";
  return `${trimTrailingZeros(percent.toFixed(2))}%`;
}

export function formatRcbPayDiscountText(value: string | number | null | undefined): string {
  const discountPercent = parsePercent(value);
  if (discountPercent === null) return "--";
  const payPercent = 100 - discountPercent;
  return `${trimTrailingZeros((payPercent / 10).toFixed(2))} 折`;
}

export function formatLockPeriod(
  days: number | string | null | undefined,
  noneText: string,
  daysTemplate: string,
): string {
  const numericDays = Number(days);
  if (!Number.isFinite(numericDays) || numericDays <= 0) return noneText;
  return daysTemplate.replace("{days}", trimTrailingZeros(String(numericDays)));
}

function formatDecimalNumber(
  value: string | number | null | undefined,
  {
    minFractionDigits,
    maxFractionDigits,
    useGrouping,
  }: {
    minFractionDigits: number;
    maxFractionDigits: number;
    useGrouping: boolean;
  },
): string {
  if (value === null || value === undefined) return "--";

  const raw = String(value).trim();
  if (!raw) return "--";

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return "--";

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
    useGrouping,
  }).format(numeric);
}

export function formatAssetAmount(value: string | number | null | undefined): string {
  return formatDecimalNumber(value, {
    minFractionDigits: 2,
    maxFractionDigits: 8,
    useGrouping: false,
  });
}

export function formatVolume(value: string | number | null | undefined): string {
  return formatDecimalNumber(value, {
    minFractionDigits: 2,
    maxFractionDigits: 4,
    useGrouping: true,
  });
}

export function formatNumberLike(value: string | null): string {
  if (value === null) return "--";

  const raw = String(value).trim();
  if (!raw) return "--";

  const sign = raw.startsWith("-") ? "-" : "";
  const unsigned = sign ? raw.slice(1) : raw;
  const [integerPart = "0", decimalPart] = unsigned.split(".");
  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const normalizedDecimal = decimalPart ? decimalPart.replace(/0+$/, "") : "";

  return `${sign}${formattedInteger}${normalizedDecimal ? `.${normalizedDecimal}` : ""}`;
}

export function isCurrentLevel(levelCode: string, currentCode: string | null): boolean {
  return Boolean(currentCode) && levelCode === currentCode;
}
