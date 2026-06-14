// web/lib/api/modules/assets.ts
import { apiGet } from "@/lib/api/core/http";
import WithdrawAPI from "./assets_withdraw";

/**
 * /asset/coins：币种元信息（以你后端实际返回为准）
 */
export type CoinItem = {
  id?: number;
  symbol: string; // "USDT" / "MFC" ...
  name?: string;
  asset_type?: string;
  display_precision?: number;
  enabled?: boolean;

  // 兼容老字段
  is_enabled?: boolean;
  precision?: number;
  icon_url?: string;
};

/**
 * /asset/networks：链（chains）
 * 后端统一：code = chain_key（bsc/polygon/...）
 */
export type NetworkItem = {
  id?: number;
  code: string; // chain_key
  name?: string; // 展示名
  chain_id?: string | number; // 56 / 137
  enabled?: boolean;

  explorer_tx_url?: string | null;
  // 兼容老字段
  is_enabled?: boolean;
};

/**
 * /asset/balances：这里我们用来“推导币种支持哪些网络”
 * 你的后端（asset.py）会返回每个 asset_chain 一行：symbol + chain_key + deposit_enabled 等
 */
export type BalanceItem = {
  // 后端新字段
  symbol?: string;
  chain_key?: string;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  enabled?: boolean;

  available?: string;
  frozen?: string;

  // 兼容老字段（如果你别的页面还在用）
  coin_symbol?: string;
  network_code?: string;
  available_amount?: string;
  frozen_amount?: string;
  account_type?: string;
};

export type AccountBalanceItem = {
  symbol: string;
  account_key: 'funding' | 'spot' | 'contract' | string;
  available: string;
  frozen: string;
  coin_symbol?: string;
  account_type?: string;
  chain_key?: string;
  network_code?: string;
  available_amount?: string;
  frozen_amount?: string;
};
// ===== compatibility exports (for older code imports) =====

// 你现在资产“概览/列表”本质都来自 /asset/balances
export type Asset = BalanceItem;

// 老代码里常见：AssetListResponse / AssetOverview
export type AssetListResponse = {
  items: Asset[];
};

export type AssetOverview = AssetListResponse;

/**
 * /asset/deposit/address 返回（以你后端实现为准）
 */
export type DepositAddressResp = {
  // 标准字段（后端）
  symbol?: string;
  network?: string; // chain_key
  chain_id?: number;
  address: string;
  memo?: string | null;

  contract_address?: string | null;
  decimals?: number;
  confirm_required?: number;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  min_deposit?: string;
  notice?: string[];

  // 兼容字段
  coin_symbol?: string;
  network_code?: string;
};

/**
 * ✅ /asset/deposits 返回的记录项（按你后端新增接口返回字段）
 */
export type DepositRecord = {
  id: number;
  symbol: string;
  chain_key: string;
  address?: string | null;
  memo?: string | null;
  txid?: string | null;
  log_index?: number;
  from_address?: string | null;
  amount: string;
  status?: string | null;
  confirmations?: number;
  confirm_required?: number;
  block_number?: number | null;
  block_hash?: string | null;
  created_at?: string | null;
  confirmed_at?: string | null;
};

export type DepositListResp = {
  items: DepositRecord[];
  page: number;
  page_size: number;
  total: number;
};

export type DepositOptionItem = {
  coin_symbol: string;
  coin_name?: string;
  display_precision?: number;
  icon_url?: string | null;
  asset_sort_order?: number;
  deposit_sort_order?: number;
  deposit_quick_enabled?: boolean;
  deposit_default_enabled?: boolean;
  chain_key: string;
  chain_name?: string;
  chain_id?: string | number;
  chain_icon_url?: string | null;
  network_icon_url?: string | null;
  network_sort_order?: number;
  contract_address?: string | null;
  decimals?: number;
  min_deposit?: string;
  min_withdraw?: string;
  withdraw_fee?: string;
  confirmations?: number;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  enabled?: boolean;
  asset_enabled?: boolean;
  chain_enabled?: boolean;
  asset_chain_enabled?: boolean;
};

export type DepositOptionsResp = {
  items: DepositOptionItem[];
  default_asset_symbol?: string | null;
};

