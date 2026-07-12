"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import BdApplyCard from "@/components/user/bd/BdApplyCard";
import BdHero from "@/components/user/bd/BdHero";
import BdStatsCards from "@/components/user/bd/BdStatsCards";
import UserSidebar from "@/components/user/UserSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  createMyBdApplication,
  getMyBdApplication,
  getMyBdTeamOverview,
  type BdApplication,
  type MyBdTeamOverview,
} from "@/lib/api/modules/bd";
import { formatRatePercent } from "@/lib/utils/format";

type SettlementRow = {
  coin: "RCB" | "USDT";
  total: string;
  pending: string;
  paid: string;
};

function parseCoinTotals(value: string | null | undefined) {
  const result: Record<string, string> = {};
  const text = String(value || "").trim();
  if (!text || text === "0") return result;

  text.split("/").forEach((part) => {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length >= 2) {
      result[tokens[1].toUpperCase()] = tokens[0];
    }
  });
  return result;
}

function resolveAssetTotals(totals: Record<string, string> | null | undefined, fallback: string) {
  if (totals && typeof totals === "object") return totals;
  return parseCoinTotals(fallback);
}

function formatAmount(value: string | number | null | undefined): string {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function getAssetAmount(totals: Record<string, string>, symbol: string): string | undefined {
  return totals[symbol] ?? totals[symbol.toUpperCase()] ?? totals[symbol.toLowerCase()];
}

function resolveInviteSystemLabel(
  t: ReturnType<typeof useLocaleContext>["t"],
  sourceType?: string | null,
): string {
  const normalizedType = String(sourceType || "").trim().toUpperCase();

  if (normalizedType === "BD") {
    return t("bdChannel", "user");
  }
  if (normalizedType === "USER_INVITE") {
    return t("normalInvite", "user");
  }
  if (normalizedType === "NONE") {
    return "--";
  }

  return "--";
}

function resolveBdCommissionStatus(
  t: ReturnType<typeof useLocaleContext>["t"],
  status?: string | null,
): string {
  const normalizedStatus = String(status || "").trim().toUpperCase();
  const statusLabelKeys: Record<string, string> = {
    PENDING: "bdCommissionStatusPending",
    PROCESSING: "bdCommissionStatusProcessing",
    PAID: "bdCommissionStatusPaid",
    FAILED: "bdCommissionStatusFailed",
  };
  const labelKey = statusLabelKeys[normalizedStatus];
  return labelKey ? t(labelKey, "user") : "--";
}

function buildSettlementRows(data: MyBdTeamOverview): SettlementRow[] {
  const total = resolveAssetTotals(
    data.summary.total_commission_by_asset,
    data.summary.total_commission,
  );
  const pending = resolveAssetTotals(
    data.summary.pending_commission_by_asset,
    data.summary.pending_commission,
  );
  const paid = resolveAssetTotals(
    data.summary.paid_commission_by_asset,
    data.summary.paid_commission,
  );

  return (["RCB", "USDT"] as const).map((coin) => ({
    coin,
    total: formatAmount(getAssetAmount(total, coin)),
    pending: formatAmount(getAssetAmount(pending, coin)),
    paid: formatAmount(getAssetAmount(paid, coin)),
  }));
}

export default function BdTeamPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [data, setData] = useState<MyBdTeamOverview | null>(null);
  const [application, setApplication] = useState<BdApplication | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [applyLevel, setApplyLevel] = useState("BD1");
  const [depositCoinSymbol, setDepositCoinSymbol] = useState("USDT");
  const [depositAmount, setDepositAmount] = useState("1000");
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [siteBaseUrl, setSiteBaseUrl] = useState(process.env.NEXT_PUBLIC_SITE_URL || "");
  const [inviteCopied, setInviteCopied] = useState(false);
  const applyRef = useRef<HTMLDivElement | null>(null);

  const isBd = Boolean(data?.is_bd);
  const bdAccountStatus = String(data?.account?.status || "").trim().toUpperCase();
  const isBdDisabled = Boolean(data?.account && !isBd && bdAccountStatus && bdAccountStatus !== "ACTIVE");
  const inviteCode = (data?.account?.invite_code || "").trim();
  const settlementAssetSymbols = data?.summary.settlement_asset_symbols?.join(" / ") || "RCB / USDT";
  const inviteLink = useMemo(() => {
    if (!inviteCode) return "";
    const baseUrl = siteBaseUrl.replace(/\/+$/, "");
    if (!baseUrl) return "";
    return `${baseUrl}/register?invite_code=${encodeURIComponent(inviteCode)}&invite_type=bd`;
  }, [inviteCode, siteBaseUrl]);
  const benefitCards = useMemo(
    () => [
      {
        title: t("bdBenefitSettlementTitle", "user"),
        desc: t("bdBenefitSettlementDesc", "user"),
      },
      {
        title: t("bdBenefitAssetStatsTitle", "user"),
        desc: t("bdBenefitAssetStatsDesc", "user"),
      },
      {
        title: t("bdBenefitRecordPayoutTitle", "user"),
        desc: t("bdBenefitRecordPayoutDesc", "user"),
      },
    ],
    [t],
  );

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) {
      setSiteBaseUrl(window.location.origin);
    }
  }, []);

  const loadData = useCallback(
    async (aliveRef: { alive: boolean }) => {
      setLoading(true);
      setError("");
      try {
        const [overview, latestApplication] = await Promise.all([
          getMyBdTeamOverview(),
          getMyBdApplication(),
        ]);
        if (!aliveRef.alive) return;
        setData(overview);
        setApplication(latestApplication);
      } catch (err) {
        if (!aliveRef.alive) return;
        console.error("Failed to load BD team center:", err);
        setError(t("bdTeamLoadFailed", "user"));
      } finally {
        if (aliveRef.alive) setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    const aliveRef = { alive: true };
    loadData(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadData, reloadKey]);

  useEffect(() => {
    if (loading || isBd || isBdDisabled || typeof window === "undefined") return;
    if (window.location.search.includes("apply")) {
      window.setTimeout(() => {
        applyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    }
  }, [loading, isBd, isBdDisabled]);

  const scrollToApply = () => {
    applyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setInviteCopied(true);
    window.setTimeout(() => setInviteCopied(false), 1600);
  };

  const submitApplication = async () => {
    setSubmitMessage("");
    setSubmitError("");

    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setSubmitError(t("bdInvalidDepositAmount", "user"));
      return;
    }

    setSubmitting(true);
    try {
      const nextApplication = await createMyBdApplication({
        apply_level: applyLevel,
        deposit_coin_symbol: depositCoinSymbol,
        deposit_amount: depositAmount,
        remark,
      });
      setApplication(nextApplication);
      setSubmitMessage(t("bdApplicationSubmitted", "user"));
    } catch (err) {
      console.error("Failed to submit BD application:", err);
      setSubmitError(t("bdApplicationSubmitFailed", "user"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen bg-[#05070b] text-white">
      <UserSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="relative w-full overflow-hidden px-4 py-8 lg:w-4/5 lg:px-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(240,185,11,0.14),transparent_32%),radial-gradient(circle_at_15%_35%,rgba(34,211,238,0.08),transparent_28%)]" />
        <div className="relative mx-auto max-w-7xl space-y-6">
          <BdHero
            isBd={isBd}
            account={data?.account}
            inviteLink={inviteLink}
            copied={inviteCopied}
            onCopyInvite={copyInviteLink}
            onApplyClick={scrollToApply}
          />

          {inviteCopied ? (
            <div className="fixed right-6 top-6 z-50 rounded-2xl border border-emerald-400/25 bg-emerald-500/15 px-4 py-3 text-sm font-semibold text-emerald-100 shadow-2xl shadow-black/30 backdrop-blur">
              {t("inviteLinkCopied", "user")}
            </div>
          ) : null}

          <section id="bd-benefits" className="grid gap-4 md:grid-cols-3">
            {benefitCards.map((item) => (
              <div
                key={item.title}
                className="rounded-[1.4rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur transition hover:border-[#f0b90b]/30 hover:bg-white/[0.055]"
              >
                <div className="text-lg font-bold text-white">{item.title}</div>
                <p className="mt-3 text-sm leading-7 text-white/52">{item.desc}</p>
              </div>
            ))}
          </section>

          {loading ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.035] px-6 py-16 text-center text-white/60">
              {t("bdTeamLoading", "user")}
            </div>
          ) : error ? (
            <div className="rounded-[1.5rem] border border-red-400/20 bg-red-400/10 px-6 py-12 text-center">
              <div className="text-base font-semibold text-red-200">{error}</div>
              <button
                type="button"
                onClick={() => setReloadKey((value) => value + 1)}
                className="mt-4 rounded-xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
              >
                {t("reload", "asset")}
              </button>
            </div>
          ) : isBd && data ? (
            <div className="space-y-6">
              <section className="grid gap-4 md:grid-cols-4">
                <div className="rounded-[1.35rem] border border-[#f0b90b]/20 bg-[#f0b90b]/10 p-5">
                  <div className="text-sm text-[#f0b90b]">{t("myBdLevel", "user")}</div>
                  <div className="mt-3 text-[24px] font-semibold tabular-nums text-white">
                    {data.account?.bd_level || "--"}
                  </div>
                </div>
                <div className="rounded-[1.35rem] border border-white/10 bg-[#0d1118] p-5">
                  <div className="text-sm text-white/45">{t("currentInviteSystem", "user")}</div>
                  <div className="mt-3 text-[24px] font-semibold tabular-nums text-white">
                    {resolveInviteSystemLabel(t, data.summary.source_type)}
                  </div>
                </div>
                <div className="rounded-[1.35rem] border border-white/10 bg-[#0d1118] p-5">
                  <div className="text-sm text-white/45">{t("bdCommissionRate", "user")}</div>
                  <div className="mt-3 text-[24px] font-semibold tabular-nums text-white">
                    {formatRatePercent(data.account?.commission_rate)}
                  </div>
                </div>
                <div className="rounded-[1.35rem] border border-white/10 bg-[#0d1118] p-5">
                  <div className="text-sm text-white/45">{t("latestBdCommissionTime", "user")}</div>
                  <div className="mt-3 text-[14px] font-medium tabular-nums text-white">
                    {data.summary.latest_commission_at || "--"}
                  </div>
                </div>
              </section>

              <BdStatsCards data={data} />

              <section className="rounded-[1.5rem] border border-white/10 bg-[#0d1118] p-5">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-white">{t("bdCommissionPayoutData", "user")}</h2>
                    <p className="mt-1 text-sm leading-6 text-white/45">
                      {t("bdCommissionPayoutDataDesc", "user")}
                    </p>
                  </div>
                  <div className="rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-4 py-2 text-sm font-semibold text-[#f0b90b]">
                    {t("payoutByAsset", "user")} {settlementAssetSymbols}
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  {buildSettlementRows(data).map((item) => (
                    <div
                      key={item.coin}
                      className="rounded-[1.25rem] border border-[#BD3419]/45 bg-[#BD3419]/[0.08] p-5 shadow-[0_0_0_1px_rgba(189,52,25,0.08)]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-[#ffb199]">
                          {item.coin} {t("commission", "user")}
                        </div>
                        <div className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/55">
                          {t("recordAsset", "user")}
                        </div>
                      </div>
                      <div className="mt-5 grid gap-3 sm:grid-cols-3">
                        <div>
                          <div className="text-xs text-white/40">{t("totalCommission", "user")}</div>
                          <div className="mt-2 whitespace-nowrap text-[20px] font-semibold tabular-nums text-white">
                            {item.total} <span className="text-[13px] font-medium text-white/45">{item.coin}</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-white/40">{t("pendingCommission", "user")}</div>
                          <div className="mt-2 whitespace-nowrap text-[20px] font-semibold tabular-nums text-white">
                            {item.pending} <span className="text-[13px] font-medium text-white/45">{item.coin}</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-white/40">{t("paidCommission", "user")}</div>
                          <div className="mt-2 whitespace-nowrap text-[20px] font-semibold tabular-nums text-white">
                            {item.paid} <span className="text-[13px] font-medium text-white/45">{item.coin}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-[1.5rem] border border-white/10 bg-[#0d1118] p-5">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold text-white">{t("recentCommissionRecords", "user")}</h2>
                    <p className="mt-1 text-sm text-white/45">{t("recentCommissionRecordsDesc", "user")}</p>
                  </div>
                  <div className="text-[13px] font-medium tabular-nums text-white/45">{t("totalRecordsPrefix", "asset")} {data.total} {t("totalRecordsSuffix", "asset")}</div>
                </div>

                {data.records.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-left text-[13px]">
                      <thead className="text-[11px] uppercase tracking-[0.14em] text-white/35">
                        <tr className="border-b border-white/10">
                          <th className="py-3 pr-4 font-semibold">ID</th>
                          <th className="py-3 pr-4 font-semibold">{t("sourceUser", "user")}</th>
                          <th className="py-3 pr-4 font-semibold">{t("fee", "user")}</th>
                          <th className="py-3 pr-4 font-semibold">{t("commission", "user")}</th>
                          <th className="py-3 pr-4 font-semibold">{t("status", "user")}</th>
                          <th className="py-3 pr-4 font-semibold">{t("createdAt", "user")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {data.records.map((record) => {
                          const commissionAsset =
                            "commission_asset_symbol" in record &&
                            typeof record.commission_asset_symbol === "string"
                              ? record.commission_asset_symbol
                              : "RCB";
                          return (
                            <tr key={record.id} className="text-white/72">
                              <td className="py-3 pr-4 font-medium tabular-nums text-white/55">{record.id}</td>
                              <td className="py-3 pr-4 font-medium tabular-nums">{record.source_user_id}</td>
                              <td className="py-3 pr-4 font-medium tabular-nums">
                                {formatAmount(record.original_fee_amount)} {record.fee_coin_symbol}
                              </td>
                              <td className="py-3 pr-4 font-semibold tabular-nums text-white">
                                {formatAmount(record.commission_amount)} {commissionAsset}
                              </td>
                              <td className="py-3 pr-4">{resolveBdCommissionStatus(t, record.status)}</td>
                              <td className="py-3 pr-4 font-medium tabular-nums text-white/55">{record.created_at || "--"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-5 py-8 text-center text-white/45">
                    {t("noCommissionRecords", "user")}
                  </div>
                )}
              </section>
            </div>
          ) : isBdDisabled ? (
            <div className="rounded-[1.5rem] border border-amber-300/20 bg-amber-400/10 px-6 py-8">
              <div className="text-lg font-bold text-amber-100">{t("bdQualificationDisabled", "user")}</div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/75">
                {t("bdQualificationDisabledDesc", "user")}
              </p>
            </div>
          ) : (
            <div id="apply" ref={applyRef}>
              <BdApplyCard
                application={application}
                applyLevel={applyLevel}
                depositCoinSymbol={depositCoinSymbol}
                depositAmount={depositAmount}
                remark={remark}
                submitting={submitting}
                message={submitMessage}
                error={submitError}
                onApplyLevelChange={setApplyLevel}
                onDepositCoinSymbolChange={setDepositCoinSymbol}
                onDepositAmountChange={setDepositAmount}
                onRemarkChange={setRemark}
                onSubmit={submitApplication}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
