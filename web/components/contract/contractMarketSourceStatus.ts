'use client';

export type ContractMarketSourceTone =
  | 'realtime'
  | 'snapshot'
  | 'history'
  | 'internal'
  | 'fallback'
  | 'delayed'
  | 'unavailable';

export type ContractMarketSourceDomain = 'ticker' | 'depth' | 'trades' | 'kline';

type ContractTranslate = (key: string, namespace?: 'contracts') => string;

const LABEL_KEYS: Record<ContractMarketSourceTone, string> = {
  realtime: 'marketSourceRealtime',
  snapshot: 'marketSourceSnapshot',
  history: 'marketSourceHistory',
  internal: 'marketSourceInternal',
  fallback: 'marketSourceFallback',
  delayed: 'marketSourceDelayed',
  unavailable: 'marketSourceUnavailable',
};

const FALLBACK_LABELS: Record<ContractMarketSourceTone, string> = {
  realtime: 'Real-time',
  snapshot: 'Snapshot',
  history: 'History',
  internal: 'Internal',
  fallback: 'Fallback',
  delayed: 'Delayed',
  unavailable: 'Unavailable',
};

const DOMAIN_KEYS: Record<ContractMarketSourceDomain, string> = {
  ticker: 'tickerSourceStatus',
  depth: 'depthSourceStatus',
  trades: 'tradesSourceStatus',
  kline: 'klineSourceStatus',
};

const DOMAIN_FALLBACKS: Record<ContractMarketSourceDomain, string> = {
  ticker: 'Ticker source',
  depth: 'Order book source',
  trades: 'Trades source',
  kline: 'Kline source',
};

function normalize(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function contractText(t: ContractTranslate | undefined, key: string, fallback: string) {
  if (!t) return fallback;
  const value = t(key, 'contracts');
  return value === key ? fallback : value;
}

function classify(token: string | null): ContractMarketSourceTone | null {
  if (!token) return null;
  if (token === 'MISSING' || token === 'EMPTY' || token === 'UNKNOWN' || token === 'UNAVAILABLE') {
    return 'unavailable';
  }
  if (token === 'STALE' || token === 'CACHE_STALE' || token === 'EXPIRED' || token === 'DELAYED') {
    return 'delayed';
  }
  if (
    token === 'LAST_GOOD'
    || token === 'LAST_GOOD_BBO'
    || token === 'LAST_VALID'
    || token === 'FALLBACK'
    || token === 'CACHE'
    || token === 'CACHED'
  ) {
    return 'fallback';
  }
  if (token === 'REST_HISTORY' || token === 'HISTORY' || token === 'HISTORICAL') {
    return 'history';
  }
  if (token === 'INTERNAL') return 'internal';
  if (
    token === 'REST_SNAPSHOT'
    || token === 'SNAPSHOT'
    || token === 'REST'
    || token === 'PROVIDER'
    || token === 'PROVIDER_KLINE'
    || token === 'KLINE_CLOSE'
  ) {
    return 'snapshot';
  }
  if (token === 'LIVE' || token === 'LIVE_WS' || token === 'RECENT' || token === 'REALTIME') {
    return 'realtime';
  }
  return null;
}

export function getContractMarketSourceTone(
  source?: string | null,
  freshness?: string | null,
): ContractMarketSourceTone {
  const normalizedSource = normalize(source);
  const normalizedFreshness = normalize(freshness);
  const sourceTone = classify(normalizedSource);
  const freshnessTone = classify(normalizedFreshness);

  if (sourceTone === 'unavailable' || freshnessTone === 'unavailable') return 'unavailable';
  if (freshnessTone === 'delayed' || sourceTone === 'delayed') return 'delayed';
  if (freshnessTone === 'fallback' || sourceTone === 'fallback') return 'fallback';
  if (sourceTone === 'history') return 'history';
  if (sourceTone === 'internal') return 'internal';
  if (sourceTone === 'snapshot') return 'snapshot';
  if (sourceTone === 'realtime' || freshnessTone === 'realtime') return 'realtime';
  if (freshnessTone === 'history') return 'history';
  if (freshnessTone === 'internal') return 'internal';
  if (freshnessTone === 'snapshot') return 'snapshot';
  return 'unavailable';
}

export function getContractMarketSourceLabel(
  source?: string | null,
  freshness?: string | null,
  t?: ContractTranslate,
) {
  const tone = getContractMarketSourceTone(source, freshness);
  return contractText(t, LABEL_KEYS[tone], FALLBACK_LABELS[tone]);
}

export function getContractDomainStatusLabel(
  domain: ContractMarketSourceDomain,
  source?: string | null,
  freshness?: string | null,
  t?: ContractTranslate,
) {
  const domainLabel = contractText(t, DOMAIN_KEYS[domain], DOMAIN_FALLBACKS[domain]);
  const sourceLabel = getContractMarketSourceLabel(source, freshness, t);
  return `${domainLabel}: ${sourceLabel}`;
}

export function getContractMarketSourceToneClass(tone: ContractMarketSourceTone) {
  if (tone === 'realtime') return 'border-[#00c087]/20 bg-[#00c087]/10 text-[#00c087]';
  if (tone === 'snapshot') return 'border-white/10 bg-white/[0.05] text-white/58';
  if (tone === 'history' || tone === 'fallback' || tone === 'delayed') {
    return 'border-[#f0b90b]/20 bg-[#f0b90b]/10 text-[#f0b90b]';
  }
  if (tone === 'internal') return 'border-[#38bdf8]/20 bg-[#38bdf8]/10 text-[#38bdf8]';
  return 'border-[#f6465d]/20 bg-[#f6465d]/10 text-[#f6465d]';
}
