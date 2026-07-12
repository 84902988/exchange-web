'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  getTickerDirectionFlashClass,
  getTickerDirectionTextClass,
  type PriceDirection,
} from './spotTickerColor';
import {
  resolveSpotMarketStatus,
} from './spotMarketStatus';

type SpotMarketPresentationKind = 'live' | 'delayed' | 'unavailable' | 'loading';

function spotMarketStatusTone(kind: SpotMarketPresentationKind) {
  if (kind === 'live') {
    return 'bg-[#00c087]';
  }
  if (kind === 'delayed') {
    return 'bg-[#f0b90b]';
  }
  if (kind === 'unavailable') {
    return 'bg-[#f6465d]';
  }
  return 'bg-white/36';
}

interface SpotHeaderProps {
  symbol: string;
  displaySymbol?: string | null;
  price: string;
  change: string;
  changeAmount: string;
  highLow: string;
  volume: string;
  turnover: string;
  priceDirection?: PriceDirection;
  marketStatus?: string | null;
  quoteFreshness?: string | null;
  tickerSource?: string | null;
  tickerFreshness?: string | null;
  dataSource?: string | null;
  isLoading?: boolean;
  isHydrating?: boolean;
  marketSessionType?: string | null;
  symbolSelector?: React.ReactNode;
}

