"use client";

import { useLocaleContext } from "@/contexts/LocaleContext";

export function clsx(...arr: Array<string | false | undefined | null>) {
  return arr.filter(Boolean).join(" ");
}

export type WithdrawStatusKind =
  | "success"
  | "failed"
  | "reviewing"
  | "verifying"
  | "processing"
  | "canceled"
  | "unknown";

export type WithdrawStatusMeta = {
  canonical: string;
  kind: WithdrawStatusKind;
  badge: string;
  title: string;
  message: string;
  className: string;
  terminal: boolean;
};

export type WithdrawProgressStepState = "done" | "current" | "waiting" | "danger" | "stopped";

export type WithdrawProgressStep = {
  label: string;
  state: WithdrawProgressStepState;
};

export type WithdrawProgress = {
  canonical: string;
  caption: string;
  terminal: boolean;
  tone: "normal" | "success" | "danger" | "muted";
  steps: WithdrawProgressStep[];
};

export type AssetTranslator = (key: string, namespace?: "asset") => string;

const SUCCESS_WITHDRAW_STATUSES = new Set(["SUCCESS", "SUCCEEDED", "COMPLETED", "CONFIRMED"]);
const FAILED_WITHDRAW_STATUSES = new Set(["FAILED", "REJECTED", "CANCELED_BY_ADMIN"]);
const PROCESSING_WITHDRAW_STATUSES = new Set([
  "FROZEN",
  "SENT",
  "SENDING",
  "PENDING",
  "PROCESSING",
  "APPROVED",
  "BROADCASTING",
]);
const CANCELED_WITHDRAW_STATUSES = new Set(["CANCELED", "CANCELLED"]);
const WITHDRAW_PROGRESS_LABEL_KEYS = [
  "withdrawStepApply",
  "withdrawStepRiskReview",
  "withdrawStepOnChainSend",
  "withdrawStepNetworkConfirm",
  "withdrawStepCompleted",
];

function assetText(t: AssetTranslator | undefined, key: string) {
  return t?.(key, "asset") ?? key;
}

export function normalizeWithdrawStatus(status?: string | null) {
  const normalized = String(status || "").trim().toUpperCase();
  if (SUCCESS_WITHDRAW_STATUSES.has(normalized)) return "SUCCESS";
  if (FAILED_WITHDRAW_STATUSES.has(normalized)) {
    if (normalized === "REJECTED" || normalized === "CANCELED_BY_ADMIN") return normalized;
    return "FAILED";
  }
  if (CANCELED_WITHDRAW_STATUSES.has(normalized)) return "CANCELED";
  return normalized;
}

export function getWithdrawStatusMeta(
  status?: string | null,
  failureReason?: string | null,
  t?: AssetTranslator
): WithdrawStatusMeta {
  const canonical = normalizeWithdrawStatus(status);

  if (canonical === "SUCCESS") {
    return {
      canonical,
      kind: "success",
      badge: assetText(t, "withdrawStatusSuccessBadge"),
      title: assetText(t, "withdrawStatusSuccessTitle"),
      message: assetText(t, "withdrawStatusSuccessMessage"),
      className: "border-emerald-500/30 text-emerald-300 bg-emerald-500/10",
      terminal: true,
    };
  }

  if (canonical === "FAILED" || canonical === "REJECTED" || canonical === "CANCELED_BY_ADMIN") {
    const isRejected = canonical === "REJECTED" || canonical === "CANCELED_BY_ADMIN";
    return {
      canonical,
      kind: "failed",
      badge: assetText(t, isRejected ? "withdrawStatusRejectedBadge" : "withdrawStatusFailedBadge"),
      title: assetText(t, isRejected ? "withdrawStatusRejectedTitle" : "withdrawStatusFailedTitle"),
      message: failureReason || assetText(t, isRejected ? "withdrawStatusRejectedMessage" : "withdrawStatusFailedMessage"),
      className: "border-red-500/30 text-red-300 bg-red-500/10",
      terminal: true,
    };
  }

  if (canonical === "REVIEWING") {
    return {
      canonical,
      kind: "reviewing",
      badge: assetText(t, "withdrawStatusReviewingBadge"),
      title: assetText(t, "withdrawStatusReviewingTitle"),
      message: assetText(t, "withdrawStatusReviewingMessage"),
      className: "border-amber-500/30 text-amber-200 bg-amber-500/10",
      terminal: false,
    };
  }

  if (canonical === "VERIFYING") {
    return {
      canonical,
      kind: "verifying",
      badge: assetText(t, "withdrawStatusVerifyingBadge"),
      title: assetText(t, "withdrawStatusVerifyingTitle"),
      message: assetText(t, "withdrawStatusVerifyingMessage"),
      className: "border-sky-500/30 text-sky-200 bg-sky-500/10",
      terminal: false,
    };
  }

  if (PROCESSING_WITHDRAW_STATUSES.has(canonical)) {
    return {
      canonical,
      kind: "processing",
      badge: assetText(t, "withdrawStatusProcessingBadge"),
      title: assetText(t, "withdrawStatusProcessingTitle"),
      message: assetText(t, "withdrawStatusProcessingMessage"),
      className: "border-sky-500/30 text-sky-200 bg-sky-500/10",
      terminal: false,
    };
  }

  if (canonical === "CANCELED") {
    return {
      canonical,
      kind: "canceled",
      badge: assetText(t, "withdrawStatusCanceledBadge"),
      title: assetText(t, "withdrawStatusCanceledTitle"),
      message: assetText(t, "withdrawStatusCanceledMessage"),
      className: "border-white/15 text-white/60 bg-white/5",
      terminal: true,
    };
  }

  return {
    canonical,
    kind: "unknown",
    badge: status || "-",
    title: assetText(t, "withdrawStatusProcessingTitle"),
    message: assetText(t, "withdrawStatusProcessingMessage"),
    className: "border-white/15 text-white/60 bg-white/5",
    terminal: false,
  };
}

