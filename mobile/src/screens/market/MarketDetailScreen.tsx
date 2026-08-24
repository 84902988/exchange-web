import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { usePreventRemove } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchSpotKlines, type SpotKline } from '../../api/spot';
import MarketDetailView from '../../components/market/MarketDetailView';
import type { KlineInterval } from '../../components/trade/kline.utils';
import { useContractKlineRealtime } from '../../hooks/useContractKlineRealtime';
import { useContractMarketRealtime } from '../../hooks/useContractMarketRealtime';
import { useMarketScreenActive } from '../../hooks/useMarketScreenActive';
import { useSpotMarketRealtime } from '../../hooks/useSpotMarketRealtime';
import { parseMarketDetailRouteParams } from '../../navigation/marketDetailRoute';
import type {
  MarketDetailRouteParams,
  RootStackParamList,
} from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'MarketDetail'>;

const EMPTY_INITIAL_KLINES: SpotKline[] = [];

export function getMarketDetailScreenOptions(fullscreen: boolean) {
  return fullscreen
    ? {
        orientation: 'landscape' as const,
        gestureEnabled: false,
        statusBarHidden: true,
        navigationBarHidden: true,
      }
    : {
        orientation: 'portrait_up' as const,
        gestureEnabled: true,
        statusBarHidden: false,
        navigationBarHidden: false,
      };
}

export function getMarketDetailFullscreenPresentation(
  requested: boolean,
  isLandscape: boolean,
) {
  return {
    fullscreen: requested && isLandscape,
    transitioning: requested !== isLandscape,
  } as const;
}

export default function MarketDetailScreen({ navigation, route }: Props) {
  const params = useMemo(
    () => parseMarketDetailRouteParams(route.params),
    [route.params],
  );
  if (!params) {
    return <InvalidRoute onBack={() => navigation.goBack()} />;
  }
  return <ValidMarketDetail navigation={navigation} params={params} />;
}

