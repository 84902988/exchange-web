import { apiGet, apiPost } from "@/lib/api/core/http";
import type { VipOverviewResponse } from "@/components/vip/vip.types";

export async function getVipOverview(): Promise<VipOverviewResponse> {
  return apiGet<VipOverviewResponse>("/vip/overview");
}

export type VipFeePreferenceResponse = {
  use_rcb_fee: boolean;
};

export async function getVipFeePreference(): Promise<VipFeePreferenceResponse> {
  return apiGet<VipFeePreferenceResponse>("/vip/fee-preference");
}

export async function updateVipFeePreference(
  use_rcb_fee: boolean,
): Promise<VipFeePreferenceResponse> {
  return apiPost<VipFeePreferenceResponse, { use_rcb_fee: boolean }>(
    "/vip/fee-preference",
    { use_rcb_fee },
  );
}

export type VipRcbLockRecord = {
  id: number;
  asset_symbol: string;
  lock_amount: string;
  lock_period_days: number;
  start_time: string | null;
  end_time: string | null;
  status: string;
  current_svip: string | null;
  created_at: string | null;
};

export type VipRcbLockSummary = {
  rcb_funding_available: string | null;
  rcb_locked: string | null;
  svip_level_code: string | null;
  effective_level_code: string | null;
  effective_fee_source: string | null;
  effective_spot_maker_fee: string | null;
  effective_spot_taker_fee: string | null;
};

export type VipRcbLockResponse = {
  lock: VipRcbLockRecord;
  summary: VipRcbLockSummary;
};

export type VipRcbLocksResponse = {
  items: VipRcbLockRecord[];
};

export async function lockRcb(
  amount: string,
  lock_period_days: number,
): Promise<VipRcbLockResponse> {
  return apiPost<VipRcbLockResponse, { amount: string; lock_period_days: number }>(
    "/vip/lock-rcb",
    { amount, lock_period_days },
  );
}

export async function getMyRcbLocks(): Promise<VipRcbLocksResponse> {
  return apiGet<VipRcbLocksResponse>("/vip/rcb-locks");
}
