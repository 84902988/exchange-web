import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import ContractBottomTabs, {
  type ContractRecordTab,
} from '../../components/contract/ContractBottomTabs';
import ContractChartModal from '../../components/contract/ContractChartModal';
import ContractMoreSheet from '../../components/contract/ContractMoreSheet';
import ContractOrderBook from '../../components/contract/ContractOrderBook';
import ContractOrderForm, {
  type ContractActionMode,
  type ContractDirection,
} from '../../components/contract/ContractOrderForm';
import ContractSymbolHeader from '../../components/contract/ContractSymbolHeader';
import ContractTopTabs, {
  type ContractBusinessTab,
} from '../../components/contract/ContractTopTabs';
import MobileKlineChart from '../../components/trade/MobileKlineChart';
import type {KlineInterval} from '../../components/trade/kline.utils';
import type {RootStackParamList} from '../../navigation/types';
import {
  fetchContractAccountSummary,
  fetchContractDepth,
  fetchContractKlines,
  fetchContractMarketTrades,
  fetchContractOrders,
  fetchContractPositions,
  fetchContractQuote,
  fetchContractTrades,
  formatContractNumber,
  type ContractAccountSummary,
  type ContractKline,
  type ContractMarketTrade,
  type ContractOrderBookLevel,
  type ContractOrderItem,
  type ContractOrderType,
  type ContractPositionItem,
  type ContractQuote,
  type ContractTradeItem,
} from '../../api/contract';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';
import {
  MOBILE_FORM_PANEL_FLEX,
  MOBILE_ORDER_BOOK_PANEL_FLEX,
  MOBILE_TRADING_PANEL_GAP,
  MOBILE_TRADING_PANEL_HEIGHT,
} from '../../constants/tradingLayout';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

const DEFAULT_SYMBOL = 'BTCUSDT_PERP';
const DEFAULT_SYMBOL_LABEL = 'BTC/USDT 永续';

const businessTabs: ContractBusinessTab[] = [
  {key: 'contract', label: '合约'},
  {key: 'tradfi', label: 'TradFi'},
  {key: 'activity', label: '活动'},
  {key: 'tools', label: '工具'},
];

