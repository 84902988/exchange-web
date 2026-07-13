"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import AssetsAPI, { type CoinItem } from "@/lib/api/modules/assets";
import { ApiError } from "@/lib/api";
import { useLocaleContext } from "@/contexts/LocaleContext";
import WithdrawAPI, { type WithdrawRecord } from "@/lib/api/modules/assets_withdraw";
import UserTransferAPI, { type UserTransferRecord } from "@/lib/api/modules/user_transfer";
import { useAuth } from "@/lib/authContext";
import { privateQueryKey } from "@/lib/authPrivateQueries";

import type { Language } from "@/utils/language";

import {
  clsx,
  getWithdrawFailureReason,
  getWithdrawStatusMeta,
  getWithdrawTxHash,
  IconCheck,
  IconCopy,
  isLiveWithdrawStatus,
  mapWithdrawUserMessage,
  normalizeWithdrawStatus,
  WithdrawProgressStepper,
} from "./withdraw.shared";

type AssetTranslator = (key: string, namespace?: "asset") => string;

function formatMessage(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function maskAddress(addr: string) {
  const a = (addr || "").trim();
  if (!a) return "-";
  if (a.length <= 16) return a;
  return `${a.slice(0, 10)}...${a.slice(-10)}`;
}

function formatChannelLabel(
  channel: string,
  t?: AssetTranslator
) {
  if (channel === "internal in") {
    return t?.("assetWithdrawRecordsInternalTransferIn", "asset") ?? "Internal transfer in";
  }
  if (channel === "internal out") {
    return t?.("assetWithdrawRecordsInternalTransferOut", "asset") ?? "Internal transfer out";
  }
  return channel;
}

function formatInternalTransferStatus(
  status?: string,
  t?: AssetTranslator
) {
  const normalized = String(status || "").trim().toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(normalized)) {
    return t?.("assetWithdrawSuccess", "asset") ?? "Success";
  }
  if (["FAILED", "FAIL"].includes(normalized)) {
    return t?.("assetWithdrawFailed", "asset") ?? "Failed";
  }
  if (["PENDING", "PROCESSING", "REVIEWING"].includes(normalized)) {
    return t?.("assetWithdrawRecordsProcessing", "asset") ?? "Processing";
  }
  return status || "-";
}

function formatNetworkLabel(network: string) {
  const value = (network || "").trim();
  if (!value) return "-";
  const normalized = value.toLowerCase();
  if (normalized === "polygon") return "Polygon";
  if (normalized === "bsc") return "BSC";
  if (normalized === "arbitrum") return "Arbitrum";
  return value;
}

function formatWithdrawAmount(amount: string | number | undefined) {
  const raw = String(amount ?? "").replace(/,/g, "").trim();
  if (!raw || raw === "-") return "-";

  const sign = raw.startsWith("-") ? "-" : raw.startsWith("+") ? "+" : "";
  const normalized = raw.replace(/^[+-]/, "");

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return raw;
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  const [wholeRaw, fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.slice(0, 8).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatPositiveAmount(amount: string | number | undefined) {
  const raw = String(amount ?? "").replace(/,/g, "").trim();
  if (!raw || raw === "-") return raw || "-";
  if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) return raw.replace(/^-/, "");
  return raw.replace(/^[+-]/, "");
}

function toTs(v?: string) {
  if (!v) return NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function formatRecordDateTime(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-") return { date: "-", time: "", title: "-" };

  const isoLikeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})/);
  if (isoLikeMatch) {
    const [, date, time] = isoLikeMatch;
    return { date, time, title: `${date} ${time}` };
  }

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    const sanitized = raw.replace("T", " ").split(".")[0];
    return { date: sanitized, time: "", title: sanitized };
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const formattedDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const formattedTime = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return { date: formattedDate, time: formattedTime, title: `${formattedDate} ${formattedTime}` };
}

function getWithdrawActionErrorMessage(
  error: unknown,
  fallback: string,
  t?: AssetTranslator
): string {
  const raw =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : fallback;
  const normalized = raw.toLowerCase();
  if (normalized.includes("code incorrect") || normalized.includes("code_invalid")) {
    return t?.("assetWithdrawRecordsIncorrectVerificationCode", "asset") ?? fallback;
  }
  if (normalized.includes("code expired") || normalized.includes("code_expired")) {
    return t?.("assetWithdrawRecordsVerificationCodeExpired", "asset") ?? fallback;
  }
  return raw ? mapWithdrawUserMessage(raw, t) : fallback;
}

type DisplayWithdrawBase = {
  id?: number | string;
  withdraw_id?: number;
  symbol?: string;
  coin_symbol?: string;
  chain_key?: string;
  network?: string;
  network_code?: string;
  to_address?: string;
  address?: string;
  toAddress?: string;
  to?: string;
  recipient?: string;
  recipient_name?: string | null;
  recipient_email_mask?: string | null;
  transfer_no?: string | null;
  amount?: string | number;
  net_amount?: string | number;
  fee?: string | number;
  request_amount?: string | number;
  status?: string;
  tx_hash?: string | null;
  txid?: string | null;
  txId?: string | null;
  txHash?: string | null;
  hash?: string | null;
  reject_reason?: string | null;
  fail_reason?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
  reason?: string | null;
  remark?: string | null;
  withdraw_type?: string;
  withdrawType?: string;
  transfer_type?: string;
  transferType?: string;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  time?: string | null;
};

