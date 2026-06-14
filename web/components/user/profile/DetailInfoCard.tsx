"use client";

import React from "react";
import { useRouter } from "next/navigation";
import type { UserInfo } from "@/lib/api";
import { updateMe, updatePhone, uploadAvatar } from "@/lib/api";
import { useAuth } from "@/lib/authContext";
import UserAvatar from "@/components/user/UserAvatar";
import { getUserDisplayName } from "@/lib/userAvatar";
import { useLocaleContext } from "@/contexts/LocaleContext";

type Props = {
  userInfo: UserInfo;
  onUserInfoChange?: (next: UserInfo) => void;
  onRefresh?: () => Promise<void> | void;
};

type EditField = "username" | "nickname";
type KycView = {
  statusLabel: string;
  levelLabel: string;
  title: string;
  description: string;
  button: string;
  badgeClass: string;
};

type CompressionMeta = {
  file: File;
  originalBytes: number;
  compressedBytes: number;
};

type UserTranslator = (key: string, namespace?: "user") => string;

const KYC_VERIFY_PATH = "/user/kyc";
const PHONE_PATTERN = /^[+\d][+\d\s-]{5,19}$/;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const FORMATTABLE_COUNTRY_CODES = new Set([
  "1",
  "7",
  "20",
  "27",
  "30",
  "31",
  "32",
  "33",
  "34",
  "36",
  "39",
  "40",
  "41",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "81",
  "82",
  "84",
  "86",
  "90",
  "91",
  "92",
  "93",
  "94",
  "95",
  "98",
  "211",
  "212",
  "213",
  "216",
  "218",
  "220",
  "221",
  "222",
  "223",
  "224",
  "225",
  "226",
  "227",
  "228",
  "229",
  "230",
  "231",
  "232",
  "233",
  "234",
  "235",
  "236",
  "237",
  "238",
  "239",
  "240",
  "241",
  "242",
  "243",
  "244",
  "245",
  "246",
  "248",
  "249",
  "250",
  "251",
  "252",
  "253",
  "254",
  "255",
  "256",
  "257",
  "258",
  "260",
  "261",
  "262",
  "263",
  "264",
  "265",
  "266",
  "267",
  "268",
  "269",
  "290",
  "291",
  "297",
  "298",
  "299",
  "350",
  "351",
  "352",
  "353",
  "354",
  "355",
  "356",
  "357",
  "358",
  "359",
  "370",
  "371",
  "372",
  "373",
  "374",
  "375",
  "376",
  "377",
  "378",
  "379",
  "380",
  "381",
  "382",
  "383",
  "385",
  "386",
  "387",
  "389",
  "420",
  "421",
  "423",
  "500",
  "501",
  "502",
  "503",
  "504",
  "505",
  "506",
  "507",
  "508",
  "509",
  "590",
  "591",
  "592",
  "593",
  "594",
  "595",
  "596",
  "597",
  "598",
  "599",
  "670",
  "672",
  "673",
  "674",
  "675",
  "676",
  "677",
  "678",
  "679",
  "680",
  "681",
  "682",
  "683",
  "685",
  "686",
  "687",
  "688",
  "689",
  "690",
  "691",
  "692",
  "850",
  "852",
  "853",
  "855",
  "856",
  "870",
  "971",
  "972",
  "973",
  "974",
  "975",
  "976",
  "977",
  "992",
  "993",
  "994",
  "995",
  "996",
  "998",
]);

