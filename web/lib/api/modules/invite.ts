import { request } from "../core/request";

export type InviteCommissionStatus = "PENDING" | "PAID" | "FAILED" | string;

export interface MyInviteSummary {
  invited_count: number;
  total_commission_rcb: string;
  pending_commission_rcb: string;
  paid_commission_rcb: string;
  commission_rate?: string;
  commission_percent?: string;
  source_type?: string;
  source_label?: string;
}

export interface MyInviteRecentRecord {
  id: number;
  invitee_user_id: number;
  fee_coin_symbol: string;
  fee_amount: string;
  fee_usdt_value: string;
  commission_rate: string;
  commission_rcb_amount: string;
  status: InviteCommissionStatus;
  created_at: string | null;
  paid_at: string | null;
}

export interface MyInviteOverview {
  invite_code: string | null;
  invite_link: string | null;
  commission_rate: string;
  commission_percent: string;
  summary: MyInviteSummary;
  recent_records: MyInviteRecentRecord[];
}

export interface ValidateUserInviteResult {
  type: "user";
  valid: boolean;
  invite_code: string;
  commission_rate?: string;
  commission_percent?: string;
  inviter_name?: string | null;
  message?: string | null;
}

export const getMyInviteOverview = (): Promise<MyInviteOverview> => {
  return request<MyInviteOverview>("/user/invite/overview", { method: "GET" });
};

export const validateUserInvite = (inviteCode: string): Promise<ValidateUserInviteResult> => {
  return request<ValidateUserInviteResult>(
    `/user/invite/validate?invite_code=${encodeURIComponent(inviteCode)}`,
    { method: "GET" },
  );
};
