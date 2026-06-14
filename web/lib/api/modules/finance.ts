import { request } from "../core/request";

export interface FinanceAccount {
  totalAmount: string;
  totalEarnings: string;
}

export interface FinanceProduct {
  id: string;
  name: string;
  symbol: string;
  apr: string;
  amount: string;
  totalEarnings: string;
}

export interface FinanceProductListResponse {
  list: FinanceProduct[];
  total: number;
  page: number;
  page_size: number;
}

// ✅ 理财账户总览
export const getFinanceAccountOverview = (): Promise<FinanceAccount> => {
  return request<FinanceAccount>("/api/v1/finance/account", { method: "GET" });
};

// ✅ 理财产品列表
export const getFinanceProducts = (
  page: number = 1,
  page_size: number = 20
): Promise<FinanceProductListResponse> => {
  const qs = new URLSearchParams({
    page: String(page),
    page_size: String(page_size),
  }).toString();

  return request<FinanceProductListResponse>(`/api/v1/finance/products?${qs}`, {
    method: "GET",
  });
};

// ✅ 理财产品详情
export const getFinanceProductDetail = (id: string): Promise<FinanceProduct> => {
  return request<FinanceProduct>(`/api/v1/finance/products/${encodeURIComponent(id)}`, {
    method: "GET",
  });
};
