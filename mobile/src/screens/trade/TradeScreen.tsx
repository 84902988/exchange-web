import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import MobileKlineChart from '../../components/trade/MobileKlineChart';
import TradeBottomTabs, {
  type TradeRecordTab,
} from '../../components/trade/TradeBottomTabs';
import TradeChartModal from '../../components/trade/TradeChartModal';
import TradeMoreSheet from '../../components/trade/TradeMoreSheet';
import TradeOrderBook from '../../components/trade/TradeOrderBook';
import TradeOrderForm, {
  type TradeOrderType,
  type TradeSide,
} from '../../components/trade/TradeOrderForm';
import TradeSymbolHeader from '../../components/trade/TradeSymbolHeader';
import TradeTopTabs, {
  type TradeBusinessTab,
} from '../../components/trade/TradeTopTabs';
import type {KlineInterval} from '../../components/trade/kline.utils';
import type {RootStackParamList} from '../../navigation/types';
import {
  fetchSpotBalances,
  fetchSpotCurrentOrders,
  fetchSpotDepth,
  fetchSpotHistoryOrders,
  fetchSpotKlines,
  fetchSpotMyTrades,
  fetchSpotTicker,
  fetchSpotTrades,
  formatSpotNumber,
  type SpotKline,
  type SpotMyTradeItem,
  type SpotOrderBookLevel,
  type SpotOrderItem,
  type SpotTicker,
  type SpotTrade,
} from '../../api/spot';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_SYMBOL_LABEL = 'BTC/USDT';
const BASE_ASSET = 'BTC';
const QUOTE_ASSET = 'USDT';

const businessTabs: TradeBusinessTab[] = [
  {key: 'spot', label: '现货'},
  {key: 'margin', label: '杠杆', disabled: true},
  {key: 'onchain', label: '链上交易', disabled: true},
  {key: 'earn', label: '理财', disabled: true},
  {key: 'buy', label: '买币', disabled: true},
  {key: 'tools', label: '工具', disabled: true},
];

