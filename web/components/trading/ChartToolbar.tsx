'use client';
import React, { useState } from 'react';
import useLocale from '@/hooks/useLocale';

/**
 * 图表工具栏组件属性
 */
export interface ChartToolbarProps {
  /** 当前选中的交易对（如：AAPL/USDT） */
  symbol: string;
  /** 交易对切换回调函数 */
  onSymbolChange: (symbol: string) => void;
}

/**
 * 图表工具栏组件
 * @description 提供交易对选择、图表类型切换和技术指标选择等功能
 * @param {ChartToolbarProps} props 组件属性
 * @returns {JSX.Element} 组件渲染结果
 * 
 * @example
 * ```jsx
 * <ChartToolbar 
 *   symbol="AAPL/USDT" 
 *   onSymbolChange={(newSymbol) => console.log(newSymbol)} 
 * />
 * ```
 */
const ChartToolbar: React.FC<ChartToolbarProps> = ({ symbol, onSymbolChange }) => {
  const { t } = useLocale();
  
  /** 交易对下拉菜单的展开状态 */
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  /** 币股合约交易对列表 */
  const symbols = ['AAPL/USDT', 'MSFT/USDT', 'GOOGL/USDT', 'TSLA/USDT', 'AMZN/USDT'];

  return (
    <div className="bg-[#0b0b0f] p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 左侧：交易对选择和图表类型 */}
        <div className="flex items-center gap-2">
          {/* 交易对选择 */}
          <div className="relative">
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="flex items-center space-x-2 bg-[#12121a] px-3 py-1.5 rounded-md hover:bg-[#2a3142] transition-colors text-sm"
            >
              <span className="font-medium">{symbol}</span>
              <span className="text-gray-400">▼</span>
            </button>
            {isDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-[#12121a] rounded-md shadow-lg border border-[#2a3142] w-48 z-10 max-h-[200px] overflow-y-auto dark-scrollbar">
                {symbols.map((sym) => (
                  <button
                    key={sym}
                    onClick={() => {
                      onSymbolChange(sym);
                      setIsDropdownOpen(false);
                    }}
                    className={`w-full text-left px-4 py-2 hover:bg-[#2a3142] transition-colors ${symbol === sym ? 'bg-[#2a3142] text-amber-400' : ''}`}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 图表类型选择 */}
            <div className="flex space-x-1">
              <button className="px-3 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-sm rounded-l-md">
                {t('kLine', 'contracts')}
              </button>
              <button className="px-3 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-sm">
                {t('timeSharing', 'contracts')}
              </button>
              <button className="px-3 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-sm rounded-r-md">
                {t('depth', 'contracts')}
              </button>
            </div>

            {/* 时间周期选择 */}
            <div className="flex space-x-1 ml-2">
              {[
                { key: 'minute1', label: t('minute1', 'contracts') },
                { key: 'minute5', label: t('minute5', 'contracts') },
                { key: 'minute15', label: t('minute15', 'contracts') },
                { key: 'hour1', label: t('hour1', 'contracts') },
                { key: 'hour4', label: t('hour4', 'contracts') },
                { key: 'day1', label: t('day1', 'contracts') },
                { key: 'week1', label: t('week1', 'contracts') },
                { key: 'month1', label: t('month1', 'contracts') }
              ].map((period) => (
                <button
                  key={period.key}
                  className="px-3 py-1.5 bg-[#12121a] hover:bg-[#2a3142] transition-colors text-sm"
                >
                  {period.label}
                </button>
              ))}
            </div>
        </div>

        {/* 右侧：图表控制和指标 */}
        <div className="flex items-center gap-2">
          {/* K线类型 */}
          <div className="flex space-x-1">
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              K
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              B
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              C
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              H
            </button>
          </div>

          {/* 技术指标 */}
          <div className="flex space-x-1">
            <button className="w-10 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              MA
            </button>
            <button className="w-10 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              BOLL
            </button>
            <button className="w-10 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              MACD
            </button>
            <button className="w-10 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              KDJ
            </button>
            <button className="w-10 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              RSI
            </button>
          </div>

          {/* 其他控制按钮 */}
          <div className="flex space-x-1">
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              📊
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              📐
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              📈
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              🎯
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              ➕
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              ➖
            </button>
            <button className="w-6 h-6 grid place-items-center bg-[#12121a] hover:bg-[#2a3142] transition-colors text-xs rounded">
              ⛶
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChartToolbar;
