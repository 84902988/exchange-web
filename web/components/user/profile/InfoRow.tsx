"use client";

import React, { useState } from "react";
import { useLocaleContext } from "@/contexts/LocaleContext";

type Props = {
  label: string;
  value?: React.ReactNode;
  copyText?: string;
  actionText?: string;
  onAction?: () => void;
  showArrow?: boolean;
};

export default function InfoRow({
  label,
  value,
  copyText,
  actionText,
  onAction,
  showArrow = false,
}: Props) {
  const { t } = useLocaleContext();
  const [copied, setCopied] = useState(false);
  const copyLabel = t("copy", "common");
  const copiedLabel = t("copied", "user");

  const doCopy = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("copy failed", e);
    }
  };

  return (
    <div className="flex items-center justify-between px-6 py-5 border-t border-white/10 first:border-t-0">
      <div className="text-white/70 text-sm">{label}</div>

      <div className="flex items-center gap-3">
        <div className="text-white text-sm">{value ?? "-"}</div>

        {copyText ? (
          <button
            onClick={doCopy}
            className="text-white/60 hover:text-white transition-colors"
            aria-label={copyLabel}
            title={copied ? copiedLabel : copyLabel}
          >
            {copied ? (
              <span className="text-xs text-green-400">{copiedLabel}</span>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V7Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <path
                  d="M6 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
              </svg>
            )}
          </button>
        ) : null}

        {actionText && onAction ? (
          <button
            onClick={onAction}
            className="text-sky-400 hover:text-sky-300 text-sm transition-colors flex items-center gap-1"
          >
            {actionText}
            {showArrow ? <span className="text-white/40">&gt;</span> : null}
          </button>
        ) : null}
      </div>
    </div>
  );
}
