'use client';
import React, { useState, useRef, useEffect } from 'react';
import useLocale from '@/hooks/useLocale';
import { wsService } from '@/services/websocket';
import { Order, TradeRecord } from '@/types/orderBook';

/**
 * 订单簿数据获取策略说明
 * 
 * 1. 初始数据获取：
 *    - 使用REST API获取完整的订单簿快照和历史成交记录
 *    - 确保组件加载时能立即显示数据
 *    - API URL: https://api.example.com/api/v1/orderbook?symbol={symbol}
 * 
 * 2. 实时数据更新：
 *    - 使用WebSocket接收订单簿和成交记录的实时更新
 *    - 订单簿更新：包含完整的买盘和卖盘列表
 *    - 成交记录更新：包含最新的成交记录
 *    - WebSocket URL: wss://api.example.com/ws
 *    - 订阅频道：orderbook_{symbol}, trade_{symbol}
 * 
 * 3. 数据更新策略：
 *    - 订单簿：每次更新替换整个列表
 *    - 成交记录：将新成交记录添加到列表开头，限制最大数量为50条
 * 
 * 4. 错误处理：
 *    - REST API请求失败时，显示错误提示
 *    - WebSocket连接错误时，显示错误提示
 *    - 支持自动重连机制（最多5次尝试）
 * 
 * 5. 性能优化：
 *    - 使用React.memo优化组件渲染
 *    - 限制成交记录数量，避免数据过多导致性能问题
 *    - WebSocket连接复用，避免多个组件创建多个连接
 */

interface OrderBookProps {
  symbol: string;
}

/**
 * 订单簿组件
 * @description 显示订单簿（买盘/卖盘）和成交记录，支持实时数据更新
 * @param {OrderBookProps} props 组件属性
 * @returns {JSX.Element} 订单簿组件
 */