function formatDisplayPhone(phone: string | null | undefined, t: UserTranslator) {
  if (!phone) return t("profileNotFilled", "user");
  const trimmed = phone.trim();
  if (!trimmed) return t("profileNotFilled", "user");
  if (!trimmed.startsWith("+")) {
    const compact = trimmed.replace(/\s+/g, "");
    if (!/^\d+$/.test(compact)) {
      return trimmed;
    }

    if (compact.length <= 2) return compact;

    for (let i = 3; i >= 1; i--) {
      const countryCode = compact.slice(0, i);
      const localNumber = compact.slice(i);
      if (FORMATTABLE_COUNTRY_CODES.has(countryCode) && localNumber.length > 0) {
        return `+${countryCode} ${localNumber}`;
      }
    }

    const fallbackCountryCode = compact.slice(0, 2);
    const fallbackLocalNumber = compact.slice(2);
    return `+${fallbackCountryCode} ${fallbackLocalNumber}`;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  if (!/^\+\d+$/.test(normalized)) return trimmed;

  const digits = normalized.slice(1);
  for (let i = 3; i >= 1; i--) {
    const countryCode = digits.slice(0, i);
    const localNumber = digits.slice(i);
    if (FORMATTABLE_COUNTRY_CODES.has(countryCode) && localNumber.length > 0) {
      return `+${countryCode} ${localNumber}`;
    }
  }

  return trimmed;
}

function formatDateTime(value?: string | null, locale = "en") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email || "-";
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function formatText(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce((next, [key, value]) => next.replaceAll(`{${key}}`, value), template);
}

function normalizeError(error: unknown, t: UserTranslator, fallback = t("profileActionFailed", "user")) {
  if (error instanceof Error) {
    const message = error.message || fallback;
    if (message.toLowerCase().includes("failed to fetch") || message.toLowerCase().includes("network")) {
      return fallback;
    }
    return message;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; detail?: { message?: unknown } };
    const code = String(record.code || "");
    const message = String(record.message || record.detail?.message || fallback);
    if (code === "NETWORK_ERROR" || message.toLowerCase().includes("failed to fetch")) return fallback;
    if (code === "PHONE_TAKEN" || message.includes("Phone already exists")) return t("profilePhoneTaken", "user");
    if (code === "VALIDATION_ERROR" || message.includes("invalid phone") || message.includes("Invalid request payload")) {
      return t("profilePhoneInvalid", "user");
    }
    return message;
  }
  return fallback;
}

function normalizePhoneError(error: unknown, t: UserTranslator) {
  return normalizeError(error, t, t("profilePhoneInvalidRetry", "user"));
}

function getAccountStatusText(status: UserInfo["accountStatus"], t: UserTranslator) {
  if (status === "active") return t("profileAccountActive", "user");
  if (status === "frozen") return t("profileAccountFrozen", "user");
  if (status === "banned") return t("profileAccountBanned", "user");
  return t("profileAccountUnknown", "user");
}

function getKycView(userInfo: UserInfo, t: UserTranslator): KycView {
  const status = String(userInfo.kycStatus || "").toUpperCase();
  const level = Number(userInfo.kycLevel || 0);

  if (status === "PENDING") {
    return {
      statusLabel: t("profileKycPending", "user"),
      levelLabel: level > 0 ? `Level ${level}` : t("profileKycPending", "user"),
      title: t("profileKycPendingTitle", "user"),
      description: t("profileKycPendingDesc", "user"),
      button: t("profileViewDetails", "user"),
      badgeClass: "border-amber-300/30 bg-amber-300/10 text-amber-200",
    };
  }

  if (status === "APPROVED" || level > 0) {
    return {
      statusLabel: t("profileKycVerified", "user"),
      levelLabel: level > 0 ? `Level ${level}` : t("profileKycIdentity", "user"),
      title: t("profileKycVerifiedTitle", "user"),
      description: t("profileKycVerifiedDesc", "user"),
      button: t("profileViewDetails", "user"),
      badgeClass: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    };
  }

  if (status === "REJECTED") {
    return {
      statusLabel: t("profileKycRejected", "user"),
      levelLabel: t("profileKycRejected", "user"),
      title: t("profileKycRejectedTitle", "user"),
      description: t("profileKycRejectedDesc", "user"),
      button: t("profileViewDetails", "user"),
      badgeClass: "border-red-400/30 bg-red-400/10 text-red-300",
    };
  }

  return {
    statusLabel: t("profileKycNotSubmitted", "user"),
    levelLabel: t("profileKycNotSubmitted", "user"),
    title: t("profileKycNotSubmittedTitle", "user"),
    description: t("profileKycNotSubmittedDesc", "user"),
    button: t("profileGoVerify", "user"),
    badgeClass: "border-white/10 bg-white/[0.04] text-white/60",
  };
}

