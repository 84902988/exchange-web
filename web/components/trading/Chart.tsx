'use client';

declare global {
  interface Window {
    TradingView?: any;
  }
}

import React, { useEffect, useRef, useState } from 'react';
import useLocale from '@/hooks/useLocale';
import { MACD, RSI, BollingerBands, SMA } from 'technicalindicators';

/**
 * 图表组件属性
 */
interface ChartProps {
  /** 交易对（如：AAPL/USDT） */
  symbol: string;
}

/**
 * K线数据类型定义
 * @description 表示单根K线的完整数据，包含时间、开盘价、最高价、最低价、收盘价和成交量
 */
interface KlineData {
  /** 时间戳（毫秒） */
  timestamp: number;
  /** 开盘价 */
  open: number;
  /** 最高价 */
  high: number;
  /** 最低价 */
  low: number;
  /** 收盘价 */
  close: number;
  /** 成交量 */
  volume: number;
}

/**
 * 技术指标类型定义
 * @description 存储计算后的技术指标数据
 */
interface TechnicalIndicators {
  /** MACD指标数据 */
  macd?: any[];
  /** RSI指标数据 */
  rsi?: number[];
  /** 布林带指标数据 */
  bollingerBands?: any[];
}

/**
 * K线图组件
 * @description 集成TradingView图表，显示K线数据和技术指标，支持实时数据更新
 * @param {ChartProps} props 组件属性
 * @returns {JSX.Element} K线图组件
 * 
 * @example
 * ```jsx
 * <Chart symbol="AAPL/USDT" />
 * ```
 */
