import { apiGet } from "@/lib/api/core/http";

export type MyDividendSummary = {
  total_rcb: string;
  month_rcb: string;
  latest_amount_rcb: string | null;
  latest_dividend_date: string | null;
  latest_status: string | null;
  current_svip_level: string | null;
  eligible: boolean;
};

export type MyDividendRecord = {
  id: number;
  dividend_date: string | null;
  svip_level_code: string;
  amount_rcb: string;
  amount_usdt: string;
  status: string;
  paid_at: string | null;
};

export type MyDividendRecordsResponse = {
  items: MyDividendRecord[];
  total: number;
  page: number;
  page_size: number;
};

export async function getMyDividendSummary(): Promise<MyDividendSummary> {
  return apiGet<MyDividendSummary>("/dividend/my/summary");
}

export async function getMyDividendRecords(
  page: number = 1,
  pageSize: number = 20,
): Promise<MyDividendRecordsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  return apiGet<MyDividendRecordsResponse>(`/dividend/my/records?${params.toString()}`);
}
