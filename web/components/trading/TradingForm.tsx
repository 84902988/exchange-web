'use client';
import React, { useState, useEffect } from 'react';
import useLocale from '@/hooks/useLocale';

/**
 * 资产数据类型
 * @description 表示用户的资产信息，包括总余额、可用余额等
 */
export interface AssetData {
  /** 总余额 */
  totalBalance: number;
  /** 可用余额 */
  availableBalance: number;
  /** 锁定余额 */
  lockedBalance: number;
  /** 保证金余额 */
  marginBalance: number;
  /** 仓位保证金 */
  positionMargin: number;
  /** 未实现盈亏 */
  unrealizedPnl: number;
  /** 已实现盈亏 */
  realizedPnl: number;
}

/**
 * 交易表单组件属性
 */
export interface TradingFormProps {
  /** 用户资产数据 */
  assetData: AssetData;
}

/**
 * 交易表单组件
 * @description 用于下单操作，支持限价单和市价单，提供杠杆选择和数量百分比功能
 * @param {TradingFormProps} props 组件属性
 * @returns {JSX.Element} 组件渲染结果
 * 
 * @example
 * ```jsx
 * <TradingForm assetData={{
 *   totalBalance: 500.00,
 *   availableBalance: 500.00,
 *   lockedBalance: 0.00,
 *   marginBalance: 0.00,
 *   positionMargin: 0.00,
 *   unrealizedPnl: 0.00,
 *   realizedPnl: 0.00
 * }} />
 * ```
 */
