import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  fetchMobileMarkets,
  getCachedMobileMarkets,
  getOverviewMarkets,
  MARKET_FALLBACK_ITEMS,
  type MarketCategoryKey,
  type MarketInstrument,
} from '../../api/market';
import MarketCategoryTabs, {
  type MarketCategoryTab,
} from '../../components/markets/MarketCategoryTabs';
import MarketOverviewCards from '../../components/markets/MarketOverviewCards';
import MarketSearchBar from '../../components/markets/MarketSearchBar';
import MarketSectionList, {
  type MarketSection,
} from '../../components/markets/MarketSectionList';
import {colors, layout, typography} from '../../theme';

const CATEGORY_TABS: MarketCategoryTab[] = [
  {key: 'overview', label: '总览'},
  {key: 'favorites', label: '自选'},
  {key: 'crypto', label: '加密货币'},
  {key: 'stock', label: '股票'},
  {key: 'cfd', label: 'CFD'},
  {key: 'onchain', label: '链上交易'},
];

const CATEGORY_LABELS: Record<
  Exclude<MarketCategoryKey, 'overview' | 'favorites'>,
  string
> = {
  stock: '股票',
  crypto: '现货',
  cfd: '合约 / CFD',
  onchain: '链上交易',
};

const SECTION_ORDER: Array<Exclude<MarketCategoryKey, 'overview' | 'favorites'>> =
  ['stock', 'crypto', 'cfd', 'onchain'];
const SCROLL_INDICATOR_INSETS = {bottom: layout.tabBarContentInset};

function getSearchText(item: MarketInstrument) {
  return `${item.symbol} ${item.displaySymbol} ${item.name}`.toLowerCase();
}

function filterByCategory(items: MarketInstrument[], category: MarketCategoryKey) {
  if (category === 'overview') return items;
  if (category === 'favorites') return [];
  return items.filter(item => item.category === category);
}

function sortByActivity(items: MarketInstrument[]) {
  return [...items].sort((a, b) => {
    const left = Math.abs(a.changePercent || 0);
    const right = Math.abs(b.changePercent || 0);
    return right - left;
  });
}

function buildSections(items: MarketInstrument[]): MarketSection[] {
  return SECTION_ORDER.map(category => ({
    key: category,
    title: CATEGORY_LABELS[category],
    items: sortByActivity(items.filter(item => item.category === category)).slice(
      0,
      5,
    ),
  })).filter(section => section.items.length > 0);
}

