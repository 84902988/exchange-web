'use client';

import LoadingSkeleton from '@/components/ui/LoadingSkeleton';
import EmptyState from '@/components/ui/EmptyState';

// 理财产品类型定义
export interface FinanceProduct {
  id: string;
  name: string;
  symbol: string;
  apr: string;
  amount: string;
  totalEarnings: string;
}

interface FinanceProductListProps {
  products: FinanceProduct[];
  loading?: boolean;
  onProductClick?: (productId: string) => void;
}

export default function FinanceProductList({ 
  products, 
  loading = false,
  onProductClick 
}: FinanceProductListProps) {
  if (loading) {
    return (
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <div className="grid grid-cols-12 gap-4 p-4 bg-white/5">
          <div className="col-span-4 text-sm font-medium text-white/70">产品名称</div>
          <div className="col-span-2 text-sm font-medium text-white/70">币种</div>
          <div className="col-span-2 text-sm font-medium text-white/70">参考年化</div>
          <div className="col-span-2 text-sm font-medium text-white/70">持仓金额</div>
          <div className="col-span-2 text-sm font-medium text-white/70">累计收益</div>
        </div>
        <div className="space-y-3 p-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="grid grid-cols-12 gap-4">
              <div className="col-span-4">
                <LoadingSkeleton className="h-6 w-32" />
              </div>
              <div className="col-span-2">
                <LoadingSkeleton className="h-4 w-12" />
              </div>
              <div className="col-span-2">
                <LoadingSkeleton className="h-4 w-20" />
              </div>
              <div className="col-span-2">
                <LoadingSkeleton className="h-4 w-16" />
              </div>
              <div className="col-span-2">
                <LoadingSkeleton className="h-4 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="border border-white/10 rounded-xl overflow-hidden p-8 text-center">
        <EmptyState
          title="暂无理财产品"
          description="当前没有可用的理财产品"
        />
      </div>
    );
  }

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <div className="grid grid-cols-12 gap-4 p-4 bg-white/5">
        <div className="col-span-4 text-sm font-medium text-white/70">产品名称</div>
        <div className="col-span-2 text-sm font-medium text-white/70">币种</div>
        <div className="col-span-2 text-sm font-medium text-white/70">参考年化</div>
        <div className="col-span-2 text-sm font-medium text-white/70">持仓金额</div>
        <div className="col-span-2 text-sm font-medium text-white/70">累计收益</div>
      </div>
      <div className="space-y-1">
        {products.map((product) => (
          <div 
            key={product.id} 
            className={`grid grid-cols-12 gap-4 p-4 transition-colors ${
              onProductClick ? 'cursor-pointer hover:bg-white/5' : ''
            }`}
            onClick={onProductClick ? () => onProductClick(product.id) : undefined}
          >
            <div className="col-span-4 flex items-center">
              <div className="text-white font-medium">{product.name}</div>
            </div>
            <div className="col-span-2 flex items-center">
              <div className="text-white/80">{product.symbol}</div>
            </div>
            <div className="col-span-2 flex items-center">
              <div className="text-white/80">{product.apr}</div>
            </div>
            <div className="col-span-2 flex items-center">
              <div className="text-white">{product.amount}</div>
            </div>
            <div className="col-span-2 flex items-center">
              <div className="text-white">{product.totalEarnings}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
