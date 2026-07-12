"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/lib/authContext";
import { useLocaleContext } from "@/contexts/LocaleContext";
import { getMyInviteOverview, type MyInviteOverview, type MyInviteRecentRecord } from "@/lib/api";

const INVITE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const DEFAULT_COMMISSION_PERCENT = "15";

function normalizePercent(value?: string | number | null): string {
  const numeric = Number(value ?? DEFAULT_COMMISSION_PERCENT);
  if (!Number.isFinite(numeric)) return DEFAULT_COMMISSION_PERCENT;
  const fixed = numeric % 1 === 0 ? numeric.toFixed(0) : numeric.toFixed(2);
  return fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

type UserTranslator = (key: string, namespace?: "user" | "common") => string;

function buildInviteStats(commissionPercent: string, t: UserTranslator) {
  return [
    { label: t("inviteDefaultCommission", "user"), value: `${commissionPercent}%` },
    { label: t("inviteRewardCoin", "user"), value: "RCB" },
    { label: t("inviteBindingTiming", "user"), value: t("inviteOnRegistration", "user") },
    { label: t("inviteRelationshipRule", "user"), value: t("inviteCannotChange", "user") },
  ];
}

function buildRuleCards(commissionPercent: string, t: UserTranslator) {
  return [
    {
      title: t("inviteRuleShareTitle", "user").replace("{percent}", commissionPercent),
      desc: t("inviteRuleShareDesc", "user").replace("{percent}", commissionPercent),
    },
    {
      title: t("inviteRuleRewardTitle", "user"),
      desc: t("inviteRuleRewardDesc", "user"),
    },
    {
      title: t("inviteRuleBindingTitle", "user"),
      desc: t("inviteRuleBindingDesc", "user"),
    },
  ];
}

function buildFlowSteps(t: UserTranslator) {
  return [
    t("inviteFlowOpenLink", "user"),
    t("inviteFlowFriendRegisters", "user"),
    t("inviteFlowBindOnRegister", "user"),
    t("inviteFlowGenerateReward", "user"),
  ];
}

function saveInviteCode(code: string) {
  const normalized = code.trim();
  if (!normalized) return;
  localStorage.setItem("invite_code", normalized);
  localStorage.setItem("invite_type", "user");
  document.cookie = `invite_code=${encodeURIComponent(normalized)}; path=/; max-age=${INVITE_COOKIE_MAX_AGE}; SameSite=Lax`;
  document.cookie = `invite_type=user; path=/; max-age=${INVITE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusText(status: string, t: UserTranslator) {
  const normalized = status.toUpperCase();
  if (normalized === "PENDING") return t("inviteStatusPending", "user");
  if (normalized === "PAID") return t("inviteStatusPaid", "user");
  if (normalized === "FAILED") return t("failed", "user");
  return status;
}

function statusClassName(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "PAID") return "border-green-400/30 bg-green-400/10 text-green-300";
  if (normalized === "FAILED") return "border-red-400/30 bg-red-400/10 text-red-300";
  return "border-amber-400/30 bg-amber-400/10 text-amber-300";
}

function inviteProgramLabel(
  sourceType: string | null | undefined,
  t: UserTranslator,
) {
  const normalized = String(sourceType || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (normalized === "BD") return t("bdChannel", "user");
  if (normalized === "USER_INVITE") return t("normalInvite", "user");
  if (normalized === "NONE") return "--";
  return "--";
}

function InviteLinkCard({
  inviteCode,
  commissionPercent,
  t,
}: {
  inviteCode?: string | null;
  commissionPercent: string;
  t: UserTranslator;
}) {
  const [copied, setCopied] = useState(false);

  const normalizedCode = (inviteCode || "").trim();
  const inviteLink =
    normalizedCode && typeof window !== "undefined"
      ? `${window.location.origin}/invite?code=${encodeURIComponent(normalizedCode)}`
      : "";

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-lg border border-white/10 bg-[#121217] p-6"
    >
      <h2 className="mb-6 text-xl font-bold text-white">{t("myInviteLink", "user")}</h2>
      {normalizedCode ? (
        <div className="flex flex-col gap-4">
          <input
            suppressHydrationWarning
            type="text"
            value={inviteLink || t("inviteLinkGenerating", "user")}
            readOnly
            className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-amber-500/50"
          />
          <button
            type="button"
            disabled={!inviteLink}
            onClick={copyInviteLink}
            className="w-full rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 px-6 py-3 font-medium text-white transition-colors hover:from-amber-600 hover:to-amber-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:self-start"
          >
            {copied ? t("copied", "user") : t("copyInviteLink", "user")}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          {t("inviteCodeGenerating", "user")}
        </div>
      )}
      <p className="mt-4 text-sm tabular-nums leading-6 text-gray-400">
        {t("inviteLinkDesc", "user").replace("{percent}", commissionPercent)}
      </p>
    </motion.div>
  );
}

function InviteOverviewPanel({
  overview,
  loading,
  error,
  t,
}: {
  overview: MyInviteOverview | null;
  loading: boolean;
  error: string;
  t: UserTranslator;
}) {
  const summary = overview?.summary;
  const records = overview?.recent_records || [];
  const cards = [
    {
      label: t("inviteCurrentSystem", "user"),
      value: inviteProgramLabel(summary?.source_type, t),
    },
    { label: t("inviteInvitedCount", "user"), value: String(summary?.invited_count ?? 0) },
    { label: t("inviteTotalRewardRcb", "user"), value: summary?.total_commission_rcb ?? "0.00000000" },
    { label: t("invitePendingRewardRcb", "user"), value: summary?.pending_commission_rcb ?? "0.00000000" },
    { label: t("invitePaidRewardRcb", "user"), value: summary?.paid_commission_rcb ?? "0.00000000" },
  ];

  return (
    <div className="space-y-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
        className="rounded-lg border border-white/10 bg-[#121217] p-6"
      >
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="text-xl font-bold text-white">{t("inviteStats", "user")}</h2>
          {loading ? <span className="text-sm text-gray-400">{t("loading", "common")}</span> : null}
        </div>
        {error ? (
          <div className="mb-5 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {cards.map((item) => (
            <div key={item.label} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="text-sm text-gray-400">{item.label}</div>
              <div className="mt-2 break-words text-[24px] font-semibold tabular-nums text-amber-400">{item.value}</div>
            </div>
          ))}
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="rounded-lg border border-white/10 bg-[#121217] p-6"
      >
        <h2 className="mb-6 text-xl font-bold text-white">{t("recentRewardRecords", "user")}</h2>
        {records.length ? (
          <div className="space-y-4">
            {records.map((record) => (
              <InviteRecordItem key={record.id} record={record} t={t} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-gray-400">
            {t("noInviteRewardRecords", "user")}
          </div>
        )}
      </motion.div>
    </div>
  );
}

function InviteRecordItem({ record, t }: { record: MyInviteRecentRecord; t: UserTranslator }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[12px] tabular-nums text-gray-400">{formatDateTime(record.created_at)}</div>
          <div className="mt-1 text-[13px] font-medium tabular-nums text-white">
            {t("inviteeUserId", "user")}: {record.invitee_user_id}
          </div>
        </div>
        <span className={`w-fit rounded-full border px-3 py-1 text-xs font-medium ${statusClassName(record.status)}`}>
          {statusText(record.status, t)}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
        <div>
          <div className="text-gray-500">{t("feeCoin", "user")}</div>
          <div className="mt-1 font-medium text-gray-200">{record.fee_coin_symbol}</div>
        </div>
        <div>
          <div className="text-gray-500">{t("feeAmount", "user")}</div>
          <div className="mt-1 font-medium tabular-nums text-gray-200">{record.fee_amount}</div>
        </div>
        <div>
          <div className="text-gray-500">{t("rewardRcb", "user")}</div>
          <div className="mt-1 font-semibold tabular-nums text-amber-300">{record.commission_rcb_amount}</div>
        </div>
      </div>
    </div>
  );
}

function InviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLocaleContext();
  const { user, isLoggedIn, loading } = useAuth();
  const [selectedTab, setSelectedTab] = useState("overview");
  const [overview, setOverview] = useState<MyInviteOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const code = useMemo(
    () => (searchParams.get("code") || searchParams.get("invite_code") || "").trim(),
    [searchParams],
  );

  useEffect(() => {
    if (code) saveInviteCode(code);
  }, [code]);

  useEffect(() => {
    if (loading || isLoggedIn || !code) return;
    router.replace(`/register?invite_code=${encodeURIComponent(code)}&invite_type=user`);
  }, [code, isLoggedIn, loading, router]);

  useEffect(() => {
    if (loading) return;

    let cancelled = false;

    const loadOverview = async () => {
      try {
        const data = await getMyInviteOverview();
        if (cancelled) return;
        setOverview(data);
        setOverviewError("");
      } catch {
        if (cancelled) return;
        setOverviewError(t("inviteStatsLoadFailed", "user"));
      } finally {
        if (!cancelled) setOverviewLoading(false);
      }
    };

    void loadOverview();

    return () => {
      cancelled = true;
    };
  }, [loading, isLoggedIn, t]);

  const commissionPercent = normalizePercent(overview?.commission_percent ?? overview?.summary?.commission_percent);
  const inviteStats = useMemo(() => buildInviteStats(commissionPercent, t), [commissionPercent, t]);
  const ruleCards = useMemo(() => buildRuleCards(commissionPercent, t), [commissionPercent, t]);
  const flowSteps = useMemo(() => buildFlowSteps(t), [t]);
  const inviteCode = overview?.invite_code ?? user?.invite_code ?? "";

  const goRegister = () => {
    router.push(code ? `/register?invite_code=${encodeURIComponent(code)}&invite_type=user` : "/register");
  };

  const goLogin = () => {
    const redirect = code ? `/invite?code=${encodeURIComponent(code)}` : "/invite";
    router.push(`/login?redirect=${encodeURIComponent(redirect)}`);
  };

  return (
    <main className="min-h-screen bg-[#0b0b0f] text-white">
      <motion.section
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="border-b border-white/10 bg-gradient-to-r from-amber-600/20 via-transparent to-amber-600/20"
      >
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-8 px-4 py-12 sm:px-6 lg:flex-row lg:px-8">
          <div>
            <h1 className="mb-3 text-3xl font-bold text-white md:text-4xl">{t("inviteHeroTitle", "user")}</h1>
            <p className="mb-6 text-xl tabular-nums text-gray-300">
              {t("inviteHeroDesc", "user").replace("{percent}", commissionPercent)}
            </p>
            <div className="flex flex-wrap gap-6">
              <div>
                <span className="mb-1 block text-sm text-gray-400">{t("inviteApplicableUsers", "user")}</span>
                <span className="font-semibold text-white">{t("regularUser", "user")}</span>
              </div>
              <div>
                <span className="mb-1 block text-sm text-gray-400">{t("inviteBindingMethod", "user")}</span>
                <span className="font-semibold text-white">{t("inviteAutoBindOnRegister", "user")}</span>
              </div>
              <div>
                <span className="mb-1 block text-sm text-gray-400">{t("inviteActivityStatus", "user")}</span>
                <span className="inline-block rounded-full bg-green-500/20 px-3 py-1 text-sm font-medium text-green-400">
                  {t("inviteActivityOngoing", "user")}
                </span>
              </div>
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, delay: 0.15 }}
            className="rounded-lg border border-white/10 bg-[#121217] p-6 text-center"
          >
            <div className="mb-2 text-[30px] font-bold tabular-nums text-amber-400">{commissionPercent}%</div>
            <span className="text-sm text-gray-400">{t("inviteDefaultFeeShare", "user")}</span>
          </motion.div>
        </div>
      </motion.section>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 border-b border-white/10">
          <div className="flex gap-8 overflow-x-auto">
            {[
              { id: "overview", label: t("inviteOverview", "user") },
              { id: "rules", label: t("activityRules", "user") },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedTab(tab.id)}
                className={`border-b-2 px-1 py-4 font-medium transition-colors ${
                  selectedTab === tab.id
                    ? "border-amber-400 text-amber-400"
                    : "border-transparent text-gray-400 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            {selectedTab === "overview" ? (
              <>
                {loading ? (
                  <div className="rounded-lg border border-white/10 bg-[#121217] px-6 py-12 text-center text-gray-400">
                    {t("inviteInfoLoading", "user")}
                  </div>
                ) : isLoggedIn ? (
                  <>
                    <InviteLinkCard inviteCode={inviteCode} commissionPercent={commissionPercent} t={t} />
                    <InviteOverviewPanel overview={overview} loading={overviewLoading} error={overviewError} t={t} />
                  </>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                    className="rounded-lg border border-white/10 bg-[#121217] p-6"
                  >
                    <h2 className="mb-3 text-xl font-bold text-white">{t("inviteFriendsToRegister", "user")}</h2>
                    <p className="mb-6 text-sm leading-7 text-gray-400">
                      {t("inviteGuestDesc", "user")}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={goRegister}
                        className="rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 px-6 py-3 font-medium text-white transition-colors hover:from-amber-600 hover:to-amber-700"
                      >
                        {t("registerNow", "user")}
                      </button>
                      <button
                        type="button"
                        onClick={goLogin}
                        className="rounded-lg border border-white/10 bg-white/5 px-6 py-3 font-medium text-white transition-colors hover:bg-white/10"
                      >
                        {t("alreadyHaveAccountLogin", "user")}
                      </button>
                    </div>
                  </motion.div>
                )}

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.1 }}
                  className="rounded-lg border border-white/10 bg-[#121217] p-6"
                >
                  <h2 className="mb-6 text-xl font-bold text-white">{t("inviteRuleIntro", "user")}</h2>
                  <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
                    {inviteStats.map((item, index) => (
                      <motion.div
                        key={item.label}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: 0.05 * index }}
                        className="text-center"
                      >
                        <div className="mb-2 text-[20px] font-semibold tabular-nums text-amber-400">{item.value}</div>
                        <span className="text-sm text-gray-400">{item.label}</span>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              </>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className="rounded-lg border border-white/10 bg-[#121217] p-6"
              >
                <h2 className="mb-6 text-xl font-bold text-white">{t("activityRules", "user")}</h2>
                <div className="space-y-4">
                  {ruleCards.map((rule, index) => (
                    <motion.div
                      key={rule.title}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.3, delay: 0.08 * index }}
                      className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
                    >
                      <div className="mb-2 flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-600/20 font-bold text-amber-400">
                          {index + 1}
                        </div>
                        <div className="font-medium text-white">{rule.title}</div>
                      </div>
                      <p className="pl-11 text-sm leading-6 text-gray-400">{rule.desc}</p>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </div>

          <div className="space-y-8">
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.45 }}
              className="rounded-lg border border-white/10 bg-[#121217] p-6"
            >
              <h2 className="mb-6 text-xl font-bold text-white">{t("inviteFlowTitle", "user")}</h2>
              <div className="space-y-4">
                {flowSteps.map((item, index) => (
                  <div key={item} className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-600/20 text-sm font-bold text-amber-400">
                      {index + 1}
                    </div>
                    <div className="text-sm text-gray-300">{item}</div>
                  </div>
                ))}
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.45, delay: 0.12 }}
              className="rounded-lg border border-amber-600/30 bg-amber-600/10 p-6"
            >
              <h2 className="mb-4 text-xl font-bold text-amber-400">{t("inviteTips", "user")}</h2>
              <ul className="list-disc space-y-3 pl-5 text-sm leading-6 text-gray-300">
                <li>{t("inviteTipCodeLink", "user")}</li>
                <li>{t("inviteTipLoggedIn", "user")}</li>
                <li>{t("inviteTipRcbRecord", "user")}</li>
                <li>{t("inviteTipActualRecord", "user")}</li>
              </ul>
            </motion.div>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#0b0b0f] p-8 text-white">Loading...</main>}>
      <InviteContent />
    </Suspense>
  );
}
