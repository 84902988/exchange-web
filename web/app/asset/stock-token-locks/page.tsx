"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import AssetSidebar from "@/components/asset/AssetSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  convertStockToken,
  getStockTokenConverts,
  getStockTokenLocks,
  type StockTokenLockItem,
} from "@/lib/api/modules/stockToken";
import { fallbackSiteConfig, getSiteConfig, type SiteConfig } from "@/lib/api/modules/site";

type AssetTranslator = (key: string, namespace?: "asset") => string;

function formatMessage(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function normalizeAmount(value: string) {
  return value.trim();
}

function parseDecimalParts(value: string): { sign: 1 | -1; intPart: string; fracPart: string } | null {
  const text = normalizeAmount(value);
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    sign: match[1] === "-" ? -1 : 1,
    intPart: match[2].replace(/^0+(?=\d)/, "") || "0",
    fracPart: match[3] ?? "",
  };
}

function comparePositiveDecimal(a: string, b: string) {
  const left = parseDecimalParts(a);
  const right = parseDecimalParts(b);
  if (!left || !right) return Number.NaN;
  if (left.sign !== right.sign) return left.sign > right.sign ? 1 : -1;
  if (left.intPart.length !== right.intPart.length) {
    return left.intPart.length > right.intPart.length ? left.sign : -left.sign;
  }
  if (left.intPart !== right.intPart) {
    return left.intPart > right.intPart ? left.sign : -left.sign;
  }
  const scale = Math.max(left.fracPart.length, right.fracPart.length);
  const leftFrac = left.fracPart.padEnd(scale, "0");
  const rightFrac = right.fracPart.padEnd(scale, "0");
  if (leftFrac === rightFrac) return 0;
  return leftFrac > rightFrac ? left.sign : -left.sign;
}

function isPositiveAmount(value: string) {
  return comparePositiveDecimal(value, "0") > 0;
}

function formatDateOnly(value: string | null) {
  if (!value) return "--";
  return value.replace("T", " ").slice(0, 10);
}

function formatAmount(value: string | number | null | undefined, maxDecimals = 8, minDecimals = 0) {
  const text = String(value ?? "").trim();
  if (!text) return minDecimals > 0 ? `0.${"0".repeat(minDecimals)}` : "0";
  const parsed = parseDecimalParts(text);
  if (!parsed) return text;
  const intPart = parsed.intPart.replace(/^0+(?=\d)/, "") || "0";
  const fracPart = parsed.fracPart.slice(0, maxDecimals).replace(/0+$/, "");
  const sign = parsed.sign < 0 && (intPart !== "0" || fracPart) ? "-" : "";
  const displayFrac = fracPart.length >= minDecimals ? fracPart : fracPart.padEnd(minDecimals, "0");
  if (!displayFrac) return `${sign}${intPart}`;
  return `${sign}${intPart}.${displayFrac}`;
}

function formatDisplayAmount(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "0";
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return text;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: false,
  }).format(numeric);
}

function toNumber(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value: number) {
  const percent = Math.min(Math.max(value, 0), 100);
  return `${percent.toFixed(2).replace(/\.?0+$/, "")}%`;
}

function formatDailyReleaseRate(value: string) {
  const rate = toNumber(value);
  const percent = rate > 1 ? rate : rate * 100;
  return formatPercent(percent);
}

function releasedPercent(item: StockTokenLockItem) {
  const status = normalizeStatus(item.status);
  if (status === "RELEASED" || status === "CONVERTED") return 100;
  if (!item.release_started) return 0;
  if (item.progress_percent) return toNumber(item.progress_percent);
  const total = toNumber(item.total_amount);
  if (total <= 0) return 0;
  return ((toNumber(item.available_amount) + toNumber(item.converted_amount)) / total) * 100;
}

function hasAvailableAmount(item: StockTokenLockItem) {
  return normalizeStatus(item.status) !== "CONVERTED" && comparePositiveDecimal(item.available_amount, "0") > 0;
}

function normalizeStatus(status: string) {
  return String(status || "").trim().toUpperCase();
}

function statusLabel(status: string, t: AssetTranslator) {
  const normalized = normalizeStatus(status);
  if (normalized === "RELEASED") return t("released", "asset");
  if (normalized === "CONVERTED") return t("converted", "asset");
  if (normalized === "LOCKED") return t("locked", "asset");
  if (normalized === "RELEASING") return t("releasing", "asset");
  return status || "--";
}

