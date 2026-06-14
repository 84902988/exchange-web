"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import AssetSidebar from "@/components/asset/AssetSidebar";
import CoinSelect from "@/components/asset/CoinSelect";
import NetworkSelect from "@/components/asset/NetworkSelect";
import { useLocaleContext } from "@/contexts/LocaleContext";
import AssetsAPI, { DepositOptionItem, DepositRecord } from "@/lib/api/modules/assets";

function buildQrUrl(text: string) {
  const qs = new URLSearchParams({ data: text, size: "220x220" }).toString();
  return `https://api.qrserver.com/v1/create-qr-code/?${qs}`;
}

function clsx(...arr: Array<string | false | undefined | null>) {
  return arr.filter(Boolean).join(" ");
}

function maskAddress(addr: string) {
  const a = addr.trim();
  if (a.length <= 16) return a;
  return `${a.slice(0, 10)}...${a.slice(-10)}`;
}

function IconCopy() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="inline-block">
      <path
        fill="currentColor"
        d="M16 1H6a2 2 0 0 0-2 2v10h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="inline-block">
      <path
        fill="currentColor"
        d="M9 16.2 4.8 12 3.4 13.4 9 19 21 7 19.6 5.6z"
      />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="inline-block">
      <path
        fill="currentColor"
        d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"
      />
    </svg>
  );
}

function StepLabel({
  num,
  title,
  active,
  done,
}: {
  num: number;
  title: string;
  active?: boolean;
  done?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={clsx(
          "w-7 h-7 rounded-full flex items-center justify-center text-sm border",
          done
            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
            : active
              ? "bg-white/10 border-white/25 text-white"
              : "bg-white/5 border-white/10 text-white/60"
        )}
      >
        {num}
      </div>
      <div className={clsx("text-sm", active ? "text-white" : "text-white/70")}>
        {title}
      </div>
    </div>
  );
}

function SkeletonLine() {
  return (
    <div className="h-10 rounded-xl bg-white/5 border border-white/10 animate-pulse" />
  );
}