export default function TradeScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [activeBusiness, setActiveBusiness] = useState('spot');
  const [side, setSide] = useState<TradeSide>('BUY');
  const [orderType, setOrderType] = useState<TradeOrderType>('LIMIT');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [ticker, setTicker] = useState<SpotTicker | null>(null);
  const [asks, setAsks] = useState<SpotOrderBookLevel[]>([]);
  const [bids, setBids] = useState<SpotOrderBookLevel[]>([]);
  const [trades, setTrades] = useState<SpotTrade[]>([]);
  const [klines, setKlines] = useState<SpotKline[]>([]);
  const [availableBase, setAvailableBase] = useState<number | null>(null);
  const [availableQuote, setAvailableQuote] = useState<number | null>(null);
  const [currentOrders, setCurrentOrders] = useState<SpotOrderItem[]>([]);
  const [historyOrders, setHistoryOrders] = useState<SpotOrderItem[]>([]);
  const [myTrades, setMyTrades] = useState<SpotMyTradeItem[]>([]);
  const [recordTab, setRecordTab] = useState<TradeRecordTab>('current');
  const [publicError, setPublicError] = useState<string | null>(null);
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [publicLoading, setPublicLoading] = useState(true);
  const [klineInterval, setKlineInterval] = useState<KlineInterval>('1m');
  const [moreOpen, setMoreOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);

  const pricePrecision = ticker?.pricePrecision ?? 2;
  const lastPrice = ticker?.lastPrice ?? null;
  const changePercent = ticker?.changePercent ?? null;
  const availableText =
    side === 'BUY'
      ? `${formatSpotNumber(availableQuote, 2)} ${QUOTE_ASSET}`
      : `${formatSpotNumber(availableBase, 6)} ${BASE_ASSET}`;

  const loadPublicSnapshot = useCallback(async () => {
    try {
      const [nextTicker, depth, nextTrades] = await Promise.all([
        fetchSpotTicker(DEFAULT_SYMBOL),
        fetchSpotDepth(DEFAULT_SYMBOL, 10),
        fetchSpotTrades(DEFAULT_SYMBOL, 20),
      ]);
      setTicker(nextTicker);
      setAsks(depth.asks);
      setBids(depth.bids);
      setTrades(nextTrades);
      setPublicError(null);
      if (nextTicker?.lastPrice) {
        setPrice(current =>
          current || formatSpotNumber(nextTicker.lastPrice, nextTicker.pricePrecision),
        );
      }
    } catch (error) {
      setPublicError(error instanceof Error ? error.message : '行情加载失败');
    }
  }, []);

  const loadPublicKlines = useCallback(async () => {
    setPublicLoading(true);
    try {
      const nextKlines = await fetchSpotKlines(DEFAULT_SYMBOL, klineInterval, 80);
      setKlines(nextKlines);
      setPublicError(null);
    } catch (error) {
      setPublicError(error instanceof Error ? error.message : 'K线加载失败');
    } finally {
      setPublicLoading(false);
    }
  }, [klineInterval]);

  const loadPrivateData = useCallback(async () => {
    if (!isLoggedIn) {
      setAvailableBase(null);
      setAvailableQuote(null);
      setCurrentOrders([]);
      setHistoryOrders([]);
      setMyTrades([]);
      setPrivateError(null);
      return;
    }

    try {
      const [balances, current, history, fills] = await Promise.all([
        fetchSpotBalances(DEFAULT_SYMBOL),
        fetchSpotCurrentOrders(DEFAULT_SYMBOL),
        fetchSpotHistoryOrders(DEFAULT_SYMBOL),
        fetchSpotMyTrades(DEFAULT_SYMBOL),
      ]);
      const base = balances.find(item => item.coinSymbol === BASE_ASSET);
      const quote = balances.find(item => item.coinSymbol === QUOTE_ASSET);
      setAvailableBase(base?.availableAmount ?? null);
      setAvailableQuote(quote?.availableAmount ?? null);
      setCurrentOrders(current);
      setHistoryOrders(history);
      setMyTrades(fills);
      setPrivateError(null);
    } catch (error) {
      setPrivateError(error instanceof Error ? error.message : '账户交易数据加载失败');
    }
  }, [isLoggedIn]);

  useEffect(() => {
    loadPublicSnapshot();
  }, [loadPublicSnapshot]);

  useEffect(() => {
    loadPublicKlines();
  }, [loadPublicKlines]);

  useEffect(() => {
    loadPrivateData();
  }, [loadPrivateData]);

  const handleBusinessChange = useCallback((key: string) => {
    if (key !== 'spot') {
      Alert.alert('暂未开放', '当前 V1 仅实现现货交易页。');
      return;
    }
    setActiveBusiness(key);
  }, []);

  const handlePercentPress = useCallback(
    (percent: number) => {
      const referencePrice =
        orderType === 'MARKET' ? lastPrice : Number(price.replace(/,/g, ''));
      if (side === 'BUY') {
        if (!availableQuote || !referencePrice) return;
        setAmount(formatSpotNumber((availableQuote * percent) / 100 / referencePrice, 6));
        return;
      }
      if (!availableBase) return;
      setAmount(formatSpotNumber((availableBase * percent) / 100, 6));
    },
    [availableBase, availableQuote, lastPrice, orderType, price, side],
  );

  const openLogin = useCallback(() => {
    navigation.navigate('Auth', {screen: 'Login'});
  }, [navigation]);

  const handleSubmit = useCallback(() => {
    Alert.alert(
      '暂未提交',
      'TODO：下一步接入 /order/create，并在提交前完成余额、精度和风险校验。',
    );
  }, []);

  const handleOpenChart = useCallback(() => {
    setChartOpen(true);
  }, []);

  const handleKlineIntervalChange = useCallback((nextInterval: KlineInterval) => {
    setKlineInterval(nextInterval);
    setKlines([]);
    setPublicError(null);
  }, []);

  const handleMoreAction = useCallback((label: string) => {
    setMoreOpen(false);
    Alert.alert(label, '该功能入口已预留，后续接入对应移动端页面。');
  }, []);

  return (
    <AppScreen>
      <TradeTopTabs
        activeKey={activeBusiness}
        tabs={businessTabs}
        onChange={handleBusinessChange}
      />
      <TradeSymbolHeader
        changePercent={changePercent}
        lastPrice={lastPrice}
        pricePrecision={pricePrecision}
        symbolLabel={DEFAULT_SYMBOL_LABEL}
        onOpenChart={handleOpenChart}
        onOpenMore={() => setMoreOpen(true)}
      />
      {publicError ? <Text style={styles.error}>{publicError}</Text> : null}
      <View style={styles.tradeMain}>
        <TradeOrderForm
          amount={amount}
          availableText={availableText}
          baseAsset={BASE_ASSET}
          isLoggedIn={isLoggedIn}
          lastPrice={lastPrice}
          orderType={orderType}
          price={price}
          quoteAsset={QUOTE_ASSET}
          side={side}
          onAmountChange={setAmount}
          onLoginPress={openLogin}
          onOrderTypeChange={setOrderType}
          onPercentPress={handlePercentPress}
          onPriceChange={setPrice}
          onSideChange={setSide}
          onSubmitPress={handleSubmit}
        />
        <TradeOrderBook
          asks={asks}
          bids={bids}
          lastPrice={lastPrice}
          pricePrecision={pricePrecision}
          trades={trades}
          onPricePress={setPrice}
        />
      </View>

      <View style={styles.chartCard}>
        <View style={styles.chartHeader}>
          <Text style={styles.chartTitle}>K线 / 行情走势</Text>
          <Pressable onPress={handleOpenChart}>
            <Text style={styles.chartAction}>全屏</Text>
          </Pressable>
        </View>
        <MobileKlineChart
          error={publicError}
          height={176}
          interval={klineInterval}
          items={klines}
          loading={publicLoading}
          pricePrecision={pricePrecision}
          visibleCount={42}
          onIntervalChange={handleKlineIntervalChange}
        />
      </View>

      <TradeBottomTabs
        activeTab={recordTab}
        currentOrders={currentOrders}
        error={privateError}
        fills={myTrades}
        historyOrders={historyOrders}
        isLoggedIn={isLoggedIn}
        onChange={setRecordTab}
        onLoginPress={openLogin}
      />

      <TradeMoreSheet
        visible={moreOpen}
        onActionPress={handleMoreAction}
        onClose={() => setMoreOpen(false)}
      />
      <TradeChartModal
        asks={asks}
        bids={bids}
        changePercent={changePercent}
        error={publicError}
        interval={klineInterval}
        klines={klines}
        lastPrice={lastPrice}
        loading={publicLoading}
        pricePrecision={pricePrecision}
        symbolLabel={DEFAULT_SYMBOL_LABEL}
        trades={trades}
        visible={chartOpen}
        onIntervalChange={handleKlineIntervalChange}
        onClose={() => setChartOpen(false)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  error: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    color: colors.gold,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tradeMain: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  chartCard: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  chartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  chartTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  chartAction: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
});
