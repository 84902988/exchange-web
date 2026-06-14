import { request } from "../core/request";

export interface FuturesAccountOverview {
  total: number;
  available: number;
  frozen: number;
  positions: number;
  todayProfit?: number;
  todayProfitRate?: number;
  margin: number;
  equity: number;
}

export interface FuturesPosition {
  id: string;
  symbol: string;
  type: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
}

export interface FuturesOrder {
  id: string;
  symbol: string;
  type: "limit" | "market";
  side: "buy" | "sell";
  size: number;
  price?: number;
  status: "pending" | "filled" | "cancelled" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface FuturesSymbol {
  symbol: string;
  name: string;
  baseAsset: string;
  quoteAsset: string;
  maxLeverage: number;
  minOrderSize: number;
  pricePrecision: number;
  sizePrecision: number;
}

// ✅ 合约账户总览
export const getFuturesAccountOverview = (): Promise<FuturesAccountOverview> => {
  return request<FuturesAccountOverview>("/api/v1/futures/account/overview", { method: "GET" });
};

// ✅ 合约持仓
export const getFuturesPositions = (): Promise<FuturesPosition[]> => {
  return request<FuturesPosition[]>("/api/v1/futures/positions", { method: "GET" });
};

// ✅ 合约订单列表
export const getFuturesOrders = (
  page: number = 1,
  page_size: number = 20
): Promise<{ list: FuturesOrder[]; total: number; page: number; page_size: number }> => {
  const qs = new URLSearchParams({
    page: String(page),
    page_size: String(page_size),
  }).toString();

  return request<{ list: FuturesOrder[]; total: number; page: number; page_size: number }>(
    `/api/v1/futures/orders?${qs}`,
    { method: "GET" }
  );
};

// ✅ 合约交易对
export const getFuturesSymbols = (): Promise<FuturesSymbol[]> => {
  return request<FuturesSymbol[]>("/api/v1/futures/symbols", { method: "GET" });
};
