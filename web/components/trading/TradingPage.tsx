'use client';
import React, { useState } from 'react';
import useLocale from '@/hooks/useLocale';
import TradingHeader from './TradingHeader';
import Chart from './Chart';
import ChartToolbar from './ChartToolbar';
import OrderBook from './OrderBook';
import TradesHistory from './TradesHistory';
import TradingForm from './TradingForm';
import AssetInfo from './AssetInfo';

/**
 * 币股合约交易对数据类型
 * @description 用于存储交易对的基本信息，包括价格、涨跌幅、成交量等
 */
export interface SymbolData {
  /** 当前价格（字符串格式，带千分位分隔符） */
  price: string;
  /** 涨跌幅（带正负号，如：+0.32%） */
  change: string;
  /** 涨跌额（带正负号，如：+$0.57） */
  changeAmount: string;
  /** 24小时最高价/最低价（格式：high / low） */
  highLow: string;
  /** 24小时成交量（带单位，如：12.5K） */
  volume: string;
  /** 24小时成交额（带单位，如：$2.37M） */
  turnover: string;
  /** 交易对分类（如：科技股、汽车股） */
  category: string;
}

/**
 * 币股合约交易对模拟数据
 * @description 模拟的交易对数据，用于组件开发和测试
 */
const symbolDataMap: Record<string, SymbolData> = {
  'AAPL/USDT': {
    price: '$189.50',
    change: '-0.25%',
    changeAmount: '-$0.47',
    highLow: '190.80 / 188.50',
    volume: '12.5K',
    turnover: '$2.37M',
    category: 'tech'
  },
  'MSFT/USDT': {
    price: '$378.20',
    change: '+0.15%',
    changeAmount: '+$0.57',
    highLow: '379.50 / 376.80',
    volume: '8.3K',
    turnover: '$3.14M',
    category: 'tech'
  },
  'GOOGL/USDT': {
    price: '$142.85',
    change: '-0.32%',
    changeAmount: '-$0.46',
    highLow: '143.90 / 142.10',
    volume: '15.2K',
    turnover: '$2.18M',
    category: 'tech'
  },
  'TSLA/USDT': {
    price: '$245.30',
    change: '+1.20%',
    changeAmount: '+$2.92',
    highLow: '246.80 / 242.10',
    volume: '22.8K',
    turnover: '$5.59M',
    category: 'auto'
  },
  'AMZN/USDT': {
    price: '$158.70',
    change: '+0.45%',
    changeAmount: '+$0.71',
    highLow: '159.50 / 157.80',
    volume: '18.6K',
    turnover: '$2.95M',
    category: 'ecommerce'
  }
};

/**
 * 模拟资产数据
 * @description 用于组件开发和测试的模拟资产数据
 */
const mockAssetData = {
  totalBalance: 500.00,
  availableBalance: 500.00,
  lockedBalance: 0.00,
  marginBalance: 0.00,
  positionMargin: 0.00,
  unrealizedPnl: 0.00,
  realizedPnl: 0.00,
  usdtEquity: 0.00,
  walletBalance: 0.00,
  roi: 0.00,
  bonus: 0.00,
  positionBonus: 0.00,
  fundingLeverage: 0.00,
  used: 0.00,
  frozen: 0.00,
  maintenanceMarginRate: 2.08,
  maintenanceMargin: 0.0409,
};

/**
 * 交易页面组件
 * @description 币股合约交易页面的主组件，整合了所有交易相关的子组件
 * @returns {JSX.Element} 交易页面渲染结果
 * 
 * @example
 * ```jsx
 * <TradingPage />
 * ```
 */
