'use client';

import { OrderBookRowData } from './orderbook.types';
import { formatPrice } from '@/lib/marketPrecision';

interface Props {
  data: OrderBookRowData;
  side: 'buy' | 'sell';
  pricePrecision?: number;
}

export default function OrderBookRow({ data, side, pricePrecision = 2 }: Props) {
  return (
    <div className="relative grid grid-cols-3 text-sm px-2 py-1">

      {/* Depth bar */}
      <div
        className={`absolute top-0 right-0 h-full ${
          side === 'buy' ? 'bg-green-500/10' : 'bg-red-500/10'
        }`}
        style={{ width: `${data.percent}%` }}
      />

      <div className={side === 'buy' ? 'text-green-500' : 'text-red-500'}>
        {formatPrice(data.price, pricePrecision)}
      </div>

      <div className="text-right">{data.amount.toFixed(4)}</div>

      <div className="text-right text-gray-400">
        {data.total.toFixed(4)}
      </div>
    </div>
  );
}