function statusBadgeClass(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "RELEASED") return "border-emerald-400/20 bg-emerald-400/10 text-emerald-300";
  if (normalized === "CONVERTED") return "border-white/15 bg-white/10 text-white/60";
  if (normalized === "LOCKED") return "border-sky-300/20 bg-sky-300/10 text-sky-200";
  if (normalized === "RELEASING") return "border-amber-300/20 bg-amber-300/10 text-amber-200";
  return "border-white/10 bg-white/5 text-white/55";
}

function toScaledIntegerString(value: string, scale = 18) {
  const parsed = parseDecimalParts(value || "0");
  if (!parsed || parsed.sign < 0) return "0";
  const frac = parsed.fracPart.slice(0, scale).padEnd(scale, "0");
  return `${parsed.intPart}${frac}`.replace(/^0+/, "") || "0";
}

function multiplyIntegerStrings(left: string, right: string) {
  if (left === "0" || right === "0") return "0";
  const result = Array.from({ length: left.length + right.length }, () => 0);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const sum = result[i + j + 1] + Number(left[i]) * Number(right[j]);
      result[i + j + 1] = sum % 10;
      result[i + j] += Math.floor(sum / 10);
    }
  }
  return result.join("").replace(/^0+/, "") || "0";
}

function divideIntegerByPowerOfTen(value: string, scale: number) {
  if (value.length <= scale) return "0";
  return value.slice(0, -scale).replace(/^0+/, "") || "0";
}

function formatScaledInteger(value: string, scale = 18) {
  const padded = value.padStart(scale + 1, "0");
  const intPart = padded.slice(0, -scale).replace(/^0+/, "") || "0";
  const fracPart = padded.slice(-scale).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function multiplyDecimalStrings(amount: string, rate: string) {
  const scale = 18;
  const product = multiplyIntegerStrings(toScaledIntegerString(amount, scale), toScaledIntegerString(rate, scale));
  return formatScaledInteger(divideIntegerByPowerOfTen(product, scale), scale);
}

function noticeLines(content?: string | null) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+[.)\s]*/, ""));
}

function StatusBadge({ status, t }: { status: string; t: AssetTranslator }) {
  return (
    <span className={`rounded-full border px-2.5 py-1 text-xs ${statusBadgeClass(status)}`}>
      {statusLabel(status, t)}
    </span>
  );
}

function StockLockMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
      <div className="text-xs text-white/40">{label}</div>
      <div className="mt-1 truncate font-mono text-sm font-semibold text-white" title={value}>
        {value}
      </div>
    </div>
  );
}

