"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";

export type CoinSelectOption = {
  symbol: string;
  name?: string;
  icon_url?: string | null;
  iconUrl?: string | null;
  icon?: string | null;
};

type CoinSelectProps = {
  value: string;
  options: CoinSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

function clsx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

function formatCoinLabel(option?: CoinSelectOption | null) {
  const symbol = (option?.symbol || "").trim();
  const name = (option?.name || "").trim();
  if (!symbol) return "";
  if (!name || name.toUpperCase() === symbol.toUpperCase()) return symbol;
  return `${symbol} - ${name}`;
}

function coinInitial(symbol: string) {
  return (symbol || "?").trim().slice(0, 1).toUpperCase() || "?";
}

function getCoinIcon(option?: CoinSelectOption | null) {
  return (option?.icon_url || option?.iconUrl || option?.icon || "").trim();
}

function CoinAvatar({
  option,
  fallbackSymbol,
  selected,
  failedIcons,
  onIconError,
}: {
  option?: CoinSelectOption | null;
  fallbackSymbol: string;
  selected?: boolean;
  failedIcons: Record<string, true>;
  onIconError: (url: string) => void;
}) {
  const icon = getCoinIcon(option);
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
      {coinInitial(fallbackSymbol)}
    </span>
  );
}

export default function CoinSelect({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  className,
  ariaLabel,
}: CoinSelectProps) {
  const { t } = useLocaleContext();
  const [open, setOpen] = useState(false);
  const [failedIcons, setFailedIcons] = useState<Record<string, true>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resolvedPlaceholder = placeholder ?? t("assetDepositPleaseSelect", "asset");
  const resolvedAriaLabel = ariaLabel ?? t("selectCoinAria", "asset");
  const normalizedValue = (value || "").trim().toUpperCase();
  const selected = useMemo(
    () => options.find((item) => item.symbol.trim().toUpperCase() === normalizedValue) || null,
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
        aria-expanded={open}
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
          <CoinAvatar
            option={selected}
            fallbackSymbol={selected?.symbol || value}
            failedIcons={failedIcons}
            onIconError={markIconFailed}
          />
          <span className="min-w-0">
            <span className={clsx("block truncate font-semibold", selected ? "text-white" : "text-white/45")}>
              {selected ? formatCoinLabel(selected) : resolvedPlaceholder}
            </span>
          </span>
        </span>
        <span className={clsx("flex-shrink-0 text-white/45 transition", open && "rotate-180")}>▾</span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-[#2a2f3a] bg-[#111318] shadow-xl shadow-black/35">
          <div role="listbox" aria-label={resolvedAriaLabel} className="max-h-[280px] overflow-y-auto bg-[#111318] py-1">
            {options.map((option) => {
              const symbol = option.symbol.trim();
              const optionValue = symbol.toUpperCase();
              const isSelected = optionValue === normalizedValue;
              const name = (option.name || "").trim();
              return (
                <button
                  key={symbol}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(symbol);
                    setOpen(false);
                  }}
                  className={clsx(
                    "flex h-11 w-full items-center gap-3 px-3 text-left transition",
                    isSelected ? "bg-amber-400/12 text-white" : "text-white/80 hover:bg-white/10"
                  )}
                >
                  <CoinAvatar
                    option={option}
                    fallbackSymbol={symbol}
                    selected={isSelected}
                    failedIcons={failedIcons}
                    onIconError={markIconFailed}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{symbol}</span>
                    {name && name.toUpperCase() !== optionValue ? (
                      <span className="block truncate text-xs text-white/45">{name}</span>
                    ) : null}
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
