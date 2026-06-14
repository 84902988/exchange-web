'use client';

import LoadingSkeleton from '@/components/ui/LoadingSkeleton';

interface FinanceAccountSummaryProps {
  totalAmount: string;
  totalEarnings: string;
  loading?: boolean;
}

export default function FinanceAccountSummary({ 
  totalAmount, 
  totalEarnings, 
  loading = false 
}: FinanceAccountSummaryProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-sm text-white/50 mb-2">总额</div>
        <div className="flex items-center">
          {loading ? (
            <LoadingSkeleton className="h-10 w-20" />
          ) : (
            <div className="text-3xl font-bold text-white">{totalAmount}</div>
          )}
        </div>
        <div className="mt-2 text-sm text-white/50">≈0.00USD</div>
      </div>
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-sm text-white/50 mb-2">累计收益</div>
        <div className="flex items-center">
          {loading ? (
            <LoadingSkeleton className="h-10 w-20" />
          ) : (
            <div className="text-3xl font-bold text-white">{totalEarnings}</div>
          )}
        </div>
        <div className="mt-2 text-sm text-green-400">+0.00%</div>
      </div>
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-sm text-white/50 mb-2">可用余额</div>
        <div className="flex items-center">
          {loading ? (
            <LoadingSkeleton className="h-10 w-20" />
          ) : (
            <div className="text-3xl font-bold text-white">{totalAmount}</div>
          )}
        </div>
        <div className="mt-4">
          <button className="w-full bg-gradient-to-r from-amber-500 to-amber-600 text-white rounded-full py-2 px-4 text-sm font-medium hover:opacity-90 transition-opacity">
            转入理财
          </button>
        </div>
      </div>
    </div>
  );
}