export function getWithdrawProgress(status?: string | null, t?: AssetTranslator): WithdrawProgress {
  const canonical = normalizeWithdrawStatus(status);
  const makeSteps = (
    completedThrough: number,
    currentIndex: number | null,
    terminalState?: WithdrawProgressStepState
  ) =>
    WITHDRAW_PROGRESS_LABEL_KEYS.map((labelKey, index) => {
      let state: WithdrawProgressStepState = "waiting";
      if (index <= completedThrough) state = "done";
      if (currentIndex === index) state = terminalState ?? "current";
      return { label: assetText(t, labelKey), state };
    });

  if (canonical === "SUCCESS") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressCompleted"),
      terminal: true,
      tone: "success",
      steps: makeSteps(4, null),
    };
  }

  if (canonical === "FAILED") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressFailed"),
      terminal: true,
      tone: "danger",
      steps: makeSteps(1, 2, "danger"),
    };
  }

  if (canonical === "REJECTED" || canonical === "CANCELED_BY_ADMIN") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressRejected"),
      terminal: true,
      tone: "danger",
      steps: makeSteps(0, 1, "danger"),
    };
  }

  if (canonical === "CANCELED") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressCanceled"),
      terminal: true,
      tone: "muted",
      steps: makeSteps(0, 1, "stopped"),
    };
  }

  if (canonical === "VERIFYING") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressVerifying"),
      terminal: false,
      tone: "normal",
      steps: makeSteps(0, null),
    };
  }

  if (canonical === "REVIEWING") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressReviewing"),
      terminal: false,
      tone: "normal",
      steps: makeSteps(0, 1),
    };
  }

  if (canonical === "SENT") {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressNetworkConfirming"),
      terminal: false,
      tone: "normal",
      steps: makeSteps(2, 3),
    };
  }

  if (["SENDING", "BROADCASTING"].includes(canonical)) {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressOnChainSending"),
      terminal: false,
      tone: "normal",
      steps: makeSteps(1, 2),
    };
  }

  if (["FROZEN", "APPROVED", "PROCESSING", "PENDING"].includes(canonical)) {
    return {
      canonical,
      caption: assetText(t, "withdrawProgressProcessing"),
      terminal: false,
      tone: "normal",
      steps: makeSteps(1, 2),
    };
  }

  return {
    canonical,
    caption: assetText(t, "withdrawProgressWaiting"),
    terminal: false,
    tone: "normal",
    steps: makeSteps(0, 1),
  };
}