const TradingForm: React.FC<TradingFormProps> = ({ assetData }) => {
  const { t } = useLocale();
  
  /** 订单类型（limit: 限价单, market: 市价单） */
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  
  /** 订单方向（buy: 买入, sell: 卖出） */
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy');
  
  /** 订单价格 */
  const [price, setPrice] = useState('3,046.95');
  
  /** 订单数量 */
  const [amount, setAmount] = useState('');
  
  /** 订单总金额 */
  const [total, setTotal] = useState('0.00');
  
  /** 杠杆倍数 */
  const [leverage, setLeverage] = useState('20x');

  /**
   * 计算订单总金额
   * @description 根据价格和数量计算订单总金额，并格式化显示
   */
  const calculateTotal = () => {
    // 清除价格中的逗号，转换为数字
    const cleanedPrice = parseFloat(price.replace(/,/g, ''));
    // 将数量转换为数字
    const cleanedAmount = parseFloat(amount);
    
    // 只有当价格和数量都为有效数字时，才计算总金额
    if (!isNaN(cleanedPrice) && !isNaN(cleanedAmount)) {
      const calculatedTotal = cleanedPrice * cleanedAmount;
      // 格式化总金额，保留两位小数
      setTotal(calculatedTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    } else {
      setTotal('0.00');
    }
  };

  /**
   * 监听价格和数量变化，重新计算总金额
   * @description 当价格或数量改变时，自动更新总金额
   */
  useEffect(() => {
    calculateTotal();
  }, [price, amount]);

  /**
   * 处理数量百分比按钮点击
   * @description 根据可用余额的百分比自动计算订单数量
   * @param {number} percentage 百分比值（0-100）
   */
  const handlePercentageClick = (percentage: number) => {
    // 清除价格中的逗号，转换为数字
    const cleanedPrice = parseFloat(price.replace(/,/g, ''));
    if (isNaN(cleanedPrice)) return;
    
    // 计算订单数量：(可用余额 / 价格) * 百分比
    const calculatedAmount = (assetData.availableBalance / cleanedPrice) * (percentage / 100);
    // 格式化数量，保留六位小数
    setAmount(calculatedAmount.toFixed(6));
  };

  return (
    <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] p-3">
      {/* 订单类型和方向选择 */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        {/* 订单类型 */}
        <div>
          <div className="flex space-x-1">
            <button
              onClick={() => setOrderType('limit')}
              className={`flex-1 py-1.5 rounded-l-md text-sm font-medium transition-colors ${orderType === 'limit' ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white' : 'bg-[#12121a] text-gray-400 hover:text-white'}`}
            >
              {t('limitOrder', 'contracts')}
            </button>
            <button
              onClick={() => setOrderType('market')}
              className={`flex-1 py-1.5 rounded-r-md text-sm font-medium transition-colors ${orderType === 'market' ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white' : 'bg-[#12121a] text-gray-400 hover:text-white'}`}
            >
              {t('marketOrder', 'contracts')}
            </button>
          </div>
        </div>
        
        {/* 订单方向 */}
        <div>
          <div className="flex space-x-1">
            <button
              onClick={() => setOrderSide('buy')}
              className={`flex-1 py-1.5 rounded-l-md text-sm font-medium transition-colors ${orderSide === 'buy' ? 'bg-gradient-to-r from-green-500 to-green-600 text-white' : 'bg-[#12121a] text-gray-400 hover:text-white'}`}
            >
              {t('buyLong', 'contracts')}
            </button>
            <button
              onClick={() => setOrderSide('sell')}
              className={`flex-1 py-1.5 rounded-r-md text-sm font-medium transition-colors ${orderSide === 'sell' ? 'bg-gradient-to-r from-red-500 to-red-600 text-white' : 'bg-[#12121a] text-gray-400 hover:text-white'}`}
            >
              {t('sellShort', 'contracts')}
            </button>
          </div>
        </div>
      </div>

      {/* 交易表单 */}
      <div className="space-y-3">
        {/* 杠杆选择 */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('leverage', 'contracts')}</label>
            <div className="bg-[#12121a] border border-[#2a3142] rounded-md px-2 py-2 text-sm">
              {/* 杠杆滑块 */}
              <div className="relative">
                {/* 滑块轨道 */}
                <input
                  type="range"
                  min="1"
                  max="100"
                  step="1"
                  value={parseInt(leverage.replace('x', ''))}
                  onChange={(e) => {
                    const value = parseInt(e.target.value);
                    // 映射到预设的杠杆值
                    const leverages = [1, 5, 10, 20, 50, 100];
                    const closest = leverages.reduce((prev, curr) => {
                      return Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev;
                    });
                    setLeverage(`${closest}x`);
                  }}
                  className="w-full h-2 bg-[#2a3142] rounded-lg appearance-none cursor-pointer accent-amber-500"
                  style={{
                    // 自定义滑块拇指样式
                    WebkitAppearance: 'none',
                    appearance: 'none',
                  }}
                />
                <style jsx>{`
                  /* 自定义滑块拇指 */
                  input[type='range']::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 16px;
                    height: 16px;
                    background: #f59e0b;
                    border-radius: 50%;
                    cursor: pointer;
                    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
                    transition: all 0.2s ease;
                  }
                  
                  input[type='range']::-webkit-slider-thumb:hover {
                    transform: scale(1.2);
                    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.5);
                  }
                  
                  input[type='range']::-moz-range-thumb {
                    width: 16px;
                    height: 16px;
                    background: #f59e0b;
                    border: none;
                    border-radius: 50%;
                    cursor: pointer;
                    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
                    transition: all 0.2s ease;
                  }
                  
                  input[type='range']::-moz-range-thumb:hover {
                    transform: scale(1.2);
                    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.5);
                  }
                `}</style>
                
                {/* 刻度标记 */}
                <div className="flex justify-between text-[10px] text-gray-500 mt-1 px-1">
                  <span>1x</span>
                  <span>5x</span>
                  <span>10x</span>
                  <span>20x</span>
                  <span>50x</span>
                  <span>100x</span>
                </div>
                
                {/* 当前杠杆显示 */}
                <div className="flex justify-center mt-2">
                  <div className="bg-[#0b0b0f] px-4 py-1 rounded-full border border-amber-500/50 text-amber-500 font-medium">
                    {leverage}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('availableBalance', 'contracts')}</label>
            <div className="bg-[#12121a] rounded-md px-2 py-1.5 text-sm">
              {assetData.availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
            </div>
            <label className="block text-xs text-gray-400 mb-1 mt-2">{t('availableMargin', 'contracts')}</label>
            <div className="bg-[#12121a] rounded-md px-2 py-1.5 text-sm">
              {/* 计算可用保证金：保证金余额 - 仓位保证金 */}
              {(assetData.marginBalance - assetData.positionMargin).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
            </div>
          </div>
        </div>

        {/* 价格和数量输入 */}
        <div className="space-y-2">
          {/* 价格输入 */}
          {orderType === 'limit' && (
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-xs text-gray-400">{t('price', 'contracts')} (USDT)</label>
                <div className="text-xs text-gray-400">最新: {price}</div>
              </div>
              <div className="flex border border-[#3a4152] rounded-md overflow-hidden">
                <input
                  type="text"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="flex-1 bg-[#12121a] px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                  placeholder="0.00"
                />
                <button className="bg-[#2a3142] hover:bg-[#3a4152] px-3 py-2 text-xs text-white">
                  {t('oppositePrice', 'contracts')}
                </button>
              </div>
            </div>
          )}

          {/* 数量输入 */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="block text-xs text-gray-400">{t('amount', 'contracts')} (ETH)</label>
              <div className="text-xs text-gray-400">{t('total', 'contracts')}: {total} USDT</div>
            </div>
            <div className="space-y-1">
              <div className="flex border border-[#3a4152] rounded-md overflow-hidden">
                <input
                  type="text"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="flex-1 bg-[#12121a] px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                  placeholder="0.000000"
                />
                <button className="bg-[#2a3142] hover:bg-[#3a4152] px-3 py-2 text-xs text-white">
                  {t('max', 'contracts')}
                </button>
              </div>
              
              {/* 数量百分比按钮 */}
              <div className="flex space-x-1">
                <button onClick={() => handlePercentageClick(25)} className="flex-1 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded-l-md">25%</button>
                <button onClick={() => handlePercentageClick(50)} className="flex-1 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs">50%</button>
                <button onClick={() => handlePercentageClick(75)} className="flex-1 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs">75%</button>
                <button onClick={() => handlePercentageClick(100)} className="flex-1 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded-r-md">100%</button>
              </div>
            </div>
          </div>
        </div>

        {/* 下单按钮 */}
        <div className="flex space-x-2">
          <button
            className={`flex-1 py-2 rounded-md font-medium transition-all duration-300 ${orderSide === 'buy' ? 'bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white shadow-lg hover:shadow-xl' : 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white shadow-lg hover:shadow-xl'}`}
          >
            {orderSide === 'buy' ? t('buyLong', 'contracts') : t('sellShort', 'contracts')}
          </button>
          <button
            className="flex-1 py-2 rounded-md font-medium bg-[#12121a] text-white/80 hover:bg-[#2a3142] transition-colors text-sm"
          >
            {t('marketClose', 'contracts')}
          </button>
        </div>

        {/* 高级选项 */}
        <div className="mt-2 text-xs text-gray-400">
          <div className="flex items-center space-x-3">
            <label className="flex items-center space-x-1">
              <input type="checkbox" className="rounded bg-[#12121a] border-[#3a4152] text-amber-500 focus:ring-0" />
              <span>{t('takeProfitStopLoss', 'contracts')}</span>
            </label>
            <label className="flex items-center space-x-1">
              <input type="checkbox" className="rounded bg-[#12121a] border-[#3a4152] text-amber-500 focus:ring-0" />
              <span>{t('makerOnly', 'contracts')}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TradingForm;
