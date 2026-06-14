import React, { useState, useEffect } from 'react';
import useLocale from '@/hooks/useLocale';
import { wsService } from '@/services/websocket';

/**
 * 成交记录数据类型
 * @description 表示已成交的交易记录，包含时间、价格、数量、总金额和成交方向
 */
export interface TradeRecord {
  /** 成交时间（格式：HH:MM:SS） */
  time: string;
  /** 成交价格（字符串格式，带千分位分隔符） */
  price: string;
  /** 成交数量（字符串格式） */
  amount: string;
  /** 成交总金额（字符串格式，带千分位分隔符） */
  total: string;
  /** 成交方向（buy: 买入, sell: 卖出） */
  type: 'buy' | 'sell';
}

/**
 * 成交记录组件属性
 */
export interface TradesHistoryProps {
  /** 当前交易对（如：AAPL/USDT） */
  symbol: string;
}

/**
 * 成交记录组件
 * @description 显示交易对的成交记录，支持实时数据更新
 * @param {TradesHistoryProps} props 组件属性
 * @returns {JSX.Element} 组件渲染结果
 * 
 * @example
 * ```jsx
 * <TradesHistory symbol="AAPL/USDT" />
 * ```
 */
const TradesHistory: React.FC<TradesHistoryProps> = ({ symbol }) => {
  const { t } = useLocale();
  
  /** 成交记录列表 */
  const [trades, setTrades] = useState<TradeRecord[]>([
    // 默认模拟成交记录数据
    { time: '10:30:45', price: '3,046.95', amount: '0.123', total: '374.77', type: 'buy' },
    { time: '10:30:40', price: '3,046.90', amount: '0.456', total: '1,390.40', type: 'sell' },
    { time: '10:30:35', price: '3,046.85', amount: '0.789', total: '2,394.06', type: 'buy' },
    { time: '10:30:30', price: '3,046.80', amount: '0.234', total: '712.95', type: 'sell' },
    { time: '10:30:25', price: '3,046.75', amount: '0.567', total: '1,727.51', type: 'buy' },
    { time: '10:30:20', price: '3,046.70', amount: '0.890', total: '2,711.56', type: 'sell' },
    { time: '10:30:15', price: '3,046.65', amount: '0.101', total: '307.71', type: 'buy' },
    { time: '10:30:10', price: '3,046.60', amount: '0.404', total: '1,230.83', type: 'sell' },
    { time: '10:30:05', price: '3,046.55', amount: '0.707', total: '2,153.91', type: 'buy' },
    { time: '10:30:00', price: '3,046.50', amount: '0.007', total: '21.33', type: 'sell' },
  ]);

  /**
   * 初始化WebSocket连接和订阅
   * @description 组件挂载时连接WebSocket，订阅成交记录数据
   */
  useEffect(() => {
    // 连接WebSocket服务
    wsService.connect();
    
    // 订阅当前交易对的成交记录
    wsService.subscribe(symbol);
    
    /**
     * 处理成交记录更新
     * @param {any} update 成交记录更新数据
     */
    const handleTradeUpdate = (update: any) => {
      if (update.type === 'trade' && update.data) {
        // 将新成交记录添加到列表开头
        setTrades(prev => {
          const newTrade: TradeRecord = {
            time: update.data.time,
            price: update.data.price,
            amount: update.data.amount,
            total: update.data.total,
            type: update.data.type
          };
          // 限制最大数量为50条
          return [newTrade, ...prev].slice(0, 50);
        });
      }
    };
    
    // 注册WebSocket事件监听器
    wsService.on('trade', handleTradeUpdate);
    
    // 组件卸载时清理
    return () => {
      // 取消事件监听器
      wsService.off('trade', handleTradeUpdate);
      // 取消订阅
      wsService.unsubscribe(symbol);
    };
  }, [symbol]);

  return (
    <div className="bg-[#0b0b0f] border border-white">
      {/* 成交记录头部 */}
      <div className="px-4 py-3 border-b border-[#2a3142] bg-[#2a3142]">
        <h2 className="text-lg font-semibold">{t('tradeHistory', 'contracts')}</h2>
      </div>

      {/* 成交记录标题行 */}
      <div className="grid grid-cols-4 gap-2 px-4 py-2 text-sm text-gray-400 border-b border-[#2a3142]">
        <div className="text-left">{t('time', 'contracts')}</div>
        <div className="text-right">{t('price', 'contracts')}</div>
        <div className="text-right">{t('amount', 'contracts')}</div>
        <div className="text-right">{t('total', 'contracts')}</div>
      </div>

      {/* 成交记录列表 */}
      <div className="max-h-[200px] overflow-y-auto pr-2">
        {trades.map((trade, index) => (
          <div key={index} className="grid grid-cols-4 gap-2 px-4 py-1.5 text-sm hover:bg-[#2a3142] transition-colors">
            <div className="text-left text-gray-400">{trade.time}</div>
            <div className={`text-right font-medium ${trade.type === 'buy' ? 'text-green-500' : 'text-red-500'}`}>{trade.price}</div>
            <div className="text-right">{trade.amount}</div>
            <div className="text-right opacity-75">{trade.total}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TradesHistory;