function formatFileSize(bytes: number) {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function createCompressedAvatar(file: File, t: UserTranslator): Promise<CompressionMeta> {
  return new Promise((resolve, reject) => {
    const originalBytes = file.size;
    if (!file.type.startsWith("image/")) {
      reject(new Error(t("profileSelectImageFile", "user")));
      return;
    }

    const fileName = file.name.replace(/\.[^.]+$/, "") || "avatar";
    const encodeBlob = (
      canvas: HTMLCanvasElement,
      type: "image/webp" | "image/jpeg",
      quality: number,
    ): Promise<Blob | null> =>
      new Promise((resolveBlob) => {
        canvas.toBlob((blob) => resolveBlob(blob), type, quality);
      });

    const image = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      image.onload = () => {
        const maxSide = 512;
        const ratio = Math.min(1, Math.min(maxSide / image.naturalWidth, maxSide / image.naturalHeight));
        const targetWidth = Math.max(1, Math.round(image.naturalWidth * ratio));
        const targetHeight = Math.max(1, Math.round(image.naturalHeight * ratio));

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext("2d");
        if (!context) {
            reject(new Error(t("profileImageProcessFailed", "user")));
          return;
        }

        try {
          context.clearRect(0, 0, targetWidth, targetHeight);
          context.drawImage(image, 0, 0, targetWidth, targetHeight);
        } catch {
            reject(new Error(t("profileImageProcessFailed", "user")));
          return;
        }

        void (async () => {
          let blob = await encodeBlob(canvas, "image/webp", 0.8);
          let suffix = "webp";
          if (!blob) {
            blob = await encodeBlob(canvas, "image/jpeg", 0.82);
            suffix = "jpg";
          }
          if (!blob) {
            resolve({
              file,
              originalBytes,
              compressedBytes: originalBytes,
            });
            return;
          }

          resolve({
            file: new File([blob], `${fileName}.${suffix}`, {
              type: blob.type || file.type,
            }),
            originalBytes,
            compressedBytes: blob.size,
          });
        })();
      };
      image.onerror = () => {
            reject(new Error(t("profileImageProcessFailed", "user")));
      };
      image.src = reader.result as string;
    };
    reader.onerror = () => {
            reject(new Error(t("profileImageProcessFailed", "user")));
    };
    reader.readAsDataURL(file);
  });
}