export default function StockTokenLocksPage() {
  const { locale: currentLanguage, t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [items, setItems] = useState<StockTokenLockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [selectedLock, setSelectedLock] = useState<StockTokenLockItem | null>(null);
  const [modalError, setModalError] = useState("");
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(fallbackSiteConfig);

  const rowsWithAvailable = useMemo(
    () => items.filter((item) => hasAvailableAmount(item)).length,
    [items],
  );

  const loadData = useCallback(async (aliveRef?: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const data = await getStockTokenLocks();
      if (aliveRef && !aliveRef.alive) return;
      setItems(data.items);
    } catch (err) {
      if (aliveRef && !aliveRef.alive) return;
      console.error("Failed to load stock token locks:", err);
      setError(t("stockTokenLocksLoadFailed", "asset"));
    } finally {
      if (!aliveRef || aliveRef.alive) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    loadData(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadData]);

  useEffect(() => {
    let alive = true;
    getSiteConfig(currentLanguage)
      .then((config) => {
        if (alive) {
          setSiteConfig({ ...fallbackSiteConfig, ...config });
        }
      })
      .catch((err) => {
        console.warn("Failed to load site config:", err);
      });
    return () => {
      alive = false;
    };
  }, [currentLanguage]);

  const openConvertModal = (item: StockTokenLockItem) => {
    setSuccessMessage("");
    setModalError("");
    setSelectedLock(item);
  };

  const closeConvertModal = () => {
    if (modalSubmitting) return;
    setSelectedLock(null);
    setModalError("");
  };

  const submitConvert = async () => {
    if (!selectedLock) return;
    const amount = normalizeAmount(selectedLock.available_amount);
    setSuccessMessage("");
    setModalError("");

    if (!isPositiveAmount(amount)) {
      setModalError(t("noConvertibleAmount", "asset"));
      return;
    }

    setModalSubmitting(true);
    try {
      const result = await convertStockToken(selectedLock.id, amount);
      setSelectedLock(null);
      setSuccessMessage(formatMessage(t("convertSuccess", "asset"), { symbol: result.to_symbol }));
      await Promise.all([
        loadData(),
        getStockTokenConverts().catch((err) => {
          console.warn("Failed to refresh stock token convert history:", err);
          return null;
        }),
      ]);
    } catch (err) {
      console.error("Failed to convert stock token:", err);
      setModalError(t("convertFailed", "asset"));
    } finally {
      setModalSubmitting(false);
    }
  };

  const selectedTradeSymbol = selectedLock?.trade_symbol || t("targetToken", "asset");
  const selectedExpectedAmount = selectedLock
    ? multiplyDecimalStrings(selectedLock.available_amount, selectedLock.conversion_rate_snapshot)
    : "0";
  const stockTokenNoticeLines = noticeLines(siteConfig.stock_token_locks_notice_content);
  const stockTokenNoticeTitle =
    String(siteConfig.stock_token_locks_notice_title || "").trim() || t("stockTokenLocksNoticeTitle", "asset");

  return (
    <main className="flex min-h-screen bg-[#0a0a0d] py-8 text-white">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="w-full px-4 py-10 lg:w-4/5">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-sm font-medium text-amber-300">{t("stockTokenLocksEyebrow", "asset")}</div>
              <h1 className="mt-2 text-3xl font-bold">{t("stockTokenLocksTitle", "asset")}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
                {t("stockTokenLocksDesc", "asset")}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/60">
                {formatMessage(t("convertibleBatches", "asset"), { count: rowsWithAvailable })}
              </div>
              <Link
                href="/asset/stock-token-converts"
                className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/70 hover:bg-white/[0.06]"
              >
                {t("convertHistory", "asset")}
              </Link>
            </div>
          </div>

          {successMessage ? (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-5 py-4 text-sm text-emerald-200">
              {successMessage}
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center text-white/60">
              {t("loadingStockTokenLocks", "asset")}
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-400/20 bg-red-400/10 px-6 py-12 text-center">
              <div className="text-base font-semibold text-red-200">{error}</div>
              <button
                type="button"
                onClick={() => loadData()}
                className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                {t("reload", "asset")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center">
              <div className="text-base font-medium">{t("noStockTokenLocks", "asset")}</div>
            </div>
          ) : (
            <div className="space-y-4">
              {items.map((item) => {
                const canConvert = hasAvailableAmount(item);
                const status = normalizeStatus(item.status);
                const releaseStarted = Boolean(item.release_started) || status === "RELEASED" || status === "CONVERTED";
                const progress = releasedPercent(item);
                const tradeSymbol = item.trade_symbol || t("targetToken", "asset");

                return (
                  <article
                    key={item.id}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]"
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="rounded-xl border border-amber-300/15 bg-amber-300/10 px-3 py-2">
                            <div className="text-xs text-amber-100/60">{t("equityCertificate", "asset")}</div>
                            <div className="mt-1 font-semibold text-amber-100">{item.lock_symbol}</div>
                          </div>
                          <div className="rounded-xl border border-sky-300/15 bg-sky-300/10 px-3 py-2">
                            <div className="text-xs text-sky-100/60">{t("tradeToken", "asset")}</div>
                            <div className="mt-1 font-semibold text-sky-100">{item.trade_symbol ?? "--"}</div>
                          </div>
                          <StatusBadge status={item.status} t={t} />
                        </div>
                      </div>

                      <div className="w-full xl:w-80">
                        {releaseStarted ? (
                          <>
                            <div className="flex items-center justify-between text-xs text-white/50">
                              <span>{t("releaseProgress", "asset")}</span>
                              <span>{formatPercent(progress)}</span>
                            </div>
                            <div className="mt-2 h-2 rounded-full bg-white/10">
                              <div
                                className="h-2 rounded-full bg-emerald-400"
                                style={{ width: formatPercent(progress) }}
                              />
                            </div>
                          </>
                        ) : (
                          <div className={`rounded-xl border px-3 py-2 text-xs ${statusBadgeClass(item.status)}`}>
                            {statusLabel(item.status, t)}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <StockLockMetric label={t("totalAmount", "asset")} value={formatAmount(item.total_amount)} />
                      <StockLockMetric label={t("lockedAmount", "asset")} value={formatAmount(item.locked_amount)} />
                      <StockLockMetric label={t("convertibleAmount", "asset")} value={formatAmount(item.available_amount)} />
                      <StockLockMetric label={t("convertedAmount", "asset")} value={formatAmount(item.converted_amount)} />
                    </div>

                    <div className="mt-5 flex flex-col gap-4 border-t border-white/10 pt-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="grid gap-2 text-sm text-white/55 md:grid-cols-2 lg:flex-1">
                        <div>
                          <span className="text-white/40">{t("timeRule", "asset")}</span>
                          <span className="text-white/75">
                            {formatMessage(t("afterDaysDailyRelease", "asset"), {
                              days: item.lock_days,
                              rate: formatDailyReleaseRate(item.daily_release_rate),
                            })}
                          </span>
                        </div>
                        <div>
                          <span className="text-white/40">{t("lockTime", "asset")}</span>
                          <span className="text-white/75">
                            {formatDateOnly(item.lock_start_at)} - {formatDateOnly(item.lock_end_at)}
                          </span>
                        </div>
                        <div>
                          <span className="text-white/40">{t("releaseFinishTime", "asset")}</span>
                          <span className="text-white/75">
                            {formatDateOnly(item.release_start_at)} - {formatDateOnly(item.release_finish_at)}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
                        {canConvert ? (
                          <>
                            <div className="text-xs leading-5 text-white/55">
                              {formatMessage(t("convertibleTokenAmount", "asset"), {
                                symbol: tradeSymbol,
                                amount: formatAmount(item.available_amount),
                              })}
                            </div>
                            <button
                              type="button"
                              onClick={() => openConvertModal(item)}
                              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-300"
                            >
                              {formatMessage(t("convertToken", "asset"), { symbol: tradeSymbol })}
                            </button>
                          </>
                        ) : (
                          <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/45">
                            {t("noConvertibleAmount", "asset")}
                          </span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {stockTokenNoticeLines.length > 0 ? (
            <section className="rounded-2xl border border-amber-300/15 bg-white/[0.03] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <h2 className="text-lg font-semibold text-amber-200">{stockTokenNoticeTitle}</h2>
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-7 text-white/65">
                {stockTokenNoticeLines.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      </div>

      {selectedLock ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="mt-2 text-2xl font-semibold text-white">
                  {formatMessage(t("convertModalTitle", "asset"), { symbol: selectedTradeSymbol })}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeConvertModal}
                disabled={modalSubmitting}
                className="rounded-full border border-white/10 px-3 py-1 text-sm text-white/60 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("close", "asset")}
              </button>
            </div>

            <div className="mt-5 space-y-3 rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
              <div className="flex justify-between gap-4">
                <span className="text-white/45">{t("convertibleEquity", "asset")}</span>
                <span className="font-medium text-white">
                  {formatDisplayAmount(selectedLock.available_amount)} {selectedLock.lock_symbol}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-white/45">{t("conversionRate", "asset")}</span>
                <span className="font-medium text-white">
                  1 : {formatDisplayAmount(selectedLock.conversion_rate_snapshot)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-white/45">{t("estimatedArrival", "asset")}</span>
                <span className="font-semibold text-amber-200">
                  {formatDisplayAmount(selectedExpectedAmount)} {selectedTradeSymbol}
                </span>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-amber-300/15 bg-amber-300/10 px-4 py-3 text-sm leading-relaxed text-amber-100/85">
              {formatMessage(t("convertNotice", "asset"), { symbol: selectedTradeSymbol })}
            </div>

            {modalError ? (
              <div className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {modalError}
              </div>
            ) : null}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeConvertModal}
                disabled={modalSubmitting}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/75 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("cancel", "asset")}
              </button>
              <button
                type="button"
                onClick={submitConvert}
                disabled={modalSubmitting}
                className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {modalSubmitting ? t("convertSubmitting", "asset") : t("confirmConvert", "asset")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
