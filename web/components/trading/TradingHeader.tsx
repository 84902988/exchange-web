'use client';
import React, { useEffect, useState } from 'react';
import useLocale from '@/hooks/useLocale';
import { wsService } from '@/services/websocket';

/**
 * 行情滚动数据项类型
 */
export interface MarketScrollItem {
  /** 交易对（如：ETH/USDT） */
  symbol: string;
  /** 价格（字符串格式，便于直接显示） */
  price: string;
  /** 涨跌幅（带正负号，如：+0.32%） */
  change: string;
}

interface TradingHeaderProps {
  symbol: string;
  price: string;
  change: string;
  changeAmount: string;
  highLow: string;
  volume: string;
  turnover: string;
  category: string;
  /** 可选：自定义行情滚动数据，用于替换默认的模拟数据 */
  customMarketData?: MarketScrollItem[];
  /** 可选：是否启用实时行情更新（通过WebSocket） */
  enableRealTime?: boolean;
}

const TradingHeader: React.FC<TradingHeaderProps> = ({ 
  symbol, 
  price, 
  change, 
  changeAmount, 
  highLow, 
  volume, 
  turnover, 
  category,
  customMarketData,
  enableRealTime = false 
}) => {
  const { t } = useLocale();
  // 判断涨跌方向，用于显示不同颜色
  const isPositive = change.startsWith('+');
  const changeColor = isPositive ? 'text-green-500' : 'text-red-500';
  const arrowIcon = isPositive ? '↑' : '↓';

  // 行情滚动数据状态管理
  const [marketData, setMarketData] = useState<MarketScrollItem[]>([
    // 默认模拟行情数据
    { symbol: 'ETH/USDT', price: '$3,045.95', change: '-0.17%' },
    { symbol: 'BTC/USDT', price: '$63,251.00', change: '+0.32%' },
    { symbol: 'SOL/USDT', price: '$98.75', change: '-1.23%' },
    { symbol: 'BNB/USDT', price: '$321.45', change: '+0.78%' },
    { symbol: 'XRP/USDT', price: '$0.5678', change: '-0.45%' },
    { symbol: 'ADA/USDT', price: '$0.4321', change: '+1.56%' },
    { symbol: 'DOGE/USDT', price: '$0.1234', change: '-2.34%' },
    { symbol: 'DOT/USDT', price: '$7.8901', change: '+0.98%' },
  ]);

  // 如果提供了自定义行情数据，使用自定义数据
  const displayedMarketData = customMarketData ?? marketData;

  // 实时行情更新（通过WebSocket）
  useEffect(() => {
    if (!enableRealTime) return;

    // 连接WebSocket并订阅行情数据
    wsService.connect();
    
    // 订阅全市场行情数据（具体频道名称需根据实际API调整）
    wsService.send({ type: 'subscribe', channels: ['market_summary'] });
    
    /**
     * 处理市场行情更新
     * @param update 市场行情更新数据
     */
    const handleMarketUpdate = (update: unknown) => {
      const marketUpdate = update as { type?: string; data?: MarketScrollItem[] };
      if (marketUpdate.type === 'market_summary' && Array.isArray(marketUpdate.data)) {
        const nextMarketData = marketUpdate.data;
        // 更新行情滚动数据
        setMarketData(prev => {
          // 将最新的行情数据与现有数据合并，避免频繁更新导致的闪烁
          const updatedData = [...prev];
          
          // 更新已存在的交易对数据
          nextMarketData.forEach((newItem) => {
            const index = updatedData.findIndex(item => item.symbol === newItem.symbol);
            if (index !== -1) {
              updatedData[index] = newItem;
            } else {
              // 添加新的交易对（如果不存在）
              updatedData.push(newItem);
              // 限制最大数量为10个
              if (updatedData.length > 10) {
                updatedData.shift();
              }
            }
          });
          
          return updatedData;
        });
      }
    };
    
    // 注册WebSocket事件监听器
    wsService.on('market_summary', handleMarketUpdate);
    
    // 组件卸载时清理
    return () => {
      wsService.off('market_summary', handleMarketUpdate);
    };
  }, [enableRealTime]);

  return (
    <div className="w-full bg-[#0b0b0f] text-white">
      {/* 独立容器：行情滚动条和交易对详细信息 */}
      <div className="border-b border-[#2a3142]">
        {/* 行情滚动条 */}
        <div className="bg-[#0b0b0f] py-1 overflow-hidden">
          <div className="flex items-center space-x-6 animate-marquee">
            {/* 重复数据以实现无缝滚动效果 */}
            {[...displayedMarketData, ...displayedMarketData].map((item, index) => (
              <div key={index} className="flex items-center space-x-3">
                <span className="text-xs text-gray-400">{item.symbol}</span>
                <span className="text-xs font-medium">{item.price}</span>
                <span className={`text-xs ${item.change.startsWith('+') ? 'text-green-500' : 'text-red-500'}`}>
                  {item.change}
                </span>
                <span className="text-gray-600">|</span>
              </div>
            ))}
          </div>
        </div>

        {/* 交易对详细信息 */}
        <div className="w-full px-1 py-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 左侧：交易对和价格 */}
            <div className="flex flex-wrap items-start gap-4 w-[70%] ml-4 pt-1">
              <div className="flex items-center space-x-2">
                <h1 className="text-xl font-bold">{symbol}</h1>
                <span className="bg-[#12121a] px-2 py-1 rounded text-xs">{t('perpetualContract', 'contracts')}</span>
              </div>
              <div className="flex items-baseline space-x-3">
                <span className="text-2xl font-bold">{price}</span>
                <span className={`${changeColor} flex items-center space-x-1 text-sm font-medium`}>
                  <span>{arrowIcon}</span>
                  <span>{change}</span>
                </span>
              </div>
            </div>

            {/* 右侧：价格统计信息 */}
            <div className="flex flex-wrap gap-3 text-sm">
              <div className="flex flex-col min-w-[80px]">
                <span className="text-gray-400">{t('change24h', 'contracts')}</span>
                <span className={changeColor}>{change}</span>
              </div>
              <div className="flex flex-col min-w-[80px]">
              <span className="text-gray-400">{t('highLow24h', 'contracts')}</span>
              <span>{highLow}</span>
            </div>
            <div className="flex flex-col min-w-[80px]">
              <span className="text-gray-400">{t('volume24h', 'contracts')}({symbol.split('/')[0]})</span>
              <span>{volume}</span>
            </div>
            <div className="flex flex-col min-w-[80px]">
              <span className="text-gray-400">{t('turnover24h', 'contracts')}({symbol.split('/')[0]})</span>
              <span>{turnover}</span>
            </div>
            <div className="flex flex-col min-w-[80px]">
              <span className="text-gray-400">{t('tokenCategory', 'contracts')}</span>
              <span>{t(category, 'contracts')}</span>
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TradingHeader;