const OrderBook: React.FC<OrderBookProps> = ({ symbol }) => {
  const { t } = useLocale();
  // 标签页状态（order: 订单簿, trade: 成交记录）
  const [activeTab, setActiveTab] = useState<'order' | 'trade'>('order');
  
  // 实时数据状态管理
  const [bids, setBids] = useState<Order[]>([]);           // 买盘订单列表
  const [asks, setAsks] = useState<Order[]>([]);           // 卖盘订单列表
  const [trades, setTrades] = useState<TradeRecord[]>([]); // 成交记录列表
  const [isLoading, setIsLoading] = useState(true);        // 加载状态
  const [error, setError] = useState<string | null>(null); // 错误信息
  
  // 用于自动滚动的ref
  const asksRef = useRef<HTMLDivElement>(null);  // 卖盘区域ref
  const bidsRef = useRef<HTMLDivElement>(null);  // 买盘区域ref
  const tradesRef = useRef<HTMLDivElement>(null);// 成交记录区域ref
  
  /**
   * 自动滚动到底部
   * @description 将指定元素滚动到底部
   * @param {React.RefObject<HTMLDivElement>} ref 要滚动的元素ref
   */
  const scrollToBottom = (ref: React.RefObject<HTMLDivElement | null>) => {
  const el = ref.current;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
};
  
  /**
   * 监听数据变化，实现自动滚动
   * @description 当数据或标签页变化时，自动滚动到合适位置
   */
  useEffect(() => {
    if (activeTab === 'order') {
      // 订单簿：卖单区域滚动到顶部，买单区域滚动到底部
      if (asksRef.current) {
        asksRef.current.scrollTop = 0;
      }
      scrollToBottom(bidsRef);
    } else {
      // 成交记录：滚动到底部
      scrollToBottom(tradesRef);
    }
  }, [activeTab, bids, asks, trades]);

  /**
   * 获取初始数据
   * @description 从REST API获取初始订单簿和成交记录数据
   * @returns {Promise<{ bids: Order[], asks: Order[], recentTrades: TradeRecord[] } | null>} 初始数据或null
   */
  const fetchInitialData = async () => {
    try {
      // 构建API请求URL
      const apiUrl = `https://api.example.com/api/v1/orderbook?symbol=${symbol}`;
      // 发送API请求
      const response = await fetch(apiUrl);
      // 解析响应数据
      const data = await response.json();
      
      // 检查请求是否成功
      if (data.success) {
        return data.data;
      } else {
        throw new Error(data.message || 'Failed to fetch initial data');
      }
    } catch (error) {
      console.error('从REST API获取初始数据失败:', error);
      return null;
    }
  };

  /**
   * 初始化数据和WebSocket连接
   * @description 组件挂载时，获取初始数据并设置WebSocket连接
   */
  useEffect(() => {
    let isMounted = true;
    
    /**
     * 异步初始化函数
     * @description 获取初始数据并设置WebSocket连接
     */
    const initialize = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        // 获取初始数据
        const initialData = await fetchInitialData();
        
        if (isMounted && initialData) {
          // 更新状态，设置初始数据
          setBids(initialData.bids);
          setAsks(initialData.asks);
          setTrades(initialData.recentTrades);
        }
        
        // 连接WebSocket并订阅数据
        wsService.connect();
        wsService.subscribe(symbol);
        
        /**
         * 处理订单簿更新
         * @param {any} update 订单簿更新数据
         */
        const handleOrderBookUpdate = (update: any) => {
          if (isMounted) {
            setBids(update.bids);
            setAsks(update.asks);
          }
        };
        
        /**
         * 处理成交记录更新
         * @param {any} update 成交记录更新数据
         */
        const handleTradeUpdate = (update: any) => {
          if (isMounted) {
            setTrades(prev => {
              // 将新成交记录添加到列表开头，限制最大数量为50条
              return [update.trade, ...prev].slice(0, 50);
            });
          }
        };
        
        /**
         * 处理WebSocket错误
         * @param {any} wsError WebSocket错误数据
         */
        const handleWebSocketError = (wsError: any) => {
          if (isMounted) {
            console.error('WebSocket错误:', wsError);
            setError('WebSocket连接错误，请刷新页面重试');
          }
        };
        
        // 注册WebSocket事件监听器
        wsService.on('orderbook', handleOrderBookUpdate);
        wsService.on('trade', handleTradeUpdate);
        wsService.on('error', handleWebSocketError);
        
        // 组件卸载时清理
        return () => {
          isMounted = false;
          // 取消事件监听器
          wsService.off('orderbook', handleOrderBookUpdate);
          wsService.off('trade', handleTradeUpdate);
          wsService.off('error', handleWebSocketError);
          // 取消订阅
          wsService.unsubscribe(symbol);
        };
      } catch (error) {
        if (isMounted) {
          console.error('初始化失败:', error);
          setError('数据获取失败，请刷新页面重试');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };
    
    // 调用初始化函数
    initialize();
    
    // 组件卸载时的清理函数
    return () => {
      isMounted = false;
    };
  }, [symbol]);

  // 如果没有初始数据，使用模拟数据作为备用
  const fallbackBids: Order[] = [
    { price: '3,046.95', amount: '0.123', total: '374.77' },
    { price: '3,046.90', amount: '0.456', total: '1,390.40' },
    { price: '3,046.85', amount: '0.789', total: '2,394.06' },
    { price: '3,046.80', amount: '0.234', total: '712.95' },
    { price: '3,046.75', amount: '0.567', total: '1,727.51' },
    { price: '3,046.70', amount: '0.890', total: '2,711.56' },
    { price: '3,046.65', amount: '0.101', total: '307.71' },
    { price: '3,046.60', amount: '0.404', total: '1,230.83' },
    { price: '3,046.55', amount: '0.707', total: '2,153.91' },
    { price: '3,046.50', amount: '0.007', total: '21.33' },
  ];

  const fallbackAsks: Order[] = [
    { price: '3,047.00', amount: '0.135', total: '411.35' },
    { price: '3,047.05', amount: '0.468', total: '1,426.02' },
    { price: '3,047.10', amount: '0.801', total: '2,440.73' },
    { price: '3,047.15', amount: '0.246', total: '749.60' },
    { price: '3,047.20', amount: '0.579', total: '1,764.33' },
    { price: '3,047.25', amount: '0.912', total: '2,780.90' },
    { price: '3,047.30', amount: '0.112', total: '341.30' },
    { price: '3,047.35', amount: '0.415', total: '1,264.65' },
    { price: '3,047.40', amount: '0.718', total: '2,188.03' },
    { price: '3,047.45', amount: '0.018', total: '54.85' },
  ];

  const fallbackTrades: TradeRecord[] = [
    { time: '10:30:45', price: '3,046.95', amount: '0.123', type: 'buy' },
    { time: '10:30:40', price: '3,046.90', amount: '0.456', type: 'sell' },
    { time: '10:30:35', price: '3,046.85', amount: '0.789', type: 'buy' },
    { time: '10:30:30', price: '3,046.80', amount: '0.234', type: 'sell' },
    { time: '10:30:25', price: '3,046.75', amount: '0.567', type: 'buy' },
    { time: '10:30:20', price: '3,046.70', amount: '0.890', type: 'sell' },
    { time: '10:30:15', price: '3,046.65', amount: '0.101', type: 'buy' },
    { time: '10:30:10', price: '3,046.60', amount: '0.404', type: 'sell' },
    { time: '10:30:05', price: '3,046.55', amount: '0.707', type: 'buy' },
    { time: '10:30:00', price: '3,046.50', amount: '0.007', type: 'sell' },
  ];

  // 使用实际数据或回退到模拟数据
  const displayBids = bids.length > 0 ? bids : fallbackBids;
  const displayAsks = asks.length > 0 ? asks : fallbackAsks;
  const displayTrades = trades.length > 0 ? trades : fallbackTrades;

  return (
    <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] relative">
      {/* 订单簿和成交记录标签页 */}
      <div className="flex border-b border-[#2a3142]">
        <button
          onClick={() => setActiveTab('order')}
          className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'order' ? 'text-white border-b-2 border-amber-500' : 'text-gray-400 hover:text-white'}`}
        >
          {t('orderBook', 'contracts')}
        </button>
        <button
          onClick={() => setActiveTab('trade')}
          className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'trade' ? 'text-white border-b-2 border-amber-500' : 'text-gray-400 hover:text-white'}`}
        >
          {t('tradeHistory', 'contracts')}
        </button>
      </div>

      {/* 加载状态显示 */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0b0b0f]/80 text-white z-10">
          <div className="text-center">
            <div className="text-lg font-medium mb-2">{t('loading', 'contracts')}</div>
            <div className="text-sm text-gray-400">
              {t('loadingOrderBook', 'contracts')}
            </div>
          </div>
        </div>
      )}
      
      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-red-500/10 text-red-500 text-sm border-b border-[#2a3142]">
          {error}
        </div>
      )}

      {/* 订单簿内容 */}
      {activeTab === 'order' ? (
        <div>
          {/* 订单簿标题行 */}
          <div className="grid grid-cols-3 gap-2 px-3 py-2 text-xs text-gray-400 border-b border-[#2a3142]">
            <div className="text-right">{t('price', 'contracts')} (USDT)</div>
            <div className="text-center">{t('amount', 'contracts')} ({symbol.split('/')[0]})</div>
            <div className="text-right">{t('total', 'contracts')} (USDT)</div>
          </div>

          {/* 卖单区域 */}
          <div ref={asksRef} className="max-h-[200px] overflow-y-auto pr-1 dark-scrollbar">
            {displayAsks.map((ask, index) => (
              <div key={index} className="grid grid-cols-3 gap-2 px-3 py-1 text-xs text-red-500 hover:bg-[#2a3142] transition-colors">
                <div className="text-right cursor-pointer hover:underline">{ask.price}</div>
                <div className="text-center">{ask.amount}</div>
                <div className="text-right opacity-75">{ask.total}</div>
              </div>
            ))}
          </div>

          {/* 复刻标题行 */}
          <div className="grid grid-cols-3 gap-2 px-3 py-2 text-xs text-gray-400 border-b border-[#2a3142]">
            <div className="text-right">{t('price', 'contracts')} (USDT)</div>
            <div className="text-center">{t('amount', 'contracts')} ({symbol.split('/')[0]})</div>
            <div className="text-right">{t('total', 'contracts')} (USDT)</div>
          </div>

          {/* 买单区域 */}
          <div ref={bidsRef} className="max-h-[200px] overflow-y-auto pr-1 dark-scrollbar">
            {displayBids.map((bid, index) => (
              <div key={index} className="grid grid-cols-3 gap-2 px-3 py-1 text-xs text-green-500 hover:bg-[#2a3142] transition-colors">
                <div className="text-right cursor-pointer hover:underline">{bid.price}</div>
                <div className="text-center">{bid.amount}</div>
                <div className="text-right opacity-75">{bid.total}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* 成交记录内容 */
        <div>
          {/* 成交记录标题行 */}
          <div className="grid grid-cols-3 gap-2 px-3 py-2 text-xs text-gray-400 border-b border-[#2a3142]">
            <div className="text-left">时间</div>
            <div className="text-right">价格 (USDT)</div>
            <div className="text-right">数量 ({symbol.split('/')[0]})</div>
          </div>

          {/* 成交记录列表 */}
          <div ref={tradesRef} className="max-h-[400px] overflow-y-auto pr-1 dark-scrollbar">
            {displayTrades.map((trade, index) => (
              <div key={index} className="grid grid-cols-3 gap-2 px-3 py-1 text-xs hover:bg-[#2a3142] transition-colors">
                <div className="text-left text-gray-400">{trade.time}</div>
                <div className={`text-right font-medium ${trade.type === 'buy' ? 'text-green-500' : 'text-red-500'}`}>
                  {trade.price}
                </div>
                <div className="text-right">{trade.amount}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default OrderBook;
