import { apiGet, apiPost } from "@/lib/api/core/http";

export type AssetTotals = Record<string, string>;

export type MyBdAccount = {
  bd_user_id: number;
  bd_level: string;
  commission_rate: string;
  invite_code: string;
  status: string;
};

export type MyBdTeamSummary = {
  bound_user_count: number;
  total_original_fee: string;
  total_commission: string;
  pending_commission: string;
  paid_commission: string;
  paid_rcb_amount: string;
  total_original_fee_by_asset: AssetTotals;
  total_commission_by_asset: AssetTotals;
  pending_commission_by_asset: AssetTotals;
  paid_commission_by_asset: AssetTotals;
  total_totals_by_asset: AssetTotals;
  pending_totals_by_asset: AssetTotals;
  paid_totals_by_asset: AssetTotals;
  paid_amounts_by_asset: AssetTotals;
  settlement_asset_symbol: string;
  settlement_asset_symbols: string[];
  source_type: string;
  source_label: string;
  latest_commission_at: string | null;
};

export type MyBdCommissionRecord = {
  id: number;
  source_user_id: number;
  order_id: number | null;
  trade_id: number | null;
  fee_coin_symbol: string;
  original_fee_amount: string;
  commission_rate: string;
  commission_amount: string;
  pool_amount: string;
  status: string;
  paid_at: string | null;
  created_at: string | null;
};

export type MyBdTeamOverview = {
  is_bd: boolean;
  account: MyBdAccount | null;
  summary: MyBdTeamSummary;
  records: MyBdCommissionRecord[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
};

export type BdApplicationStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";

export type BdApplication = {
  id: number;
  user_id: number;
  apply_level: string;
  deposit_coin_symbol: string;
  deposit_amount: string;
  status: BdApplicationStatus | string;
  remark: string | null;
  admin_remark: string | null;
  created_at: string | null;
  updated_at: string | null;
  reviewed_at: string | null;
  reviewed_by: number | null;
};

export type CreateBdApplicationPayload = {
  apply_level: string;
  deposit_coin_symbol: string;
  deposit_amount: string;
  remark?: string;
};

export type BindInvitePayload = {
  invite_code: string;
};

export type BindInviteResult = {
  bound: boolean;
  message: string;
  bd_user_id: number;
  user_id: number;
  invite_code: string;
};

export type ValidateBdInviteResult = {
  valid: boolean;
  invite_code: string;
};

export async function getMyBdTeamOverview(
  page: number = 1,
  pageSize: number = 10,
): Promise<MyBdTeamOverview> {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  return apiGet<MyBdTeamOverview>(`/bd/my/team?${params.toString()}`);
}

export async function getMyBdApplication(): Promise<BdApplication | null> {
  return apiGet<BdApplication | null>("/bd/my/application");
}

export async function createMyBdApplication(
  payload: CreateBdApplicationPayload,
): Promise<BdApplication> {
  return apiPost<BdApplication, CreateBdApplicationPayload>("/bd/my/application", payload);
}

export async function bindInvite(payload: BindInvitePayload): Promise<BindInviteResult> {
  return apiPost<BindInviteResult, BindInvitePayload>("/bd/invite/bind", payload);
}

export async function validateBdInvite(inviteCode: string): Promise<ValidateBdInviteResult> {
  return apiGet<ValidateBdInviteResult>(`/bd/invite/validate?invite_code=${encodeURIComponent(inviteCode)}`);
}
