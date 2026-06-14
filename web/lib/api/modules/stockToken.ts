import { apiGet, apiPost } from "@/lib/api/core/http";

export type StockTokenLockItem = {
  id: number;
  lock_symbol: string;
  trade_symbol: string | null;
  total_amount: string;
  locked_amount: string;
  available_amount: string;
  converted_amount: string;
  conversion_rate_snapshot: string;
  daily_release_rate: string;
  lock_days: number;
  release_days: number;
  unlock_at: string | null;
  lock_start_at: string | null;
  lock_end_at: string | null;
  release_start_at: string | null;
  release_finish_at: string | null;
  release_started: boolean;
  progress_percent: string;
  status: string;
  start_at: string | null;
  end_at: string | null;
};

export type StockTokenLocksResponse = {
  items: StockTokenLockItem[];
};

export type StockTokenConvertResponse = {
  success: boolean;
  record_id: number;
  from_symbol: string;
  to_symbol: string;
  from_amount: string;
  to_amount: string;
};

export type StockTokenConvertRecord = {
  id: number;
  from_symbol: string;
  to_symbol: string;
  from_amount: string;
  to_amount: string;
  conversion_rate: string;
  status: string;
  created_at: string | null;
};

export type StockTokenConvertsResponse = {
  items: StockTokenConvertRecord[];
};

export async function getStockTokenLocks(): Promise<StockTokenLocksResponse> {
  return apiGet<StockTokenLocksResponse>("/stock-token/locks");
}

export async function convertStockToken(
  lockItemId: number,
  amount: string,
): Promise<StockTokenConvertResponse> {
  return apiPost<StockTokenConvertResponse, { lock_item_id: number; amount: string }>(
    "/stock-token/convert",
    {
      lock_item_id: lockItemId,
      amount,
    },
  );
}

export async function getStockTokenConverts(): Promise<StockTokenConvertsResponse> {
  return apiGet<StockTokenConvertsResponse>("/stock-token/converts");
}
