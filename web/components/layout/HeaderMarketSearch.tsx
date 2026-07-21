'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { useRouter } from 'next/navigation';

import { useLocaleContext } from '@/contexts/LocaleContext';
import { getContractSymbols } from '@/lib/api/modules/contract';
import { getSpotMarketPairs } from '@/lib/api/modules/spot';
import {
  HEADER_MARKET_SEARCH_GROUP_ORDER,
  mergeHeaderMarketSearchResults,
  type HeaderMarketSearchGroup,
  type HeaderMarketSearchKind,
  type HeaderMarketSearchResult,
} from './headerMarketSearchModel';

type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

type HeaderMarketSearchProps = {
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

type CachedSearch = {
  expiresAt: number;
  results: HeaderMarketSearchResult[];
};

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 40;
const SEARCH_RESULT_LIMIT = 8;
const searchCache = new Map<string, CachedSearch>();

function readCachedSearch(query: string): HeaderMarketSearchResult[] | null {
  const cached = searchCache.get(query);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    searchCache.delete(query);
    return null;
  }
  return cached.results;
}

function writeCachedSearch(query: string, results: HeaderMarketSearchResult[]) {
  if (!searchCache.has(query) && searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(query, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    results,
  });
}

export default function HeaderMarketSearch({ onClose, triggerRef }: HeaderMarketSearchProps) {
  const router = useRouter();
  const { t } = useLocaleContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const requestVersionRef = useRef(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HeaderMarketSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);

  const indexedGroups = useMemo(
    () => HEADER_MARKET_SEARCH_GROUP_ORDER.map((group) => ({
      group,
      items: results
        .map((result, index) => ({ result, index }))
        .filter((item) => item.result.group === group),
    })).filter((group) => group.items.length > 0),
    [results],
  );

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose, triggerRef]);

  useEffect(() => {
    const normalizedQuery = query.trim().toUpperCase();
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setActiveIndex(-1);

    if (!normalizedQuery) {
      setResults([]);
      setStatus('idle');
      return;
    }

    const cached = readCachedSearch(normalizedQuery);
    if (cached) {
      setResults(cached);
      setStatus('ready');
      setActiveIndex(cached.length > 0 ? 0 : -1);
      return;
    }

    setResults([]);
    setStatus('loading');
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const [spotResponse, contractResponse] = await Promise.allSettled([
        getSpotMarketPairs({
          marketType: 'spot',
          category: 'all',
          quote: 'all',
          keyword: normalizedQuery,
          page: 1,
          pageSize: SEARCH_RESULT_LIMIT,
        }),
        getContractSymbols({
          category: 'all',
          quote: 'all',
          keyword: normalizedQuery,
          page: 1,
          page_size: SEARCH_RESULT_LIMIT,
        }),
      ]);
      if (cancelled || requestVersionRef.current !== requestVersion) return;

      if (spotResponse.status === 'rejected' && contractResponse.status === 'rejected') {
        setStatus('error');
        return;
      }

      const nextResults = mergeHeaderMarketSearchResults(
        spotResponse.status === 'fulfilled' ? spotResponse.value.items : [],
        contractResponse.status === 'fulfilled' ? contractResponse.value.items : [],
      );
      writeCachedSearch(normalizedQuery, nextResults);
      setResults(nextResults);
      setStatus('ready');
      setActiveIndex(nextResults.length > 0 ? 0 : -1);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const groupLabel = (group: HeaderMarketSearchGroup): string => {
    const keys: Record<HeaderMarketSearchGroup, string> = {
      SPOT: 'spot',
      CONTRACT: 'contract',
      STOCK: 'stocks',
      CFD: 'cfd',
    };
    return t(keys[group], 'markets');
  };

  const kindLabel = (kind: HeaderMarketSearchKind): string => {
    const keys: Record<HeaderMarketSearchKind, string> = {
      SPOT: 'spot',
      CONTRACT: 'contract',
      STOCK_QUOTE: 'stocks',
      STOCK_CONTRACT: 'stockContracts',
      CFD: 'cfd',
    };
    return t(keys[kind], 'markets');
  };

  const navigateToResult = (result: HeaderMarketSearchResult) => {
    onClose();
    router.push(result.href);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? results.length - 1 : current - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[activeIndex >= 0 ? activeIndex : 0];
      if (selected) navigateToResult(selected);
    }
  };

  const hasQuery = query.trim().length > 0;
  const activeResultId = activeIndex >= 0 ? `header-search-result-${activeIndex}` : undefined;

  return (
    <section className="relative z-50 border-b border-white/10 bg-[#0a0a0d] px-3.5 py-3">
      <div ref={rootRef} className="relative mx-auto max-w-7xl">
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('searchPlaceholder', 'common')}
            className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-4 pr-11 text-sm text-white outline-none transition-colors duration-200 placeholder:text-white/50 focus:border-amber-500"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={hasQuery}
            aria-controls="header-market-search-results"
            aria-activedescendant={activeResultId}
            autoComplete="off"
            autoFocus
          />
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center text-white/50 transition-colors duration-200 hover:text-white"
            aria-label={t('closeSearch', 'common')}
          >
            {'\u00d7'}
          </button>
        </div>

        {hasQuery ? (
          <div
            id="header-market-search-results"
            className="absolute inset-x-0 top-12 z-50 max-h-[calc(100vh-8rem)] overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#11161d] shadow-2xl shadow-black/60 sm:max-h-[520px]"
            role="listbox"
            aria-label={t('search', 'common')}
            aria-live="polite"
          >
            {status === 'loading' ? (
              <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-white/55">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-amber-400" aria-hidden="true" />
                {t('loading', 'common')}
              </div>
            ) : null}

            {status === 'error' ? (
              <div className="px-4 py-8 text-center text-sm text-red-300">
                {t('marketLoadFailed', 'markets')}
              </div>
            ) : null}

            {status === 'ready' && results.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-white/50">
                {t('noMatchingMarkets', 'markets')}
              </div>
            ) : null}

            {status === 'ready' && results.length > 0 ? (
              <div className="py-2">
                {indexedGroups.map(({ group, items }) => (
                  <div key={group} className="border-b border-white/[0.07] py-1 last:border-b-0">
                    <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                      {groupLabel(group)}
                    </div>
                    {items.map(({ result, index }) => {
                      const isActive = index === activeIndex;
                      const subtitle = result.displaySymbol !== result.symbol
                        ? `${result.symbol} · ${kindLabel(result.kind)}`
                        : kindLabel(result.kind);
                      return (
                        <button
                          key={result.id}
                          id={`header-search-result-${index}`}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          onMouseEnter={() => {
                            setActiveIndex(index);
                            router.prefetch(result.href);
                          }}
                          onClick={() => navigateToResult(result)}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                            isActive ? 'bg-amber-400/10' : 'hover:bg-white/[0.05]'
                          }`}
                        >
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-[10px] font-bold text-white/75">
                            {result.symbol.slice(0, 3)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-white">
                              {result.displaySymbol}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-white/45">{subtitle}</span>
                          </span>
                          <span className="text-sm text-amber-400" aria-hidden="true">{'\u2192'}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