export default function ContractScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [activeBusiness, setActiveBusiness] = useState('contract');
  const [actionMode, setActionMode] = useState<ContractActionMode>('OPEN');
  const [direction, setDirection] = useState<ContractDirection>('LONG');
  const [orderType, setOrderType] = useState<ContractOrderType>('LIMIT');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [leverage] = useState(10);
  const [quote, setQuote] = useState<ContractQuote | null>(null);
  const [asks, setAsks] = useState<ContractOrderBookLevel[]>([]);
  const [bids, setBids] = useState<ContractOrderBookLevel[]>([]);
  const [trades, setTrades] = useState<ContractMarketTrade[]>([]);
  const [klines, setKlines] = useState<ContractKline[]>([]);
  const [account, setAccount] = useState<ContractAccountSummary | null>(null);
  const [positions, setPositions] = useState<ContractPositionItem[]>([]);
  const [currentOrders, setCurrentOrders] = useState<ContractOrderItem[]>([]);
  const [historyOrders, setHistoryOrders] = useState<ContractOrderItem[]>([]);
  const [myTrades, setMyTrades] = useState<ContractTradeItem[]>([]);
  const [recordTab, setRecordTab] = useState<ContractRecordTab>('positions');
  const [publicError, setPublicError] = useState<string | null>(null);
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [publicLoading, setPublicLoading] = useState(true);
  const [klineInterval, setKlineInterval] = useState<KlineInterval>('1m');
  const [moreOpen, setMoreOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);

  const pricePrecision = quote?.pricePrecision ?? 2;
  const lastPrice = quote?.lastPrice ?? null;
  const markPrice = quote?.markPrice ?? quote?.lastPrice ?? null;
  const availableMargin = account?.availableMargin ?? null;
  const equity = account?.equity ?? null;
  const marketStatus =
    quote?.executable === false ? '不可交易' : quote?.marketStatus || '合约行情';

  const loadPublicSnapshot = useCallback(async () => {
    try {
      const [nextQuote, depth, nextTrades] = await Promise.all([
        fetchContractQuote(DEFAULT_SYMBOL),
        fetchContractDepth(DEFAULT_SYMBOL, 10),
        fetchContractMarketTrades(DEFAULT_SYMBOL, 20),
      ]);
      setQuote(nextQuote);
      setAsks(depth.asks);
      setBids(depth.bids);
      setTrades(nextTrades);
      setPublicError(null);
      const initialPrice = nextQuote?.markPrice ?? nextQuote?.lastPrice;
      if (initialPrice) {
        setPrice(current =>
          current || formatContractNumber(initialPrice, nextQuote?.pricePrecision ?? 2),
        );
      }
    } catch (error) {
      setPublicError(error instanceof Error ? error.message : '合约行情加载失败');
    }
  }, []);

  const loadPublicKlines = useCallback(async () => {
    setPublicLoading(true);
    try {
      const nextKlines = await fetchContractKlines(DEFAULT_SYMBOL, klineInterval, 80);
      setKlines(nextKlines);
      setPublicError(null);
    } catch (error) {
      setPublicError(error instanceof Error ? error.message : '合约 K线加载失败');
    } finally {
      setPublicLoading(false);
    }
  }, [klineInterval]);

  const loadPrivateData = useCallback(async () => {
    if (!isLoggedIn) {
      setAccount(null);
      setPositions([]);
      setCurrentOrders([]);
      setHistoryOrders([]);
      setMyTrades([]);
      setPrivateError(null);
      return;
    }

    try {
      const [summary, nextPositions, current, history, fills] = await Promise.all([
        fetchContractAccountSummary(),
        fetchContractPositions(DEFAULT_SYMBOL),
        fetchContractOrders({symbol: DEFAULT_SYMBOL, status: 'OPEN'}),
        fetchContractOrders({symbol: DEFAULT_SYMBOL}),
        fetchContractTrades(DEFAULT_SYMBOL),
      ]);
      setAccount(summary);
      setPositions(nextPositions);
      setCurrentOrders(current);
      setHistoryOrders(history);
      setMyTrades(fills);
      setPrivateError(null);
    } catch (error) {
      setPrivateError(error instanceof Error ? error.message : '合约账户数据加载失败');
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

  const openLogin = useCallback(() => {
    navigation.navigate('Auth', {screen: 'Login'});
  }, [navigation]);

  const handleBusinessChange = useCallback((key: string) => {
    if (key !== 'contract') {
      Alert.alert('暂未开放', '该入口已预留，V1 当前只实现合约交易主页面。');
      return;
    }
    setActiveBusiness(key);
  }, []);

  const handleBboPress = useCallback(() => {
    const bestAsk = asks[0]?.price ?? quote?.askPrice ?? null;
    const bestBid = bids[0]?.price ?? quote?.bidPrice ?? null;
    const useAsk =
      (actionMode === 'OPEN' && direction === 'LONG') ||
      (actionMode === 'CLOSE' && direction === 'SHORT');
    const nextPrice = useAsk ? bestAsk : bestBid;
    if (nextPrice !== null) {
      setPrice(formatContractNumber(nextPrice, pricePrecision));
    }
  }, [actionMode, asks, bids, direction, pricePrecision, quote]);

  const handlePercentPress = useCallback(
    (percent: number) => {
      if (actionMode === 'CLOSE') {
        const matched = positions.filter(item => item.side === direction);
        const totalQuantity = matched.reduce((sum, item) => {
          const value = Number(item.quantity);
          return Number.isFinite(value) ? sum + value : sum;
        }, 0);
        if (totalQuantity > 0) {
          setQuantity(formatContractNumber((totalQuantity * percent) / 100, 6));
        }
        return;
      }

      const referencePrice =
        orderType === 'MARKET'
          ? markPrice ?? lastPrice
          : Number(price.replace(/,/g, ''));
      if (!availableMargin || !referencePrice) return;
      const notional = (availableMargin * percent * leverage) / 100;
      setQuantity(formatContractNumber(notional / referencePrice, 6));
    },
    [
      actionMode,
      availableMargin,
      direction,
      lastPrice,
      leverage,
      markPrice,
      orderType,
      positions,
      price,
    ],
  );

  const handleSubmit = useCallback(() => {
    Alert.alert(
      '合约下单未提交',
      'TODO：已确认真实接口为 /contract/orders/open 与 /contract/orders/close-summary；移动端 V1 本轮先完成行情、账户和交易结构，下单提交继续等待精度、保证金和风险确认。',
    );
  }, []);

  const handleKlineIntervalChange = useCallback((nextInterval: KlineInterval) => {
    setKlineInterval(nextInterval);
    setKlines([]);
    setPublicError(null);
  }, []);

  const handleMoreAction = useCallback((label: string) => {
    setMoreOpen(false);
    Alert.alert(label, '该入口已预留，等待移动端对应页面后再接入路由。');
  }, []);

  return (
    <AppScreen>
      <ContractTopTabs
        activeKey={activeBusiness}
        tabs={businessTabs}
        onChange={handleBusinessChange}
      />
      <ContractSymbolHeader
        changePercent={quote?.changePercent ?? null}
        fundingRateText="资金费率 --"
        lastPrice={lastPrice}
        marketStatus={marketStatus}
        markPrice={markPrice}
        pricePrecision={pricePrecision}
        symbolLabel={DEFAULT_SYMBOL_LABEL}
        onOpenChart={() => setChartOpen(true)}
        onOpenMore={() => setMoreOpen(true)}
      />
      {publicError ? <Text style={styles.error}>{publicError}</Text> : null}
      <View style={styles.tradeMain}>
        <View style={styles.formPanelWrap}>
          <ContractOrderForm
            actionMode={actionMode}
            availableMargin={availableMargin}
            direction={direction}
            equity={equity}
            isLoggedIn={isLoggedIn}
            lastPrice={lastPrice}
            leverage={leverage}
            markPrice={markPrice}
            orderType={orderType}
            price={price}
            pricePrecision={pricePrecision}
            quantity={quantity}
            spreadFeePrice={quote?.spreadFeePrice}
            onActionModeChange={setActionMode}
            onBboPress={handleBboPress}
            onDirectionChange={setDirection}
            onLoginPress={openLogin}
            onOrderTypeChange={setOrderType}
            onPercentPress={handlePercentPress}
            onPriceChange={setPrice}
            onQuantityChange={setQuantity}
            onSubmitPress={handleSubmit}
          />
        </View>
        <View style={styles.orderBookPanelWrap}>
          <ContractOrderBook
            asks={asks}
            bids={bids}
            lastPrice={lastPrice}
            markPrice={markPrice}
            pricePrecision={pricePrecision}
            trades={trades}
            onPricePress={setPrice}
          />
        </View>
      </View>

      <View style={styles.chartCard}>
        <View style={styles.chartHeader}>
          <Text style={styles.chartTitle}>合约 K线 / 标记价走势</Text>
          <Pressable onPress={() => setChartOpen(true)}>
            <Text style={styles.chartAction}>全屏</Text>
          </Pressable>
        </View>
        <MobileKlineChart
          error={publicError}
          height={158}
          interval={klineInterval}
          items={klines}
          loading={publicLoading}
          pricePrecision={pricePrecision}
          visibleCount={42}
          onIntervalChange={handleKlineIntervalChange}
        />
      </View>

      <ContractBottomTabs
        activeTab={recordTab}
        currentOrders={currentOrders}
        error={privateError}
        fills={myTrades}
        historyOrders={historyOrders}
        isLoggedIn={isLoggedIn}
        positions={positions}
        onChange={setRecordTab}
        onLoginPress={openLogin}
      />

      <ContractMoreSheet
        visible={moreOpen}
        onActionPress={handleMoreAction}
        onClose={() => setMoreOpen(false)}
      />
      <ContractChartModal
        asks={asks}
        bids={bids}
        changePercent={quote?.changePercent ?? null}
        error={publicError}
        interval={klineInterval}
        klines={klines}
        lastPrice={lastPrice}
        loading={publicLoading}
        markPrice={markPrice}
        pricePrecision={pricePrecision}
        symbolLabel={DEFAULT_SYMBOL_LABEL}
        trades={trades}
        visible={chartOpen}
        onClose={() => setChartOpen(false)}
        onIntervalChange={handleKlineIntervalChange}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  error: {
    marginTop: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    color: colors.gold,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  tradeMain: {
    marginTop: 8,
    height: MOBILE_TRADING_PANEL_HEIGHT,
    flexDirection: 'row',
    gap: MOBILE_TRADING_PANEL_GAP,
  },
  formPanelWrap: {
    flex: MOBILE_FORM_PANEL_FLEX,
    height: '100%',
    minWidth: 0,
  },
  orderBookPanelWrap: {
    flex: MOBILE_ORDER_BOOK_PANEL_FLEX,
    height: '100%',
    minWidth: 0,
  },
  chartCard: {
    marginTop: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 8,
  },
  chartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  chartTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  chartAction: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
});
