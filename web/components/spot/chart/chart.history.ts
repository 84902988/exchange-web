import { getSpotMarketKlines } from '@/lib/api/modules/market';
import { adaptKlines } from './chart.adapter';
import type { CandleItem, VolumeItem } from './chart.types';

export interface SpotChartHistoryResult {
  candles: CandleItem[];
  volumes: VolumeItem[];
}

export interface FetchSpotChartHistoryParams {
  symbol: string;
  interval: string;
  limit?: number;
  endTime?: number;
}

export async function fetchSpotChartHistory(
  params: FetchSpotChartHistoryParams
): Promise<SpotChartHistoryResult> {
  const { symbol, interval, limit = 200, endTime } = params;

  try {
    const payload = await getSpotMarketKlines({
      symbol,
      interval,
      limit,
      endTime,
    });

    return adaptKlines(payload?.items || []);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'K-line request failed';
    throw new Error(message);
  }
}