export default function SpotHeader({
  symbol,
  displaySymbol,
  price,
  change,
  changeAmount,
  highLow,
  volume,
  turnover,
  priceDirection = 'flat',
  marketStatus,
  quoteFreshness,
  tickerSource,
  tickerFreshness,
  dataSource,
  isLoading = false,
  isHydrating = false,
  marketSessionType,
  symbolSelector,
}: SpotHeaderProps) {
  const { t } = useLocaleContext();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!price || price === '--') return;

    const startTimer = window.setTimeout(() => {
      setFlash(true);
    }, 0);
    const timer = window.setTimeout(() => {
      setFlash(false);
    }, 320);

    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(timer);
    };
  }, [price]);

  const isChangeUp = change.startsWith('+');
  const isChangeDown = change.startsWith('-');

  const priceColorClass = getTickerDirectionTextClass(priceDirection);
  const priceFlashClass = flash ? getTickerDirectionFlashClass(priceDirection) : '';
  const displayPriceStatus = resolveSpotMarketStatus({
    source: tickerSource,
    freshness: tickerFreshness || quoteFreshness,
    dataSource,
    isLoading,
    isHydrating,
  }, t);
  const marketStatusPresentation = useMemo(() => {
    const assetLabel = (key: string, fallback: string) => {
      const value = t(key, 'asset');
      return value && value !== key ? value : fallback;
    };
    const presentationKind: SpotMarketPresentationKind = displayPriceStatus.kind === 'loading'
      ? 'loading'
      : displayPriceStatus.kind === 'unavailable'
        ? 'unavailable'
        : displayPriceStatus.kind === 'live' || displayPriceStatus.kind === 'internal'
          ? 'live'
          : 'delayed';

    if (presentationKind === 'live') {
      return {
        kind: presentationKind,
        label: assetLabel('spotMarketStatusLiveCompact', 'Live'),
        fullLabel: assetLabel('spotMarketStatusLive', 'Live market'),
      };
    }
    if (presentationKind === 'delayed') {
      return {
        kind: presentationKind,
        label: assetLabel('spotMarketStatusDelayedCompact', 'Delayed'),
        fullLabel: assetLabel('spotMarketStatusDelayed', 'Delayed market'),
      };
    }
    if (presentationKind === 'unavailable') {
      return {
        kind: presentationKind,
        label: assetLabel('spotMarketStatusUnavailableCompact', 'Unavailable'),
        fullLabel: assetLabel('spotMarketStatusUnavailable', 'Unavailable'),
      };
    }
    return {
      kind: presentationKind,
      label: assetLabel('spotMarketStatusLoadingCompact', 'Loading'),
      fullLabel: assetLabel('spotMarketStatusLoading', 'Loading'),
    };
  }, [displayPriceStatus.kind, t]);
  const displayPriceStatusTone = spotMarketStatusTone(marketStatusPresentation.kind);
  const tradingSessionLabel = useMemo(() => {
    const status = String(marketStatus || '').trim().toUpperCase();
    const sessionType = String(marketSessionType || '').trim().toUpperCase();
    const marketLabel = (key: string, fallback: string) => {
      const value = t(key, 'markets');
      return value && value !== key ? value : fallback;
    };

    if (sessionType === 'PRE_MARKET') return marketLabel('market.session.preMarket', 'Pre-market');
    if (sessionType === 'AFTER_HOURS') return marketLabel('market.session.afterHours', 'After-hours');
    if (status === 'HOLIDAY' || sessionType === 'HOLIDAY') {
      return marketLabel('market.session.holiday', 'Market holiday');
    }
    if (status === 'CLOSED') return marketLabel('market.session.closed', 'Closed');
    if (status === 'OPEN') return marketLabel('market.session.open', 'Trading');
    return marketLabel('market.session.unknown', 'Status unknown');
  }, [marketSessionType, marketStatus, t]);

  const statColorClass = useMemo(() => {
    if (isChangeUp) return 'text-[#00c087]';
    if (isChangeDown) return 'text-[#f6465d]';
    return 'text-white/58';
  }, [isChangeUp, isChangeDown]);

  const changeSummary = useMemo(() => {
    const safeAmount = String(changeAmount || '').trim();
    const safePercent = String(change || '').trim();
    const hasAmount = safeAmount && safeAmount !== '--';
    const hasPercent = safePercent && safePercent !== '--';

    if (hasAmount && hasPercent) return `${safeAmount} (${safePercent})`;
    if (hasAmount) return safeAmount;
    if (hasPercent) return safePercent;
    return '--';
  }, [change, changeAmount]);

  const [high24h, low24h] = useMemo(() => {
    const [highValue, lowValue] = highLow.split('/').map((item) => item.trim());
    return [highValue || '--', lowValue || '--'];
  }, [highLow]);

  return (
    <div className="tabular-nums border-b border-white/[0.06] bg-[#11161d] px-3 py-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 xl:flex-nowrap">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap sm:min-w-[350px]">
          <div className="flex min-w-0 flex-col justify-center gap-1">
            {symbolSelector || (
              <span className="text-[17px] font-semibold leading-none text-white">
                {displaySymbol || formatSpotDisplaySymbol(symbol)}
              </span>
            )}
          </div>

          <div className="flex w-[154px] flex-col justify-center gap-0.5">
            <div
              data-testid="spot-header-display-price"
              data-display-source={tickerSource || ''}
              data-display-freshness={tickerFreshness || ''}
              className={`inline-flex max-w-full items-center truncate rounded-md px-1 py-0.5 text-[28px] font-semibold leading-none transition-all duration-200 ${priceColorClass} ${priceFlashClass} ${
                flash ? 'scale-[1.02] shadow-[0_0_24px_rgba(255,255,255,0.04)]' : 'scale-100'
              }`}
            >
              {price}
            </div>
            <div className="min-h-4 pl-1 text-[12px] font-semibold leading-tight">
              <span className={statColorClass}>{changeSummary}</span>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-5">
          <Metric
            label={t('spotHeaderTradeStatus', 'asset')}
            value={
              <span
                data-testid="spot-header-market-trading-status"
                className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-white/78"
                title={`${marketStatusPresentation.fullLabel} · ${tradingSessionLabel}`}
              >
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span
                    data-testid="spot-header-market-status-dot"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${displayPriceStatusTone}`}
                  />
                  <span className="truncate">{marketStatusPresentation.label}</span>
                </span>
                <span className="text-white/36">·</span>
                <span className="truncate">{tradingSessionLabel}</span>
              </span>
            }
          />
          <Metric label={t('spotHeaderHigh24h', 'asset')} value={high24h} />
          <Metric label={t('spotHeaderLow24h', 'asset')} value={low24h} />
          <Metric label={t('spotHeaderVolume24h', 'asset')} value={volume} />
          <Metric label={t('spotHeaderTurnover24h', 'asset')} value={turnover} />
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  valueClassName = 'text-white/88',
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border border-white/[0.045] bg-white/[0.02] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="text-[10px] font-medium leading-none text-white/36">{label}</div>
      <div className={`mt-1.5 text-[13px] font-medium leading-tight ${valueClassName}`}>{value}</div>
    </div>
  );
}
