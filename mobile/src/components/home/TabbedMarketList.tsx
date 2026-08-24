import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MarketInstrument } from '../../api/market';
import { useMarketFavorites } from '../../hooks/useMarketFavorites';
import { useLanguage, type TranslationKey } from '../../i18n';
import { colors, typography } from '../../theme';
import MarketRow from '../common/MarketRow';

export type HomeMarketRankingKey =
  | 'favorites'
  | 'holdings'
  | 'hot'
  | 'gainers'
  | 'losers';

type Props = {
  holdingSymbols?: readonly string[];
  holdingsLoading?: boolean;
  holdingsUnavailable?: boolean;
  items?: readonly MarketInstrument[];
  onPress?: (item: MarketInstrument) => void;
};

const RANKING_TABS: Array<{
  key: HomeMarketRankingKey;
  labelKey: TranslationKey;
}> = [
  { key: 'favorites', labelKey: 'home.marketTabFavorites' },
  { key: 'holdings', labelKey: 'home.marketTabHoldings' },
  { key: 'hot', labelKey: 'home.marketTabHot' },
  { key: 'gainers', labelKey: 'home.marketTabGainers' },
  { key: 'losers', labelKey: 'home.marketTabLosers' },
];

export default function TabbedMarketList({
  holdingSymbols = [],
  holdingsLoading = false,
  holdingsUnavailable = false,
  items = [],
  onPress,
}: Props) {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<HomeMarketRankingKey>('hot');
  const favorites = useMarketFavorites();
  const favoriteSet = useMemo(
    () => new Set(favorites.symbols.map(normalizeMarketIdentity)),
    [favorites.symbols],
  );
  const visibleItems = useMemo(
    () =>
      selectHomeMarketRankingItems({
        favoriteSymbols: favorites.symbols,
        holdingSymbols,
        items,
        ranking: activeTab,
      }).slice(0, 6),
    [activeTab, favorites.symbols, holdingSymbols, items],
  );
  const toggleFavorite = useCallback(
    (item: MarketInstrument) => {
      favorites.toggle(item.symbol);
    },
    [favorites],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}
      >
        {RANKING_TABS.map(tab => {
          const active = activeTab === tab.key;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              style={({ pressed }) => [
                styles.tab,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text
                style={[styles.tabLabel, active ? styles.activeLabel : null]}
              >
                {t(tab.labelKey)}
              </Text>
              <View
                style={[
                  styles.indicator,
                  active ? styles.activeIndicator : null,
                ]}
              />
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.list}>
        {visibleItems.map(item => {
          const favorite = favoriteSet.has(
            normalizeMarketIdentity(item.symbol),
          );
          return (
            <MarketRow
              favorite={favorite}
              favoriteAccessibilityLabel={t(
                favorite
                  ? 'home.marketRemoveFavoriteA11y'
                  : 'home.marketAddFavoriteA11y',
                { symbol: item.displaySymbol },
              )}
              item={item}
              key={item.id}
              onPress={onPress}
              onToggleFavorite={toggleFavorite}
            />
          );
        })}
        {visibleItems.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {getEmptyMessage({
                activeTab,
                favoritesLoading: favorites.loading,
                holdingsLoading,
                holdingsUnavailable,
                t,
              })}
            </Text>
          </View>
        ) : null}
        {favorites.error ? (
          <Text style={styles.error}>
            {t('home.marketFavoritesSaveFailed')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function selectHomeMarketRankingItems({
  favoriteSymbols,
  holdingSymbols,
  items,
  ranking,
}: {
  favoriteSymbols: readonly string[];
  holdingSymbols: readonly string[];
  items: readonly MarketInstrument[];
  ranking: HomeMarketRankingKey;
}) {
  if (ranking === 'favorites') {
    return orderByIdentity(items, favoriteSymbols, item => item.symbol);
  }
  if (ranking === 'holdings') {
    return orderByIdentity(items, holdingSymbols, item => item.displaySymbol);
  }
  if (ranking === 'gainers') {
    return [...items]
      .filter(item => (item.changePercent ?? 0) > 0)
      .sort(compareChangeDescending);
  }
  if (ranking === 'losers') {
    return [...items]
      .filter(item => (item.changePercent ?? 0) < 0)
      .sort(compareChangeAscending);
  }
  return [...items].sort(compareHotMarkets);
}

function getEmptyMessage({
  activeTab,
  favoritesLoading,
  holdingsLoading,
  holdingsUnavailable,
  t,
}: {
  activeTab: HomeMarketRankingKey;
  favoritesLoading: boolean;
  holdingsLoading: boolean;
  holdingsUnavailable: boolean;
  t: ReturnType<typeof useLanguage>['t'];
}) {
  if (activeTab === 'favorites') {
    return favoritesLoading
      ? t('common.loading')
      : t('home.marketFavoritesEmpty');
  }
  if (activeTab === 'holdings') {
    if (holdingsLoading) return t('home.marketHoldingsLoading');
    if (holdingsUnavailable) return t('home.marketHoldingsUnavailable');
    return t('home.marketHoldingsEmpty');
  }
  if (activeTab === 'gainers') return t('home.marketGainersEmpty');
  if (activeTab === 'losers') return t('home.marketLosersEmpty');
  return t('home.marketsUnavailable');
}

function orderByIdentity(
  items: readonly MarketInstrument[],
  identities: readonly string[],
  getItemIdentity: (item: MarketInstrument) => string,
) {
  const order = new Map(
    identities.map((identity, index) => [
      normalizeMarketIdentity(identity),
      index,
    ]),
  );
  return items
    .filter(item => order.has(normalizeMarketIdentity(getItemIdentity(item))))
    .sort(
      (left, right) =>
        (order.get(normalizeMarketIdentity(getItemIdentity(left))) ?? 0) -
        (order.get(normalizeMarketIdentity(getItemIdentity(right))) ?? 0),
    );
}

function compareHotMarkets(left: MarketInstrument, right: MarketInstrument) {
  const leftRank = left.overviewRank;
  const rightRank = right.overviewRank;
  if (typeof leftRank === 'number' && typeof rightRank === 'number') {
    return leftRank - rightRank;
  }
  if (typeof leftRank === 'number') return -1;
  if (typeof rightRank === 'number') return 1;
  return compareActivity(right, left);
}

function compareChangeDescending(
  left: MarketInstrument,
  right: MarketInstrument,
) {
  return compareNullableNumber(right.changePercent, left.changePercent);
}

function compareChangeAscending(
  left: MarketInstrument,
  right: MarketInstrument,
) {
  return compareNullableNumber(left.changePercent, right.changePercent);
}

function compareActivity(left: MarketInstrument, right: MarketInstrument) {
  return compareNullableNumber(
    Math.abs(left.changePercent ?? 0),
    Math.abs(right.changePercent ?? 0),
  );
}

function compareNullableNumber(left: number | null, right: number | null) {
  return (
    (left ?? Number.NEGATIVE_INFINITY) - (right ?? Number.NEGATIVE_INFINITY)
  );
}

function normalizeMarketIdentity(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '');
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  tabs: {
    minHeight: 42,
    gap: 18,
    alignItems: 'center',
    paddingRight: 12,
  },
  tab: {
    minHeight: 40,
    justifyContent: 'center',
  },
  tabLabel: {
    ...typography.medium,
    color: colors.textSubtle,
    fontSize: 13,
  },
  activeLabel: {
    color: colors.gold,
    fontWeight: '700',
  },
  indicator: {
    position: 'absolute',
    bottom: 2,
    left: 0,
    right: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'transparent',
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
  list: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  empty: {
    minHeight: 112,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    ...typography.regular,
    color: colors.textSubtle,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
  },
  error: {
    ...typography.regular,
    paddingVertical: 8,
    color: colors.red,
    fontSize: 11,
    textAlign: 'center',
  },
});