type ChainWithdrawRecord = WithdrawRecord & DisplayWithdrawBase;

type InternalTransferDisplayRecord = DisplayWithdrawBase & {
  id: string;
  symbol: string;
  coin_symbol: string;
  chain_key: "internal in" | "internal out";
  network: "internal in" | "internal out";
  to_address: string;
  amount: string;
  fee: string;
  net_amount: string;
  status: string;
  tx_hash: null;
  transfer_type: "internal";
  withdraw_type: "internal";
  created_at: string;
  user_transfer_direction: UserTransferRecord["direction"];
  recipient_name?: string | null;
  recipient_email_mask?: string | null;
  transfer_no: string;
};

type WithdrawItem = ChainWithdrawRecord | InternalTransferDisplayRecord;

type WithdrawListResp = {
  items: WithdrawItem[];
  total?: number;
  count?: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
  meta?: {
    total?: number;
    count?: number;
    page?: number;
    page_size?: number;
    total_pages?: number;
  };
};

type Props = {
  currentLanguage: Language | undefined;

  coinSymbol?: string;
  networkCode?: string;
  networkOptionsAll?: unknown[];

  copiedKey: string;
  onCopy: (text: string, key: string) => Promise<void>;
  onToast?: (text: string) => void;
  onBalanceRefresh?: () => Promise<unknown> | unknown;
  onRefreshBalances?: () => Promise<unknown> | unknown;
  onWithdrawRecordsChange?: (records: WithdrawRecord[]) => void;

  coins?: CoinItem[];
};

type TimeFilter = "all" | "7d" | "30d" | "90d";
type StatusFilter =
  | "all"
  | "REVIEWING"
  | "REJECTED"
  | "VERIFYING"
  | "FROZEN"
  | "SENDING"
  | "SENT"
  | "SUCCESS"
  | "FAILED"
  | "CANCELED"
  | "CANCELLED";

const WITHDRAW_STATUS_OPTIONS: Exclude<StatusFilter, "all">[] = [
  "REVIEWING",
  "REJECTED",
  "VERIFYING",
  "FROZEN",
  "SENDING",
  "SENT",
  "SUCCESS",
  "FAILED",
  "CANCELED",
];

const BALANCE_REFRESH_FROM_STATUSES = new Set(["REVIEWING", "VERIFYING", "FROZEN", "SENDING", "SENT"]);
const BALANCE_REFRESH_TO_STATUSES = new Set(["FROZEN", "REJECTED", "SUCCESS", "FAILED", "CANCELED"]);
const recordGridClass =
  "grid grid-cols-[minmax(0,.95fr)_minmax(0,1.15fr)_minmax(0,.48fr)_minmax(0,.52fr)_minmax(0,1fr)_minmax(0,.95fr)] gap-3";

function normStatus(status?: string) {
  return normalizeWithdrawStatus(status);
}

function isVerifyingStatus(status?: string) {
  const normalized = normalizeWithdrawStatus(status);
  return normalized === "VERIFYING" || normalized === "\u5f85\u9a8c\u8bc1" || normalized === "\u5f85\u9a57\u8b49";
}

function isCancelableWithdrawStatus(status?: string) {
  const normalized = normalizeWithdrawStatus(status);
  return normalized === "REVIEWING" || normalized === "VERIFYING" || normalized === "FROZEN";
}

function isInternalType(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["internal", "internal_transfer", "platform", "platform_transfer", "station"].includes(normalized);
}

function isOnchainType(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["onchain", "chain", "blockchain", "external"].includes(normalized);
}

function resolveWithdrawSource(
  r: WithdrawItem,
  chainKey: string,
  tx: string,
  addr: string
): "onchain" | "internal" {
  const backendType = r.withdraw_type ?? r.withdrawType ?? r.transfer_type ?? r.transferType;
  if (isInternalType(backendType)) return "internal";
  if (isOnchainType(backendType)) return "onchain";
  if ("user_transfer_direction" in r || chainKey.toLowerCase().startsWith("internal")) return "internal";
  if (chainKey || tx || addr) return "onchain";
  return "internal";
}

function withdrawRecordKey(record: DisplayWithdrawBase, index: number) {
  const id = record.withdraw_id ?? record.id;
  if (id != null && id !== "") return String(id);
  const tx = getWithdrawTxHash(record);
  return `${record.symbol ?? record.coin_symbol ?? "withdraw"}-${tx || record.created_at || index}`;
}