const Chart: React.FC<ChartProps> = ({ symbol }) => {
  const { t } = useLocale();
  
  /** Chart容器DOM引用 - 用于挂载TradingView图表 */
  const chartRef = useRef<HTMLDivElement>(null);
  
  /** TradingView图表实例引用 - 用于管理图表生命周期 */
  const tradingViewRef = useRef<any>(null);
  
  /** WebSocket连接实例引用 - 用于管理实时数据连接 */
  const wsRef = useRef<WebSocket | null>(null);
  
  /** K线数据状态 - 存储历史和实时K线数据 */
  const [klineData, setKlineData] = useState<KlineData[]>([]);
  
  /** 技术指标状态 - 存储计算后的技术指标数据 */
  const [technicalIndicators, setTechnicalIndicators] = useState<TechnicalIndicators>({});
  
  /** 加载状态 - 用于显示加载提示 */
  const [isLoading, setIsLoading] = useState(true);

  // ============================ 技术指标计算 ============================
  /**
   * 计算技术指标
   * @param data K线数据数组
   */
  const calculateTechnicalIndicators = (data: KlineData[]) => {
    if (data.length < 20) return; // 确保有足够的数据计算指标
    
    const closePrices = data.map(d => d.close);
    const indicators: TechnicalIndicators = {};
    
    try {
      // 计算MACD
      indicators.macd = MACD.calculate({
        values: closePrices,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      
      // 计算RSI
      indicators.rsi = RSI.calculate({
        values: closePrices,
        period: 14
      });
      
      // 计算布林带
      indicators.bollingerBands = BollingerBands.calculate({
        values: closePrices,
        period: 20,
        stdDev: 2
      });
      
      // 计算MA5、MA10、MA20
      const ma5 = SMA.calculate({ values: closePrices, period: 5 });
      const ma10 = SMA.calculate({ values: closePrices, period: 10 });
      const ma20 = SMA.calculate({ values: closePrices, period: 20 });
      
      // 这里可以将计算结果用于自定义图表渲染或传递给TradingView
      console.log('技术指标计算结果:', {
        macd: indicators.macd?.slice(-5), // 只显示最新5个
        rsi: indicators.rsi?.slice(-5),
        bollingerBands: indicators.bollingerBands?.slice(-5),
        ma5: ma5?.slice(-5),
        ma10: ma10?.slice(-5),
        ma20: ma20?.slice(-5)
      });
      
      setTechnicalIndicators(indicators);
    } catch (error) {
      console.error('技术指标计算错误:', error);
    }
  };

  // ============================ REST API 数据源 ============================
  /**
   * 从REST API获取历史K线数据
   * @param symbol 交易对
   * @param interval 时间周期 (如: 1m, 5m, 15m, 1h, 4h, 1d)
   * @param limit 数据条数
   */
  const fetchKlineDataFromREST = async (symbol: string, interval: string = '1m', limit: number = 100) => {
    setIsLoading(true);
    try {
      // 这里替换为实际的REST API URL
      const apiUrl = `https://api.example.com/api/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      
      const response = await fetch(apiUrl);
      const result = await response.json();
      
      // 处理API返回的数据，转换为标准K线格式
      const formattedData: KlineData[] = result.data.map((item: any) => ({
        timestamp: item.timestamp,
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close: parseFloat(item.close),
        volume: parseFloat(item.volume)
      }));
      
      setKlineData(formattedData);
      calculateTechnicalIndicators(formattedData);
      setIsLoading(false);
      
      return formattedData;
    } catch (error) {
      console.error('从REST API获取K线数据失败:', error);
      setIsLoading(false);
      return [];
    }
  };

  // ============================ WebSocket 数据源 ============================
  /**
   * 连接WebSocket获取实时数据
   * @param symbol 交易对
   */
  const connectWebSocket = (symbol: string) => {
    // 关闭现有连接
    if (wsRef.current) {
      wsRef.current.close(1000, 'client disconnect');
    }
    
    try {
      // 这里替换为实际的WebSocket URL
      const wsUrl = 'wss://api.example.com/ws';
      const ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log('WebSocket连接已建立');
        // 订阅K线数据
        ws.send(JSON.stringify({
          type: 'subscribe',
          channels: [
            `kline_1m_${symbol}`,
            `kline_5m_${symbol}`,
            `kline_15m_${symbol}`,
            `trade_${symbol}`
          ]
        }));
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'kline') {
            // 处理实时K线数据
            const newKline: KlineData = {
              timestamp: data.timestamp,
              open: parseFloat(data.open),
              high: parseFloat(data.high),
              low: parseFloat(data.low),
              close: parseFloat(data.close),
              volume: parseFloat(data.volume)
            };
            
            // 更新K线数据
            setKlineData(prev => {
              const updated = [...prev, newKline].slice(-100); // 保留最新100条
              calculateTechnicalIndicators(updated);
              return updated;
            });
          } else if (data.type === 'trade') {
            // 处理实时成交数据
            console.log('实时成交数据:', data);
          }
        } catch (error) {
          console.error('WebSocket消息处理错误:', error);
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket错误:', error);
      };
      
      ws.onclose = () => {
        console.log('WebSocket连接已关闭');
        // 可以添加重连逻辑
      };
      
      wsRef.current = ws;
    } catch (error) {
      console.error('WebSocket连接失败:', error);
    }
  };

  // ============================ TradingView 集成 ============================
  /**
   * 初始化TradingView图表
   * @param container 图表容器DOM元素
   * @param symbol 交易对
   */
  const initTradingView = (container: HTMLDivElement, symbol: string) => {
    // 确保TradingView库已加载
    if (typeof window === 'undefined' || !window.TradingView) {
      console.error('TradingView库未加载');
      return null;
    }
    
    try {
      const widget = new window.TradingView.widget({
        container: container,
        symbol: symbol,
        interval: '1', // 1分钟
        theme: 'dark',
        style: '1',
        locale: 'zh_CN',
        toolbar_bg: '#0b0b0f',
        enable_publishing: false,
        allow_symbol_change: true,
        studies: ['MACD', 'RSI@tv-basicstudies', 'Bollinger Bands@tv-basicstudies'],
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        timezone: 'Asia/Shanghai',
        // 自定义数据源配置
        datafeed: {
          // 这里可以配置自定义数据源，用于替换默认的TradingView数据源
          // 详细配置请参考TradingView文档
        },
        // 事件回调
        callbacks: {
          onSymbolChanged: (newSymbol: string) => {
            console.log('交易对已切换:', newSymbol);
            // 可以在这里更新数据
          },
          onIntervalChanged: (newInterval: string) => {
            console.log('时间周期已切换:', newInterval);
            // 可以在这里更新数据
          }
        }
      });
      
      return widget;
    } catch (error) {
      console.error('TradingView初始化错误:', error);
      return null;
    }
  };

  // ============================ 组件生命周期 ============================
  // 初始化图表和数据源
  useEffect(() => {
    console.log(`初始化K线图，交易对：${symbol}`);
    
    // 1. 从REST API获取历史数据
    fetchKlineDataFromREST(symbol);
    
    // 2. 连接WebSocket获取实时数据
    // 注意：当前为注释状态，如需启用请取消注释
    // connectWebSocket(symbol);
    
    // 3. 初始化TradingView图表
    if (chartRef.current) {
      // 检查TradingView库是否已加载
      if (typeof window !== 'undefined' && window.TradingView) {
        tradingViewRef.current = initTradingView(chartRef.current, symbol);
      } else {
        // 如果TradingView库未加载，可以添加加载脚本的逻辑
        console.log('TradingView库未加载，正在加载...');
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        script.onload = () => {
          console.log('TradingView库加载完成');
          if (chartRef.current) {
            tradingViewRef.current = initTradingView(chartRef.current, symbol);
          }
        };
        document.body.appendChild(script);
      }
    }
    
    // 清理函数
    return () => {
      console.log(`销毁K线图，交易对：${symbol}`);
      
      // 销毁TradingView图表
      if (tradingViewRef.current) {
        tradingViewRef.current.remove();
        tradingViewRef.current = null;
      }
      
      // 关闭WebSocket连接
      if (wsRef.current) {
        wsRef.current.close(1000, 'client disconnect');
        wsRef.current = null;
      }
    };
  }, [symbol]);
  
  // 当K线数据更新时，更新技术指标
  useEffect(() => {
    if (klineData.length > 0) {
      calculateTechnicalIndicators(klineData);
    }
  }, [klineData]);

  return (
    <div className="bg-[#0b0b0f] overflow-hidden w-full">
      {/* K线图区域 - 集成TradingView图表 */}
      <div className="relative w-full h-[450px] bg-[#2a3142] overflow-hidden">
        {/* TradingView图表容器 */}
        <div ref={chartRef} className="w-full h-full"></div>
        
        {/* 图表加载提示 - 仅在数据加载中显示 */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#2a3142]/80 text-white pointer-events-none">
            <div className="text-center">
              <div className="text-lg font-medium mb-2">{t('loadingChart', 'contracts')}</div>
              <div className="text-sm text-gray-400">
                {t('connectingMarketData', 'contracts')}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 图表信息和技术指标概览 */}
      <div className="flex flex-wrap justify-between items-center p-2 text-xs text-gray-400 bg-[#0b0b0f] border-t border-[rgba(255,255,255,0.45)]">
        {/* 左侧：交易对和周期信息 */}
        <div className="flex items-center space-x-4 mb-2 sm:mb-0">
          <div className="flex items-center space-x-2">
            <span className="font-medium text-white">{symbol}</span>
            <span className="bg-[#12121a] px-2 py-0.5 rounded">{t('perpetualContract', 'contracts')}</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-3 h-1 bg-[#22c55e]"></span>
            <span>MA 5: {technicalIndicators.macd?.length ? technicalIndicators.macd[technicalIndicators.macd.length - 1]?.macd?.toFixed(2) : '--'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-3 h-1 bg-[#60a5fa]"></span>
            <span>MA 10: {technicalIndicators.macd?.length ? technicalIndicators.macd[technicalIndicators.macd.length - 1]?.signal?.toFixed(2) : '--'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-3 h-1 bg-[#f472b6]"></span>
            <span>MA 20: {technicalIndicators.macd?.length ? technicalIndicators.macd[technicalIndicators.macd.length - 1]?.histogram?.toFixed(2) : '--'}</span>
          </div>
        </div>
        
        {/* 右侧：RSI和其他技术指标 */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-1">
            <span className="w-3 h-1 bg-[#eab308]"></span>
            <span>RSI: {technicalIndicators.rsi?.length ? technicalIndicators.rsi[technicalIndicators.rsi.length - 1]?.toFixed(2) : '--'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <span className="w-3 h-1 bg-[#8b5cf6]"></span>
            <span>更新中...</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Chart;
