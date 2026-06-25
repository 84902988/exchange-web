import {apiClient} from './client';

export type AssetAccountKey = 'funding' | 'spot' | 'contract' | string;

export type AssetAccountBalance = {
  symbol: string;
  accountKey: AssetAccountKey;
  available: number | null;
  frozen: number | null;
};

export type AssetBalanceLogItem = {
  id: string;
  createdAt?: string | null;
  bizType: string;
  coinSymbol: string;
  accountKey: string;
  changeAmount: string;
  afterAvailable: string;
  remark: string;
};

export type AssetBalanceLogResponse = {
  items: AssetBalanceLogItem[];
  page: number;
  pageSize: number;
  total: number;
};

export type AssetChainOption = {
  coinSymbol: string;
  coinName?: string;
  displayPrecision?: number | null;
  chainKey: string;
  chainName?: string;
  chainId?: string | number | null;
  contractAddress?: string | null;
  decimals?: number | null;
  minDeposit?: string;
  minWithdraw?: string;
  withdrawFee?: string;
  confirmations?: number | null;
  depositEnabled?: boolean;
  withdrawEnabled?: boolean;
  enabled?: boolean;
  assetEnabled?: boolean;
  chainEnabled?: boolean;
  assetChainEnabled?: boolean;
  depositSortOrder?: number;
  withdrawSortOrder?: number;
  depositDefaultEnabled?: boolean;
  withdrawDefaultEnabled?: boolean;
  memoRequired?: boolean;
  memoLabel?: string | null;
  riskTip?: string | null;
};

export type AssetOptionsResponse = {
  items: AssetChainOption[];
  defaultAssetSymbol?: string | null;
};

export type DepositAddress = {
  symbol: string;
  network: string;
  chainId?: number | null;
  address: string;
  memo?: string | null;
  contractAddress?: string | null;
  decimals?: number | null;
  confirmRequired?: number | null;
  depositEnabled?: boolean;
  withdrawEnabled?: boolean;
  minDeposit?: string;
  notice: string[];
};

export type WithdrawFeeEstimate = {
  fee: string;
  feeCoin?: string;
  feeCurrency?: string;
  receiveAmount?: string;
  netAmount?: string;
  totalDeductAmount?: string;
  totalFeeUsdt?: string;
  totalDebit?: string;
  feeSource?: string;
  fallbackReason?: string | null;
};

export type WithdrawCreateResponse = {
  withdrawId: number;
  symbol: string;
  chainKey: string;
  toAddress: string;
  amount: string;
  status: string;
  needManualReview?: boolean;
  riskReason?: string;
  feeEstimate?: string;
  feeCoin?: string;
  receiveAmount?: string;
  totalDebitEstimate?: string;
};

export type WithdrawCodeResponse = {
  withdrawId: number;
  status: string;
  hint?: string;
};

export type WithdrawConfirmResponse = {
  withdrawId: number;
  symbol: string;
  chainKey: string;
  amount: string;
  status: string;
  feeFinal?: string;
  feeCoin?: string;
  receiveAmount?: string;
  totalDebitFinal?: string;
};

export type AssetTransferAccountKey = 'funding' | 'spot' | 'contract';

export type AccountTransferResponse = {
  record?: {
    id?: number;
    transfer_no?: string;
    symbol?: string;
    from_account?: string;
    to_account?: string;
    amount?: string;
    status?: string;
    created_at?: string;
  };
};

export type AssetInviteOverview = {
  inviteCode: string | null;
  invitedCount: number;
  totalReward: string;
  pendingReward: string;
  paidReward: string;
  rewardAsset: string;
};

export type AssetBdOverview = {
  isBd: boolean;
  bdLevel: string;
  teamCount: number;
  totalCommission: string;
  pendingCommission: string;
  paidCommission: string;
  settlementAsset: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRows(payload: unknown, keys: string[]) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readString(row: Record<string, unknown>, keys: string[], fallback = '') {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function readBoolean(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
    }
  }
  return undefined;
}

function readStringList(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) {
      return value
        .map(item => (typeof item === 'string' ? item.trim() : String(item)))
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) return [value.trim()];
  }
  return [];
}

function withQuery(path: string, params: Record<string, string | number | undefined | null>) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}