function ValidMarketDetail({
  navigation,
  params,
}: {
  navigation: Props['navigation'];
  params: MarketDetailRouteParams;
}) {
  const active = useMarketScreenActive();
  const [interval, setInterval] = useState<KlineInterval>(
    params.initialInterval ?? '1m',
  );
  const { height, width } = useWindowDimensions();
  const isLandscape = width > height;
  const [fullscreenRequested, setFullscreenRequested] = useState(false);
  const orientationTransitionRef = useRef<View>(null);
  const orientationTransitionDots = useMemo(
    () => [
      new Animated.Value(0.35),
      new Animated.Value(0.35),
      new Animated.Value(0.35),
    ],
    [],
  );
  const fullscreenPresentation = getMarketDetailFullscreenPresentation(
    fullscreenRequested,
    isLandscape,
  );

  useEffect(() => {
    if (!fullscreenPresentation.transitioning) {
      orientationTransitionDots.forEach(dot => {
        dot.stopAnimation();
        dot.setValue(0.35);
      });
      return undefined;
    }

    const animations = orientationTransitionDots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 120),
          Animated.timing(dot, {
            toValue: 1,
            duration: 180,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0.35,
            duration: 180,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.delay((orientationTransitionDots.length - index - 1) * 120),
        ]),
      ),
    );
    animations.forEach(animation => animation.start());

    return () => animations.forEach(animation => animation.stop());
  }, [
    fullscreenPresentation.transitioning,
    orientationTransitionDots,
  ]);

  useLayoutEffect(() => {
    navigation.setOptions(getMarketDetailScreenOptions(false));
  }, [navigation]);

  const requestFullscreen = useCallback(
    (next: boolean) => {
      orientationTransitionRef.current?.setNativeProps({
        style: { opacity: 1 },
      });
      setFullscreenRequested(next);
      navigation.setOptions(getMarketDetailScreenOptions(next));
    },
    [navigation],
  );

  usePreventRemove(fullscreenRequested, () => {
    requestFullscreen(false);
  });

  const handleBack = useCallback(() => {
    if (fullscreenRequested) {
      requestFullscreen(false);
      return;
    }
    navigation.goBack();
  }, [fullscreenRequested, navigation, requestFullscreen]);

  const handleEnterFullscreen = useCallback(() => {
    requestFullscreen(true);
  }, [requestFullscreen]);

  const sharedUi = {
    active,
    fullscreen: fullscreenPresentation.fullscreen,
    interval,
    onBack: handleBack,
    onEnterFullscreen: handleEnterFullscreen,
    onExitFullscreen: () => requestFullscreen(false),
    onIntervalChange: setInterval,
  };

  return (
    <View style={styles.detailRoot}>
      {params.market === 'spot' ? (
        <SpotMarketDetail params={params} {...sharedUi} />
      ) : (
        <ContractMarketDetail params={params} {...sharedUi} />
      )}
      <View
        pointerEvents={fullscreenPresentation.transitioning ? 'auto' : 'none'}
        ref={orientationTransitionRef}
        style={[
          styles.orientationTransition,
          fullscreenPresentation.transitioning
            ? null
            : styles.orientationTransitionHidden,
        ]}
        testID="market-detail-orientation-transition"
      >
        <View
          accessibilityLabel="正在切换全屏"
          accessibilityRole="progressbar"
          style={styles.orientationTransitionDots}
          testID="market-detail-orientation-transition-dots"
        >
          {orientationTransitionDots.map((opacity, index) => (
            <Animated.View
              key={index}
              style={[
                styles.orientationTransitionDot,
                {
                  opacity,
                  transform: [
                    {
                      scale: opacity.interpolate({
                        inputRange: [0.35, 1],
                        outputRange: [0.82, 1],
                      }),
                    },
                  ],
                },
              ]}
              testID={`market-detail-orientation-transition-dot-${index + 1}`}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

type SharedDetailProps = {
  active: boolean;
  fullscreen: boolean;
  interval: KlineInterval;
  onBack: () => void;
  onEnterFullscreen: () => void;
  onExitFullscreen: () => void;
  onIntervalChange: (interval: KlineInterval) => void;
};

function SpotMarketDetail({
  params,
  active,
  fullscreen,
  interval,
  onBack,
  onEnterFullscreen,
  onExitFullscreen,
  onIntervalChange,
}: SharedDetailProps & {
  params: Extract<MarketDetailRouteParams, { market: 'spot' }>;
}) {
  const realtime = useSpotMarketRealtime(
    params.symbol,
    'market-detail-spot',
    active,
  );
  const fallback = useSpotFallbackKlines(
    params.symbol,
    interval,
    active,
    params.initialKlines ?? EMPTY_INITIAL_KLINES,
    params.initialInterval ?? '1m',
  );
  const ticker = realtime.ticker;
  return (
    <MarketDetailView
      asks={realtime.depth.asks}
      baseAsset={params.baseAsset}
      baseVolume24h={ticker?.baseVolume24h ?? null}
      bids={realtime.depth.bids}
      changePercent={ticker?.changePercent ?? null}
      fallbackError={fallback.error}
      fallbackKlines={fallback.items}
      fallbackLoading={fallback.loading}
      fullscreen={fullscreen}
      high24h={ticker?.high24h ?? null}
      interval={interval}
      low24h={ticker?.low24h ?? null}
      market="spot"
      marketStatus={ticker?.marketStatus ?? null}
      price={ticker?.lastPrice ?? null}
      displayPricePrecision={
        ticker?.displayPricePrecision ?? ticker?.pricePrecision ?? 2
      }
      quoteAsset={params.quoteAsset}
      quoteVolume24h={ticker?.quoteVolume24h ?? null}
      realtimeError={realtime.error}
      realtimePhase={realtime.phase}
      symbol={params.symbol}
      symbolLabel={params.displayLabel}
      trades={realtime.trades}
      onBack={onBack}
      onEnterFullscreen={onEnterFullscreen}
      onExitFullscreen={onExitFullscreen}
      onIntervalChange={onIntervalChange}
    />
  );
}

function ContractMarketDetail({
  params,
  active,
  fullscreen,
  interval,
  onBack,
  onEnterFullscreen,
  onExitFullscreen,
  onIntervalChange,
}: SharedDetailProps & {
  params: Extract<MarketDetailRouteParams, { market: 'contract' }>;
}) {
  const { t } = useLanguage();
  const realtime = useContractMarketRealtime(
    params.symbol,
    'market-detail-contract',
    active,
  );
  const fallback = useContractKlineRealtime(
    params.symbol,
    interval,
    'market-detail-contract-native',
    active,
  );
  const initialPreviewKlines =
    interval === (params.initialInterval ?? '1m')
      ? params.initialKlines ?? EMPTY_INITIAL_KLINES
      : EMPTY_INITIAL_KLINES;
  const fallbackItems =
    fallback.items.length > 0 ? fallback.items : initialPreviewKlines;
  const view = realtime.marketView;
  const quote = view?.quote ?? null;
  const fallbackStatusNote = fallback.gapDetected
    ? t('marketDetail.klineBackfill')
    : fallback.mode === 'REST_ONLY'
    ? t('marketDetail.restRefresh')
    : fallback.phase === 'reconnecting'
    ? t('marketDetail.reconnecting')
    : null;
  return (
    <MarketDetailView
      asks={view?.depth.asks ?? []}
      baseAsset={params.baseAsset}
      baseVolume24h={quote?.baseVolume24h ?? null}
      bids={view?.depth.bids ?? []}
      category={
        params.marketCategory === 'crypto' ? undefined : params.marketCategory
      }
      changePercent={quote?.changePercent ?? null}
      fallbackError={fallback.error}
      fallbackKlines={fallbackItems}
      fallbackLoading={fallback.loading && fallbackItems.length === 0}
      fallbackStatusNote={fallbackStatusNote}
      fullscreen={fullscreen}
      high24h={quote?.high24h ?? null}
      interval={interval}
      low24h={quote?.low24h ?? null}
      market="contract"
      marketStatus={quote?.marketStatus ?? null}
      markPrice={quote?.markPrice ?? null}
      price={quote?.lastPrice ?? null}
      displayPricePrecision={quote?.pricePrecision ?? 2}
      quoteAsset={params.quoteAsset}
      quoteVolume24h={quote?.quoteVolume24h ?? null}
      referencePriceLines={params.referencePriceLines ?? []}
      realtimeError={realtime.error}
      realtimePhase={realtime.phase}
      symbol={params.symbol}
      symbolLabel={params.displayLabel}
      trades={view?.trades ?? []}
      onBack={onBack}
      onEnterFullscreen={onEnterFullscreen}
      onExitFullscreen={onExitFullscreen}
      onIntervalChange={onIntervalChange}
    />
  );
}

function useSpotFallbackKlines(
  symbol: string,
  interval: KlineInterval,
  active: boolean,
  initialItems: SpotKline[],
  initialInterval: KlineInterval,
) {
  const { t } = useLanguage();
  const tRef = useRef(t);
  const [items, setItems] = useState<SpotKline[]>(() =>
    interval === initialInterval ? initialItems : [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  tRef.current = t;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const seed = interval === initialInterval ? initialItems : [];
    const load = async (initial: boolean) => {
      if (initial) setLoading(seed.length === 0);
      try {
        const next = await fetchSpotKlines(symbol, interval, 240);
        if (cancelled) return;
        setItems(next);
        setError(null);
      } catch (nextError) {
        if (cancelled) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : tRef.current('marketDetail.klineLoadFailed'),
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => load(false), 15_000);
        }
      }
    };
    setItems(seed);
    setError(null);
    load(true).catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, initialInterval, initialItems, interval, symbol]);

  return { items, loading, error };
}

function InvalidRoute({ onBack }: { onBack: () => void }) {
  const { t } = useLanguage();
  return (
    <SafeAreaView style={styles.invalidSafe}>
      <View style={styles.invalidCard} testID="market-detail-invalid-route">
        <Text style={styles.invalidTitle}>
          {t('marketDetail.invalidTitle')}
        </Text>
        <Text style={styles.invalidMessage}>
          {t('marketDetail.invalidDescription')}
        </Text>
        <Pressable
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(0, 0, 0, 0.12)' }}
          style={({ pressed }) => [
            styles.invalidButton,
            pressed ? styles.pressed : null,
          ]}
          onPress={onBack}
        >
          <Text style={styles.invalidButtonText}>{t('common.back')}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  detailRoot: { flex: 1, backgroundColor: colors.bg },
  orientationTransition: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orientationTransitionHidden: { opacity: 0 },
  orientationTransitionDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  orientationTransitionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  invalidSafe: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: 24,
  },
  invalidCard: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: 24,
  },
  invalidTitle: { ...typography.heavy, color: colors.text, fontSize: 18 },
  invalidMessage: {
    ...typography.medium,
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  invalidButton: {
    minWidth: 110,
    minHeight: 44,
    alignItems: 'center',
    marginTop: 20,
    borderRadius: 8,
    backgroundColor: colors.gold,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  invalidButtonText: { ...typography.bold, color: colors.black, fontSize: 13 },
});
