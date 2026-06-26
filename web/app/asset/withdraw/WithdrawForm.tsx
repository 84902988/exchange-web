"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type { WithdrawOptionItem } from "@/lib/api/modules/assets";
import { ApiError } from "@/lib/api";
import CoinSelect from "@/components/asset/CoinSelect";
import NetworkSelect from "@/components/asset/NetworkSelect";
import { useLocaleContext } from "@/contexts/LocaleContext";
import WithdrawAPI, { type WithdrawRecord } from "@/lib/api/modules/assets_withdraw";
import UserTransferAPI, { type UserTransferRecipient } from "@/lib/api/modules/user_transfer";
import type { Language } from "@/utils/language";
import {
  getWithdrawFailureReason,
  getWithdrawProgress,
  getWithdrawStatusMeta,
  getWithdrawTxHash,
  mapWithdrawUserMessage,
  normalizeWithdrawStatus,
  WithdrawProgressStepper,
} from "./withdraw.shared";

type Props = {
  currentLanguage: Language | undefined;
  withdrawOptions?: WithdrawOptionItem[];
  balances?: WithdrawBalanceItem[];
  coinSymbol: string;
  setCoinSymbol: (v: string) => void;
  networkCode: string;
  setNetworkCode: (v: string) => void;
  copiedKey?: string | null;
  latestWithdrawRecords?: WithdrawRecord[];
  withdrawLocked?: boolean;
  withdrawLockedReason?: string;
  onCopy?: (text: string, key: string) => void | Promise<void>;
  onToast: (text: string) => void;
  onError: (text: string) => void;
  onSuccessVerified: () => void;
};

type WithdrawBalanceItem = {
  symbol?: string;
  coin_symbol?: string;
  account_key?: string;
  chain_key?: string;
  account_type?: string;
  network_code?: string;
  available?: string;
  available_amount?: string;
  frozen?: string;
  frozen_amount?: string;
};

type Step = 1 | 2 | 3;
type ReceiverMode = "onchain" | "internal";
type AssetIconFields = { icon_url?: string | null; iconUrl?: string | null; icon?: string | null };
type AssetTranslator = (key: string, namespace?: "asset") => string;

type ConfirmSnapshot = {
  symbol: string;
  network: string;
  to_address: string;
  amount: string;
};

type ResultState = {
  ok: boolean;
  kind: "withdraw" | "user_transfer";
  status: string;
  message?: string;
  withdraw_id?: number;
  transfer_no?: string;
  snapshot?: ConfirmSnapshot;
  fee?: string;
  tx_hash?: string;
};

function clsx(...arr: Array<string | false | undefined | null>) {
  return arr.filter(Boolean).join(" ");
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  const e = error as {
    message?: string;
    response?: { data?: { message?: string; detail?: string; error?: { message?: string } } };
    data?: { message?: string; detail?: string; error?: { message?: string } };
  };
  return (
    e?.response?.data?.error?.message ||
    e?.response?.data?.message ||
    e?.response?.data?.detail ||
    e?.data?.error?.message ||
    e?.data?.message ||
    e?.data?.detail ||
    e?.message ||
    fallback
  );
}

function getInternalTransferErrorMessage(
  error: unknown,
  fallback: string,
  t?: AssetTranslator
): string {
  const message = getErrorMessage(error, fallback);
  const pick = (key: string) => t?.(key, "asset") ?? fallback;
  const raw = message.toLowerCase();
  if (raw.includes("recipient") && raw.includes("not found")) {
    return pick("assetWithdrawRecipientUserNotFound");
  }
  if (raw.includes("cannot transfer to yourself")) {
    return pick("assetWithdrawCannotTransferToYourself");
  }
  if (raw.includes("status") && raw.includes("active")) {
    return pick("assetWithdrawRecipientAccountAbnormal");
  }
  if (raw.includes("insufficient") || raw.includes("available balance")) {
    return pick("assetWithdrawInsufficientFundingAccountAvailableBalance");
  }
  if (raw.includes("amount")) {
    return pick("assetWithdrawTransferAmountMustBeGreaterThan0");
  }
  if (raw.includes("email")) {
    return pick("assetWithdrawValidRecipientEmail");
  }
  if (raw.includes("confirm recipient")) {
    return pick("assetWithdrawConfirmRecipientFirst");
  }
  if (raw.includes("select a coin")) {
    return pick("assetWithdrawPleaseSelectACoin");
  }
  if (raw.includes("request_id")) {
    return pick("assetWithdrawRequestExpired");
  }
  return fallback;
}