const TradingPage: React.FC = () => {
  const { t } = useLocale();
  
  /** 当前选中的交易对（如：AAPL/USDT） */
  const [symbol, setSymbol] = useState('AAPL/USDT');
  
  /** 当前交易对的价格 */
  const [currentPrice, setCurrentPrice] = useState(symbolDataMap['AAPL/USDT'].price);
  
  /** 当前交易对的涨跌幅 */
  const [priceChange, setPriceChange] = useState(symbolDataMap['AAPL/USDT'].change);
  
  /** 当前交易对的涨跌额 */
  const [priceChangeAmount, setPriceChangeAmount] = useState(symbolDataMap['AAPL/USDT'].changeAmount);
  
  /** 资产数据，包括总余额、可用余额等 */
  const [assetData, setAssetData] = useState(mockAssetData);
  
  /** 24小时最高价/最低价 */
  const [highLow, setHighLow] = useState(symbolDataMap['AAPL/USDT'].highLow);
  
  /** 24小时成交量 */
  const [volume, setVolume] = useState(symbolDataMap['AAPL/USDT'].volume);
  
  /** 24小时成交额 */
  const [turnover, setTurnover] = useState(symbolDataMap['AAPL/USDT'].turnover);
  
  /** 交易对分类（如：科技股、汽车股） */
  const [category, setCategory] = useState(symbolDataMap['AAPL/USDT'].category);
  
  /** 弹窗显示状态 */
  const [showPopup, setShowPopup] = useState(true);
  
  /**
   * 关闭弹窗
   * @description 设置showPopup为false，隐藏弹窗
   */
  const closePopup = () => {
    setShowPopup(false);
  };

  /**
   * 监听交易对变化，更新相关数据
   * @description 当交易对改变时，从symbolDataMap中获取对应的数据并更新状态
   */
  React.useEffect(() => {
    if (symbolDataMap[symbol]) {
      const data = symbolDataMap[symbol];
      setCurrentPrice(data.price);
      setPriceChange(data.change);
      setPriceChangeAmount(data.changeAmount);
      setHighLow(data.highLow);
      setVolume(data.volume);
      setTurnover(data.turnover);
      setCategory(data.category);
    }
  }, [symbol]);

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white">
      {/* 暂未开放提示弹窗 */}
      {showPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] rounded-lg p-6 max-w-md w-full mx-4">
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-4">{t('featureNotice', 'common')}</h3>
              <p className="text-gray-400 mb-6">{t('featureNotAvailable', 'common')}</p>
              <button
                className="px-6 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-md font-medium transition-all duration-300"
                onClick={closePopup}
              >
                {t('ok', 'common')}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 顶部导航栏和行情滚动条 */}
      <TradingHeader
        symbol={symbol}
        price={currentPrice}
        change={priceChange}
        changeAmount={priceChangeAmount}
        highLow={highLow}
        volume={volume}
        turnover={turnover}
        category={category}
      />
      
      {/* 主要内容区域 - 充满整个宽度，贴近页面边缘 */}
      <div className="w-full py-2">
        {/* 交易界面主网格 - 充满整个宽度，无内边距 */}
        <div className="grid grid-cols-1 lg:grid-cols-12 px-1">
          {/* 左侧K线图区域 - 占8列，贴近页面左侧 */}
          <div className="lg:col-span-8">
            {/* 交易实时图表容器 - 充满整个宽度 */}
            <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] p-2">
              {/* K线图工具栏 */}
            <ChartToolbar symbol={symbol} onSymbolChange={setSymbol} />
              
              {/* K线图 */}
              <Chart symbol={symbol} />
            </div>
            
            {/* 仓位信息和交易历史容器 - 充满整个宽度 */}
            <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] p-3">
              {/* 仓位信息 */}
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-lg font-semibold">{t('position', 'contracts')} (0)</h3>
                <div className="flex space-x-3">
                  <button className="text-sm bg-[#12121a] hover:bg-[#2a3142] px-3 py-1 rounded">{t('currentBill', 'contracts')}(0)</button>
                  <button className="text-sm bg-[#12121a] hover:bg-[#2a3142] px-3 py-1 rounded">{t('tradingBot', 'contracts')}(0)</button>
                  <button className="text-sm bg-[#12121a] hover:bg-[#2a3142] px-3 py-1 rounded">{t('currentOrder', 'contracts')}(0)</button>
                </div>
              </div>
              
              {/* 交易历史标签 */}
              <div className="flex space-x-4 border-b border-[#2a3142] pb-2">
                <button className="text-sm font-medium text-gray-400 hover:text-white transition-colors">{t('historyOrders', 'contracts')}</button>
                <button className="text-sm font-medium text-gray-400 hover:text-white transition-colors">{t('historyPositions', 'contracts')}</button>
                <button className="text-sm font-medium text-gray-400 hover:text-white transition-colors">{t('tradeDetails', 'contracts')}</button>
                <button className="text-sm font-medium text-gray-400 hover:text-white transition-colors">{t('financialRecords', 'contracts')}</button>
                <button className="text-sm font-medium text-gray-400 hover:text-white transition-colors">{t('assets', 'contracts')}</button>
              </div>
              
              {/* 无数据提示 */}
              <div className="py-8 text-center text-gray-500">
                <p>{t('noPositionData', 'contracts')}</p>
              </div>
              
              {/* 快速操作按钮 */}
              <div className="flex space-x-3 mt-4">
                <button className="flex-1 py-2 bg-[#12121a] hover:bg-[#2a3142] rounded text-sm">{t('sandboxSimulation', 'contracts')}</button>
                <button className="flex-1 py-2 bg-[#12121a] hover:bg-[#2a3142] rounded text-sm">{t('simulation', 'contracts')}</button>
                <button className="flex-1 py-2 bg-[#12121a] hover:bg-[#2a3142] rounded text-sm">{t('useTradingBot', 'contracts')}</button>
                <button className="flex-1 py-2 bg-[#12121a] hover:bg-[#2a3142] rounded text-sm">{t('contractGuide', 'contracts')}</button>
              </div>
            </div>
          </div>
          
          {/* 右侧订单簿和交易表单区域 - 占4列，贴近页面右侧 */}
          <div className="lg:col-span-4">
            {/* 订单簿和成交记录容器 - 充满整个宽度 */}
            <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)]">
              <OrderBook symbol={symbol} />
            </div>
            
            {/* 交易表单容器 - 充满整个宽度 */}
            <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] p-3">
              <TradingForm assetData={assetData} />
            </div>
            
            {/* 资产信息容器 - 充满整个宽度 */}
            <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)]">
              <AssetInfo data={assetData} />
            </div>
            
            {/* 合约信息容器 - 充满整个宽度 */}
            <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)] p-3">
              <h3 className="text-lg font-semibold mb-3">{t('contractInfo', 'contracts')}</h3>
              
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">{t('liquidationPrice', 'contracts')}</span>
                  <span>-</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{t('maintenanceMarginRate', 'contracts')}(MMR)</span>
                  <span>2.00%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{t('maintenanceMargin', 'contracts')}</span>
                  <span>0.0000</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{t('positionMargin', 'contracts')}</span>
                  <span>0.0000</span>
                </div>
              </div>
              
              <div className="border-t border-[#2a3142] mt-3 pt-3">
                <button className="w-full py-2 bg-[#12121a] hover:bg-[#2a3142] rounded text-sm">{t('viewMore', 'contracts')}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TradingPage;
