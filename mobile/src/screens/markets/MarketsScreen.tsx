import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  fetchMobileMarkets,
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
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] =
    useState<MarketCategoryKey>('overview');
  const [markets, setMarkets] = useState<MarketInstrument[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setMarkets(MARKET_FALLBACK_ITEMS);
      setError('行情接口暂不可用，正在展示开发占位行情');
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

  const showSearchEmpty =
    query.trim().length > 0 && !loading && filteredMarkets.length === 0;
  const showEmpty =
    !query.trim() &&
    !loading &&
    activeCategory !== 'favorites' &&
    filteredMarkets.length === 0;
  const showFavoriteEmpty =
    !loading && activeCategory === 'favorites' && filteredMarkets.length === 0;

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

        {error ? <Text style={styles.warning}>{error}</Text> : null}

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.gold} />
            <Text style={styles.loadingText}>正在加载行情</Text>
          </View>
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
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
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
    ...typography.medium,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    color: colors.gold,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  loading: {
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingText: {
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
});