function normUpper(s: string) {
  return (s || "").trim().toUpperCase();
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getRecordWithdrawId(record: WithdrawRecord): number {
  return Number(record.withdraw_id ?? record.id ?? 0);
}

function defaultPrecisionForCoin(symbol: string): number {
  const normalized = normUpper(symbol);
  if (normalized === "USDT") return 2;
  if (normalized === "BTC" || normalized === "ETH") return 6;
  return 4;
}

function resolveAmountPrecision(symbol: string, option?: WithdrawOptionItem | null): number {
  const fromOption = Number(option?.display_precision ?? option?.decimals);
  if (Number.isInteger(fromOption) && fromOption >= 0 && fromOption <= 18) return fromOption;
  return defaultPrecisionForCoin(symbol);
}

function formatCoinAmount(value: unknown, precision: number, useGrouping = true): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  return n
    .toLocaleString("en-US", { useGrouping, minimumFractionDigits: 0, maximumFractionDigits: precision })
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function clampDecimals(v: string, precision: number): string {
  const s = (v ?? "").trim().replace(/,/g, "");
  if (!s) return "";
  const m = s.match(new RegExp(`^\\d*(?:\\.\\d{0,${precision}})?`));
  return m ? m[0] : "";
}

function clampDigits(v: string, maxLen: number) {
  return (v ?? "").replace(/\D/g, "").slice(0, maxLen);
}

function maskAddress(addr: string) {
  const a = (addr || "").trim();
  if (!a) return "-";
  if (a.length <= 16) return a;
  return `${a.slice(0, 8)}...${a.slice(-6)}`;
}

export default function WithdrawForm(props: Props) {
  const { t } = useLocaleContext();
  const {
    withdrawOptions = [],
    balances = [],
    coinSymbol,
    setCoinSymbol,
    networkCode,
    setNetworkCode,
    latestWithdrawRecords = [],
    withdrawLocked = false,
    withdrawLockedReason,
    onToast,
    onError,
    onSuccessVerified,
  } = props;

  const resolvedWithdrawLockedReason = withdrawLockedReason || t("assetWithdrawRiskLocked", "asset");
  const withdrawSendSubmitFailedMessage = t("assetWithdrawChainSendingTaskSubmissionFailedPleaseContinueFromWithdrawRecords", "asset");

  const [receiverMode, setReceiverMode] = useState<ReceiverMode>("onchain");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientRemark, setRecipientRemark] = useState("");
  const [resolvedRecipient, setResolvedRecipient] = useState<UserTransferRecipient | null>(null);
  const [resolvedRecipientEmail, setResolvedRecipientEmail] = useState("");
  const [step, setStep] = useState<Step>(1);
  const [confirmSnapshot, setConfirmSnapshot] = useState<ConfirmSnapshot | null>(null);
  const [withdrawId, setWithdrawId] = useState<number | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const cooldownRef = useRef(0);
  const [fee, setFee] = useState("");
  const [feeLoading, setFeeLoading] = useState(false);
  const [finalFee, setFinalFee] = useState("");
  const [finalFeeLoading, setFinalFeeLoading] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [internalError, setInternalError] = useState("");

  const optionItems = useMemo(
    () =>
      (withdrawOptions ?? []).filter(
        (item) =>
          item.enabled !== false &&
          item.asset_enabled !== false &&
          item.chain_enabled !== false &&
          item.asset_chain_enabled !== false &&
          item.withdraw_enabled !== false
      ),
    [withdrawOptions]
  );

  const coinOptions = useMemo(() => {
    const map = new Map<
      string,
      {
        symbol: string;
        name?: string;
        sortOrder: number;
        icon_url?: string | null;
        iconUrl?: string | null;
        icon?: string | null;
      }
    >();
    optionItems.forEach((item) => {
      const symbol = item.coin_symbol?.trim();
      if (!symbol || map.has(symbol)) return;
      const iconFields = item as AssetIconFields;
      map.set(symbol, {
        symbol,
        name: item.coin_name,
        sortOrder: Number(item.withdraw_sort_order ?? 100),
        icon_url: iconFields.icon_url,
        iconUrl: iconFields.iconUrl,
        icon: iconFields.icon,
      });
    });
    return Array.from(map.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.symbol.localeCompare(b.symbol));
  }, [optionItems]);

  const networkOptions = useMemo(() => {
    if (!coinSymbol) return [];
    return optionItems
      .filter((item) => item.coin_symbol?.toUpperCase() === coinSymbol.toUpperCase())
      .sort(
        (a, b) =>
          Number(a.network_sort_order ?? 0) - Number(b.network_sort_order ?? 0) ||
          (a.chain_name || a.chain_key).localeCompare(b.chain_name || b.chain_key)
      );
  }, [optionItems, coinSymbol]);
  const networkSelectOptions = useMemo(
    () =>
      networkOptions.map((item) => ({
        ...item,
        icon_url: item.chain_icon_url || item.network_icon_url || null,
      })),
    [networkOptions]
  );

  const currentOption = useMemo(
    () => networkOptions.find((item) => item.chain_key === networkCode) ?? null,
    [networkOptions, networkCode]
  );

  const amountPrecision = resolveAmountPrecision(coinSymbol, currentOption);
  const noWithdrawOptions = optionItems.length === 0;

  useEffect(() => {
    if (!coinSymbol && coinOptions.length > 0) setCoinSymbol(coinOptions[0].symbol);
  }, [coinOptions, coinSymbol, setCoinSymbol]);

  useEffect(() => {
    const ok = networkOptions.some((n) => n.chain_key === networkCode);
    if (!networkCode || !ok) setNetworkCode(networkOptions[0]?.chain_key || "");
  }, [networkOptions, networkCode, setNetworkCode]);

  const formatNetworkLabel = (chainKey: string) => {
    const n = optionItems.find((x) => x.chain_key === chainKey);
    const name = (n?.chain_name || chainKey.toUpperCase()).trim();
    const cid = n?.chain_id ? String(n.chain_id) : "";
    return cid ? `${name} (${cid})` : name;
  };

  const currentBalance = useMemo(() => {
    const row =
      (balances ?? []).find(
        (r) =>
          normUpper(r.coin_symbol ?? r.symbol ?? "") === normUpper(coinSymbol) &&
          [r.account_key, r.account_type, r.chain_key, r.network_code].some(
            (value) => String(value ?? "").toLowerCase() === "funding"
          )
      ) ?? null;
    return { availableNum: toNum(row?.available_amount ?? row?.available ?? "0") };
  }, [balances, coinSymbol]);

  const amountText = amount.trim();
  const rawAmountNum = Number(amountText);
  const amountNum = toNum(amountText);
  const feeNum = toNum(fee);
  const feeCoin = "USDT";
  const isWithdrawCoinUsdt = normUpper(coinSymbol) === feeCoin;
  const totalDebitNum = isWithdrawCoinUsdt ? amountNum + feeNum : amountNum;
  const amountNotNumber = amountText !== "" && !Number.isFinite(rawAmountNum);
  const amountNotPositive = amountText !== "" && !amountNotNumber && amountNum <= 0;
  const amountInvalid = amountNotNumber || amountNotPositive;
  const amountExceedsAvailableBeforeFee = amountText !== "" && !amountInvalid && amountNum > currentBalance.availableNum;
  const amountTooLarge =
    amountText !== "" &&
    !amountInvalid &&
    (receiverMode === "onchain" && fee !== "" && isWithdrawCoinUsdt
      ? totalDebitNum > currentBalance.availableNum
      : amountExceedsAvailableBeforeFee);
  const amountTooSmall = false;
  const minWithdrawNum = toNum(currentOption?.min_withdraw);
  const amountBelowMin =
    receiverMode === "onchain" && amountText !== "" && amountNum > 0 && minWithdrawNum > 0 && amountNum < minWithdrawNum;
  const amountErrorMessage = amountNotNumber
    ? t("assetWithdrawInvalidAmountFormat", "asset")
    : amountNotPositive
      ? t("assetWithdrawTransferAmountMustBeGreaterThan0", "asset")
      : amountTooLarge
        ? t("assetWithdrawInsufficientFundingAccountAvailableBalance", "asset")
        : amountBelowMin
          ? `${t("assetWithdrawBelowMinimumWithdrawAmount", "asset")}: ${formatCoinAmount(minWithdrawNum, amountPrecision)} ${coinSymbol}`
          : amountTooSmall
            ? t("assetWithdrawWithdrawAmountMustBeGreaterThanTheFee", "asset")
            : "";

  useEffect(() => {
    setFee("");
    setFinalFee("");
    setFinalFeeLoading(false);
  }, [coinSymbol, networkCode, receiverMode]);

  useEffect(() => {
    if (step !== 1 || receiverMode !== "onchain" || !coinSymbol || !networkCode) return;
    if (!amount || amountInvalid || amountExceedsAvailableBeforeFee || amountBelowMin) {
      setFee("");
      return;
    }
    setFeeLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await WithdrawAPI.getWithdrawFee({
          symbol: coinSymbol,
          network: networkCode,
          amount: amount.trim(),
          to_address: toAddress || undefined,
        });
        setFee(String(res?.fee ?? ""));
      } catch {
        setFee("");
      } finally {
        setFeeLoading(false);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [step, receiverMode, coinSymbol, networkCode, amount, toAddress, amountInvalid, amountExceedsAvailableBeforeFee, amountBelowMin]);

  useEffect(() => {
    if (step !== 2 || receiverMode !== "onchain" || !confirmSnapshot) return;
    setFinalFeeLoading(true);
    WithdrawAPI.getWithdrawFee({
      symbol: confirmSnapshot.symbol,
      network: confirmSnapshot.network,
      amount: confirmSnapshot.amount,
      to_address: confirmSnapshot.to_address || undefined,
    })
      .then((res) => setFinalFee(String(res?.fee ?? "")))
      .catch(() => setFinalFee(""))
      .finally(() => setFinalFeeLoading(false));
  }, [step, receiverMode, confirmSnapshot]);

  useEffect(() => {
    cooldownRef.current = codeCooldown;
  }, [codeCooldown]);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = window.setInterval(() => setCodeCooldown((prev) => (prev <= 1 ? 0 : prev - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [codeCooldown]);

  const resultWithdrawId = result?.kind === "withdraw" ? result.withdraw_id : undefined;

  useEffect(() => {
    if (!resultWithdrawId || latestWithdrawRecords.length === 0) return;
    const latestRecord = latestWithdrawRecords.find((record) => getRecordWithdrawId(record) === resultWithdrawId);
    if (!latestRecord) return;

    setResult((prev) => {
      if (!prev || prev.kind !== "withdraw" || prev.withdraw_id !== resultWithdrawId) return prev;

      const failureReason = getWithdrawFailureReason(latestRecord, t);
      const recordStatus = normalizeWithdrawStatus(latestRecord.status || prev.status) || prev.status;
      const recordTxHash = getWithdrawTxHash(latestRecord);
      const recordMeta = getWithdrawStatusMeta(recordStatus, failureReason || prev.message, t);
      const txHash = recordTxHash || prev.tx_hash;
      const nextStatus =
        prev.tx_hash && !recordTxHash && !recordMeta.terminal ? prev.status : recordStatus;
      const meta = getWithdrawStatusMeta(nextStatus, failureReason || prev.message, t);
      const nextSnapshot: ConfirmSnapshot = {
        symbol: String(latestRecord.symbol ?? latestRecord.coin_symbol ?? prev.snapshot?.symbol ?? ""),
        network: String(latestRecord.chain_key ?? latestRecord.network ?? latestRecord.network_code ?? prev.snapshot?.network ?? ""),
        to_address: String(latestRecord.to_address ?? prev.snapshot?.to_address ?? ""),
        amount: String(latestRecord.amount ?? prev.snapshot?.amount ?? ""),
      };
      const nextFee = latestRecord.fee != null ? String(latestRecord.fee) : prev.fee;
      const nextMessage = failureReason || prev.message;

      if (
        prev.status === nextStatus &&
        prev.tx_hash === txHash &&
        prev.fee === nextFee &&
        prev.message === nextMessage &&
        prev.ok === (meta.kind !== "failed") &&
        prev.snapshot?.symbol === nextSnapshot.symbol &&
        prev.snapshot?.network === nextSnapshot.network &&
        prev.snapshot?.to_address === nextSnapshot.to_address &&
        prev.snapshot?.amount === nextSnapshot.amount
      ) {
        return prev;
      }

      return {
        ...prev,
        ok: meta.kind !== "failed",
        status: nextStatus,
        message: nextMessage,
        tx_hash: txHash,
        fee: nextFee,
        snapshot: nextSnapshot,
      };
    });
  }, [latestWithdrawRecords, resultWithdrawId, t]);

  const resetFlow = () => {
    setStep(1);
    setConfirmSnapshot(null);
    setWithdrawId(null);
    setVerifyCode("");
    setCodeSent(false);
    setCodeCooldown(0);
    setFee("");
    setFinalFee("");
    setResult(null);
    setInternalError("");
  };

  const resetAll = () => {
    resetFlow();
    setToAddress("");
    setAmount("");
    setRecipientEmail("");
    setRecipientRemark("");
    setResolvedRecipient(null);
    setResolvedRecipientEmail("");
  };

  const changeReceiverMode = (mode: ReceiverMode) => {
    setReceiverMode(mode);
    resetFlow();
    setAmount("");
    onError("");
    setInternalError("");
    if (mode === "onchain") {
      setRecipientEmail("");
      setRecipientRemark("");
      setResolvedRecipient(null);
      setResolvedRecipientEmail("");
    } else {
      setToAddress("");
    }
  };

  const resolveRecipientMut = useMutation({
    mutationFn: async () => {
      setInternalError("");
      if (receiverMode === "onchain") onError("");
      const email = recipientEmail.trim();
      if (!email) throw new Error("email");
      const recipient = await UserTransferAPI.resolveRecipient(email);
      setResolvedRecipient(recipient);
      setResolvedRecipientEmail(email);
      return recipient;
    },
    onSuccess: () => onToast(t("assetWithdrawRecipientConfirmed", "asset")),
    onError: (e: unknown) => {
      setResolvedRecipient(null);
      setResolvedRecipientEmail("");
      setInternalError(getInternalTransferErrorMessage(
        e,
        t("assetWithdrawFailedToConfirmRecipient", "asset"),
        t
      ));
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      setInternalError("");
      if (receiverMode === "onchain") onError("");
      if (withdrawLocked) throw new Error(resolvedWithdrawLockedReason);
      if (!coinSymbol) throw new Error(receiverMode === "internal" ? "select a coin" : t("assetWithdrawPleaseSelectACoin", "asset"));
      if (!amount.trim()) throw new Error(receiverMode === "internal" ? "amount" : t("assetWithdrawPleaseEnterAmount", "asset"));
      if (amountErrorMessage) throw new Error(amountErrorMessage);

      if (receiverMode === "internal") {
        const email = recipientEmail.trim();
        if (!email) throw new Error("email");
        if (!resolvedRecipient || resolvedRecipientEmail !== email || !resolvedRecipient.can_transfer) {
          throw new Error("confirm recipient");
        }
        const requestId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const res = await UserTransferAPI.createTransfer({
          request_id: requestId,
          recipient_email: email,
          symbol: normUpper(coinSymbol),
          amount: amount.trim(),
          remark: recipientRemark.trim() || undefined,
        });
        const record = res.record;
        setResult({
          ok: true,
          kind: "user_transfer",
          status: record.status,
          message: t("assetWithdrawPlatformTransferCompleted", "asset"),
          transfer_no: record.transfer_no,
          snapshot: {
            symbol: record.symbol,
            network: "funding",
            to_address: record.recipient_email_mask,
            amount: record.amount,
          },
          fee: record.fee_amount,
        });
        setStep(3);
        onSuccessVerified();
        return;
      }

      if (!networkCode) throw new Error(t("assetWithdrawPleaseSelectWithdrawNetwork", "asset"));
      if (!toAddress.trim()) throw new Error(t("assetWithdrawPleaseEnterWithdrawAddress", "asset"));
      const snap: ConfirmSnapshot = {
        symbol: normUpper(coinSymbol),
        network: networkCode,
        to_address: toAddress.trim(),
        amount: amount.trim(),
      };
      setConfirmSnapshot(snap);
      const res = await WithdrawAPI.createWithdraw({
        symbol: snap.symbol,
        network: snap.network,
        to_address: snap.to_address,
        amount: snap.amount,
      });
      const id = res?.withdraw_id;
      if (!id) throw new Error(t("assetWithdrawWithdrawIdWasNotReturned", "asset"));
      const nextStatus = normUpper(res?.status || "VERIFYING");
      const needManualReview = Boolean(res?.need_manual_review) || nextStatus === "REVIEWING";
      setWithdrawId(Number(id));
      setVerifyCode("");
      setCodeSent(false);
      setCodeCooldown(0);
      if (needManualReview) {
        setResult({
          ok: true,
          kind: "withdraw",
          status: "REVIEWING",
          message: t("assetWithdrawThisOnChainWithdrawIsUnderManualReview", "asset"),
          withdraw_id: Number(id),
          snapshot: snap,
          fee: String(res?.fee_estimate ?? fee ?? ""),
        });
        setStep(3);
        onSuccessVerified();
        return;
      }
      setResult(null);
      setStep(2);
    },
    onError: (e: unknown) => {
      if (receiverMode === "internal") {
        setInternalError(getInternalTransferErrorMessage(
          e,
          t("assetWithdrawPlatformTransferSubmissionFailed", "asset"),
          t
        ));
        return;
      }
      onError(mapWithdrawUserMessage(getErrorMessage(e, t("assetWithdrawSubmissionFailed", "asset")), t));
    },
  });

  const sendCodeMut = useMutation({
    mutationFn: async () => {
      onError("");
      if (withdrawLocked) throw new Error(resolvedWithdrawLockedReason);
      if (!withdrawId) throw new Error(t("assetWithdrawMissingWithdrawId", "asset"));
      await WithdrawAPI.sendWithdrawCode({ withdraw_id: withdrawId });
      setCodeSent(true);
      setCodeCooldown(60);
      onToast(t("assetWithdrawVerificationCodeSent", "asset"));
    },
    onError: (e: unknown) => onError(mapWithdrawUserMessage(getErrorMessage(e, t("assetWithdrawFailedToSendVerificationCode", "asset")), t)),
  });

  const confirmMut = useMutation({
    mutationFn: async () => {
      onError("");
      if (withdrawLocked) throw new Error(resolvedWithdrawLockedReason);
      if (!withdrawId) throw new Error(t("assetWithdrawMissingWithdrawId", "asset"));
      const code = clampDigits(verifyCode, 6);
      if (!code || code.length < 4) throw new Error(t("assetWithdrawPleaseEnterVerificationCode", "asset"));
      const snap = confirmSnapshot;
      if (!snap) throw new Error(t("assetWithdrawConfirmationInformationIsMissing", "asset"));
      const resConfirm = await WithdrawAPI.confirmWithdraw({ withdraw_id: withdrawId, code });
      if (String(resConfirm?.status ?? "") !== "FROZEN") {
        throw new Error(resConfirm?.message || t("assetWithdrawVerificationCodeCheckFailed", "asset"));
      }

      const currentWithdrawId = withdrawId;
      const resultFee = String((resConfirm?.fee_final ?? finalFee) || fee || "");
      setResult({
        ok: true,
        kind: "withdraw",
        status: "FROZEN",
        message: "",
        withdraw_id: currentWithdrawId,
        snapshot: snap,
        fee: resultFee,
      });
      setStep(3);
      setVerifyCode("");
      setCodeSent(false);
      setCodeCooldown(0);
      onSuccessVerified();

      void (async () => {
        try {
          const resSend = await WithdrawAPI.sendWithdrawTx({ withdraw_id: currentWithdrawId });
          const st = normalizeWithdrawStatus(resSend?.status || "PROCESSING") || "PROCESSING";
          const txHash = String(resSend?.tx_hash ?? "").trim();
          if (!resSend?.ok || st === "FAILED" || st === "REJECTED") {
            throw new Error(resSend?.error || t("assetWithdrawAssetSendingFailed", "asset"));
          }
          setResult((prev) => {
            if (!prev || prev.kind !== "withdraw" || prev.withdraw_id !== currentWithdrawId) return prev;
            return {
              ...prev,
              ok: true,
              status: st,
              tx_hash: txHash || prev.tx_hash,
              message: prev.message,
            };
          });
        } catch (error) {
          console.warn("withdraw send task submit failed", error);
          setResult((prev) => {
            if (!prev || prev.kind !== "withdraw" || prev.withdraw_id !== currentWithdrawId) return prev;
            return {
              ...prev,
              ok: true,
              status: "FROZEN",
              message: mapWithdrawUserMessage(withdrawSendSubmitFailedMessage, t),
            };
          });
          onToast(mapWithdrawUserMessage(withdrawSendSubmitFailedMessage, t));
        } finally {
          onSuccessVerified();
        }
      })();
    },
    onError: (e: unknown) => {
      const msg = mapWithdrawUserMessage(getErrorMessage(e, t("assetWithdrawConfirmationFailed", "asset")), t);
      onError(msg);
      setResult({
        ok: false,
        kind: "withdraw",
        status: "FAILED",
        message: msg,
        withdraw_id: withdrawId ?? undefined,
        snapshot: confirmSnapshot ?? undefined,
        fee: finalFee || fee || "",
      });
    },
  });

  const internalReady =
    receiverMode === "internal" &&
    recipientEmail.trim() &&
    resolvedRecipient &&
    resolvedRecipientEmail === recipientEmail.trim();
  const step1Disabled =
    createMut.isPending ||
    withdrawLocked ||
    !coinSymbol ||
    !amount.trim() ||
    Boolean(amountErrorMessage) ||
    amountInvalid ||
    amountTooLarge ||
    amountTooSmall ||
    amountBelowMin ||
    noWithdrawOptions ||
    (receiverMode === "onchain" && (!networkCode || !toAddress.trim())) ||
    (receiverMode === "internal" && !internalReady);
  const sendDisabled = withdrawLocked || sendCodeMut.isPending || !withdrawId || codeCooldown > 0;
  const confirmDisabled =
    withdrawLocked ||
    confirmMut.isPending ||
    !withdrawId ||
    clampDigits(verifyCode, 6).length < 4 ||
    Boolean(
      confirmSnapshot &&
        finalFee !== "" &&
        normUpper(confirmSnapshot.symbol) === feeCoin &&
        toNum(confirmSnapshot.amount) + toNum(finalFee) > currentBalance.availableNum
    );

  const resultStatusMeta =
    result?.kind === "withdraw" ? getWithdrawStatusMeta(result.status, result.message, t) : null;
  const resultProgress =
    result?.kind === "withdraw" ? getWithdrawProgress(result.status, t) : null;
  const resultTitle =
    result?.kind === "user_transfer"
      ? t("assetWithdrawPlatformTransferCompleted", "asset")
      : resultStatusMeta?.title ?? (result?.ok
        ? t("assetWithdrawOnChainWithdrawSubmitted", "asset")
        : t("assetWithdrawOnChainWithdrawFailed", "asset"));
  const resultMessage =
    result?.kind === "user_transfer"
      ? result.message || t("assetWithdrawPlatformTransferCompleted", "asset")
      : (result?.message || resultStatusMeta?.message) ?? (result?.ok
        ? t("assetWithdrawTheSystemIsProcessingYourRequest", "asset")
        : t("assetWithdrawPleaseTryAgainLater", "asset"));
  const resultBadgeClass =
    result?.kind === "withdraw"
      ? resultStatusMeta?.className
      : result?.ok
        ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
        : "border-red-500/30 text-red-300 bg-red-500/10";
  const resultBadgeText =
    result?.kind === "withdraw" ? resultStatusMeta?.badge ?? result.status : result?.ok
      ? t("assetWithdrawSuccess", "asset")
      : t("assetWithdrawFailed", "asset");

  const formatWithdrawDeductDisplay = (withdrawAmount: unknown, withdrawSymbol: string, feeValue: unknown) => {
    const normalizedSymbol = normUpper(withdrawSymbol);
    const feeText = formatCoinAmount(feeValue, 3);
    if (normalizedSymbol === feeCoin) {
      return `${formatCoinAmount(toNum(withdrawAmount) + toNum(feeValue), amountPrecision)} ${feeCoin}`;
    }
    return `${formatCoinAmount(withdrawAmount, amountPrecision)} ${withdrawSymbol} + ${feeText} ${feeCoin}`;
  };

  const finalFeeDisplay = finalFeeLoading ? "..." : finalFee === "" ? "--" : `${formatCoinAmount(finalFee, 3)} ${feeCoin}`;
  const finalNetDisplay =
    !confirmSnapshot || finalFeeLoading || finalFee === ""
      ? finalFeeLoading
        ? "..."
        : "--"
      : `${formatCoinAmount(confirmSnapshot.amount, amountPrecision)} ${confirmSnapshot.symbol}`;
  const finalTotalDebitDisplay =
    !confirmSnapshot || finalFeeLoading || finalFee === ""
      ? finalFeeLoading
        ? "..."
        : "--"
      : formatWithdrawDeductDisplay(confirmSnapshot.amount, confirmSnapshot.symbol, finalFee);
  const resultTotalDebitDisplay =
    result?.snapshot && result?.fee
      ? formatWithdrawDeductDisplay(result.snapshot.amount, result.snapshot.symbol, result.fee)
      : result?.snapshot
        ? `${formatCoinAmount(result.snapshot.amount, amountPrecision)} ${result.snapshot.symbol}`
        : "--";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5">
      <div className="p-5 border-b border-white/10">
        <div className="text-lg font-semibold">{t("assetWithdrawWithdraw", "asset")}</div>
        <div className="mt-1 text-sm text-white/60">
          {t("assetWithdrawSelectOnChainWithdrawOrPlatformTransfer", "asset")}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {withdrawLocked ? (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {resolvedWithdrawLockedReason}
          </div>
        ) : null}

        {step === 1 && (
          <>
            <div className="space-y-2">
              <div className="text-sm text-white/80">{t("assetWithdrawCoin", "asset")}</div>
              {noWithdrawOptions ? (
                <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/50">
                  {t("assetWithdrawNoWithdrawableCoins", "asset")}
                </div>
              ) : null}
              <CoinSelect
                value={coinSymbol}
                options={coinOptions}
                disabled={noWithdrawOptions}
                placeholder={t("assetWithdrawPleaseSelectACoin", "asset")}
                ariaLabel={t("assetWithdrawSelectCoin", "asset")}
                onChange={(next) => {
                  setCoinSymbol(next);
                  setAmount("");
                  setResolvedRecipient(null);
                  setResolvedRecipientEmail("");
                  onError("");
                }}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm text-white/80">{t("assetWithdrawRecipientMethod", "asset")}</div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => changeReceiverMode("onchain")}
                  className={clsx(
                    "rounded-xl px-4 py-2 text-sm border",
                    receiverMode === "onchain"
                      ? "border-white/20 bg-white/10"
                      : "border-white/10 bg-black/10 text-white/70 hover:border-white/20"
                  )}
                >
                  {t("assetWithdrawOnChainWithdraw", "asset")}
                </button>
                <button
                  type="button"
                  onClick={() => changeReceiverMode("internal")}
                  className={clsx(
                    "rounded-xl px-4 py-2 text-sm border",
                    receiverMode === "internal"
                      ? "border-white/20 bg-white/10"
                      : "border-white/10 bg-black/10 text-white/70 hover:border-white/20"
                  )}
                >
                  {t("assetWithdrawPlatformTransfer", "asset")}
                </button>
              </div>
            </div>

            {receiverMode === "onchain" ? (
              <>
                <div className="space-y-2">
                  <div className="text-sm text-white/80">{t("assetWithdrawWithdrawNetwork", "asset")}</div>
                  <NetworkSelect
                    value={networkCode}
                    options={networkSelectOptions}
                    placeholder={t("assetWithdrawPleaseSelectNetwork", "asset")}
                    disabled={noWithdrawOptions || !coinSymbol}
                    ariaLabel={t("assetWithdrawSelectWithdrawNetwork", "asset")}
                    onChange={(next) => {
                      setNetworkCode(next);
                      setAmount("");
                      onError("");
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm text-white/80">{t("assetWithdrawWithdrawAddress", "asset")}</div>
                  <input
                    value={toAddress}
                    onChange={(e) => setToAddress(e.target.value)}
                    placeholder={t("withdrawAddressPlaceholder", "asset")}
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm outline-none focus:border-white/20"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-4">
                <div className="space-y-2">
                  <div className="text-sm text-white/80">{t("assetWithdrawRecipientEmail", "asset")}</div>
                  <div className="flex gap-3">
                    <input
                      value={recipientEmail}
                      onChange={(e) => {
                        setRecipientEmail(e.target.value);
                        setResolvedRecipient(null);
                        setResolvedRecipientEmail("");
                      }}
                      placeholder={t("withdrawEmailPlaceholder", "asset")}
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm outline-none focus:border-white/20"
                    />
                    <button
                      type="button"
                      onClick={() => resolveRecipientMut.mutate()}
                      disabled={resolveRecipientMut.isPending || !recipientEmail.trim()}
                      className={clsx(
                        "rounded-xl px-4 py-3 text-sm font-semibold whitespace-nowrap",
                        resolveRecipientMut.isPending || !recipientEmail.trim()
                          ? "bg-white/10 text-white/40"
                          : "bg-white text-black hover:bg-white/90"
                      )}
                    >
                      {resolveRecipientMut.isPending
                        ? t("assetWithdrawConfirming", "asset")
                        : t("assetWithdrawConfirmRecipient", "asset")}
                    </button>
                  </div>
                </div>

                {resolvedRecipient ? (
                  <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                    {resolvedRecipient.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={resolvedRecipient.avatar_url} alt="" className="h-9 w-9 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sm text-white/70">
                        {resolvedRecipient.email_mask.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white/90">
                        {resolvedRecipient.nickname || t("assetWithdrawNicknameNotSet", "asset")}
                      </div>
                      <div className="truncate text-xs text-white/55">{resolvedRecipient.email_mask}</div>
                    </div>
                  </div>
                ) : null}

              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm text-white/80">{t("assetWithdrawAmount", "asset")}</div>
                <button
                  type="button"
                  onClick={() => {
                    if (currentBalance.availableNum <= 0) {
                      setAmount("");
                      if (receiverMode === "internal") {
                        setInternalError(t("assetWithdrawInsufficientFundingAccountAvailableBalance", "asset"));
                      } else {
                        onError(t("assetWithdrawInsufficientFundingAccountAvailableBalance", "asset"));
                      }
                      return;
                    }
                    onError("");
                    setInternalError("");
                    setAmount(formatCoinAmount(currentBalance.availableNum, amountPrecision, false));
                  }}
                  className="text-xs text-white/70 hover:text-white"
                >
                  {t("assetWithdrawAll", "asset")}
                </button>
              </div>
              <input
                value={amount}
                onChange={(e) => setAmount(clampDecimals(e.target.value, amountPrecision))}
                placeholder={t("assetWithdrawPleaseEnterAmount", "asset")}
                inputMode="decimal"
                className={clsx(
                  "w-full rounded-xl border bg-black/20 px-4 py-3 text-sm outline-none",
                  amountErrorMessage ? "border-red-500/40 focus:border-red-500/60" : "border-white/10 focus:border-white/20"
                )}
              />
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/50">
                  {t("assetWithdrawAvailable", "asset")} <span className="text-white/70">{formatCoinAmount(currentBalance.availableNum, amountPrecision)} {coinSymbol}</span>
                </span>
                {receiverMode === "onchain" && amountErrorMessage ? <span className="text-red-400">{amountErrorMessage}</span> : null}
              </div>
            </div>

            {receiverMode === "internal" ? (
              <div className="space-y-2">
                <div className="text-sm text-white/80">{t("assetWithdrawRemarkOptional", "asset")}</div>
                <input
                  value={recipientRemark}
                  onChange={(e) => setRecipientRemark(e.target.value)}
                  maxLength={255}
                  placeholder={t("assetWithdrawAddRemark", "asset")}
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm outline-none focus:border-white/20"
                />
                {(internalError || amountErrorMessage) ? (
                  <div className="text-xs text-red-400">{internalError || amountErrorMessage}</div>
                ) : null}
              </div>
            ) : null}

            {receiverMode === "onchain" && currentBalance.availableNum <= 0 ? (
              <div className="text-xs text-amber-300">
                {t("assetWithdrawWithdrawsAndPlatformTransfersBothUseTheFundingAccountAvailable", "asset")}
              </div>
            ) : null}

            {receiverMode === "onchain" && (feeLoading || fee) ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-white/60">{t("assetWithdrawEstimatedNetworkFee", "asset")}</span>
                  <span className="font-medium">{feeLoading ? "..." : `${formatCoinAmount(feeNum, 3)} ${feeCoin}`}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-white/60">{t("assetWithdrawEstimatedArrivalAmount", "asset")}</span>
                  <span className="font-medium">
                    {feeLoading ? "..." : `${formatCoinAmount(amountNum, amountPrecision)} ${coinSymbol}`}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-white/60">{t("assetWithdrawEstimatedTotalDebit", "asset")}</span>
                  <span className="font-medium">
                    {feeLoading ? "..." : formatWithdrawDeductDisplay(amountNum, coinSymbol, feeNum)}
                  </span>
                </div>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={step1Disabled}
              className={clsx(
                "w-full rounded-xl py-3 text-sm font-semibold",
                step1Disabled ? "bg-white/10 text-white/40" : "bg-white text-black hover:bg-white/90"
              )}
            >
              {receiverMode === "internal"
                ? t("assetWithdrawConfirmPlatformTransfer", "asset")
                : t("assetWithdrawSubmitOnChainWithdraw", "asset")}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="rounded-xl border border-sky-400/20 bg-sky-500/10 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-white">{t("assetWithdrawWithdrawRequestSubmitted", "asset")}</div>
                  <div className="mt-1 text-sm text-white/60">{t("assetWithdrawYouCanViewProgressInWithdrawRecordsBelow", "asset")}</div>
                </div>
                <div className="rounded-full border border-sky-300/30 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-100">
                  {t("assetWithdrawPendingVerification", "asset")}
                </div>
              </div>
              <div className="mt-4">
                <WithdrawProgressStepper status="VERIFYING" />
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm">
              <div className="font-medium text-white/80">{t("assetWithdrawConfirmOnChainWithdrawDetails", "asset")}</div>
              <div className="mt-3 space-y-2 text-white/70">
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawCoin", "asset")}</span><span>{confirmSnapshot?.symbol ?? "-"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawWithdrawNetwork", "asset")}</span><span>{confirmSnapshot ? formatNetworkLabel(confirmSnapshot.network) : "-"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawWithdrawAddress", "asset")}</span><span>{confirmSnapshot ? maskAddress(confirmSnapshot.to_address) : "-"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawArrivalAmount", "asset")}</span><span>{confirmSnapshot ? `${formatCoinAmount(confirmSnapshot.amount, amountPrecision)} ${confirmSnapshot.symbol}` : "-"}</span></div>
                <div className="pt-2 border-t border-white/10" />
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawNetworkFee", "asset")}</span><span>{finalFeeDisplay}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawFinalArrivalAmount", "asset")}</span><span>{finalNetDisplay}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawTotalDebit", "asset")}</span><span>{finalTotalDebitDisplay}</span></div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-white/80">{t("assetWithdrawEmailVerification", "asset")}</div>
                  <div className="mt-1 text-white/60">{t("assetWithdrawSendAndEnterTheVerificationCodeToConfirmTheOn", "asset")}</div>
                </div>
                <button
                  type="button"
                  onClick={() => sendCodeMut.mutate()}
                  disabled={sendDisabled}
                  className={clsx(
                    "rounded-xl px-4 py-2 text-sm font-semibold whitespace-nowrap",
                    sendDisabled ? "bg-white/10 text-white/40" : "bg-white text-black hover:bg-white/90"
                  )}
                >
                  {codeCooldown > 0 ? `${codeCooldown}s` : codeSent
                    ? t("assetWithdrawResend", "asset")
                    : t("assetWithdrawSendCode", "asset")}
                </button>
              </div>
              <div className="mt-4 space-y-2">
                <div className="text-sm text-white/80">{t("assetWithdrawVerificationCode", "asset")}</div>
                <input
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(clampDigits(e.target.value, 6))}
                  placeholder={t("assetWithdrawPleaseEnterVerificationCode", "asset")}
                  inputMode="numeric"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm outline-none focus:border-white/20"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setVerifyCode("");
                  setCodeSent(false);
                  setCodeCooldown(0);
                }}
                className="w-full rounded-xl py-3 text-sm font-semibold border border-white/10 bg-black/10 hover:border-white/20"
              >
                {t("assetWithdrawPrevious", "asset")}
              </button>
              <button
                type="button"
                onClick={() => confirmMut.mutate()}
                disabled={!!confirmDisabled}
                className={clsx(
                  "w-full rounded-xl py-3 text-sm font-semibold",
                  confirmDisabled ? "bg-white/10 text-white/40" : "bg-white text-black hover:bg-white/90"
                )}
              >
                {t("assetWithdrawConfirmSubmit", "asset")}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <div className="rounded-xl border border-white/10 bg-black/20 p-5">
            {result?.kind === "withdraw" && result.ok ? (
              <div className="mb-4 rounded-xl border border-sky-400/20 bg-sky-500/10 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-white">{t("assetWithdrawWithdrawRequestSubmitted", "asset")}</div>
                    <div className="mt-1 text-sm text-white/60">{t("assetWithdrawYouCanViewProgressInWithdrawRecordsBelow", "asset")}</div>
                  </div>
                  <div className="rounded-full border border-sky-300/30 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-100">
                    {resultProgress?.caption ?? t("assetWithdrawRecordsProcessing", "asset")}
                  </div>
                </div>
                <div className="mt-4">
                  <WithdrawProgressStepper status={result.status} />
                </div>
              </div>
            ) : null}

            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{resultTitle}</div>
                <div className="mt-1 text-sm text-white/60">{resultMessage}</div>
              </div>
              <div className={clsx("inline-flex min-w-fit flex-shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold border", resultBadgeClass)}>
                {resultBadgeText}
              </div>
            </div>

            <div className="mt-4 border-t border-white/10 pt-4 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-white/70">
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawRecordNo", "asset")}</span><span>{result?.transfer_no ?? result?.withdraw_id ?? "--"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawCoin", "asset")}</span><span>{result?.snapshot?.symbol ?? "--"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawMethod", "asset")}</span><span>{result?.kind === "user_transfer" ? t("assetWithdrawPlatformTransfer", "asset") : result?.snapshot?.network ?? "--"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawRecipient", "asset")}</span><span>{result?.snapshot ? maskAddress(result.snapshot.to_address) : "--"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawArrivalAmount", "asset")}</span><span>{result?.snapshot ? `${formatCoinAmount(result.snapshot.amount, amountPrecision)} ${result.snapshot.symbol}` : "--"}</span></div>
                <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawFee", "asset")}</span><span>{result?.fee ? `${formatCoinAmount(result.fee, 3)} ${feeCoin}` : "0"}</span></div>
                {result?.kind === "withdraw" ? (
                  <div className="flex justify-between"><span className="text-white/50">{t("assetWithdrawTotalDebit", "asset")}</span><span>{resultTotalDebitDisplay}</span></div>
                ) : null}
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  resetAll();
                  onSuccessVerified();
                }}
                className="w-full rounded-xl py-3 text-sm font-semibold bg-white text-black hover:bg-white/90"
              >
                {t("assetWithdrawDone", "asset")}
              </button>
              <button
                type="button"
                onClick={() => resetAll()}
                className="w-full rounded-xl py-3 text-sm font-semibold border border-white/10 bg-black/10 hover:border-white/20"
              >
                {t("assetWithdrawMakeAnother", "asset")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
