'use client';

import OrderBookRow from './OrderBookRow';
import { OrderBookRowData } from './orderbook.types';

interface Props {
  data: OrderBookRowData[];
  side: 'buy' | 'sell';
  pricePrecision?: number;
}

export default function OrderBookList({ data, side, pricePrecision = 2 }: Props) {
  return (
    <div className="space-y-1">
      {data.map((item, index) => (
        <OrderBookRow key={index} data={item} side={side} pricePrecision={pricePrecision} />
      ))}
    </div>
  );
}