function truncateMiddle(s: string, head = 10, tail = 10) {
  const t = (s || "").trim();
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}...${t.slice(-tail)}`;
}

type TimeRangeKey = "all" | "24h" | "7d" | "30d";
type AssetIconFields = { icon_url?: string | null; iconUrl?: string | null; icon?: string | null };

function toIso(dt: Date) {
  return dt.toISOString().replace(".000Z", "");
}

function formatCoinLabel(coin: { symbol: string; name?: string }) {
  const symbol = (coin.symbol || "").trim();
  const name = (coin.name || "").trim();
  if (!name || name.toUpperCase() === symbol.toUpperCase()) return symbol;
  return `${symbol} - ${name}`;
}

function DepositPageContent() {
  const { t } = useLocaleContext();
  const searchParams = useSearchParams();
  const requestedCoin = useMemo(
    () => (searchParams.get("coin") || "").trim().toUpperCase(),
    [searchParams]
  );

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const toggleSidebar = () => setIsSidebarCollapsed((v) => !v);

  // deposit options
  const depositOptionsQuery = useQuery({
    queryKey: ["assetDepositOptions"],
    queryFn: () => AssetsAPI.getDepositOptions(),
    staleTime: 1000 * 60 * 5,
    retry: 0,
  });

  const depositOptionItems: DepositOptionItem[] = useMemo(() => {
    return (depositOptionsQuery.data?.items || []).filter(
      (item) =>
        item.enabled !== false &&
        item.asset_enabled !== false &&
        item.chain_enabled !== false &&
        item.asset_chain_enabled !== false &&
        item.deposit_enabled !== false
    );
  }, [depositOptionsQuery.data?.items]);

  const [coinSymbolInput, setCoinSymbolInput] = useState<string>(() => requestedCoin);
  const [networkCodeInput, setNetworkCodeInput] = useState<string>("");

  const anyLoading = depositOptionsQuery.isLoading;

  const coinOptions = useMemo(() => {
    const map = new Map<
      string,
      {
        symbol: string;
        name: string;
        asset_sort_order: number;
        deposit_sort_order: number;
        deposit_quick_enabled: boolean;
        deposit_default_enabled: boolean;
        icon_url?: string | null;
        iconUrl?: string | null;
        icon?: string | null;
      }
    >();

    depositOptionItems.forEach((item) => {
      const symbol = item.coin_symbol;
      if (!symbol || map.has(symbol)) return;
      const iconFields = item as AssetIconFields;
      map.set(symbol, {
        symbol,
        name: item.coin_name || "",
        icon_url: iconFields.icon_url,
        iconUrl: iconFields.iconUrl,
        icon: iconFields.icon,
        asset_sort_order: Number(item.asset_sort_order ?? 0),
        deposit_sort_order: Number(item.deposit_sort_order ?? 100),
        deposit_quick_enabled: item.deposit_quick_enabled !== false,
        deposit_default_enabled: item.deposit_default_enabled === true,
      });
    });

    return Array.from(map.values()).sort(
      (a, b) =>
        a.deposit_sort_order - b.deposit_sort_order ||
        a.symbol.localeCompare(b.symbol)
    );
  }, [depositOptionItems]);

  const defaultCoinOption = useMemo(() => {
    const apiDefaultSymbol = (depositOptionsQuery.data?.default_asset_symbol || "")
      .trim()
      .toUpperCase();
    if (apiDefaultSymbol) {
      const apiDefault = coinOptions.find(
        (item) => item.symbol.toUpperCase() === apiDefaultSymbol
      );
      if (apiDefault) return apiDefault;
    }
    return coinOptions.find((item) => item.deposit_default_enabled) || coinOptions[0];
  }, [coinOptions, depositOptionsQuery.data?.default_asset_symbol]);

  const requestedCoinOption = requestedCoin
    ? coinOptions.find((item) => item.symbol.toUpperCase() === requestedCoin)
    : undefined;
  const urlCoinSupported = !!requestedCoinOption;
  const urlCoinUnsupported = !!requestedCoin && coinOptions.length > 0 && !urlCoinSupported;
  const coinSymbol = coinOptions.some((item) => item.symbol === coinSymbolInput)
    ? coinSymbolInput
    : urlCoinSupported
      ? requestedCoinOption?.symbol || ""
      : defaultCoinOption?.symbol || "";

  const networkOptions = useMemo(() => {
    return depositOptionItems
      .filter((item) => item.coin_symbol === coinSymbol)
      .sort(
        (a, b) =>
          Number(a.network_sort_order ?? 0) - Number(b.network_sort_order ?? 0) ||
          (a.chain_name || a.chain_key).localeCompare(b.chain_name || b.chain_key)
      );
  }, [depositOptionItems, coinSymbol]);
  const networkSelectOptions = useMemo(
    () =>
      networkOptions.map((item) => ({
        ...item,
        icon_url: item.chain_icon_url || item.network_icon_url || null,
      })),
    [networkOptions]
  );

  const getFirstNetworkCodeForCoin = useCallback((symbol: string) => {
    const first = depositOptionItems
      .filter((item) => item.coin_symbol === symbol)
      .sort(
        (a, b) =>
          Number(a.network_sort_order ?? 0) - Number(b.network_sort_order ?? 0) ||
          (a.chain_name || a.chain_key).localeCompare(b.chain_name || b.chain_key)
      )[0];
    return first?.chain_key || "";
  }, [depositOptionItems]);

  const networkCode = networkOptions.some((item) => item.chain_key === networkCodeInput)
    ? networkCodeInput
    : getFirstNetworkCodeForCoin(coinSymbol);

  const resetDepositState = () => {
    setAddress("");
    setMemo(null);
    setError("");
    setDepStatus("");
    setDepQ("");
    setDepQDebounced("");
    setTimeRange("all");
    setDepPage(1);
  };

  const setCoinSymbol = (symbol: string) => {
    setCoinSymbolInput(symbol);
    setNetworkCodeInput("");
    resetDepositState();
  };

  const setNetworkCode = (code: string) => {
    setNetworkCodeInput(code);
    resetDepositState();
  };

  const [address, setAddress] = useState<string>("");
  const [memo, setMemo] = useState<string | null>(null);
  const [loadingAddr, setLoadingAddr] = useState(false);
  const [error, setError] = useState<string>("");

  const [toast, setToast] = useState<string>("");
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const [copiedKey, setCopiedKey] = useState<string>("");

  const markCopied = (key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? "" : prev));
    }, 1200);
  };

  const handleFetchAddress = async () => {
    setError("");
    setAddress("");
    setMemo(null);

    if (!coinSymbol) {
      return setError(
        t("assetDepositPleaseSelectACoin", "asset")
      );
    }
    if (!networkCode) {
      return setError(
        t("assetDepositPleaseSelectANetwork", "asset")
      );
    }

    setLoadingAddr(true);
    try {
      const res = await AssetsAPI.getDepositAddress({
        coin_symbol: coinSymbol,
        network_code: networkCode,
      });
      setAddress(res.address);
      setMemo(res.memo ?? null);
      setToast(
        t("assetDepositAddressLoaded", "asset")
      );
    } catch {
      setError(
        t("assetDepositFailedToGetDepositAddress", "asset")
      );
      setAddress("");
      setMemo(null);
    } finally {
      setLoadingAddr(false);
    }
  };

  const copyText = async (text: string, key: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    markCopied(key);
  };

  const quickCoins = useMemo(() => {
    const enabledQuickCoins = coinOptions.filter(
      (item) => item.deposit_quick_enabled !== false
    );
    return (enabledQuickCoins.length > 0 ? enabledQuickCoins : coinOptions).slice(0, 6);
  }, [coinOptions]);

  const step1Done = !!coinSymbol;
  const step2Done = !!networkCode;
  const step3Done = !!address;

  const [depPage, setDepPage] = useState(1);
  const depPageSize = 10;

  const [depStatus, setDepStatus] = useState<string>("");
  const [depQ, setDepQ] = useState<string>("");
  const [depQDebounced, setDepQDebounced] = useState(depQ);

  const [timeRange, setTimeRange] = useState<TimeRangeKey>("all");

  useEffect(() => {
    const t = window.setTimeout(() => setDepQDebounced(depQ), 350);
    return () => window.clearTimeout(t);
  }, [depQ]);

  useEffect(() => {
    setDepPage(1);
  }, [coinSymbol, networkCode, depStatus, depQDebounced, timeRange]);

  useEffect(() => {
    setDepStatus("");
    setDepQ("");
    setTimeRange("all");
  }, [coinSymbol, networkCode]);

  const { start_time, end_time } = useMemo(() => {
    if (timeRange === "all") return { start_time: undefined, end_time: undefined };

    const now = new Date();
    const start = new Date(now);
    if (timeRange === "24h") start.setHours(start.getHours() - 24);
    if (timeRange === "7d") start.setDate(start.getDate() - 7);
    if (timeRange === "30d") start.setDate(start.getDate() - 30);

    return { start_time: toIso(start), end_time: toIso(now) };
  }, [timeRange]);

  const depositsQuery = useQuery({
    queryKey: [
      "assetDeposits",
      coinSymbol,
      networkCode,
      depStatus,
      depQDebounced,
      timeRange,
      depPage,
      depPageSize,
    ],
    queryFn: () =>
      AssetsAPI.getDeposits({
        page: depPage,
        page_size: depPageSize,
        symbol: coinSymbol,
        network: networkCode,
        status: depStatus || undefined,
        q: depQDebounced || undefined,
        start_time,
        end_time,
      }),
    enabled: !!coinSymbol && !!networkCode,
    staleTime: 3000,
    retry: 0,
  });

  const depTotal = depositsQuery.data?.total ?? 0;
  const depItems: DepositRecord[] = depositsQuery.data?.items ?? [];
  const depHasPrev = depPage > 1;
  const depHasNext = depPage * depPageSize < depTotal;

  const formatNetwork = (chainKey: string) => {
    const n = depositOptionItems.find((x) => x.chain_key === chainKey);
    const name = (n?.chain_name || chainKey.toUpperCase()).trim();
    const cid = n?.chain_id ? String(n.chain_id) : "";
    return cid ? `${name} (${cid})` : name;
  };

  const getTxUrl = () => {
    return "";
  };

  return (
    <main className="min-h-screen py-8 flex bg-[#0a0a0d]">
      <AssetSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="lg:w-4/5 w-full px-4 text-white">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold mt-1">
              {t("assetDepositDeposit", "asset")}
            </h1>
          </div>
        </div>

        {toast ? (
          <div className="fixed top-6 right-6 z-50 rounded-xl border border-white/15 bg-black/70 px-4 py-2 text-sm text-white/90 shadow-lg backdrop-blur">
            {toast}
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 bg-red-900/25 border border-red-500/35 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-red-200 text-sm">{error}</span>
              <button
                onClick={() => setError("")}
                className="text-white/70 hover:text-white text-sm"
              >
                {t("assetDepositClose", "asset")}
              </button>
            </div>
          </div>
        ) : null}

        {urlCoinUnsupported ? (
          <div className="mt-4 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {t("assetDepositTheSelectedCoinDoesNotSupportDepositYet", "asset")}
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6">
          <div className="rounded-2xl border border-white/10 bg-white/5">
            <div className="p-5 border-b border-white/10">
              <div className="flex flex-col sm:flex-row gap-4 sm:gap-8">
                <StepLabel
                  num={1}
                  title={t("assetDepositSelectCoin", "asset")}
                  active={!step1Done}
                  done={step1Done}
                />
                <StepLabel
                  num={2}
                  title={t("assetDepositSelectNetwork", "asset")}
                  active={step1Done && !step2Done}
                  done={step2Done}
                />
                <StepLabel
                  num={3}
                  title={t("assetDepositDepositAddress", "asset")}
                  active={step2Done && !step3Done}
                  done={step3Done}
                />
              </div>
            </div>

            <div className="p-5">
              {/* Step 1 */}
              <div>
                <div className="text-white/80 text-sm mb-2">
                  {t("assetDepositSelectCoin", "asset")}
                </div>

                {anyLoading ? (
                  <SkeletonLine />
                ) : coinOptions.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/55">
                    {t("assetDepositNoDepositCoinsAvailable", "asset")}
                  </div>
                ) : (
                  <CoinSelect
                    value={coinSymbol}
                    options={coinOptions}
                    placeholder={t("assetDepositPleaseSelect", "asset")}
                    ariaLabel={t("assetDepositSelectCoin", "asset")}
                    onChange={(next) => {
                      setCoinSymbol(next);
                      setNetworkCode(getFirstNetworkCodeForCoin(next));
                      setAddress("");
                      setMemo(null);
                      setError("");
                    }}
                  />
                )}

                {quickCoins.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {quickCoins.map((coin) => (
                    <button
                      key={coin.symbol}
                      onClick={() => {
                        setCoinSymbol(coin.symbol);
                        setNetworkCode(getFirstNetworkCodeForCoin(coin.symbol));
                        setAddress("");
                        setMemo(null);
                        setError("");
                      }}
                      className={clsx(
                        "px-3 py-1.5 rounded-full text-xs border transition",
                        coinSymbol === coin.symbol
                          ? "bg-white/10 border-white/25 text-white"
                          : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
                      )}
                    >
                      {formatCoinLabel(coin)}
                    </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Step 2 */}
              <div className="mt-6">
                <div className="text-white/80 text-sm mb-2">
                  {t("assetDepositSelectNetwork", "asset")}
                </div>

                {anyLoading ? (
                  <SkeletonLine />
                ) : coinOptions.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/55">
                    {t("assetDepositNoDepositCoinsAvailable", "asset")}
                  </div>
                ) : (
                  <NetworkSelect
                    value={networkCode}
                    options={networkSelectOptions}
                    placeholder={
                      coinSymbol
                        ? t("assetDepositPleaseSelect", "asset")
                        : t("assetDepositSelectCoinFirst", "asset")
                    }
                    ariaLabel={t("assetDepositSelectNetwork", "asset")}
                    disabled={!coinSymbol}
                    onChange={(next) => {
                      setNetworkCode(next);
                      setAddress("");
                      setMemo(null);
                      setError("");
                    }}
                  />
                )}
              </div>

              {/* Step 3 */}
              <div className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-white/80 text-sm">
                    {t("assetDepositDepositAddress", "asset")}
                  </div>

                  <button
                    onClick={handleFetchAddress}
                    disabled={anyLoading || loadingAddr || !coinSymbol || !networkCode}
                    className="rounded-xl bg-white text-black font-medium px-4 py-2 hover:opacity-90 disabled:opacity-50 text-sm"
                  >
                    {loadingAddr
                      ? t("assetDepositLoading", "asset")
                      : t("assetDepositGetAddress", "asset")}
                  </button>
                </div>

                {!address ? (
                  <div className="mt-3 text-white/55 text-sm">
                    {t("assetDepositSelectCoinNetworkThenClickGetAddress", "asset")}
                  </div>
                ) : (
                  <div className="mt-4 grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-5 items-start">
                    <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
                      <img
                        src={buildQrUrl(address)}
                        alt={t("depositQrAlt", "asset")}
                        className="w-full max-w-[220px] h-auto rounded-xl"
                      />
                      <div className="mt-3 text-xs text-white/45">
                        {t("assetDepositScanToDeposit", "asset")}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs text-white/45">
                            {t("assetDepositAddress", "asset")}
                          </div>
                          <div className="mt-2 break-all text-sm text-white">{address}</div>
                          <div className="mt-2 text-xs text-white/45">
                            {t("assetDepositDisplay", "asset")}：{maskAddress(address)}
                          </div>
                        </div>

                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => copyText(address, "addr")}
                            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 px-3 py-2 text-sm"
                            title={t("assetDepositCopy", "asset")}
                          >
                            <span className="text-white/80">
                              {copiedKey === "addr" ? <IconCheck /> : <IconCopy />}
                            </span>
                            <span className="text-white/80">
                              {copiedKey === "addr"
                                ? t("assetDepositCopied", "asset")
                                : t("assetDepositCopy", "asset")}
                            </span>
                          </button>
                        </div>
                      </div>

                      {memo ? (
                        <div className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3">
                          <div className="text-xs text-white/45">
                            {t("assetDepositMemoTag", "asset")}
                          </div>
                          <div className="mt-1 break-all text-sm">{memo}</div>
                          <div className="mt-3">
                            <button
                              onClick={() => copyText(memo, "memo")}
                              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 px-3 py-2 text-sm"
                            >
                              <span className="text-white/80">
                                {copiedKey === "memo" ? <IconCheck /> : <IconCopy />}
                              </span>
                              <span className="text-white/80">
                                {copiedKey === "memo"
                                  ? t("assetDepositCopied", "asset")
                                  : t("assetDepositCopyMemo", "asset")}
                              </span>
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="hidden xl:block">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="text-white font-medium">
                {t("assetDepositFaq", "asset")}
              </div>
              <div className="mt-4 space-y-3 text-sm">
                <a className="block text-white/70 hover:text-white" href="#">
                  {t("assetDepositHowToDeposit", "asset")}
                </a>
                <a className="block text-white/70 hover:text-white" href="#">
                  {t("assetDepositDepositNotArrived", "asset")}
                </a>
                <a className="block text-white/70 hover:text-white" href="#">
                  {t("assetDepositWrongNetworkDeposit", "asset")}
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5">
          <div className="p-5 border-b border-white/10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-white font-medium">
              {t("assetDepositDepositRecords", "asset")}
            </div>

            <div className="flex flex-wrap gap-2">
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as TimeRangeKey)}
                disabled={!coinSymbol || !networkCode}
                className={clsx(
                  "h-10 rounded-xl border border-white/10 bg-black/30 px-3 outline-none",
                  (!coinSymbol || !networkCode) && "opacity-60 cursor-not-allowed"
                )}
              >
                <option value="all">{t("assetDepositAllTime", "asset")}</option>
                <option value="24h">{t("assetDepositLast24Hours", "asset")}</option>
                <option value="7d">{t("assetDepositLast7Days", "asset")}</option>
                <option value="30d">{t("assetDepositLast30Days", "asset")}</option>
              </select>

              <select
                value={depStatus}
                onChange={(e) => setDepStatus(e.target.value)}
                disabled={!coinSymbol || !networkCode}
                className={clsx(
                  "h-10 rounded-xl border border-white/10 bg-black/30 px-3 outline-none",
                  (!coinSymbol || !networkCode) && "opacity-60 cursor-not-allowed"
                )}
              >
                <option value="">
                  {t("assetDepositAllStatus", "asset")}
                </option>
                <option value="DETECTING">
                  {t("assetDepositStatusDetecting", "asset")}
                </option>
                <option value="CONFIRMED">
                  {t("assetDepositStatusConfirmed", "asset")}
                </option>
                <option value="FAILED">
                  {t("assetDepositStatusFailed", "asset")}
                </option>
              </select>

              <input
                value={depQ}
                onChange={(e) => setDepQ(e.target.value)}
                disabled={!coinSymbol || !networkCode}
                placeholder={t("assetDepositSearchTxidAddress", "asset")}
                className={clsx(
                  "h-10 w-[260px] max-w-full rounded-xl border border-white/10 bg-black/30 px-3 outline-none focus:border-white/25",
                  (!coinSymbol || !networkCode) && "opacity-60 cursor-not-allowed"
                )}
              />
            </div>
          </div>

          {!coinSymbol || !networkCode ? (
            <div className="p-5 text-sm text-white/55">
              {t("assetDepositSelectCoinNetworkToViewRecords", "asset")}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-white/60">
                    <tr>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositTime", "asset")}
                      </th>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositCoin", "asset")}
                      </th>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositNetwork", "asset")}
                      </th>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositAmount", "asset")}
                      </th>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositStatus", "asset")}
                      </th>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositTxId", "asset")}
                      </th>
                      <th className="p-3 text-left whitespace-nowrap">
                        {t("assetDepositConfirm", "asset")}
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {depositsQuery.isLoading ? (
                      <tr>
                        <td colSpan={7} className="p-4 text-white/50">
                          {t("assetDepositLoading", "asset")}
                        </td>
                      </tr>
                    ) : depositsQuery.isError ? (
                      <tr>
                        <td colSpan={7} className="p-4 text-red-200">
                          {t("assetDepositLoadFailed", "asset")}
                        </td>
                      </tr>
                    ) : depItems.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-4 text-white/50">
                          {t("assetDepositNoRecords", "asset")}
                        </td>
                      </tr>
                    ) : (
                      depItems.map((r) => {
                        const txid = r.txid || "";
                        const txUrl = txid ? getTxUrl() : "";
                        const txCopyKey = `tx:${r.id}`;
                        return (
                          <tr key={r.id} className="border-t border-white/10">
                            <td className="p-3 whitespace-nowrap">
                              {r.created_at ? new Date(r.created_at).toLocaleString() : "-"}
                            </td>
                            <td className="p-3 whitespace-nowrap">{r.symbol}</td>
                            <td className="p-3 whitespace-nowrap">{formatNetwork(r.chain_key)}</td>
                            <td className="p-3 whitespace-nowrap">{r.amount}</td>
                            <td className="p-3 whitespace-nowrap">{r.status || "-"}</td>

                            <td className="p-3 whitespace-nowrap">
                              {txid ? (
                                <div className="inline-flex items-center gap-3">
                                  {txUrl ? (
                                    <a
                                      href={txUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-white/85 hover:text-white inline-flex items-center gap-2"
                                      title={txid}
                                    >
                                      <span className="font-mono">{truncateMiddle(txid)}</span>
                                      <span className="text-white/70"><IconExternal /></span>
                                    </a>
                                  ) : (
                                    <span className="font-mono text-white/80" title={txid}>
                                      {truncateMiddle(txid)}
                                    </span>
                                  )}

                                  <button
                                    onClick={() => copyText(txid, txCopyKey)}
                                    className="text-white/70 hover:text-white inline-flex items-center gap-2"
                                    title={
                                      copiedKey === txCopyKey
                                        ? t("assetDepositCopied", "asset")
                                        : t("assetDepositCopy", "asset")
                                    }
                                  >
                                    {copiedKey === txCopyKey ? <IconCheck /> : <IconCopy />}
                                  </button>
                                </div>
                              ) : (
                                "-"
                              )}
                            </td>

                            <td className="p-3 whitespace-nowrap">
                              {typeof r.confirmations === "number" && typeof r.confirm_required === "number"
                                ? `${r.confirmations}/${r.confirm_required}`
                                : "-"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="p-4 border-t border-white/10 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-xs text-white/50">
                  {t("assetDepositTotal", "asset")} {depTotal}{" "}
                  {t("assetDepositRecords", "asset")}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    disabled={!depHasPrev || depositsQuery.isFetching}
                    onClick={() => setDepPage((p) => Math.max(1, p - 1))}
                    className="px-3 py-2 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-40"
                  >
                    {t("assetDepositPrevious", "asset")}
                  </button>

                  <div className="px-3 py-2 rounded-xl border border-white/10 bg-black/20 text-white/80 text-sm">
                    {depPage}
                  </div>

                  <button
                    disabled={!depHasNext || depositsQuery.isFetching}
                    onClick={() => setDepPage((p) => p + 1)}
                    className="px-3 py-2 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-40"
                  >
                    {t("assetDepositNext", "asset")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export default function DepositPage() {
  return (
    <Suspense fallback={null}>
      <DepositPageContent />
    </Suspense>
  );
}