export function formatAssetNumber(
  value: number | null | undefined,
  precision = 4,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

export function formatAssetAmountText(
  value: number | null | undefined,
  symbol = 'USDT',
  precision = 4,
) {
  return `${formatAssetNumber(value, precision)} ${symbol}`;
}

export function estimateUsdtValue(item: AssetAccountBalance) {
  if (item.symbol.toUpperCase() !== 'USDT') return null;
  return (item.available ?? 0) + (item.frozen ?? 0);
}

export async function fetchAssetAccountBalances(): Promise<AssetAccountBalance[]> {
  const payload = await apiClient.get<unknown>('/asset/account-balances');
  return readRows(payload, ['items', 'data']).map(row => {
    const record = isRecord(row) ? row : {};
    return {
      symbol: readString(record, ['symbol', 'coin_symbol'], 'USDT').toUpperCase(),
      accountKey: readString(
        record,
        ['account_key', 'accountKey', 'account_type', 'chain_key'],
        'funding',
      ).toLowerCase(),
      available: readNumber(record, ['available', 'available_amount']),
      frozen: readNumber(record, ['frozen', 'frozen_amount']),
    };
  });
}

export async function fetchAssetBalanceLogs(
  page = 1,
  pageSize = 20,
  params: {bizType?: string; coinSymbol?: string; chainKey?: string} = {},
): Promise<AssetBalanceLogResponse> {
  const payload = await apiClient.get<unknown>(
    withQuery('/asset/my/balance-logs', {
      page,
      page_size: pageSize,
      biz_type: params.bizType,
      coin_symbol: params.coinSymbol,
      chain_key: params.chainKey,
    }),
  );
  const root = isRecord(payload) ? payload : {};
  return {
    items: readRows(payload, ['items', 'data']).map((row, index) => {
      const record = isRecord(row) ? row : {};
      return {
        id: readString(record, ['id'], `${index}`),
        createdAt: readString(record, ['created_at', 'createdAt']) || null,
        bizType: readString(record, ['biz_type', 'bizType', 'raw_biz_type'], '--'),
        coinSymbol: readString(record, ['coin_symbol', 'coinSymbol'], '--'),
        accountKey: readString(record, ['chain_key', 'account_key', 'accountKey'], '--'),
        changeAmount: readString(record, ['change_amount', 'changeAmount'], '--'),
        afterAvailable: readString(record, ['after_available', 'afterAvailable'], '--'),
        remark: readString(record, ['remark'], ''),
      };
    }),
    page: readNumber(root, ['page']) ?? page,
    pageSize: readNumber(root, ['page_size', 'pageSize']) ?? pageSize,
    total: readNumber(root, ['total']) ?? 0,
  };
}

export async function fetchAssetInviteOverview(): Promise<AssetInviteOverview> {
  const payload = await apiClient.get<unknown>('/user/invite/overview');
  const root = isRecord(payload) ? payload : {};
  const summary = isRecord(root.summary) ? root.summary : {};
  return {
    inviteCode: readString(root, ['invite_code', 'inviteCode']) || null,
    invitedCount: readNumber(summary, ['invited_count', 'invitedCount']) ?? 0,
    totalReward: readString(summary, ['total_commission_rcb', 'totalCommissionRcb'], '0'),
    pendingReward: readString(
      summary,
      ['pending_commission_rcb', 'pendingCommissionRcb'],
      '0',
    ),
    paidReward: readString(summary, ['paid_commission_rcb', 'paidCommissionRcb'], '0'),
    rewardAsset: 'RCB',
  };
}

export async function fetchAssetBdOverview(): Promise<AssetBdOverview> {
  const payload = await apiClient.get<unknown>('/bd/my/team?page=1&page_size=5');
  const root = isRecord(payload) ? payload : {};
  const account = isRecord(root.account) ? root.account : {};
  const summary = isRecord(root.summary) ? root.summary : {};
  return {
    isBd: root.is_bd === true || root.isBd === true,
    bdLevel: readString(account, ['bd_level', 'bdLevel'], '--'),
    teamCount: readNumber(summary, ['bound_user_count', 'boundUserCount']) ?? 0,
    totalCommission: readString(summary, ['total_commission', 'totalCommission'], '0'),
    pendingCommission: readString(summary, ['pending_commission', 'pendingCommission'], '0'),
    paidCommission: readString(summary, ['paid_commission', 'paidCommission'], '0'),
    settlementAsset: readString(
      summary,
      ['settlement_asset_symbol', 'settlementAssetSymbol'],
      'USDT',
    ),
  };
}

function normalizeAssetOption(row: unknown): AssetChainOption {
  const record = isRecord(row) ? row : {};
  return {
    coinSymbol: readString(record, ['coin_symbol', 'coinSymbol', 'symbol']).toUpperCase(),
    coinName: readString(record, ['coin_name', 'coinName', 'name']) || undefined,
    displayPrecision: readNumber(record, ['display_precision', 'displayPrecision', 'precision']),
    chainKey: readString(record, ['chain_key', 'chainKey', 'network', 'network_code']).toLowerCase(),
    chainName: readString(record, ['chain_name', 'chainName', 'network_name']) || undefined,
    chainId: readString(record, ['chain_id', 'chainId']) || null,
    contractAddress: readString(record, ['contract_address', 'contractAddress']) || null,
    decimals: readNumber(record, ['decimals']),
    minDeposit: readString(record, ['min_deposit', 'minDeposit']),
    minWithdraw: readString(record, ['min_withdraw', 'minWithdraw']),
    withdrawFee: readString(record, ['withdraw_fee', 'withdrawFee']),
    confirmations: readNumber(record, ['confirmations', 'confirm_required', 'confirmRequired']),
    depositEnabled: readBoolean(record, ['deposit_enabled', 'depositEnabled']),
    withdrawEnabled: readBoolean(record, ['withdraw_enabled', 'withdrawEnabled']),
    enabled: readBoolean(record, ['enabled']),
    assetEnabled: readBoolean(record, ['asset_enabled', 'assetEnabled']),
    chainEnabled: readBoolean(record, ['chain_enabled', 'chainEnabled']),
    assetChainEnabled: readBoolean(record, ['asset_chain_enabled', 'assetChainEnabled']),
    depositSortOrder: readNumber(record, ['deposit_sort_order', 'depositSortOrder']) ?? undefined,
    withdrawSortOrder: readNumber(record, ['withdraw_sort_order', 'withdrawSortOrder']) ?? undefined,
    depositDefaultEnabled: readBoolean(record, [
      'deposit_default_enabled',
      'depositDefaultEnabled',
    ]),
    withdrawDefaultEnabled: readBoolean(record, [
      'withdraw_default_enabled',
      'withdrawDefaultEnabled',
    ]),
    memoRequired: readBoolean(record, ['memo_required', 'memoRequired', 'tag_required']),
    memoLabel: readString(record, ['memo_label', 'memoLabel', 'tag_label']) || null,
    riskTip: readString(record, ['risk_tip', 'riskTip', 'withdraw_risk_tip']) || null,
  };
}

function normalizeOptionsResponse(payload: unknown): AssetOptionsResponse {
  const root = isRecord(payload) ? payload : {};
  return {
    items: readRows(payload, ['items', 'data'])
      .map(normalizeAssetOption)
      .filter(item => item.coinSymbol && item.chainKey),
    defaultAssetSymbol:
      readString(root, ['default_asset_symbol', 'defaultAssetSymbol']) || null,
  };
}

export async function fetchDepositOptions(): Promise<AssetOptionsResponse> {
  return normalizeOptionsResponse(
    await apiClient.get<unknown>('/asset/deposit/options'),
  );
}

export async function fetchWithdrawOptions(): Promise<AssetOptionsResponse> {
  return normalizeOptionsResponse(
    await apiClient.get<unknown>('/asset/withdraw/options'),
  );
}

export async function fetchDepositAddress(params: {
  symbol: string;
  network: string;
}): Promise<DepositAddress> {
  const payload = await apiClient.get<unknown>(
    withQuery('/asset/deposit/address', {
      symbol: params.symbol.trim().toUpperCase(),
      network: params.network.trim().toLowerCase(),
    }),
  );
  const root = isRecord(payload) ? payload : {};
  return {
    symbol: readString(root, ['symbol', 'coin_symbol'], params.symbol).toUpperCase(),
    network: readString(root, ['network', 'chain_key', 'network_code'], params.network),
    chainId: readNumber(root, ['chain_id', 'chainId']),
    address: readString(root, ['address']),
    memo: readString(root, ['memo', 'tag']) || null,
    contractAddress: readString(root, ['contract_address', 'contractAddress']) || null,
    decimals: readNumber(root, ['decimals']),
    confirmRequired: readNumber(root, ['confirm_required', 'confirmRequired']),
    depositEnabled: readBoolean(root, ['deposit_enabled', 'depositEnabled']),
    withdrawEnabled: readBoolean(root, ['withdraw_enabled', 'withdrawEnabled']),
    minDeposit: readString(root, ['min_deposit', 'minDeposit']),
    notice: readStringList(root, ['notice', 'notices', 'tips']),
  };
}

export async function fetchWithdrawFee(params: {
  symbol: string;
  network: string;
  amount: string;
  toAddress?: string;
}): Promise<WithdrawFeeEstimate> {
  const payload = await apiClient.get<unknown>(
    withQuery('/asset/withdraw/fee', {
      symbol: params.symbol.trim().toUpperCase(),
      network: params.network.trim().toLowerCase(),
      amount: params.amount,
      to_address: params.toAddress,
    }),
  );
  const root = isRecord(payload) ? payload : {};
  return {
    fee: readString(root, ['fee'], '0'),
    feeCoin: readString(root, ['fee_coin', 'feeCoin', 'fee_currency']),
    feeCurrency: readString(root, ['fee_currency', 'feeCurrency']),
    receiveAmount: readString(root, ['receive_amount', 'receiveAmount']),
    netAmount: readString(root, ['net_amount', 'netAmount']),
    totalDeductAmount: readString(root, ['total_deduct_amount', 'totalDeductAmount']),
    totalFeeUsdt: readString(root, ['total_fee_usdt', 'totalFeeUsdt']),
    totalDebit: readString(root, ['total_debit', 'totalDebit']),
    feeSource: readString(root, ['fee_source', 'feeSource']),
    fallbackReason: readString(root, ['fallback_reason', 'fallbackReason']) || null,
  };
}

export async function createWithdrawDraft(params: {
  symbol: string;
  network: string;
  toAddress: string;
  amount: string;
}): Promise<WithdrawCreateResponse> {
  const payload = await apiClient.post<unknown>('/asset/withdraw/create', {
    symbol: params.symbol.trim().toUpperCase(),
    network: params.network.trim().toLowerCase(),
    to_address: params.toAddress.trim(),
    amount: params.amount.trim(),
  });
  const root = isRecord(payload) ? payload : {};
  return {
    withdrawId: Number(readNumber(root, ['withdraw_id', 'withdrawId']) ?? 0),
    symbol: readString(root, ['symbol'], params.symbol).toUpperCase(),
    chainKey: readString(root, ['chain_key', 'chainKey', 'network'], params.network),
    toAddress: readString(root, ['to_address', 'toAddress'], params.toAddress),
    amount: readString(root, ['amount'], params.amount),
    status: readString(root, ['status'], 'VERIFYING'),
    needManualReview: readBoolean(root, ['need_manual_review', 'needManualReview']),
    riskReason: readString(root, ['risk_reason', 'riskReason']),
    feeEstimate: readString(root, ['fee_estimate', 'feeEstimate']),
    feeCoin: readString(root, ['fee_coin', 'feeCoin']),
    receiveAmount: readString(root, ['receive_amount', 'receiveAmount']),
    totalDebitEstimate: readString(root, ['total_debit_estimate', 'totalDebitEstimate']),
  };
}

export async function sendWithdrawCode(withdrawId: number): Promise<WithdrawCodeResponse> {
  const payload = await apiClient.post<unknown>('/asset/withdraw/send_code', {
    withdraw_id: withdrawId,
  });
  const root = isRecord(payload) ? payload : {};
  return {
    withdrawId: Number(readNumber(root, ['withdraw_id', 'withdrawId']) ?? withdrawId),
    status: readString(root, ['status'], 'VERIFYING'),
    hint: readString(root, ['hint']),
  };
}

export async function confirmWithdraw(params: {
  withdrawId: number;
  code: string;
}): Promise<WithdrawConfirmResponse> {
  const payload = await apiClient.post<unknown>('/asset/withdraw/confirm', {
    withdraw_id: params.withdrawId,
    code: params.code.trim(),
  });
  const root = isRecord(payload) ? payload : {};
  return {
    withdrawId: Number(readNumber(root, ['withdraw_id', 'withdrawId']) ?? params.withdrawId),
    symbol: readString(root, ['symbol']).toUpperCase(),
    chainKey: readString(root, ['chain_key', 'chainKey']),
    amount: readString(root, ['amount']),
    status: readString(root, ['status'], 'FROZEN'),
    feeFinal: readString(root, ['fee_final', 'feeFinal']),
    feeCoin: readString(root, ['fee_coin', 'feeCoin']),
    receiveAmount: readString(root, ['receive_amount', 'receiveAmount']),
    totalDebitFinal: readString(root, ['total_debit_final', 'totalDebitFinal']),
  };
}

export async function submitFundingSpotTransfer(params: {
  fromAccount: 'funding' | 'spot';
  toAccount: 'funding' | 'spot';
  symbol: string;
  amount: string;
}): Promise<AccountTransferResponse> {
  return apiClient.post<AccountTransferResponse>('/account/transfer', {
    from_account: params.fromAccount,
    to_account: params.toAccount,
    symbol: params.symbol.trim().toUpperCase(),
    amount: params.amount.trim(),
  });
}

export async function submitContractTransfer(params: {
  direction: 'in' | 'out';
  amount: string;
  account?: 'funding';
}): Promise<unknown> {
  return apiClient.post<unknown>(
    params.direction === 'in'
      ? '/contract/account/transfer-in'
      : '/contract/account/transfer-out',
    {
      amount: params.amount.trim(),
      account: params.account ?? 'funding',
    },
  );
}