export default function MarketsScreen() {
  const cachedMarkets = useMemo(() => getCachedMobileMarkets(), []);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] =
    useState<MarketCategoryKey>('overview');
  const [markets, setMarkets] = useState<MarketInstrument[]>(cachedMarkets);
  const [loading, setLoading] = useState(cachedMarkets.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const marketsRef = useRef(markets);

  useEffect(() => {
    marketsRef.current = markets;
  }, [markets]);

  const loadMarkets = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const nextMarkets = await fetchMobileMarkets();
      setMarkets(nextMarkets);
      setError(null);
    } catch {
      if (marketsRef.current.length > 0) {
        setError('行情刷新失败，已继续显示上次行情');
      } else {
        // TODO: remove this fallback when the mobile market catalog is complete.
        setMarkets(MARKET_FALLBACK_ITEMS);
        setError('行情接口暂不可用，正在展示开发占位行情');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
  }, [loadMarkets]);

  const filteredMarkets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const categoryItems = filterByCategory(markets, activeCategory);

    if (!normalizedQuery) return categoryItems;
    return categoryItems.filter(item =>
      getSearchText(item).includes(normalizedQuery),
    );
  }, [activeCategory, markets, query]);

  const overviewCards = useMemo(() => {
    const source = query.trim() ? filteredMarkets : markets;
    return getOverviewMarkets(source);
  }, [filteredMarkets, markets, query]);

  const sections = useMemo(
    () => buildSections(filteredMarkets),
    [filteredMarkets],
  );

  const hasData = markets.length > 0;
  const showInitialSkeleton = loading && !hasData;
  const showInlineRefreshing = loading && hasData && !refreshing;
  const showSearchEmpty =
    query.trim().length > 0 && !showInitialSkeleton && filteredMarkets.length === 0;
  const showEmpty =
    !query.trim() &&
    !showInitialSkeleton &&
    activeCategory !== 'favorites' &&
    filteredMarkets.length === 0;
  const showFavoriteEmpty =
    !showInitialSkeleton &&
    activeCategory === 'favorites' &&
    filteredMarkets.length === 0;

  const handleRowPress = useCallback((_item: MarketInstrument) => {
    // TODO: wire this to symbol detail or the corresponding trade page once
    // mobile route params for market symbols are finalized.
  }, []);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.marketBg} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.gold}
            onRefresh={() => loadMarkets(true)}
          />
        }
        scrollIndicatorInsets={SCROLL_INDICATOR_INSETS}
        showsVerticalScrollIndicator={false}
        style={styles.scroller}
        contentContainerStyle={styles.content}>
        <MarketSearchBar value={query} onChangeText={setQuery} />
        <MarketCategoryTabs
          activeKey={activeCategory}
          tabs={CATEGORY_TABS}
          onChange={setActiveCategory}
        />

        {error ? (
          <View style={styles.warning}>
            <Text style={styles.warningText}>{error}</Text>
            <Pressable style={styles.retryButton} onPress={() => loadMarkets(true)}>
              <Text style={styles.retryText}>重试</Text>
            </Pressable>
          </View>
        ) : null}

        {showInlineRefreshing ? (
          <View style={styles.inlineLoading}>
            <ActivityIndicator color={colors.gold} size="small" />
            <Text style={styles.inlineLoadingText}>行情刷新中</Text>
          </View>
        ) : null}

        {showInitialSkeleton ? (
          <MarketLoadingSkeleton />
        ) : (
          <>
            {activeCategory === 'overview' && overviewCards.length > 0 ? (
              <>
                <View style={styles.overviewHeader}>
                  <View style={styles.coinDots}>
                    <View style={[styles.coinDot, styles.orangeDot]} />
                    <View style={[styles.coinDot, styles.blueDot]} />
                    <View style={[styles.coinDot, styles.greenDot]} />
                    <View style={[styles.coinDot, styles.goldDot]} />
                  </View>
                  <Text style={styles.overviewTitle}>一站买尽全球核心资产</Text>
                </View>
                <MarketOverviewCards items={overviewCards} />
              </>
            ) : null}

            {sections.length > 0 ? (
              <MarketSectionList
                sections={sections}
                onRowPress={handleRowPress}
              />
            ) : null}

            {showFavoriteEmpty ? (
              <View style={styles.stateCard}>
                <Text style={styles.stateTitle}>自选列表为空</Text>
                <Text style={styles.stateText}>自选行情将在后续版本接入</Text>
              </View>
            ) : null}

            {showSearchEmpty ? (
              <View style={styles.stateCard}>
                <Text style={styles.stateTitle}>没有找到匹配交易对</Text>
                <Text style={styles.stateText}>换个关键词试试</Text>
              </View>
            ) : null}

            {showEmpty ? (
              <View style={styles.stateCard}>
                <Text style={styles.stateTitle}>暂无行情数据</Text>
                <Text style={styles.stateText}>下拉刷新或稍后再试</Text>
                <Pressable
                  style={styles.stateRetryButton}
                  onPress={() => loadMarkets(true)}>
                  <Text style={styles.retryText}>重试</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function MarketLoadingSkeleton() {
  return (
    <View>
      <View style={styles.overviewHeader}>
        <View style={styles.skeletonDots}>
          <SkeletonBlock style={styles.skeletonDot} />
          <SkeletonBlock style={styles.skeletonDot} />
          <SkeletonBlock style={styles.skeletonDot} />
          <SkeletonBlock style={styles.skeletonDot} />
        </View>
        <SkeletonBlock style={styles.skeletonTitle} />
      </View>
      <View style={styles.skeletonGrid}>
        {Array.from({length: 6}).map((_, index) => (
          <View key={`overview-skeleton-${index}`} style={styles.skeletonCard}>
            <SkeletonBlock style={styles.skeletonSymbol} />
            <SkeletonBlock style={styles.skeletonPrice} />
            <SkeletonBlock style={styles.skeletonChange} />
            <SkeletonBlock style={styles.skeletonTrend} />
          </View>
        ))}
      </View>
      {Array.from({length: 3}).map((_, sectionIndex) => (
        <View key={`section-skeleton-${sectionIndex}`} style={styles.skeletonSection}>
          <View style={styles.skeletonSectionHeader}>
            <SkeletonBlock style={styles.skeletonSectionTitle} />
            <SkeletonBlock style={styles.skeletonChevron} />
          </View>
          {Array.from({length: 4}).map((__, rowIndex) => (
            <View key={`row-skeleton-${sectionIndex}-${rowIndex}`} style={styles.skeletonRow}>
              <SkeletonBlock style={styles.skeletonAvatar} />
              <View style={styles.skeletonNameWrap}>
                <SkeletonBlock style={styles.skeletonRowSymbol} />
                <SkeletonBlock style={styles.skeletonRowName} />
              </View>
              <SkeletonBlock style={styles.skeletonRowPrice} />
              <SkeletonBlock style={styles.skeletonBadge} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function SkeletonBlock({style}: {style: StyleProp<ViewStyle>}) {
  return <View style={[styles.skeletonBlock, style]} />;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.marketBg,
  },
  scroller: {
    flex: 1,
    backgroundColor: colors.marketBg,
  },
  content: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: layout.tabBarContentInset,
  },
  warning: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  warningText: {
    ...typography.medium,
    flex: 1,
    color: colors.gold,
    fontSize: 12,
  },
  retryButton: {
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 10,
  },
  retryText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  inlineLoading: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  inlineLoadingText: {
    color: colors.marketMuted,
    fontSize: 12,
  },
  overviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
    marginBottom: 10,
  },
  coinDots: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  coinDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 2,
    borderWidth: 1,
    borderColor: colors.bg,
  },
  orangeDot: {
    backgroundColor: '#FF8A1F',
  },
  blueDot: {
    backgroundColor: '#2F80ED',
  },
  greenDot: {
    backgroundColor: colors.green,
  },
  goldDot: {
    backgroundColor: colors.gold,
  },
  overviewTitle: {
    ...typography.medium,
    color: colors.marketMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  stateCard: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 118,
    borderRadius: 8,
    backgroundColor: colors.marketCard,
    padding: 18,
  },
  stateTitle: {
    ...typography.medium,
    color: colors.marketText,
    fontSize: 15,
    fontWeight: '900',
  },
  stateText: {
    marginTop: 6,
    color: colors.marketMuted,
    fontSize: 12,
  },
  stateRetryButton: {
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    borderRadius: 7,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 14,
  },
  skeletonBlock: {
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.06)',
  },
  skeletonDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  skeletonDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  skeletonTitle: {
    width: 126,
    height: 10,
  },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  skeletonCard: {
    width: '31.6%',
    minHeight: 114,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.marketLine,
    backgroundColor: colors.marketCard,
    paddingHorizontal: 11,
    paddingVertical: 11,
  },
  skeletonSymbol: {
    width: 42,
    height: 11,
  },
  skeletonPrice: {
    width: '76%',
    height: 13,
    marginTop: 12,
  },
  skeletonChange: {
    width: 48,
    height: 11,
    marginTop: 8,
  },
  skeletonTrend: {
    width: '86%',
    height: 30,
    marginTop: 10,
  },
  skeletonSection: {
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.marketLine,
    backgroundColor: colors.marketCard,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  skeletonSectionHeader: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  skeletonSectionTitle: {
    width: 64,
    height: 14,
  },
  skeletonChevron: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  skeletonRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.marketLine,
    paddingVertical: 7,
  },
  skeletonAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: 10,
  },
  skeletonNameWrap: {
    flex: 1,
    gap: 7,
  },
  skeletonRowSymbol: {
    width: 58,
    height: 13,
  },
  skeletonRowName: {
    width: 92,
    height: 10,
  },
  skeletonRowPrice: {
    width: 70,
    height: 13,
    marginRight: 14,
  },
  skeletonBadge: {
    width: 76,
    height: 29,
  },
});
