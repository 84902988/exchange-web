"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";

export type NetworkSelectOption = {
  chain_key: string;
  chain_name?: string | null;
  chain_id?: string | number | null;
  icon_url?: string | null;
  iconUrl?: string | null;
  icon?: string | null;
  chain_icon_url?: string | null;
  network_icon_url?: string | null;
};

type NetworkSelectProps = {
  value: string;
  options: NetworkSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

const NETWORK_NAMES: Record<string, string> = {
  bsc: "BSC",
  polygon: "Polygon",
  avaxc: "Avalanche C-Chain",
  ethereum: "Ethereum",
  optimism: "Optimism",
};

function clsx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

function normalizeKey(value: string) {
  return (value || "").trim().toLowerCase();
}

function formatNetworkName(option?: NetworkSelectOption | null) {
  const key = normalizeKey(option?.chain_key || "");
  return (option?.chain_name || NETWORK_NAMES[key] || option?.chain_key || "").trim();
}

function formatNetworkLabel(option?: NetworkSelectOption | null) {
  const name = formatNetworkName(option);
  const chainId = option?.chain_id ? String(option.chain_id).trim() : "";
  if (!name) return "";
  return chainId ? `${name} (${chainId})` : name;
}

function networkInitial(option?: NetworkSelectOption | null) {
  const key = normalizeKey(option?.chain_key || "");
  const label = formatNetworkName(option);
  return (label || key || "?").slice(0, 1).toUpperCase();
}

function getNetworkIcon(option?: NetworkSelectOption | null) {
  return (
    option?.chain_icon_url ||
    option?.network_icon_url ||
    option?.icon_url ||
    option?.iconUrl ||
    option?.icon ||
    ""
  ).trim();
}

function NetworkAvatar({
  option,
  selected,
  failedIcons,
  onIconError,
}: {
  option?: NetworkSelectOption | null;
  selected?: boolean;
  failedIcons: Record<string, true>;
  onIconError: (url: string) => void;
}) {
  const icon = getNetworkIcon(option);
  const showIcon = !!icon && !failedIcons[icon];

  if (showIcon) {
    return (
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#151821]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={icon}
          alt=""
          className="h-full w-full rounded-full object-cover"
          onError={() => onIconError(icon)}
        />
      </span>
    );
  }

  return (
    <span
      className={clsx(
        "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        selected
          ? "border-amber-300/40 bg-amber-300/15 text-amber-100"
          : "border-white/10 bg-[#151821] text-white/75"
      )}
    >
      {networkInitial(option)}
    </span>
  );
}

export default function NetworkSelect({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  className,
  ariaLabel,
}: NetworkSelectProps) {
  const { t } = useLocaleContext();
  const [open, setOpen] = useState(false);
  const [failedIcons, setFailedIcons] = useState<Record<string, true>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resolvedPlaceholder = placeholder ?? t("assetDepositPleaseSelect", "asset");
  const resolvedAriaLabel = ariaLabel ?? t("selectNetworkAria", "asset");
  const normalizedValue = normalizeKey(value);
  const selected = useMemo(
    () => options.find((item) => normalizeKey(item.chain_key) === normalizedValue) || null,
    [normalizedValue, options]
  );

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const markIconFailed = (url: string) => {
    setFailedIcons((current) => (current[url] ? current : { ...current, [url]: true }));
  };

  return (
    <div ref={rootRef} className={clsx("relative", className)}>
      <button
        type="button"
        aria-label={resolvedAriaLabel}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        className={clsx(
          "flex h-12 w-full items-center justify-between gap-3 rounded-xl border border-[#2a2f3a] bg-[#111318] px-4 text-left text-sm text-white outline-none transition",
          "hover:border-white/20 focus:border-amber-400/70 focus:ring-2 focus:ring-amber-400/10",
          disabled && "cursor-not-allowed opacity-60"
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <NetworkAvatar option={selected} failedIcons={failedIcons} onIconError={markIconFailed} />
          <span className="min-w-0">
            <span className={clsx("block truncate font-semibold", selected ? "text-white" : "text-white/45")}>
              {selected ? formatNetworkLabel(selected) : resolvedPlaceholder}
            </span>
            {selected?.chain_key ? (
              <span className="block truncate text-xs text-white/45">{normalizeKey(selected.chain_key)}</span>
            ) : null}
          </span>
        </span>
        <span className={clsx("flex-shrink-0 text-white/45 transition", open && !disabled && "rotate-180")}>▾</span>
      </button>

      {open && !disabled ? (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-[#2a2f3a] bg-[#111318] shadow-xl shadow-black/35">
          <div role="listbox" aria-label={resolvedAriaLabel} className="max-h-[260px] overflow-y-auto bg-[#111318] py-1">
            {options.map((option) => {
              const key = option.chain_key.trim();
              const isSelected = normalizeKey(key) === normalizedValue;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onChange(key);
                    setOpen(false);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    onChange(key);
                    setOpen(false);
                  }}
                  className={clsx(
                    "flex h-11 w-full items-center gap-3 px-3 text-left transition",
                    isSelected ? "bg-amber-400/12 text-white" : "text-white/80 hover:bg-white/10"
                  )}
                >
                  <NetworkAvatar
                    option={option}
                    selected={isSelected}
                    failedIcons={failedIcons}
                    onIconError={markIconFailed}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{formatNetworkLabel(option)}</span>
                    <span className="block truncate text-xs text-white/45">{normalizeKey(key)}</span>
                  </span>
                  {isSelected ? <span className="flex-shrink-0 text-sm text-amber-200">✓</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
