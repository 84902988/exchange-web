// web/lib/api/modules/assets_withdraw.ts
import { apiGet, apiPost } from "@/lib/api/core/http";

/**
 * 提现记录
 */
export type WithdrawRecord = {
  withdraw_id?: number;
  id?: number;

  symbol?: string;
  coin_symbol?: string;

  chain_key?: string;
  network?: string;
  network_code?: string;

  to_address?: string;
  amount?: string;
  fee?: string;
  fee_coin?: string;
  fee_currency?: string;
  receive_amount?: string;
  total_deduct_amount?: string;
  total_fee_usdt?: string;
  net_amount?: string;

  status?: string;
  tx_hash?: string | null;
  txid?: string | null;
  txId?: string | null;
  txHash?: string | null;
  reject_reason?: string | null;
  fail_reason?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
  reason?: string | null;
  remark?: string | null;
  withdraw_type?: string;
  transfer_type?: string;

  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * 手续费预估
 * GET /asset/withdraw/fee?symbol=USDT&network=bsc&amount=1.23&to_address=0x...
 */
async function getWithdrawFee(params: {
  symbol: string;
  network: string; // chain_key
  amount: string;
  to_address?: string;
}): Promise<{
  fee: string;
  fee_coin?: string;
  fee_currency?: string;
  receive_amount?: string;
  net_amount?: string;
  total_deduct_amount?: string;
  total_fee_usdt?: string;
  total_debit?: string;
  fee_source?: "DYNAMIC" | "MIN_FEE" | "FALLBACK" | string;
  raw_fee_usdt?: string | null;
  min_fee?: string;
  buffer?: string;
  fallback_reason?: string;
}> {
  const qs = new URLSearchParams();
  qs.set("symbol", params.symbol);
  qs.set("network", params.network);
  qs.set("amount", params.amount);
  if (params.to_address) qs.set("to_address", params.to_address);
  return apiGet(`/asset/withdraw/fee?${qs.toString()}`);
}

/**
 * 创建提现草稿（Step1 -> Step2）
 * POST /asset/withdraw/create
 */
async function createWithdraw(params: {
  symbol: string;
  network: string; // chain_key
  to_address: string;
  amount: string;
}): Promise<{
  withdraw_id: number;
  status: string;
  need_manual_review?: boolean;
  risk_reason?: string;
  fee_estimate?: string;
  fee_coin?: string;
  fee_currency?: string;
  receive_amount?: string;
  net_amount_estimate?: string;
  total_deduct_amount?: string;
  total_fee_usdt?: string;
  total_debit_estimate?: string;
  fee_source?: string;
  raw_fee_usdt?: string | null;
  fallback_reason?: string;
}> {
  return apiPost("/asset/withdraw/create", {
    symbol: params.symbol,
    network: params.network,
    to_address: params.to_address,
    amount: params.amount,
  });
}

/**
 * 发送验证码
 * POST /asset/withdraw/send_code
 */
async function sendWithdrawCode(params: { withdraw_id: number }): Promise<{
  withdraw_id: number;
  status: string;
  hint?: string;
}> {
  return apiPost("/asset/withdraw/send_code", { withdraw_id: params.withdraw_id });
}

/**
 * 确认提现（后端会冻结余额）
 * POST /asset/withdraw/confirm
 *
 * ✅ 正确：这里成功后应该返回 FROZEN（等待热钱包发送）
 */
async function confirmWithdraw(params: { withdraw_id: number; code: string }): Promise<{
  withdraw_id: number;
  status: string; // "FROZEN"
  fee_final?: string;
  fee_coin?: string;
  fee_currency?: string;
  receive_amount?: string;
  net_amount_final?: string;
  total_deduct_amount?: string;
  total_fee_usdt?: string;
  total_debit_final?: string;
  fee_source?: string;
  raw_fee_usdt?: string | null;
  fallback_reason?: string;
  message?: string;
}> {
  return apiPost("/asset/withdraw/confirm", {
    withdraw_id: params.withdraw_id,
    code: params.code,
  });
}

/**
 * Cancel withdraw before chain submission.
 * POST /asset/withdraw/cancel
 */
async function cancelWithdraw(params: { withdraw_id: number }): Promise<{
  withdraw_id: number;
  status: string; // "CANCELED"
}> {
  return apiPost("/asset/withdraw/cancel", { withdraw_id: params.withdraw_id });
}

/**
 * Enqueue hot-wallet withdraw send job.
 * POST /asset/withdraw/send?withdraw_id=123
 *
 * 后端 withdraw_send.py 是 query 参数 withdraw_id
 * apiPost 一般会自动把 {ok:true,data:...} 解包成 data
 */
async function sendWithdrawTx(params: { withdraw_id: number }): Promise<{
  ok: boolean;
  status: string; // "PROCESSING" / "SENT" / "SENDING" / "FAILED" / ...
  withdraw_id?: number;
  withdraw_log_id?: number;
  code?: string;
  tx_hash?: string;
  queued?: boolean;
  job_id?: string;
  error?: string;
  message?: string;
  note?: string;
}> {
  const qs = new URLSearchParams();
  qs.set("withdraw_id", String(params.withdraw_id));
  // body 传空对象即可
  return apiPost(`/asset/withdraw/send?${qs.toString()}`, {});
}

/**
 * 提现记录列表（后端用 limit/offset）
 * GET /asset/withdraws?limit=&offset=
 */
async function listWithdraws(params?: { limit?: number; offset?: number }): Promise<{
  items: WithdrawRecord[];
  limit: number;
  offset: number;
}> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiGet(`/asset/withdraws${suffix}`);
}

/**
 * ✅ 兼容旧命名：getWithdraws
 */
async function getWithdraws(params?: {
  page?: number;
  page_size?: number;
  limit?: number;
  offset?: number;
}): Promise<{
  items: WithdrawRecord[];
  limit: number;
  offset: number;
}> {
  if (params?.limit !== undefined || params?.offset !== undefined) {
    return listWithdraws({ limit: params?.limit, offset: params?.offset });
  }

  const page = params?.page ?? 1;
  const pageSize = params?.page_size ?? 20;

  const limit = pageSize;
  const offset = (page - 1) * pageSize;

  return listWithdraws({ limit, offset });
}

const WithdrawAPI = {
  getWithdrawFee,
  createWithdraw,
  sendWithdrawCode,
  confirmWithdraw,
  cancelWithdraw,
  sendWithdrawTx,

  listWithdraws,
  getWithdraws,
};

export default WithdrawAPI;
