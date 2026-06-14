import { apiGet, apiPost } from "@/lib/api/core/http";

export type TransferAccountKey = "funding" | "spot";
export type TransferRecordAccountKey = TransferAccountKey | "contract" | string;

export type CreateTransferPayload = {
  from_account: TransferAccountKey;
  to_account: TransferAccountKey;
  symbol: string;
  amount: string;
};

export type TransferRecordItem = {
  id: number;
  transfer_no: string;
  symbol: string;
  from_account: TransferRecordAccountKey;
  to_account: TransferRecordAccountKey;
  amount: string;
  status: string;
  from_available_before: string;
  from_available_after: string;
  to_available_before: string;
  to_available_after: string;
  remark?: string | null;
  created_at: string;
};

export type CreateTransferResponse = {
  record: TransferRecordItem;
};

export type GetTransferRecordsParams = {
  page?: number;
  page_size?: number;
  symbol?: string;
  from_account?: string;
  to_account?: string;
};

export type GetTransferRecordsResponse = {
  items: TransferRecordItem[];
  total: number;
  page: number;
  page_size: number;
};

const TransferAPI = {
  async createTransfer(
    payload: CreateTransferPayload
  ): Promise<CreateTransferResponse> {
    return apiPost<CreateTransferResponse, CreateTransferPayload>(
      "/account/transfer",
      payload
    );
  },

  async getTransferRecords(
    params: GetTransferRecordsParams = {}
  ): Promise<GetTransferRecordsResponse> {
    const query = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      query.set(key, String(value));
    });

    const suffix = query.toString();
    const path = suffix
      ? `/account/transfer/records?${suffix}`
      : "/account/transfer/records";

    return apiGet<GetTransferRecordsResponse>(path);
  },
};

export default TransferAPI;
