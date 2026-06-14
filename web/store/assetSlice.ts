import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import type { ApiAsset } from "@/types";

/**
 * 新系统的“资产概览”是从 /asset/balances 的列表推导出来的
 * （后端返回每行包含 available/frozen，类型多为 string）
 */
export type ApiAssetOverview = {
  total: number;
  available: number;
  frozen: number;
};

interface AssetState {
  overview: ApiAssetOverview;
  assets: ApiAsset[];
  totalAssets: number;
  loading: boolean;
  error: string | null;
  page: number;
  pageSize: number;
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getSymbol(a: ApiAsset): string {
  return String((a as any).symbol ?? (a as any).coin_symbol ?? "").toUpperCase();
}

function getChainKey(a: ApiAsset): string {
  return String((a as any).chain_key ?? (a as any).network_code ?? "").toLowerCase();
}

function calcOverview(items: ApiAsset[]): ApiAssetOverview {
  let available = 0;
  let frozen = 0;

  for (const it of items) {
    // 新字段 available/frozen，老字段 available_amount/frozen_amount
    available += toNum((it as any).available ?? (it as any).available_amount ?? 0);
    frozen += toNum((it as any).frozen ?? (it as any).frozen_amount ?? 0);
  }

  return {
    available,
    frozen,
    total: available + frozen,
  };
}

const initialState: AssetState = {
  overview: {
    total: 0,
    available: 0,
    frozen: 0,
  },
  assets: [],
  totalAssets: 0,
  loading: false,
  error: null,
  page: 1,
  pageSize: 20,
};

const assetSlice = createSlice({
  name: "asset",
  initialState,
  reducers: {
    fetchAssetOverviewStart(state) {
      state.loading = true;
      state.error = null;
    },
    /**
     * 仍保留：如果你以后单独做 /asset/overview 接口，这里还能用
     */
    fetchAssetOverviewSuccess(state, action: PayloadAction<ApiAssetOverview>) {
      state.loading = false;
      state.overview = action.payload;
      state.error = null;
    },
    fetchAssetOverviewFailure(state, action: PayloadAction<string>) {
      state.loading = false;
      state.error = action.payload;
    },

    fetchAssetsStart(state) {
      state.loading = true;
      state.error = null;
    },

    /**
     * ✅ 新系统：/asset/balances 直接返回 BalanceItem[]
     */
    fetchAssetsSuccess(state, action: PayloadAction<ApiAsset[]>) {
      state.loading = false;
      state.assets = action.payload;
      state.totalAssets = action.payload.length;
      state.overview = calcOverview(action.payload);
      state.error = null;
    },

    fetchAssetsFailure(state, action: PayloadAction<string>) {
      state.loading = false;
      state.error = action.payload;
    },

    setPage(state, action: PayloadAction<number>) {
      state.page = action.payload;
    },

    setPageSize(state, action: PayloadAction<number>) {
      state.pageSize = action.payload;
      state.page = 1;
    },

    /**
     * ✅ BalanceItem 没有 id，用 (symbol + chain_key) 做唯一键
     */
    updateAsset(state, action: PayloadAction<ApiAsset>) {
      const s = getSymbol(action.payload);
      const c = getChainKey(action.payload);

      const index = state.assets.findIndex((a) => getSymbol(a) === s && getChainKey(a) === c);
      if (index !== -1) {
        state.assets[index] = action.payload;
        // 更新后顺便重新算 overview，避免显示不一致
        state.overview = calcOverview(state.assets);
      }
    },
  },
});

export const {
  fetchAssetOverviewStart,
  fetchAssetOverviewSuccess,
  fetchAssetOverviewFailure,
  fetchAssetsStart,
  fetchAssetsSuccess,
  fetchAssetsFailure,
  setPage,
  setPageSize,
  updateAsset,
} = assetSlice.actions;

export default assetSlice.reducer;
