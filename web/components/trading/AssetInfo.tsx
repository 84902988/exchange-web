'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import useLocale from '@/hooks/useLocale';

/**
 * 资产数据类型
 * @description 表示用户的资产信息，包括总余额、可用余额、保证金等
 */
export interface AssetData {
  /** 总资产余额 */
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
  /** USDT权益 */
  usdtEquity: number;
  /** 钱包金额 */
  walletBalance: number;
  /** 回报率 */
  roi: number;
  /** 体验金 */
  bonus: number;
  /** 仓位赠金 */
  positionBonus: number;
  /** 资金杠杆 */
  fundingLeverage: number;
  /** 已用 */
  used: number;
  /** 冻结 */
  frozen: number;
  /** 维持保证金率(MMR) */
  maintenanceMarginRate: number;
  /** 维持保证金 */
  maintenanceMargin: number;
}

/**
 * 资产信息组件属性
 */
export interface AssetInfoProps {
  /** 资产数据 */
  data: AssetData;
}

/**
 * 资产信息组件
 * @description 显示用户的资产信息，包括总余额、可用余额、保证金和盈亏情况
 * @param {AssetInfoProps} props 组件属性
 * @returns {JSX.Element} 组件渲染结果
 *
 * @example
 * ```jsx
 * <AssetInfo
 *   data={{
 *     totalBalance: 500.00,
 *     availableBalance: 500.00,
 *     lockedBalance: 0.00,
 *     marginBalance: 0.00,
 *     positionMargin: 0.00,
 *     unrealizedPnl: 0.00,
 *     realizedPnl: 0.00
 *   }}
 * />
 * ```
 */
const AssetInfo: React.FC<AssetInfoProps> = ({ data }) => {
  const { t } = useLocale();
  const router = useRouter();

  /** 判断未实现盈亏是否为正 */
  const isPnlPositive = data.unrealizedPnl >= 0;

  /** 未实现盈亏的显示颜色（绿色表示盈利，红色表示亏损） */
  const pnlColor = isPnlPositive ? 'text-green-500' : 'text-red-500';

  /** 未实现盈亏的方向图标（↑表示盈利，↓表示亏损） */
  const pnlIcon = isPnlPositive ? '↑' : '↓';

  /**
   * 处理充值按钮点击事件
   * @description 跳转到充值页面
   */
  const handleDeposit = () => {
    // ✅ 关键修复：不再去 /deposit（旧路由）
    router.push('/asset/deposit');
  };

  /**
   * 处理划转按钮点击事件
   * @description 跳转到划转页面
   */
  const handleTransfer = () => {
    router.push('/transfer');
  };

  /**
   * 处理单币保证金模式按钮点击事件
   * @description 切换保证金模式
   */
  const handleMarginModeToggle = () => {
    // 单币保证金模式切换逻辑保留为当前占位行为。
    console.log('切换单币保证金模式');
  };

  return (
    <div className="bg-[#0b0b0f] border border-[rgba(255,255,255,0.45)]">
      {/* 资产USDT部分 */}
      <div className="p-4">
        <h2 className="text-lg font-semibold mb-4">{t('assetUsdt', 'contracts')}</h2>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('usdtEquity', 'contracts')}</span>
            <span className="text-white">{data.usdtEquity.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('walletBalance', 'contracts')}</span>
            <span className="text-white">{data.walletBalance.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('available', 'contracts')}</span>
            <span className="text-white">{data.availableBalance.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('unrealizedPnlTotal', 'contracts')}</span>
            <span className={`text-white ${data.unrealizedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {data.unrealizedPnl.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">ROI</span>
            <span className="text-white">{data.roi.toFixed(2)} %</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('bonus', 'contracts')}</span>
            <span className="text-white">{data.bonus.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('positionBonus', 'contracts')}</span>
            <span className="text-white">{data.positionBonus.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('realizedPnlTotal', 'contracts')}</span>
            <span className={`text-white ${data.realizedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {data.realizedPnl.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('fundingLeverage', 'contracts')}</span>
            <span className="text-white">{data.fundingLeverage.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('used', 'contracts')}</span>
            <span className="text-white">{data.used.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('frozen', 'contracts')}</span>
            <span className="text-white">{data.frozen.toFixed(2)}</span>
          </div>
        </div>

        {/* 充值和划转按钮 */}
        <div className="grid grid-cols-2 gap-3 pt-4">
          <button
            className="bg-[#12121a] hover:bg-[#2a3142] transition-colors py-2 rounded-md text-sm font-medium"
            onClick={handleDeposit}
          >
            {t('deposit', 'common')}
          </button>
          <button
            className="bg-[#12121a] hover:bg-[#2a3142] transition-colors py-2 rounded-md text-sm font-medium"
            onClick={handleTransfer}
          >
            {t('transfer', 'common')}
          </button>
        </div>
      </div>

      {/* 保证金部分 */}
      <div className="p-4 border-t border-[rgba(255,255,255,0.45)]">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">{t('account', 'contracts')}</h2>
          <span className="text-blue-400">{t('pnl', 'contracts')}</span>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('margin', 'contracts')}</span>
            <span className="text-white">{data.marginBalance.toFixed(4)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('maintenanceMarginRate', 'contracts')}</span>
            <span className="text-white">{data.maintenanceMarginRate}%</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-400">{t('maintenanceMargin', 'contracts')}</span>
            <span className="text-white">{data.maintenanceMargin.toFixed(4)}</span>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-sm text-gray-400">{t('positionTierIntroduction', 'contracts')}</span>
              <span className="ml-2 text-blue-400 hover:underline cursor-pointer">{t('viewMore', 'common')}</span>
            </div>
          </div>
        </div>

        {/* 单币保证金模式按钮 */}
        <div className="mt-4">
          <button
            className="w-full py-2 bg-[#12121a] hover:bg-[#2a3142] transition-colors rounded-md text-sm font-medium"
            onClick={handleMarginModeToggle}
          >
            {t('singleCurrencyMarginMode', 'contracts')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssetInfo;
