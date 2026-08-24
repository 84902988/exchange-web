import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  StatusBar,
  StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  fetchMobileMarkets,
  getCachedMobileMarkets,
  getOverviewMarkets,
  type MarketCategoryKey,
  type MarketInstrument,
} from '../../api/market';
import {
  resolveContractTradingInstrument,
  resolveSpotTradingInstrument,
} from '../../api/tradingCatalog';
import MarketCategoryTabs, {
  type MarketCategoryTab,
} from '../../components/markets/MarketCategoryTabs';
import MarketOverviewCards from '../../components/markets/MarketOverviewCards';
import MarketSearchBar from '../../components/markets/MarketSearchBar';
import MarketSectionList, {
  type MarketSection,
} from '../../components/markets/MarketSectionList';
import type { MainTabParamList } from '../../navigation/types';
import { useLanguage, type TranslationKey, type Translator } from '../../i18n';
import { colors, layout, typography } from '../../theme';
import {resolveResponsiveLayout} from '../../constants/responsiveLayout';

const CATEGORY_TAB_KEYS: Array<{
  key: MarketCategoryKey;
  labelKey: TranslationKey;
}> = [
  { key: 'overview', labelKey: 'markets.category.overview' },
  { key: 'crypto', labelKey: 'markets.category.crypto' },
  { key: 'stock', labelKey: 'markets.category.stock' },
  { key: 'cfd', labelKey: 'markets.category.cfd' },
];

const CATEGORY_LABEL_KEYS: Record<
  Exclude<MarketCategoryKey, 'overview' | 'favorites'>,
  TranslationKey
> = {
  stock: 'markets.section.stock',
  crypto: 'markets.section.spot',
  cfd: 'markets.section.cfd',
  onchain: 'markets.section.onchain',
};

const SECTION_ORDER: Array<
  Exclude<MarketCategoryKey, 'overview' | 'favorites'>
> = ['stock', 'crypto', 'cfd'];
const SCROLL_INDICATOR_INSETS = { bottom: layout.tabBarContentInset };

function getSearchText(item: MarketInstrument) {
  return `${item.symbol} ${item.displaySymbol} ${item.name}`.toLowerCase();
}

function filterByCategory(
  items: MarketInstrument[],
  category: MarketCategoryKey,
) {
  if (category === 'overview') return items;
  return items.filter(item => item.category === category);
}

function sortByActivity(items: MarketInstrument[]) {
  return [...items].sort((a, b) => {
    const left = Math.abs(a.changePercent || 0);
    const right = Math.abs(b.changePercent || 0);
    return right - left;
  });
}

function buildSections(
  items: MarketInstrument[],
  limit: number | null,
  t: Translator,
): MarketSection[] {
  return SECTION_ORDER.map(category => ({
    key: category,
    title: t(CATEGORY_LABEL_KEYS[category]),
    items: (() => {
      const sorted = sortByActivity(
        items.filter(item => item.category === category),
      );
      return limit === null ? sorted : sorted.slice(0, limit);
    })(),
  })).filter(section => section.items.length > 0);
}