export function WithdrawProgressStepper({
  status,
  compact = false,
}: {
  status?: string | null;
  compact?: boolean;
}) {
  const { t } = useLocaleContext();
  const progress = getWithdrawProgress(status, t);
  const activeClass =
    progress.tone === "danger"
      ? "text-red-200"
      : progress.tone === "success"
        ? "text-emerald-200"
        : progress.tone === "muted"
          ? "text-white/55"
          : "text-sky-100";
  const lineClassFor = (step: WithdrawProgressStep) =>
    step.state === "done"
      ? "bg-emerald-400/70"
      : step.state === "danger"
        ? "bg-red-400/60"
        : "bg-white/10";

  if (compact) {
    return (
      <div className="flex min-w-0 items-center gap-3">
        <div className={clsx("shrink-0 text-[11px] font-semibold", activeClass)}>{progress.caption}</div>
        <div className="relative isolate grid min-w-0 flex-1 grid-cols-5 items-center">
          {progress.steps.slice(0, -1).map((step, index) => (
            <span
              key={`${step.label}-line`}
              className={clsx("pointer-events-none absolute top-1/2 z-0 h-px -translate-y-1/2", lineClassFor(step))}
              style={{ left: `${10 + index * 20}%`, width: "20%" }}
            />
          ))}
          {progress.steps.map((step) => {
            const dotClass =
              step.state === "done"
                ? "border-emerald-400 bg-emerald-400"
                : step.state === "current"
                  ? "border-sky-300 bg-sky-300 shadow-[0_0_0_3px_rgba(125,211,252,.15)]"
                  : step.state === "danger"
                    ? "border-red-400 bg-red-400"
                    : step.state === "stopped"
                      ? "border-white/35 bg-white/20"
                      : "border-white/15 bg-white/5";

            return (
              <div key={step.label} className="relative z-10 flex min-w-0 justify-center">
                <span className="rounded-full bg-[#102229] p-0.5">
                  <span className={clsx("block h-2.5 w-2.5 shrink-0 rounded-full border", dotClass)} title={step.label} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={clsx("text-xs font-semibold", activeClass)}>{progress.caption}</div>
      <div className="relative isolate">
        {progress.steps.slice(0, -1).map((step, index) => (
          <span
            key={`${step.label}-line`}
            className={clsx("pointer-events-none absolute top-3 z-0 h-px", lineClassFor(step))}
            style={{ left: `${10 + index * 20}%`, width: "20%" }}
          />
        ))}
        <div className="relative z-10 grid grid-cols-5">
          {progress.steps.map((step, index) => {
            const dotClass =
              step.state === "done"
                ? "border-emerald-400 bg-emerald-400 text-black"
                : step.state === "current"
                  ? "border-sky-300 bg-sky-300 text-black shadow-[0_0_0_3px_rgba(125,211,252,.15)]"
                  : step.state === "danger"
                    ? "border-red-400 bg-red-400 text-black"
                    : step.state === "stopped"
                      ? "border-white/35 bg-white/20 text-white/70"
                      : "border-white/15 bg-white/5 text-white/35";

            return (
              <div key={step.label} className="relative z-10 flex min-w-0 flex-col items-center">
                <div className="rounded-full bg-[#102229] p-0.5">
                  <div
                    className={clsx(
                      "flex items-center justify-center rounded-full border font-bold",
                      "h-6 w-6 text-[11px]",
                      dotClass
                    )}
                  >
                    {index + 1}
                  </div>
                </div>
                <div
                  className={clsx(
                    "mt-1 text-center leading-tight",
                    "text-xs",
                    step.state === "waiting" ? "text-white/35" : "text-white/75"
                  )}
                >
                  {step.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function isLiveWithdrawStatus(status?: string | null) {
  const meta = getWithdrawStatusMeta(status);
  return Boolean(meta.canonical) && !meta.terminal;
}

export function getWithdrawTxHash(record: {
  tx_hash?: string | null;
  txid?: string | null;
  txId?: string | null;
  txHash?: string | null;
  hash?: string | null;
}) {
  return String(record.tx_hash ?? record.txid ?? record.txId ?? record.txHash ?? record.hash ?? "").trim();
}

export const WITHDRAW_USER_CONTACT_MESSAGE = "withdrawContactSupportMessage";

const WITHDRAW_USER_TECHNICAL_PREFIXES = [
  "PRECHECK",
  "HOT_WALLET",
  "RPC",
  "CHAIN",
  "SEND_FAIL",
  "NODE_ERROR",
  "INSUFFICIENT_HOT_WALLET",
];

export function mapWithdrawUserMessage(message?: unknown, t?: AssetTranslator): string {
  const raw = String(message ?? "").trim();
  if (!raw || raw === "-" || raw === "--") return "";

  const upper = raw.toUpperCase();
  const hasTechnicalPrefix = WITHDRAW_USER_TECHNICAL_PREFIXES.some((prefix) => upper.startsWith(prefix));
  const hasTechnicalDetail =
    raw.includes("\u5185\u90e8\u7cfb\u7edf\u9519\u8bef") ||
    /\u70ed\u94b1\u5305|\u9884\u68c0|\u94fe\u4e0a\u9519\u8bef|\u94fe\u4e0a\u53d1\u9001|\u5f53\u524d\u4f59\u989d|\u9700\u8981\s*\d|RPC\s*\u8282\u70b9|\u8282\u70b9|tx[_\s-]?hash|traceback|stack|exception/i.test(raw);

  if (hasTechnicalPrefix || hasTechnicalDetail) return assetText(t, WITHDRAW_USER_CONTACT_MESSAGE);
  return assetText(t, WITHDRAW_USER_CONTACT_MESSAGE);
}

export function getWithdrawFailureReason(
  record: {
    reject_reason?: string | null;
    fail_reason?: string | null;
    error_message?: string | null;
    errorMessage?: string | null;
    reason?: string | null;
    remark?: string | null;
  },
  t?: AssetTranslator
) {
  const reason = [record.reject_reason, record.fail_reason, record.reason, record.error_message, record.errorMessage, record.remark].find((value) => {
    const text = String(value ?? "").trim();
    return text && text !== "-" && text !== "--";
  });
  return mapWithdrawUserMessage(reason, t);
}

export function truncateMiddle(s: string, head = 10, tail = 10) {
  const t = (s || "").trim();
  if (!t) return "";
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}...${t.slice(-tail)}`;
}

export function IconCopy() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="inline-block">
      <path
        fill="currentColor"
        d="M16 1H6a2 2 0 0 0-2 2v10h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z"
      />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="inline-block">
      <path
        fill="currentColor"
        d="M9 16.2 4.8 12 3.4 13.4 9 19 21 7 19.6 5.6z"
      />
    </svg>
  );
}

export type TimeRangeKey = "all" | "24h" | "7d" | "30d";

export function toIso(dt: Date) {
  return dt.toISOString().replace(".000Z", "");
}
