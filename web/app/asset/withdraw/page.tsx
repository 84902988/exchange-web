"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

import AssetSidebar from "@/components/asset/AssetSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import AssetsAPI, { type AccountBalanceItem, type CoinItem, type WithdrawOptionItem } from "@/lib/api/modules/assets";
import type { WithdrawRecord } from "@/lib/api/modules/assets_withdraw";
import { getUserInfo } from "@/lib/api/modules/user";

import WithdrawForm from "./WithdrawForm";
import WithdrawTips from "./WithdrawTips";
import WithdrawRecords from "./WithdrawRecords";

type WithdrawCoinOption = CoinItem & {
  withdraw_sort_order: number;
  withdraw_default_enabled: boolean;
};

function WithdrawPageContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const requestedCoin = useMemo(() => {
    return (searchParams.get("coin") || searchParams.get("coin_symbol") || "")
      .trim()
      .toUpperCase();
  }, [searchParams]);

  // language
  const { locale, t } = useLocaleContext();
  const currentLanguage = locale;

  // sidebar
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const toggleSidebar = () => setIsSidebarCollapsed((v) => !v);

  // global toast & error
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [latestWithdrawRecords, setLatestWithdrawRecords] = useState<WithdrawRecord[]>([]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // copy inline state
  const [copiedKey, setCopiedKey] = useState("");
  const markCopied = (key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((prev) => (prev === key ? "" : prev)), 1200);
  };
  const onCopy = async (text: string, key: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    markCopied(key);
  };

  // coin/network state
  const [coinSymbol, setCoinSymbol] = useState("");
  const [networkCode, setNetworkCode] = useState("");

  // meta queries
  const withdrawOptionsQuery = useQuery({
    queryKey: ["assetWithdrawOptions"],
    queryFn: () => AssetsAPI.getWithdrawOptions(),
    staleTime: 1000 * 60 * 5,
    retry: 0,
  });

  const balancesQuery = useQuery({
    queryKey: ["assetAccountBalancesForWithdraw"],
    queryFn: () => AssetsAPI.getAccountBalances(),
    staleTime: 1000 * 30,
    retry: 0,
  });

  const userInfoQuery = useQuery({
    queryKey: ["meForWithdrawLock"],
    queryFn: getUserInfo,
    staleTime: 1000 * 30,
    retry: 0,
  });

  const withdrawOptions = useMemo<WithdrawOptionItem[]>(() => {
    return (withdrawOptionsQuery.data?.items || []).filter(
      (item) =>
        item.enabled !== false &&
        item.asset_enabled !== false &&
        item.chain_enabled !== false &&
        item.asset_chain_enabled !== false &&
        item.withdraw_enabled !== false
    );
  }, [withdrawOptionsQuery.data?.items]);

  const coins = useMemo<WithdrawCoinOption[]>(() => {
    const map = new Map<string, WithdrawCoinOption>();
    withdrawOptions.forEach((item) => {
      const symbol = item.coin_symbol?.trim();
      if (!symbol || map.has(symbol)) return;
      map.set(symbol, {
        symbol: item.coin_symbol,
        name: item.coin_name,
        display_precision: item.display_precision,
        icon_url: item.icon_url || undefined,
        enabled: true,
        withdraw_sort_order: Number(item.withdraw_sort_order ?? 100),
        withdraw_default_enabled: item.withdraw_default_enabled === true,
      });
    });
    return Array.from(map.values()).sort(
      (a, b) =>
        a.withdraw_sort_order - b.withdraw_sort_order ||
        a.symbol.localeCompare(b.symbol)
    );
  }, [withdrawOptions]);

  const networks = useMemo(() => {
    const seen = new Set<string>();
    return withdrawOptions
      .filter((item) => {
        const key = item.chain_key?.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => ({
        code: item.chain_key,
        name: item.chain_name,
        chain_id: item.chain_id,
        enabled: true,
      }));
  }, [withdrawOptions]);

  const balances = (balancesQuery.data || []) as AccountBalanceItem[];

  const requestedCoinOption = requestedCoin
    ? coins.find((coin) => coin.symbol?.toUpperCase() === requestedCoin)
    : undefined;
  const urlCoinSupported = Boolean(requestedCoinOption);
  const urlCoinUnsupported = Boolean(requestedCoin && coins.length > 0 && !urlCoinSupported);
  const defaultCoinOption = useMemo(() => {
    const apiDefaultSymbol = (withdrawOptionsQuery.data?.default_asset_symbol || "")
      .trim()
      .toUpperCase();
    if (apiDefaultSymbol) {
      const apiDefault = coins.find(
        (coin) => coin.symbol?.toUpperCase() === apiDefaultSymbol
      );
      if (apiDefault) return apiDefault;
    }
    return coins.find((coin) => coin.withdraw_default_enabled) || coins[0];
  }, [coins, withdrawOptionsQuery.data?.default_asset_symbol]);

  const activeCoinSymbol = coins.some((coin) => coin.symbol === coinSymbol)
    ? coinSymbol
    : urlCoinSupported
    ? requestedCoinOption?.symbol || ""
    : defaultCoinOption?.symbol || "";

  const activeCoinNetworks = useMemo(() => {
    if (!activeCoinSymbol) return [];
    return withdrawOptions.filter(
      (item) => item.coin_symbol?.toUpperCase() === activeCoinSymbol.toUpperCase()
    );
  }, [withdrawOptions, activeCoinSymbol]);

  const activeNetworkCode = activeCoinNetworks.some((item) => item.chain_key === networkCode)
    ? networkCode
    : activeCoinNetworks[0]?.chain_key || "";

  const handleCoinSymbolChange = (symbol: string) => {
    setCoinSymbol(symbol);
    const nextNetwork =
      withdrawOptions.find((item) => item.coin_symbol?.toUpperCase() === symbol.toUpperCase())
        ?.chain_key || "";
    setNetworkCode(nextNetwork);
  };

  const handleNetworkCodeChange = (code: string) => {
    setNetworkCode(code);
  };

  const refreshAfterWithdraw = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["assetAccountBalancesForWithdraw"] });
    void queryClient.invalidateQueries({ queryKey: ["withdraws"] });
    void queryClient.invalidateQueries({ queryKey: ["userTransferRecords"] });
  }, [queryClient]);

  const handleWithdrawRecordsChange = useCallback((records: WithdrawRecord[]) => {
    setLatestWithdrawRecords(records);
  }, []);

  const metaLoading = withdrawOptionsQuery.isLoading || balancesQuery.isLoading;
  const withdrawLocked = Boolean(userInfoQuery.data?.withdrawLocked);
  const withdrawLockedReason =
    userInfoQuery.data?.withdrawLockedReason ||
    t("accountRestrictedTradingRisk", "asset");

  return (
    <main className="flex min-h-screen overflow-x-hidden bg-[#0a0a0d] py-8">
      <AssetSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 px-4 text-white">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold mt-1">
              {t("withdraw", "asset")}
            </h1>
          </div>
          {metaLoading ? (
            <div className="text-sm text-white/50">
              {t("assetDepositLoading", "asset")}
            </div>
          ) : null}
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
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {t("withdrawUnsupportedCoin", "asset")}
          </div>
        ) : null}

        {/* Top: two columns */}
        <div className="mt-6 grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <WithdrawForm
              currentLanguage={currentLanguage}
              withdrawOptions={withdrawOptions}
              balances={balances}
              coinSymbol={activeCoinSymbol}
              setCoinSymbol={handleCoinSymbolChange}
              networkCode={activeNetworkCode}
              setNetworkCode={handleNetworkCodeChange}
              copiedKey={copiedKey}
              latestWithdrawRecords={latestWithdrawRecords}
              withdrawLocked={withdrawLocked}
              withdrawLockedReason={withdrawLockedReason}
              onCopy={onCopy}
              onToast={(t) => setToast(t)}
              onError={(t) => setError(t)}
              onSuccessVerified={refreshAfterWithdraw}
            />
          </div>

          <div className="min-w-0">
            <WithdrawTips currentLanguage={currentLanguage} />
          </div>
        </div>

        {/* Bottom: records */}
        <div className="min-w-0 max-w-full overflow-hidden">
          <WithdrawRecords
            currentLanguage={currentLanguage}
            coinSymbol={activeCoinSymbol}
            networkCode={activeNetworkCode}
            coins={coins}
            networkOptionsAll={networks}
            copiedKey={copiedKey}
            onCopy={onCopy}
            onToast={(t) => setToast(t)}
            onBalanceRefresh={() => balancesQuery.refetch()}
            onWithdrawRecordsChange={handleWithdrawRecordsChange}
          />
        </div>
      </div>
    </main>
  );
}

export default function WithdrawPage() {
  return (
    <Suspense fallback={null}>
      <WithdrawPageContent />
    </Suspense>
  );
}
