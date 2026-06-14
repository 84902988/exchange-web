import { apiGet, apiPost } from "@/lib/api/core/http";

export type UserTransferRecipient = {
  user_id: number;
  email_mask: string;
  nickname?: string | null;
  avatar_url?: string | null;
  can_transfer: boolean;
};

export type CreateUserTransferPayload = {
  request_id: string;
  recipient_email: string;
  symbol: string;
  amount: string;
  remark?: string;
};

export type UserTransferRecord = {
  id: number;
  transfer_no: string;
  request_id: string;
  direction: "in" | "out";
  counterparty_user_id: number;
  counterparty_nickname?: string | null;
  recipient_nickname?: string | null;
  recipient_email_mask: string;
  symbol: string;
  from_account: "funding";
  to_account: "funding";
  amount: string;
  fee_amount: string;
  net_amount: string;
  status: string;
  sender_available_before: string;
  sender_available_after: string;
  receiver_available_before: string;
  receiver_available_after: string;
  remark?: string | null;
  created_at: string;
};

export type CreateUserTransferResponse = {
  record: UserTransferRecord;
};

export type GetUserTransferRecordsParams = {
  direction?: "all" | "in" | "out";
  page?: number;
  page_size?: number;
  symbol?: string;
};

export type GetUserTransferRecordsResponse = {
  items: UserTransferRecord[];
  total: number;
  page: number;
  page_size: number;
};

const UserTransferAPI = {
  async resolveRecipient(email: string): Promise<UserTransferRecipient> {
    const qs = new URLSearchParams();
    qs.set("email", email.trim());
    return apiGet<UserTransferRecipient>(`/user-transfer/recipient/resolve?${qs.toString()}`);
  },

  async createTransfer(payload: CreateUserTransferPayload): Promise<CreateUserTransferResponse> {
    return apiPost<CreateUserTransferResponse, CreateUserTransferPayload>("/user-transfer", payload);
  },

  async getRecords(params: GetUserTransferRecordsParams = {}): Promise<GetUserTransferRecordsResponse> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      qs.set(key, String(value));
    });
    const suffix = qs.toString();
    return apiGet<GetUserTransferRecordsResponse>(
      suffix ? `/user-transfer/records?${suffix}` : "/user-transfer/records"
    );
  },
};

export default UserTransferAPI;
