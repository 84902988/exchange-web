import React from 'react';
import type {SpotKline} from '../../api/spot';
import MobileKlineChart from './MobileKlineChart';
import type {KlineInterval} from './kline.utils';

type Props = {
  items: SpotKline[];
  height?: number;
  interval?: KlineInterval;
  loading?: boolean;
  error?: string | null;
  pricePrecision?: number;
  showControls?: boolean;
  onIntervalChange?: (interval: KlineInterval) => void;
};

export default function MiniKlineChart({
  items,
  height = 118,
  interval = '1m',
  loading = false,
  error = null,
  pricePrecision = 2,
  showControls = false,
  onIntervalChange,
}: Props) {
  return (
    <MobileKlineChart
      error={error}
      height={height}
      interval={interval}
      items={items}
      loading={loading}
      pricePrecision={pricePrecision}
      showControls={showControls}
      onIntervalChange={onIntervalChange}
    />
  );
}