function ActionModal({
  title,
  value,
  error,
  saving,
  placeholder,
  cancelLabel,
  confirmLabel,
  confirmingLabel,
  onChange,
  onCancel,
  onSave,
}: {
  title: string;
  value: string;
  error?: string;
  saving: boolean;
  placeholder: string;
  cancelLabel: string;
  confirmLabel: string;
  confirmingLabel: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="font-semibold text-white">{title}</div>
          <button type="button" className="text-white/60 hover:text-white" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
        <input
          className="w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none placeholder:text-zinc-600 focus:border-amber-500"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            className="rounded bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
            onClick={onCancel}
            disabled={saving}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="rounded bg-amber-500 px-4 py-2 text-sm text-white hover:bg-amber-600 disabled:opacity-60"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PhoneActionModal({
  title,
  countryCode,
  phoneNumber,
  error,
  saving,
  countryCodePlaceholder,
  countryCodeAriaLabel,
  phonePlaceholder,
  phoneAriaLabel,
  cancelLabel,
  confirmLabel,
  confirmingLabel,
  onCountryCodeChange,
  onPhoneNumberChange,
  onCancel,
  onSave,
}: {
  title: string;
  countryCode: string;
  phoneNumber: string;
  error?: string;
  saving: boolean;
  countryCodePlaceholder: string;
  countryCodeAriaLabel: string;
  phonePlaceholder: string;
  phoneAriaLabel: string;
  cancelLabel: string;
  confirmLabel: string;
  confirmingLabel: string;
  onCountryCodeChange: (value: string) => void;
  onPhoneNumberChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="font-semibold text-white">{title}</div>
          <button type="button" className="text-white/60 hover:text-white" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            className="w-28 rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none placeholder:text-zinc-600 focus:border-amber-500"
            value={countryCode}
            onChange={(event) => onCountryCodeChange(event.target.value)}
            placeholder={countryCodePlaceholder}
            aria-label={countryCodeAriaLabel}
          />
          <input
            className="min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none placeholder:text-zinc-600 focus:border-amber-500"
            value={phoneNumber}
            onChange={(event) => onPhoneNumberChange(event.target.value)}
            placeholder={phonePlaceholder}
            aria-label={phoneAriaLabel}
          />
        </div>
        {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            className="rounded bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
            onClick={onCancel}
            disabled={saving}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="rounded bg-amber-500 px-4 py-2 text-sm text-white hover:bg-amber-600 disabled:opacity-60"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DetailInfoCard({ userInfo, onUserInfoChange, onRefresh }: Props) {
  const { locale, t } = useLocaleContext();
  const router = useRouter();
  const { patchCurrentUser } = useAuth();
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const [editField, setEditField] = React.useState<EditField | null>(null);
  const [editValue, setEditValue] = React.useState("");
  const [phoneOpen, setPhoneOpen] = React.useState(false);
  const [phoneCountryCode, setPhoneCountryCode] = React.useState("");
  const [phoneNumberValue, setPhoneNumberValue] = React.useState("");
  const [modalError, setModalError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [avatarMessage, setAvatarMessage] = React.useState("");
  const [avatarPreview, setAvatarPreview] = React.useState("");

  React.useEffect(() => () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  }, [avatarPreview]);

  const kyc = getKycView(userInfo, t);
  const displayName = getUserDisplayName(userInfo) || "U";
  const avatarLetter = displayName.charAt(0).toUpperCase() || "U";
  const accountStatusText = getAccountStatusText(userInfo.accountStatus, t);
  const phoneText = formatDisplayPhone(userInfo.phone, t);
  const nicknameText = (userInfo.nickname || "").trim();
  const usernameText = (userInfo.username || "").trim();
  const shouldShowUsername = Boolean(nicknameText && usernameText && nicknameText !== usernameText);

  const openNameEdit = (field: EditField) => {
    setEditField(field);
    setEditValue(field === "username" ? userInfo.username || "" : userInfo.nickname || "");
    setModalError("");
  };

  const saveNameEdit = async () => {
    const value = editValue.trim();
    if (!value || !editField) {
      setModalError(t("profileEnterContent", "user"));
      return;
    }

    setSaving(true);
    setModalError("");
    try {
      const next = await updateMe({ [editField]: value });
      onUserInfoChange?.(next);
      setEditField(null);
      await onRefresh?.();
    } catch (error) {
      setModalError(normalizeError(error, t));
    } finally {
      setSaving(false);
    }
  };

  const savePhone = async () => {
    const nextCountryCode = phoneCountryCode.trim();
    const nextPhoneNumber = phoneNumberValue.trim();

    if (!nextCountryCode) {
      setModalError(t("profileCountryCodeRequired", "user"));
      return;
    }

    if (!nextPhoneNumber) {
      setModalError(t("profilePhoneRequired", "user"));
      return;
    }

    const nextPhone = `${nextCountryCode}${nextPhoneNumber}`;
    if (nextPhone.length < 6 || nextPhone.length > 20 || !PHONE_PATTERN.test(nextPhone)) {
      setModalError(t("profilePhoneFormatHint", "user"));
      return;
    }

    setSaving(true);
    setModalError("");
    try {
      const next = await updatePhone(nextPhone);
      onUserInfoChange?.(next);
      setPhoneOpen(false);
      await onRefresh?.();
    } catch (error) {
      setModalError(normalizePhoneError(error, t));
    } finally {
      setSaving(false);
    }
  };

  const openPhoneEdit = () => {
    setPhoneCountryCode("");
    setPhoneNumberValue("");
    setModalError("");
    setPhoneOpen(true);
  };

  const onAvatarFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const previewUrl = URL.createObjectURL(file);
    setAvatarPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return previewUrl;
    });
    setUploading(true);
    setAvatarMessage(t("profileAvatarCompressing", "user"));
    try {
      const compressed = await createCompressedAvatar(file, t);
      if (compressed.compressedBytes > AVATAR_MAX_BYTES) {
        setAvatarMessage(t("profileAvatarTooLarge", "user"));
        return;
      }
      setAvatarMessage(formatText(t("profileAvatarUploadingDetail", "user"), {
        original: formatFileSize(compressed.originalBytes),
        compressed: formatFileSize(compressed.compressedBytes),
      }));
      const next = await uploadAvatar(compressed.file);
      setAvatarMessage(
        formatText(t("profileAvatarUploadedDetail", "user"), {
          original: formatFileSize(compressed.originalBytes),
          compressed: formatFileSize(compressed.compressedBytes),
        }),
      );
      onUserInfoChange?.(next);
      patchCurrentUser({
        avatar_url: next.avatar || null,
        profile: {
          avatar_url: next.avatar || null,
        },
      });
      setAvatarPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return "";
      });
    } catch (error) {
      setAvatarPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return "";
      });
      setAvatarMessage(normalizeError(error, t, t("profileImageProcessFailed", "user")));
    } finally {
      setUploading(false);
      event.target.value = "";
      setTimeout(() => setAvatarMessage(""), 2500);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative shrink-0">
              <UserAvatar
                user={userInfo}
                src={avatarPreview || userInfo.avatar}
                initial={avatarLetter}
                className="h-16 w-16"
                fallbackClassName="text-xl"
              />
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,image/webp"
                onChange={onAvatarFile}
              />
              <button
                type="button"
                className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-amber-500 text-sm text-white hover:bg-amber-600 disabled:opacity-60"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                title={t("profileUploadAvatar", "user")}
              >
                {uploading ? "..." : t("profileEdit", "user")}
              </button>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <div className="truncate text-xl font-semibold text-white">{displayName}</div>
                <button type="button" className="text-sm text-amber-400 hover:text-amber-300" onClick={() => openNameEdit("nickname")}>
                  {t("profileEdit", "user")}
                </button>
              </div>
              <div className="mt-1 text-sm text-white/50">UID：{userInfo.id || "-"}</div>
              <span className={`mt-3 inline-flex rounded-full border px-3 py-1 text-xs ${kyc.badgeClass}`}>
                {kyc.statusLabel}
              </span>
              {avatarMessage ? <div className="mt-2 text-xs text-white/55">{avatarMessage}</div> : null}
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-4 text-sm">
            {shouldShowUsername ? (
              <InfoLine label={t("profileUsername", "user")} value={usernameText} action={t("profileEdit", "user")} onAction={() => openNameEdit("username")} />
            ) : null}
            <InfoLine label={t("profileAccountStatus", "user")} value={accountStatusText} valueClassName="text-emerald-300" />
            <InfoLine label={t("profileRegisterTime", "user")} value={formatDateTime(userInfo.createdAt, locale)} />
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <GroupedCard title={t("profileBasicInfo", "user")}>
          <InfoLine label={t("profileUserId", "user")} value={userInfo.id || "-"} />
          <InfoLine label={t("profileEmail", "user")} value={userInfo.email ? maskEmail(userInfo.email) : "-"} />
          <InfoLine
            label={t("profilePhoneNumber", "user")}
            value={phoneText}
            action={userInfo.phone ? t("profileModify", "user") : t("profileAdd", "user")}
            onAction={openPhoneEdit}
          />
          <InfoLine label={t("profileRegisterTime", "user")} value={formatDateTime(userInfo.createdAt, locale)} />
        </GroupedCard>

        <GroupedCard title={t("profileVerificationInfo", "user")}>
          <InfoLine
            label={t("profileKycStatus", "user")}
            value={kyc.statusLabel}
            valueClassName={String(userInfo.kycStatus || "").toUpperCase() === "APPROVED" ? "text-emerald-300" : "text-white"}
          />
          <InfoLine label={t("profileKycLevel", "user")} value={kyc.levelLabel} />
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-semibold text-white">{kyc.title}</div>
                <div className="mt-1 text-sm text-white/50">{kyc.description}</div>
              </div>
              <button
                type="button"
                className="w-fit rounded bg-amber-500 px-4 py-2 text-sm text-white hover:bg-amber-600"
                onClick={() => router.push(KYC_VERIFY_PATH)}
              >
                {kyc.button}
              </button>
            </div>
          </div>
        </GroupedCard>
      </section>

      {editField ? (
        <ActionModal
          title={editField === "username" ? t("profileEditUsername", "user") : t("profileEditNickname", "user")}
          value={editValue}
          error={modalError}
          saving={saving}
          placeholder={editField === "username" ? t("profileUsernamePlaceholder", "user") : t("profileNicknamePlaceholder", "user")}
          cancelLabel={t("profileCancel", "user")}
          confirmLabel={t("profileConfirm", "user")}
          confirmingLabel={t("profileConfirming", "user")}
          onChange={setEditValue}
          onCancel={() => setEditField(null)}
          onSave={saveNameEdit}
        />
      ) : null}

      {phoneOpen ? (
        <PhoneActionModal
          title={userInfo.phone ? t("profileModifyPhone", "user") : t("profileAddPhone", "user")}
          countryCode={phoneCountryCode}
          phoneNumber={phoneNumberValue}
          error={modalError}
          saving={saving}
          countryCodePlaceholder={t("profileCountryCodePlaceholder", "user")}
          countryCodeAriaLabel={t("profileCountryCodeAria", "user")}
          phonePlaceholder={t("profilePhonePlaceholder", "user")}
          phoneAriaLabel={t("profilePhoneAria", "user")}
          cancelLabel={t("profileCancel", "user")}
          confirmLabel={t("profileConfirm", "user")}
          confirmingLabel={t("profileConfirming", "user")}
          onCountryCodeChange={setPhoneCountryCode}
          onPhoneNumberChange={setPhoneNumberValue}
          onCancel={() => setPhoneOpen(false)}
          onSave={savePhone}
        />
      ) : null}
    </div>
  );
}

function GroupedCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
      <h2 className="mb-4 text-lg font-semibold text-white">{title}</h2>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function InfoLine({
  label,
  value,
  action,
  valueClassName = "text-white",
  onAction,
}: {
  label: string;
  value: React.ReactNode;
  action?: string;
  valueClassName?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
      <div className="shrink-0 text-sm text-white/45">{label}</div>
      <div className="flex min-w-0 items-center gap-3">
        <div className={`truncate text-right text-sm ${valueClassName}`}>{value}</div>
        {action && onAction ? (
          <button type="button" className="shrink-0 text-sm text-amber-400 hover:text-amber-300" onClick={onAction}>
            {action}
          </button>
        ) : null}
      </div>
    </div>
  );
}