export type WithdrawOptionItem = {
  coin_symbol: string;
  coin_name?: string;
  display_precision?: number;
  icon_url?: string | null;
  asset_sort_order?: number;
  withdraw_sort_order?: number;
  withdraw_quick_enabled?: boolean;
  withdraw_default_enabled?: boolean;
  chain_key: string;
  chain_name?: string;
  chain_id?: string | number;
  chain_icon_url?: string | null;
  network_icon_url?: string | null;
  network_sort_order?: number;
  contract_address?: string | null;
  decimals?: number;
  min_deposit?: string;
  min_withdraw?: string;
  withdraw_fee?: string;
  confirmations?: number;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  enabled?: boolean;
  asset_enabled?: boolean;
  chain_enabled?: boolean;
  asset_chain_enabled?: boolean;
};

export type WithdrawOptionsResp = {
  items: WithdrawOptionItem[];
  default_asset_symbol?: string | null;
};

export type BalanceLogItem = {
  id: number;
  created_at: string | null;
  biz_type: string;
  raw_biz_type?: string | null;
  biz_id?: string | null;
  request_id?: string | null;
  coin_symbol: string;
  chain_key: string;
  change_amount: string;
  after_available: string;
  remark: string;
};

export type BalanceLogListResp = {
  items: BalanceLogItem[];
  page: number;
  page_size: number;
  total: number;
};

export const AssetsAPI = {
  async getCoins(): Promise<CoinItem[]> {
    return apiGet<CoinItem[]>("/asset/coins");
  },

  async getNetworks(): Promise<NetworkItem[]> {
    return apiGet<NetworkItem[]>("/asset/networks");
  },

  async getBalances(): Promise<BalanceItem[]> {
    return apiGet<BalanceItem[]>("/asset/balances");
  },

  async getAccountBalances(): Promise<AccountBalanceItem[]> {
    return apiGet<AccountBalanceItem[]>("/asset/account-balances");
  },

  async getDepositOptions(): Promise<DepositOptionsResp> {
    return apiGet<DepositOptionsResp>("/asset/deposit/options");
  },

  async getWithdrawOptions(): Promise<WithdrawOptionsResp> {
    return apiGet<WithdrawOptionsResp>("/asset/withdraw/options");
  },

  /**
   * ✅ 统一：/asset/deposit/address?symbol=USDT&network=polygon
   * ✅ 兼容：允许传 coin_symbol / network_code
   */
  async getDepositAddress(params: {
    symbol?: string;
    network?: string;

    // legacy
    coin_symbol?: string;
    network_code?: string;
  }): Promise<DepositAddressResp> {
    const symbol = (params.symbol ?? params.coin_symbol ?? "").trim();
    const network = (params.network ?? params.network_code ?? "").trim();

    const qs = new URLSearchParams({ symbol, network }).toString();
    const raw = await apiGet<Record<string, unknown>>(`/asset/deposit/address?${qs}`);
    const rawSymbol = typeof raw?.symbol === "string" ? raw.symbol : symbol;
    const rawNetwork = typeof raw?.network === "string" ? raw.network : network;
    const rawCoinSymbol =
      typeof raw?.coin_symbol === "string" ? raw.coin_symbol : rawSymbol;
    const rawNetworkCode =
      typeof raw?.network_code === "string" ? raw.network_code : rawNetwork;
    const rawAddress = typeof raw?.address === "string" ? raw.address : "";

    return {
      ...raw,
      symbol: rawSymbol,
      network: rawNetwork,
      coin_symbol: rawCoinSymbol,
      network_code: rawNetworkCode,
      address: rawAddress,
    };
  },

  /**
   * ✅ 新增：充值记录列表（分页/筛选）
   * GET /asset/deposits?page=1&page_size=20&symbol=USDT&network=bsc&status=CONFIRMED&q=0x...
   */
  async getDeposits(params: {
    page: number;
    page_size: number;
    symbol?: string;
    network?: string; // chain_key
    status?: string;
    q?: string;
    start_time?: string;
    end_time?: string;
  }): Promise<DepositListResp> {
    const qs = new URLSearchParams();

    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      qs.set(k, String(v));
    });

    return apiGet<DepositListResp>(`/asset/deposits?${qs.toString()}`);
  },

  async getBalanceLogs(params: {
    page: number;
    page_size: number;
    coin_symbol?: string;
    chain_key?: string;
    account_type?: string;
    biz_type?: string;
  }): Promise<BalanceLogListResp> {
    const qs = new URLSearchParams();
    const normalizedParams = {
      ...params,
      chain_key: params.chain_key ?? params.account_type,
      account_type: undefined,
    };

    Object.entries(normalizedParams).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      qs.set(k, String(v));
    });

    return apiGet<BalanceLogListResp>(`/asset/my/balance-logs?${qs.toString()}`);
  },
    ...WithdrawAPI
};

export default AssetsAPI;