export default function MarketsScreen() {
  const { t } = useLanguage();
  const {fontScale, height, width} = useWindowDimensions();
  const responsiveContentStyle = useMemo<ViewStyle>(() => {
    const responsive = resolveResponsiveLayout(
      width,
      height,
      fontScale,
      'dashboard',
    );
    return {
      width: '100%',
      alignSelf: 'center',
      maxWidth: responsive.contentMaxWidth,
      paddingHorizontal: responsive.horizontalPadding,
    };
  }, [fontScale, height, width]);
  const navigation =
    useNavigation<BottomTabNavigationProp<MainTabParamList, 'Markets'>>();
  const route = useRoute<RouteProp<MainTabParamList, 'Markets'>>();
  const cachedMarkets = useMemo(() => getCachedMobileMarkets(), []);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] =
    useState<MarketCategoryKey>('overview');
  const [markets, setMarkets] = useState<MarketInstrument[]>(cachedMarkets);
  const [loading, setLoading] = useState(cachedMarkets.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadRequestGenerationRef = useRef(0);
  const tRef = useRef(t);
  const navigationRequestGenerationRef = useRef(0);
  const activeNavigationRowRef = useRef<string | null>(null);
  tRef.current = t;

  const categoryTabs = useMemo<MarketCategoryTab[]>(
    () =>
      CATEGORY_TAB_KEYS.map(tab => ({
        key: tab.key,
        label: t(tab.labelKey),
      })),
    [t],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestGenerationRef.current += 1;
      navigationRequestGenerationRef.current += 1;
      activeNavigationRowRef.current = null;
    };
  }, []);

  useEffect(() => {
    const requestedCategory = route.params?.category;
    if (!requestedCategory) return;
    navigationRequestGenerationRef.current += 1;
    activeNavigationRowRef.current = null;
    setRouteError(null);
    setQuery('');
    setActiveCategory(requestedCategory);
    navigation.setParams({ category: undefined });
  }, [navigation, route.params?.category]);

  const loadMarkets = useCallback(async (refresh = false) => {
    const generation = ++loadRequestGenerationRef.current;
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const nextMarkets = await fetchMobileMarkets();
      if (
        !mountedRef.current ||
        generation !== loadRequestGenerationRef.current
      ) {
        return;
      }
      setMarkets(nextMarkets);
      setError(null);
    } catch {
      if (
        !mountedRef.current ||
        generation !== loadRequestGenerationRef.current
      ) {
        return;
      }
      setMarkets([]);
      setError(tRef.current('markets.loadFailed'));
    } finally {
      if (
        mountedRef.current &&
        generation === loadRequestGenerationRef.current
      ) {
        setLoading(false);
        setRefreshing(false);
      }
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
    () =>
      buildSections(
        filteredMarkets,
        activeCategory === 'overview' ? 5 : null,
        t,
      ),
    [activeCategory, filteredMarkets, t],
  );

  const hasData = markets.length > 0;
  const showInitialSkeleton = loading && !hasData;
  const showInlineRefreshing = loading && hasData && !refreshing;
  const showSearchEmpty =
    query.trim().length > 0 &&
    !showInitialSkeleton &&
    filteredMarkets.length === 0;
  const showEmpty =
    !query.trim() && !showInitialSkeleton && filteredMarkets.length === 0;
  const handleCategoryChange = useCallback(
    (nextCategory: MarketCategoryKey) => {
      navigationRequestGenerationRef.current += 1;
      activeNavigationRowRef.current = null;
      setRouteError(null);
      setActiveCategory(nextCategory);
    },
    [],
  );

  const handleRowPress = useCallback(
    async (item: MarketInstrument) => {
      // Crypto rows are resolved once more against the authoritative spot
      // catalog before navigation. This also repairs stale mobile-overview
      // metadata for RWA spot pairs without inventing a local trade route.
      if (item.tradable === false && item.category !== 'crypto') {
        Alert.alert(
          tRef.current('markets.tradeUnsupportedTitle'),
          tRef.current('markets.tradeUnsupportedMessage', {
            symbol: item.displaySymbol,
          }),
        );
        return;
      }
      if (
        item.category !== 'crypto' &&
        item.category !== 'stock' &&
        item.category !== 'cfd'
      ) {
        return;
      }
      if (activeNavigationRowRef.current !== null) return;

      const generation = ++navigationRequestGenerationRef.current;
      activeNavigationRowRef.current = item.id;
      setRouteError(null);

      try {
        if (item.category === 'crypto') {
          const instrument = await resolveSpotTradingInstrument(
            item.tradeSymbol || item.symbol,
          );
          if (
            generation !== navigationRequestGenerationRef.current ||
            !mountedRef.current
          ) {
            return;
          }
          if (!instrument) {
            const message = tRef.current('markets.spotUnavailable');
            setRouteError(message);
            Alert.alert(tRef.current('markets.spotUnavailableTitle'), message);
            return;
          }
          navigation.navigate('Trade', {
            symbol: instrument.symbol,
            baseAsset: instrument.baseAsset,
            quoteAsset: instrument.quoteAsset,
            displayLabel: instrument.displaySymbol,
            ...(item.logoUrl ? {logoUrl: item.logoUrl} : {}),
          });
          return;
        }

        const instrument = await resolveContractTradingInstrument(
          item.tradeSymbol || item.displaySymbol || item.symbol,
        );
        if (
          generation !== navigationRequestGenerationRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        if (!instrument) {
          const message = tRef.current('markets.contractUnavailable');
          setRouteError(message);
          Alert.alert(
            tRef.current('markets.contractUnavailableTitle'),
            message,
          );
          return;
        }
        navigation.navigate('Contract', {
          symbol: instrument.symbol,
          baseAsset: instrument.baseAsset,
          quoteAsset: instrument.quoteAsset,
          displayLabel: instrument.displayName,
          marketCategory: item.category,
          ...(item.logoUrl ? {logoUrl: item.logoUrl} : {}),
        });
      } catch (requestError) {
        if (
          generation !== navigationRequestGenerationRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        const fallback =
          item.category === 'crypto'
            ? tRef.current('markets.spotCatalogFailed')
            : tRef.current('markets.contractCatalogFailed');
        const message =
          requestError instanceof Error && requestError.message.trim()
            ? requestError.message.trim()
            : fallback;
        setRouteError(message);
        Alert.alert(tRef.current('markets.entryFailedTitle'), message);
      } finally {
        if (
          generation === navigationRequestGenerationRef.current &&
          mountedRef.current
        ) {
          activeNavigationRowRef.current = null;
        }
      }
    },
    [navigation],
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.marketBg} />
      <MarketSectionList
        contentContainerStyle={[styles.content, responsiveContentStyle]}
        footer={
          showInitialSkeleton ? null : (
            <>
              {showSearchEmpty ? (
                <View style={styles.stateCard}>
                  <Text style={styles.stateTitle}>
                    {t('markets.searchEmpty')}
                  </Text>
                  <Text style={styles.stateText}>
                    {t('markets.searchEmptyDescription')}
                  </Text>
                </View>
              ) : null}

              {showEmpty ? (
                <View style={styles.stateCard}>
                  <Text style={styles.stateTitle}>{t('markets.empty')}</Text>
                  <Text style={styles.stateText}>
                    {t('markets.emptyDescription')}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                    style={({ pressed }) => [
                      styles.stateRetryButton,
                      pressed ? styles.pressed : null,
                    ]}
                    onPress={() => loadMarkets(true)}
                  >
                    <Text style={styles.retryText}>{t('common.retry')}</Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          )
        }
        header={
          <>
            <MarketSearchBar value={query} onChangeText={setQuery} />
            <MarketCategoryTabs
              activeKey={activeCategory}
              tabs={categoryTabs}
              onChange={handleCategoryChange}
            />

            {error ? (
              <View style={styles.warning}>
                <Text style={styles.warningText}>{error}</Text>
                <Pressable
                  accessibilityRole="button"
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                  style={({ pressed }) => [
                    styles.retryButton,
                    pressed ? styles.pressed : null,
                  ]}
                  onPress={() => loadMarkets(true)}
                >
                  <Text style={styles.retryText}>{t('common.retry')}</Text>
                </Pressable>
              </View>
            ) : null}

            {routeError ? (
              <View style={styles.warning}>
                <Text style={styles.warningText}>{routeError}</Text>
              </View>
            ) : null}

            {showInlineRefreshing ? (
              <View style={styles.inlineLoading}>
                <ActivityIndicator color={colors.gold} size="small" />
                <Text style={styles.inlineLoadingText}>
                  {t('markets.refreshing')}
                </Text>
              </View>
            ) : null}

            {showInitialSkeleton ? (
              <MarketLoadingSkeleton />
            ) : activeCategory === 'overview' && overviewCards.length > 0 ? (
              <>
                <View style={styles.overviewHeader}>
                  <View style={styles.coinDots}>
                    <View style={[styles.coinDot, styles.orangeDot]} />
                    <View style={[styles.coinDot, styles.blueDot]} />
                    <View style={[styles.coinDot, styles.greenDot]} />
                    <View style={[styles.coinDot, styles.goldDot]} />
                  </View>
                  <Text style={styles.overviewTitle}>
                    {t('markets.coreMarkets')}
                  </Text>
                </View>
                <MarketOverviewCards
                  items={overviewCards}
                  onPress={handleRowPress}
                />
              </>
            ) : null}
          </>
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.gold}
            onRefresh={() => loadMarkets(true)}
          />
        }
        scrollIndicatorInsets={SCROLL_INDICATOR_INSETS}
        sections={showInitialSkeleton ? [] : sections}
        style={styles.scroller}
        onRowPress={handleRowPress}
      />
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
        {Array.from({ length: 6 }).map((_, index) => (
          <View key={`overview-skeleton-${index}`} style={styles.skeletonCard}>
            <SkeletonBlock style={styles.skeletonSymbol} />
            <SkeletonBlock style={styles.skeletonPrice} />
            <SkeletonBlock style={styles.skeletonChange} />
            <SkeletonBlock style={styles.skeletonTrend} />
          </View>
        ))}
      </View>
      {Array.from({ length: 3 }).map((_, sectionIndex) => (
        <View
          key={`section-skeleton-${sectionIndex}`}
          style={styles.skeletonSection}
        >
          <View style={styles.skeletonSectionHeader}>
            <SkeletonBlock style={styles.skeletonSectionTitle} />
            <SkeletonBlock style={styles.skeletonChevron} />
          </View>
          {Array.from({ length: 4 }).map((__, rowIndex) => (
            <View
              key={`row-skeleton-${sectionIndex}-${rowIndex}`}
              style={styles.skeletonRow}
            >
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

function SkeletonBlock({ style }: { style: StyleProp<ViewStyle> }) {
  return <View style={[styles.skeletonBlock, style]} />;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  safe: {
    flex: 1,
    backgroundColor: colors.marketBg,
  },
  scroller: {
    flex: 1,
    backgroundColor: colors.marketBg,
  },
  content: {
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
    minHeight: 44,
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
    minHeight: 44,
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