export default function WithdrawRecords({
  coins = [],
  coinSymbol,
  networkCode,
  copiedKey,
  onCopy,
  onToast,
  onBalanceRefresh,
  onRefreshBalances,
  onWithdrawRecordsChange,
}: Props) {
  const { t } = useLocaleContext();
  const { userIdentityKey } = useAuth();
  const withdrawSendIncompleteMessage = t("assetWithdrawRecordsWithdrawFundsAreFrozenButOnChainSubmissionIsNot", "asset");
  const withdrawSendSubmitFailedMessage = t("assetWithdrawRecordsChainSendingTaskSubmissionFailedPleaseContinueFromWithdrawRecords", "asset");
  const [page, setPage] = useState(1);
  const [nowTs] = useState(() => Date.now());
  const pageSize = 20;

  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [activeVerifyId, setActiveVerifyId] = useState<number | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyBusyId, setVerifyBusyId] = useState<number | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<number | null>(null);
  const [submitBusyId, setSubmitBusyId] = useState<number | null>(null);
  const [verifyMessage, setVerifyMessage] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isPageVisible, setIsPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible"
  );
  const lastWithdrawStatusRef = useRef<Map<string, string>>(new Map());

  const clearActionNotice = () => {
    setVerifyMessage("");
    setVerifyError("");
  };

  const withdrawsQuery = useQuery<WithdrawListResp, Error>({
    queryKey: privateQueryKey(userIdentityKey, "withdraws", page, pageSize),
    enabled: userIdentityKey !== null,
    queryFn: async () => {
      const resp = await AssetsAPI.getWithdraws({
        page,
        page_size: pageSize,
      });
      return resp as WithdrawListResp;
    },
    staleTime: 1000 * 10,
    retry: 0,
    placeholderData: (prev) => prev,
  });

  const userTransfersQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, "userTransferRecords", page, pageSize, coinSymbol),
    enabled: userIdentityKey !== null,
    queryFn: async () => {
      return UserTransferAPI.getRecords({
        direction: "all",
        page,
        page_size: pageSize,
        symbol: coinSymbol || undefined,
      });
    },
    staleTime: 1000 * 10,
    retry: 0,
    placeholderData: (prev) => prev,
  });
  const { refetch: refetchWithdraws } = withdrawsQuery;

  const data = withdrawsQuery.data;
  const withdrawRecords = useMemo(
    () => ((data?.items ?? []) as ChainWithdrawRecord[]),
    [data?.items]
  );

  useEffect(() => {
    onWithdrawRecordsChange?.(withdrawRecords);
  }, [onWithdrawRecordsChange, withdrawRecords]);

  const rawItems: WithdrawItem[] = useMemo(
    () => {
      const merged: WithdrawItem[] = [
        ...withdrawRecords,
        ...((userTransfersQuery.data?.items ?? []).map<InternalTransferDisplayRecord>((item) => ({
          id: `ut-${item.id}`,
          symbol: item.symbol,
          coin_symbol: item.symbol,
          chain_key: item.direction === "out" ? "internal out" : "internal in",
          network: item.direction === "out" ? "internal out" : "internal in",
          to_address: item.recipient_nickname || item.recipient_email_mask,
          recipient_name: item.recipient_nickname || null,
          recipient_email_mask: item.recipient_email_mask,
          amount: formatPositiveAmount(item.amount),
          fee: item.fee_amount,
          net_amount: formatPositiveAmount(item.net_amount),
          status: item.status,
          tx_hash: null,
          transfer_no: item.transfer_no,
          transfer_type: "internal",
          withdraw_type: "internal",
          created_at: item.created_at,
          user_transfer_direction: item.direction,
        }))),
      ];
      return merged.sort((a, b) => {
        const bt = toTs((b.created_at ?? b.createdAt ?? b.time ?? "") as string);
        const at = toTs((a.created_at ?? a.createdAt ?? a.time ?? "") as string);
        const normalizedBt = Number.isFinite(bt) ? bt : 0;
        const normalizedAt = Number.isFinite(at) ? at : 0;
        return normalizedBt - normalizedAt;
      });
    },
    [withdrawRecords, userTransfersQuery.data?.items]
  );

  const hasLiveWithdrawRecords = useMemo(
    () => withdrawRecords.some((record) => isLiveWithdrawStatus(record.status)),
    [withdrawRecords]
  );

  const total =
    data?.total ??
    data?.count ??
    data?.meta?.total ??
    data?.meta?.count ??
    undefined;

  const currentPage = data?.page ?? data?.meta?.page ?? page;

  const totalPages =
    data?.total_pages ??
    data?.meta?.total_pages ??
    (typeof total === "number" ? Math.ceil(total / pageSize) : undefined);

  const isPageFetching = withdrawsQuery.isFetching || userTransfersQuery.isFetching;
  const canPrev = page > 1;
  const canNext = !isPageFetching && (
    typeof totalPages === "number"
      ? page < totalPages
      : rawItems.length >= pageSize
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPageVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!isPageVisible || !hasLiveWithdrawRecords) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refetchWithdraws();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [hasLiveWithdrawRecords, isPageVisible, refetchWithdraws]);

  useEffect(() => {
    let shouldRefreshBalance = false;
    const nextStatuses = new Map<string, string>();

    withdrawRecords.forEach((record, index) => {
      const key = withdrawRecordKey(record, index);
      const nextStatus = normalizeWithdrawStatus(record.status);
      const previousStatus = lastWithdrawStatusRef.current.get(key);

      if (
        previousStatus &&
        previousStatus !== nextStatus &&
        BALANCE_REFRESH_FROM_STATUSES.has(previousStatus) &&
        BALANCE_REFRESH_TO_STATUSES.has(nextStatus)
      ) {
        shouldRefreshBalance = true;
      }

      nextStatuses.set(key, nextStatus);
    });

    lastWithdrawStatusRef.current = nextStatuses;

    if (shouldRefreshBalance) {
      void (onBalanceRefresh ?? onRefreshBalances)?.();
    }
  }, [onBalanceRefresh, onRefreshBalances, withdrawRecords]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (!verifyMessage && !verifyError) return;
    const timer = window.setTimeout(() => {
      clearActionNotice();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [verifyError, verifyMessage]);

  const coinNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (coins ?? []).forEach((c) => {
      const label = `${c.symbol}${c.name ? ` (${c.name})` : ""}`;
      m.set(c.symbol, label);
    });
    return m;
  }, [coins]);

  const statusDisplayLabel = (s?: string) => {
    const status = normalizeWithdrawStatus(s);
    return status ? getWithdrawStatusMeta(status, undefined, t).badge : s || "-";
  };

  const statusDisplayClass = (s?: string) => {
    return getWithdrawStatusMeta(s, undefined, t).className.replace(/\/10/g, "/15").replace("text-white/60", "text-white/50");
  };

  const items = useMemo(() => {
    const kw = keyword.trim().toLowerCase();

    let cutoff = 0;
    if (timeFilter === "7d") cutoff = nowTs - 7 * 24 * 3600 * 1000;
    if (timeFilter === "30d") cutoff = nowTs - 30 * 24 * 3600 * 1000;
    if (timeFilter === "90d") cutoff = nowTs - 90 * 24 * 3600 * 1000;

    const parts = kw.split(/\s+/).filter(Boolean);

    return rawItems.filter((r) => {
      // coin/network filter
      const sym = (r.symbol ?? r.coin_symbol ?? "").toString();
      const chain = (r.chain_key ?? r.network ?? r.network_code ?? "").toString();
      if (coinSymbol && sym && sym !== coinSymbol) return false;
      if (networkCode && chain && !chain.startsWith("internal") && chain !== networkCode) return false;

      // status
      const rowStatus = normalizeWithdrawStatus(r.status);
      const selectedStatus = normalizeWithdrawStatus(statusFilter);
      if (statusFilter !== "all" && rowStatus !== selectedStatus) {
        return false;
      }

      // time
      if (timeFilter !== "all") {
        const createdAt = (r.created_at ?? r.createdAt ?? r.time ?? "") as string;
        const ts = toTs(createdAt);
        if (Number.isFinite(ts) && ts < cutoff) return false;
      }

      // keyword
      if (parts.length > 0) {
        const source = resolveWithdrawSource(r, chain, getWithdrawTxHash(r), "");
        const isInternalRecord = source === "internal";
        const addr = (
          r.recipient_name ??
          r.recipient_email_mask ??
          r.to_address ??
          r.address ??
          r.toAddress ??
          r.to ??
          r.recipient ??
          ""
        )
          .toString()
          .toLowerCase();

        const tx = isInternalRecord ? "" : getWithdrawTxHash(r).toLowerCase();

        const symbol = sym.toLowerCase();
        const chainL = isInternalRecord ? "platform transfer internal transfer" : chain.toLowerCase();

        const haystack = `${addr} ${tx} ${symbol} ${chainL}`;
        if (!parts.every((p) => haystack.includes(p))) return false;
      }

      return true;
    });
  }, [rawItems, timeFilter, statusFilter, keyword, coinSymbol, networkCode, nowTs]);

  const isCurrentPageSettled = !isPageFetching;
  const isEmptyNonFirstPage = isCurrentPageSettled && page > 1 && items.length === 0;

  useEffect(() => {
    if (!isEmptyNonFirstPage) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setVerifyMessage("");
      setVerifyError("");
      setPage((p) => Math.max(1, p - 1));
    });
    return () => {
      cancelled = true;
    };
  }, [isEmptyNonFirstPage]);

  const onPrev = () => {
    if (!canPrev) return;
    clearActionNotice();
    setPage((p) => Math.max(1, p - 1));
  };

  const onNext = () => {
    if (!canNext) return;
    clearActionNotice();
    setPage((p) => p + 1);
  };

  const sendVerificationCode = async (withdrawId: number, resent = false) => {
    setVerifyBusyId(withdrawId);
    setVerifyError("");
    setVerifyMessage("");
    try {
      await WithdrawAPI.sendWithdrawCode({ withdraw_id: withdrawId });
      setActiveVerifyId(withdrawId);
      if (!resent) setVerifyCode("");
      setResendCooldown(60);
      setVerifyMessage(resent
        ? t("assetWithdrawRecordsVerificationCodeResentPleaseCheckYourEmail", "asset")
        : t("assetWithdrawRecordsVerificationCodeSentPleaseCheckYourEmail", "asset"));
    } catch (error) {
      setVerifyError(getWithdrawActionErrorMessage(
        error,
        t("assetWithdrawRecordsFailedToSendVerificationCodePleaseTryAgainLater", "asset"),
        t
      ));
    } finally {
      setVerifyBusyId(null);
    }
  };

  const startVerification = async (withdrawId: number) => {
    await sendVerificationCode(withdrawId, false);
  };

  const resendVerificationCode = async (withdrawId: number) => {
    await sendVerificationCode(withdrawId, true);
  };

  const confirmVerification = async (withdrawId: number) => {
    const code = verifyCode.replace(/\D/g, "").slice(0, 6);
    if (code.length < 4) {
      setVerifyError(t("assetWithdrawRecordsPleaseEnterAValidVerificationCode", "asset"));
      return;
    }
    setVerifyBusyId(withdrawId);
    setVerifyError("");
    setVerifyMessage("");
    try {
      await WithdrawAPI.confirmWithdraw({ withdraw_id: withdrawId, code });
      setActiveVerifyId(null);
      setVerifyCode("");
      setResendCooldown(0);
      setVerifyMessage(t("assetWithdrawRecordsWithdrawFundsFrozenSubmittingOnChainProcessing", "asset"));
      void withdrawsQuery.refetch();
      void (onBalanceRefresh ?? onRefreshBalances)?.();
      void (async () => {
        try {
          const result = await WithdrawAPI.sendWithdrawTx({ withdraw_id: withdrawId });
          const nextStatus = normalizeWithdrawStatus(result?.status);
          if (!result?.ok || nextStatus === "FAILED" || nextStatus === "REJECTED") {
            throw new Error(result?.message || result?.error || withdrawSendIncompleteMessage);
          }
          setVerifyMessage(t("assetWithdrawRecordsWithdrawSubmittedForOnChainProcessing", "asset"));
        } catch (error) {
          console.warn("withdraw send task submit failed", error);
          setVerifyMessage("");
          setVerifyError(withdrawSendSubmitFailedMessage);
        } finally {
          void withdrawsQuery.refetch();
        }
      })();
    } catch (error) {
      setVerifyError(getWithdrawActionErrorMessage(
        error,
        t("assetWithdrawRecordsConfirmationFailedPleaseTryAgainLater", "asset"),
        t
      ));
    } finally {
      setVerifyBusyId(null);
    }
  };

  const cancelWithdraw = async (withdrawId: number, status?: string) => {
    const normalized = normalizeWithdrawStatus(status);
    const confirmMessage =
      normalized === "FROZEN"
        ? t("assetWithdrawRecordsCancelThisWithdrawFrozenFundsWillBeReturnedToFunding", "asset")
        : t("assetWithdrawRecordsCancelThisWithdraw", "asset");
    if (!window.confirm(confirmMessage)) return;

    setCancelBusyId(withdrawId);
    setVerifyError("");
    setVerifyMessage("");
    try {
      await WithdrawAPI.cancelWithdraw({ withdraw_id: withdrawId });
      if (activeVerifyId === withdrawId) {
        setActiveVerifyId(null);
        setVerifyCode("");
        setResendCooldown(0);
      }
      setVerifyMessage(t("assetWithdrawRecordsWithdrawCanceled", "asset"));
      await withdrawsQuery.refetch();
      try {
        await (onBalanceRefresh ?? onRefreshBalances)?.();
      } catch (refreshError) {
        console.warn("refresh balances after withdraw cancel failed", refreshError);
      }
    } catch (error) {
      console.warn("cancel withdraw failed", error);
      setVerifyError(t("assetWithdrawRecordsCancelFailedPleaseTryAgainLater", "asset"));
    } finally {
      setCancelBusyId(null);
    }
  };

  const submitFrozenWithdraw = async (withdrawId: number) => {
    setSubmitBusyId(withdrawId);
    setVerifyError("");
    setVerifyMessage("");
    try {
      const result = await WithdrawAPI.sendWithdrawTx({ withdraw_id: withdrawId });
      const nextStatus = normalizeWithdrawStatus(result?.status);
      if (!result?.ok || nextStatus === "FAILED" || nextStatus === "REJECTED") {
        onToast?.(withdrawSendSubmitFailedMessage);
        return;
      }

      onToast?.(t("assetWithdrawRecordsWithdrawSubmitted", "asset"));
      await withdrawsQuery.refetch();
    } catch (error) {
      console.warn("withdraw send task submit failed", error);
      onToast?.(withdrawSendSubmitFailedMessage);
    } finally {
      setSubmitBusyId(null);
    }
  };

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold">
          {t("assetWithdrawRecordsWithdrawRecords", "asset")}
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
          <select
            value={timeFilter}
            onChange={(e) => {
              setTimeFilter(e.target.value as TimeFilter);
              clearActionNotice();
              setPage(1);
            }}
            className="h-10 rounded-2xl border border-white/10 bg-black/20 px-4 pr-10 text-sm text-white/80 outline-none hover:bg-black/25 focus:border-white/20"
          >
            <option value="all">
              {t("assetWithdrawRecordsAllTime", "asset")}
            </option>
            <option value="7d">
              {t("assetWithdrawRecordsLast7Days", "asset")}
            </option>
            <option value="30d">
              {t("assetWithdrawRecordsLast30Days", "asset")}
            </option>
            <option value="90d">
              {t("assetWithdrawRecordsLast90Days", "asset")}
            </option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              clearActionNotice();
              setPage(1);
            }}
            className="h-10 rounded-2xl border border-white/10 bg-black/20 px-4 pr-10 text-sm text-white/80 outline-none hover:bg-black/25 focus:border-white/20"
          >
            <option value="all">
              {t("assetWithdrawRecordsAllStatus", "asset")}
            </option>
            {WITHDRAW_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {statusDisplayLabel(status)}
              </option>
            ))}
          </select>

          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              clearActionNotice();
              setPage(1);
            }}
            placeholder={t("assetWithdrawRecordsSearchTxidAddress", "asset")}
            className="h-10 w-full min-w-0 rounded-2xl border border-white/10 bg-black/20 px-4 text-sm text-white/80 placeholder:text-white/40 outline-none hover:bg-black/25 focus:border-white/20 sm:w-[260px] lg:w-[300px]"
          />
        </div>
      </div>

      <div className="mt-4 min-w-0 max-w-full overflow-hidden">
        {(verifyMessage || verifyError) ? (
          <div
            className={clsx(
              "mb-3 rounded-xl border px-4 py-3 text-sm",
              verifyError
                ? "border-red-500/20 bg-red-500/10 text-red-200"
                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
            )}
            role="status"
          >
            {verifyError || verifyMessage}
          </div>
        ) : null}

        {withdrawsQuery.isError ? (
          <div className="text-sm text-red-200">
            {t("assetWithdrawRecordsLoadFailed", "asset")}
          </div>
        ) : items.length === 0 && page <= 1 ? (
          <div className="text-sm text-white/50">
            {t("assetWithdrawRecordsNoRecords", "asset")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/60">
            <span>{t("assetWithdrawRecordsNoRecordsOnThisPageReturningToPreviousPage", "asset")}</span>
            <button
              type="button"
              onClick={onPrev}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-white/70 hover:bg-white/10"
            >
              {t("assetWithdrawRecordsPrev", "asset")}
            </button>
          </div>
        ) : (
          <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-white/10 bg-black/20">
            <div className="border-b border-white/10 bg-white/5 px-4 py-2 text-xs text-white/45">
              <div className={recordGridClass}>
                <div className="min-w-0 space-y-1">
                  <div>{t("assetWithdrawRecordsTime", "asset")}</div>
                  <div>{t("assetWithdrawRecordsAmount", "asset")}</div>
                </div>
                <div className="min-w-0 space-y-1">
                  <div>{t("assetWithdrawRecordsCoin", "asset")}</div>
                  <div>{t("assetWithdrawRecordsRecipient", "asset")}</div>
                </div>
                <div className="min-w-0 space-y-1">
                  <div>{t("assetWithdrawRecordsNetwork", "asset")}</div>
                  <div>&nbsp;</div>
                </div>
                <div className="min-w-0 space-y-1">
                  <div>{t("assetWithdrawRecordsSource", "asset")}</div>
                  <div>&nbsp;</div>
                </div>
                <div className="min-w-0 space-y-1">
                  <div>{t("assetWithdrawRecordsStatus", "asset")}</div>
                  <div>&nbsp;</div>
                </div>
                <div className="min-w-0 space-y-1 text-right">
                  <div>{t("assetWithdrawRecordsAction", "asset")}</div>
                  <div>{t("assetWithdrawRecordsCopyAddress", "asset")}</div>
                </div>
              </div>
            </div>

            <div className="divide-y divide-white/10">
              {items.map((r, idx) => {
                const symbol = (r.symbol ?? r.coin_symbol ?? "-") as string;
                const chainKey = (r.chain_key ?? r.network ?? r.network_code ?? "") as string;

                const rawAddr = (r.to_address ?? r.address ?? r.toAddress ?? r.to ?? r.recipient ?? "") as string;
                const source = resolveWithdrawSource(r, chainKey, "", rawAddr);
                const isInternalRecord = source === "internal";
                const recipientLabel = isInternalRecord
                  ? String(r.recipient_name || r.to_address || r.recipient_email_mask || "").trim()
                  : rawAddr;
                const recipientSubtitle = isInternalRecord
                  ? String(r.recipient_email_mask || "").trim()
                  : "";
                const addr = isInternalRecord ? recipientLabel : rawAddr;
                const tx = isInternalRecord ? "" : getWithdrawTxHash(r);

                const rowKey =
                  r?.id != null
                    ? `w-${r.id}-${tx || chainKey}-${symbol}`
                    : `w-idx-${idx}-${chainKey}-${symbol}`;

                const keyAddr = `addr-${rowKey}`;

                const createdAt = (r.created_at ?? r.createdAt ?? r.time ?? "-") as string;
                const amount = r.amount ?? r.net_amount ?? r.request_amount ?? "-";
                const withdrawId = Number(r.withdraw_id ?? (typeof r.id === "number" ? r.id : 0));
                const sourceBadge = isInternalRecord
                  ? t("assetWithdrawRecordsPlatformTransfer", "asset")
                  : t("assetWithdrawRecordsOnChain", "asset");
                const sourceDetail = isInternalRecord
                  ? t("assetWithdrawRecordsInternalTransfer", "asset")
                  : formatNetworkLabel(chainKey);
                const internalDirectionLabel = isInternalRecord ? formatChannelLabel(chainKey, t) : "";
                const hasTxHash = Boolean(tx.trim());
                const canContinueVerify = !isInternalRecord && withdrawId > 0 && isVerifyingStatus(r.status);
                const canContinueSubmit =
                  !isInternalRecord &&
                  withdrawId > 0 &&
                  normalizeWithdrawStatus(r.status) === "FROZEN" &&
                  !hasTxHash;
                const canCancelWithdraw =
                  !isInternalRecord && withdrawId > 0 && !hasTxHash && isCancelableWithdrawStatus(r.status);
                const isActiveVerify = activeVerifyId === withdrawId;
                const isBusy = verifyBusyId === withdrawId;
                const isCanceling = cancelBusyId === withdrawId;
                const isSubmitting = submitBusyId === withdrawId;
                const normalizedStatus = normalizeWithdrawStatus(r.status);
                const failureReason =
                  !isInternalRecord && getWithdrawStatusMeta(r.status, undefined, t).kind === "failed"
                    ? getWithdrawFailureReason(r, t)
                    : "";
                const failureReasonLabel =
                  normalizedStatus === "REJECTED" || normalizedStatus === "CANCELED_BY_ADMIN"
                    ? t("assetWithdrawRecordsRejectReason", "asset")
                    : t("assetWithdrawRecordsFailureReason", "asset");
                const hasRowActions = canContinueSubmit || canContinueVerify || canCancelWithdraw;
                const formattedCreatedAt = formatRecordDateTime(createdAt);

                return (
                  <React.Fragment key={rowKey}>
                    <div className="min-w-0 px-4 py-2.5 text-sm hover:bg-white/[0.025]">
                      <div className={clsx(recordGridClass, "items-center")}>
                        <div className="min-w-0 space-y-1">
                          <div className="truncate text-white/75" title={formattedCreatedAt.title}>
                            {formattedCreatedAt.title}
                          </div>
                          <div className="text-xs font-semibold tabular-nums text-white/90">
                            {formatWithdrawAmount(amount)}
                          </div>
                        </div>

                        <div className="min-w-0 space-y-1">
                          <div className="truncate font-semibold text-white/90" title={coinNameMap.get(symbol) ?? symbol}>
                            {coinNameMap.get(symbol) ?? symbol}
                          </div>
                          {isInternalRecord ? (
                            <div className="min-w-0 space-y-0.5">
                              <span className="block truncate text-xs text-white/70" title={recipientLabel || undefined}>
                                {recipientLabel || t("assetWithdrawRecordsNicknameNotSet", "asset")}
                              </span>
                              {recipientSubtitle && recipientSubtitle !== recipientLabel ? (
                                <span className="block truncate text-[11px] text-white/45" title={recipientSubtitle}>
                                  {recipientSubtitle}
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="block max-w-full truncate font-mono text-xs text-white/70" title={addr || undefined}>
                              {addr ? maskAddress(addr) : "-"}
                            </span>
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="truncate text-white/70" title={sourceDetail}>{sourceDetail}</div>
                        </div>

                        <div className="min-w-0">
                          <span
                            className={clsx(
                              "rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                              isInternalRecord
                                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                                : "border-sky-400/30 bg-sky-500/10 text-sky-100"
                            )}
                            title={internalDirectionLabel || sourceBadge}
                          >
                            {sourceBadge}
                          </span>
                        </div>

                        <div className="min-w-0 space-y-1">
                          <span
                            className={clsx(
                              "inline-flex max-w-full shrink rounded-lg border px-2 py-0.5 text-xs font-semibold leading-4",
                              isInternalRecord ? statusDisplayClass(r.status) : statusDisplayClass(r.status)
                            )}
                            title={`status=${normStatus(r.status) || "-"}`}
                          >
                            <span className="truncate">
                              {isInternalRecord ? formatInternalTransferStatus(r.status, t) : statusDisplayLabel(r.status)}
                            </span>
                          </span>
                        </div>

                        <div className="min-w-0 max-w-full space-y-1 overflow-hidden">
                          <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-1.5">
                            {canContinueSubmit ? (
                              <button
                                type="button"
                                onClick={() => submitFrozenWithdraw(withdrawId)}
                                disabled={isSubmitting}
                                className={clsx(
                                  "rounded-lg px-2 py-1 text-xs font-semibold",
                                  isSubmitting
                                    ? "bg-white/10 text-white/40"
                                    : "bg-white text-black hover:bg-white/90"
                                )}
                              >
                                {isSubmitting
                                  ? t("assetWithdrawRecordsSubmitting", "asset")
                                  : t("assetWithdrawRecordsSubmit", "asset")}
                              </button>
                            ) : null}
                            {canContinueVerify ? (
                              <button
                                type="button"
                                onClick={() => startVerification(withdrawId)}
                                disabled={isBusy}
                                className={clsx(
                                  "rounded-lg px-2 py-1 text-xs font-semibold",
                                  isBusy
                                    ? "bg-white/10 text-white/40"
                                    : "bg-white text-black hover:bg-white/90"
                                )}
                              >
                                {isBusy
                                  ? t("assetWithdrawRecordsProcessing", "asset")
                                  : t("assetWithdrawRecordsVerify", "asset")}
                              </button>
                            ) : null}
                            {canCancelWithdraw ? (
                              <button
                                type="button"
                                onClick={() => cancelWithdraw(withdrawId, r.status)}
                                disabled={isCanceling || isSubmitting}
                                className={clsx(
                                  "rounded-lg border px-2 py-1 text-xs font-semibold",
                                  isCanceling || isSubmitting
                                    ? "border-white/10 bg-white/5 text-white/40"
                                    : "border-red-400/40 bg-red-500/10 text-red-100 hover:bg-red-500/20"
                                )}
                              >
                                {isCanceling
                                  ? t("assetWithdrawRecordsCanceling", "asset")
                                  : t("assetWithdrawRecordsCancel", "asset")}
                              </button>
                            ) : null}
                            {!hasRowActions ? <span className="text-white/35">{isInternalRecord ? t("assetWithdrawRecordsReadOnly", "asset") : "-"}</span> : null}
                          </div>

                          <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-1.5">
                            {addr && !isInternalRecord ? (
                              <button
                                type="button"
                                className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-1 text-[11px] font-semibold text-white/70 hover:border-white/20 hover:bg-white/10 hover:text-white"
                                onClick={() => onCopy(addr, keyAddr)}
                                title={t("assetWithdrawRecordsCopyRecipientAddress", "asset")}
                                aria-label={t("assetWithdrawRecordsCopyRecipientAddress", "asset")}
                              >
                                {copiedKey === keyAddr ? <IconCheck /> : <IconCopy />}
                                <span>{copiedKey === keyAddr
                                  ? t("assetWithdrawRecordsAddressCopied", "asset")
                                  : t("assetWithdrawRecordsCopyAddress", "asset")}</span>
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {failureReason ? (
                        <div
                          className="mt-1 truncate text-[11px] leading-4 text-red-200/80"
                          title={failureReason}
                        >
                          {failureReasonLabel}：{failureReason}
                        </div>
                      ) : null}
                      {!isInternalRecord ? (
                        <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2">
                          <WithdrawProgressStepper status={r.status} compact />
                        </div>
                      ) : null}
                    </div>
                    {isActiveVerify ? (
                      <div className="border-t border-white/10 bg-sky-500/5 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                          <span className="text-white/70">{t("assetWithdrawRecordsEmailVerificationCode", "asset")}</span>
                          <input
                            value={verifyCode}
                            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            inputMode="numeric"
                            placeholder={t("assetWithdrawRecordsPleaseEnterVerificationCode", "asset")}
                            className="h-9 w-40 rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-white/25"
                          />
                          <button
                            type="button"
                            onClick={() => confirmVerification(withdrawId)}
                            disabled={isBusy}
                            className={clsx(
                              "h-9 rounded-lg px-4 text-xs font-semibold",
                              isBusy ? "bg-white/10 text-white/40" : "bg-white text-black hover:bg-white/90"
                            )}
                          >
                            {isBusy
                              ? t("assetWithdrawRecordsConfirming", "asset")
                              : t("assetWithdrawRecordsConfirmWithdraw", "asset")}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveVerifyId(null);
                              setVerifyCode("");
                              setVerifyError("");
                              setResendCooldown(0);
                            }}
                            className="h-9 rounded-lg border border-white/10 px-4 text-xs text-white/70 hover:border-white/20"
                          >
                            {t("assetWithdrawRecordsCancel", "asset")}
                          </button>
                          <button
                            type="button"
                            onClick={() => resendVerificationCode(withdrawId)}
                            disabled={isBusy || resendCooldown > 0}
                            className={clsx(
                              "h-9 rounded-lg border border-white/10 px-4 text-xs font-semibold",
                              isBusy || resendCooldown > 0
                                ? "bg-white/5 text-white/40"
                                : "bg-black/10 text-white/80 hover:border-white/20"
                            )}
                          >
                            {resendCooldown > 0
                              ? `${t("assetWithdrawRecordsResend", "asset")} (${resendCooldown}s)`
                              : t("assetWithdrawRecordsResendVerificationCode", "asset")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-sm text-white/60">
              <div className="min-w-0">
                {typeof total === "number"
                  ? formatMessage(t("assetWithdrawRecordsTotalCount", "asset"), { total })
                  : `${t("assetWithdrawRecordsTotal", "asset")} ${
                      items.length
                    }`}
              </div>

              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onPrev}
                  disabled={!canPrev}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-white/70 hover:bg-white/10 disabled:opacity-40"
                >
                  {t("assetWithdrawRecordsPrev", "asset")}
                </button>

                <div className="min-w-[44px] text-center text-white/80">{currentPage}</div>

                <button
                  type="button"
                  onClick={onNext}
                  disabled={!canNext}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-white/70 hover:bg-white/10 disabled:opacity-40"
                >
                  {t("assetWithdrawRecordsNext", "asset")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
