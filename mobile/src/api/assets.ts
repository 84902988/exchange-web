import { ApiClientError, apiClient, type ApiRequestOptions } from './client';
import { normalizeNonNegativeDecimalText } from '../utils/decimalText';

export type AssetAccountKey = 'funding' | 'spot' | 'contract' | string;
const VALUATION_ACCOUNT_KEYS = new Set(['funding', 'spot', 'contract']);
const WITHDRAW_CREATE_STATUSES = new Set(['VERIFYING', 'REVIEWING']);
const DECIMAL_TEXT_PATTERN = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SIGNED_DECIMAL_TEXT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export type AssetAccountBalance = {
  symbol: string;
  accountKey: AssetAccountKey;
  available: number | null;
  frozen: number | null;
  availableText?: string;
  frozenText?: string;
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
  depositEnabled: boolean;
  withdrawEnabled?: boolean;
  minDeposit: string;
  notice: string[];
};

export type WithdrawFeeEstimate = {
  symbol: string;
  chainKey: string;
  amount: string;
  fee: string;
  feeCoin: string;
  feeCurrency: string;
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
  needManualReview: boolean;
  riskReason?: string;
  feeEstimate: string;
  feeCoin: string;
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
  feeFinal: string;
  feeCoin: string;
  receiveAmount?: string;
  totalDebitFinal?: string;
};

export type AssetTransferAccountKey = 'funding' | 'spot' | 'contract';

export type AccountTransferResponse = {
  record: {
    id: number;
    transferNo: string;
    symbol: string;
    fromAccount: 'funding' | 'spot';
    toAccount: 'funding' | 'spot';
    amount: string;
    status: 'SUCCESS';
    createdAt: string;
  };
};

export type ContractTransferResponse = {
  transferNo: string;
  direction: 'IN' | 'OUT';
  marginAsset: 'USDT';
  amount: string;
  fundingAvailableBefore: string;
  fundingAvailableAfter: string;
  contractAvailableBefore: string;
  contractAvailableAfter: string;
};

export type AssetInviteOverview = {
  inviteCode: string | null;
  inviteLink: string | null;
  commissionPercent: string;
  invitedCount: number;
  totalReward: string;
  pendingReward: string;
  paidReward: string;
  rewardAsset: 'RCB';
  recentRecords: AssetInviteCommissionRecord[];
};

export type AssetInviteCommissionStatus = 'PENDING' | 'PAID' | 'FAILED';

export type AssetInviteCommissionRecord = {
  id: number;
  inviteeUserId: number;
  feeCoinSymbol: string;
  feeAmount: string;
  feeUsdtValue: string;
  commissionRate: string;
  commissionRcbAmount: string;
  status: AssetInviteCommissionStatus;
  createdAt: string;
  paidAt: string | null;
};

export type AssetBdOverview =
  | { isBd: false; accountStatus: string | null }
  | {
      isBd: true;
      bdLevel: string;
      inviteCode: string;
      teamCount: number;
      totalCommission: string;
      pendingCommission: string;
      paidCommission: string;
    };

export type AssetBdApplicationStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELED'
  | string;

export type AssetBdApplication = {
  id: number;
  applyLevel: string;
  depositCoinSymbol: string;
  depositAmount: string;
  status: AssetBdApplicationStatus;
  remark: string | null;
  adminRemark: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  reviewedAt: string | null;
};

export type CreateAssetBdApplicationInput = {
  applyLevel: 'BD1' | 'BD2' | 'BD3';
  depositCoinSymbol: 'USDT' | 'RCB';
  depositAmount: string;
  remark?: string;
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

function readString(
  row: Record<string, unknown>,
  keys: string[],
  fallback = '',
) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value);
  }
  return fallback;
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = row[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (
      typeof raw === 'string' &&
      SIGNED_DECIMAL_TEXT_PATTERN.test(raw.trim())
    ) {
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
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

function invalidAssetPayload(message: string, code: string): never {
  throw new ApiClientError(message, code);
}

function requirePayloadRecord(payload: unknown, code: string, label: string) {
  if (!isRecord(payload) || Array.isArray(payload)) {
    invalidAssetPayload(`${label}响应格式无效，请稍后重试`, code);
  }
  return payload;
}

function readRequiredStringField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readString(row, keys);
  if (!value) {
    invalidAssetPayload(`${label}缺失，请稍后重试`, code);
  }
  return value;
}

function readRequiredNonNegativeDecimalField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label);
  const numeric = Number(value);
  if (
    !DECIMAL_TEXT_PATTERN.test(value) ||
    !Number.isFinite(numeric) ||
    numeric < 0
  ) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readRequiredSignedDecimalField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label);
  if (
    !SIGNED_DECIMAL_TEXT_PATTERN.test(value) ||
    !Number.isFinite(Number(value))
  ) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readRequiredPositiveDecimalField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredNonNegativeDecimalField(row, keys, code, label);
  if (Number(value) <= 0) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readRequiredIntegerField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
  minimum: number,
) {
  for (const key of keys) {
    const raw = row[key];
    if (
      typeof raw === 'number' &&
      Number.isSafeInteger(raw) &&
      raw >= minimum
    ) {
      return raw;
    }
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value >= minimum) {
        return value;
      }
    }
  }
  invalidAssetPayload(`${label}无效，请稍后重试`, code);
}

function readRequiredBooleanField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  for (const key of keys) {
    if (typeof row[key] === 'boolean') {
      return row[key] as boolean;
    }
  }
  invalidAssetPayload(`${label}缺失，请稍后重试`, code);
}

function readRequiredAssetSymbolField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value)) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readRequiredChainKeyField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function normalizeDecimalText(value: string) {
  const normalized = value.replace(/^\+/, '');
  const [integerPart, fractionPart = ''] = normalized.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionPart.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function requireMatchingField(
  actual: string,
  expected: string,
  code: string,
  label: string,
) {
  if (actual !== expected) {
    invalidAssetPayload(`${label}与请求不一致，请稍后重试`, code);
  }
}

function readRequiredSafeAddressField(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label);
  if (
    value.length < 16 ||
    value.length > 256 ||
    !/^[A-Za-z0-9:._-]+$/.test(value)
  ) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readRequiredTransferReference(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label);
  if (
    value.length < 8 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readRequiredTransferAccount(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  const value = readRequiredStringField(row, keys, code, label).toLowerCase();
  if (value !== 'funding' && value !== 'spot') {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

function readCommissionDisplay(
  summary: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  let rawMap: Record<string, unknown> | null = null;
  for (const key of keys) {
    const value = summary[key];
    if (isRecord(value) && !Array.isArray(value)) {
      rawMap = value;
      break;
    }
  }
  if (!rawMap) {
    invalidAssetPayload(`${label}缺失，请稍后重试`, code);
  }

  const items = Object.entries(rawMap)
    .map(([rawSymbol, rawAmount]) => {
      const symbol = rawSymbol.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) {
        invalidAssetPayload(`${label}币种无效，请稍后重试`, code);
      }
      const amount = readRequiredNonNegativeDecimalField(
        { amount: rawAmount },
        ['amount'],
        code,
        `${label}${symbol}金额`,
      );
      return { amount, symbol };
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  if (items.length === 0) {
    invalidAssetPayload(`${label}为空，请稍后重试`, code);
  }
  return items.map(item => `${item.amount} ${item.symbol}`).join(' / ');
}

function readRequiredRowsField(
  root: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  for (const key of keys) {
    if (Array.isArray(root[key])) {
      return root[key] as unknown[];
    }
  }
  invalidAssetPayload(`${label}列表缺失，请稍后重试`, code);
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

function withQuery(
  path: string,
  params: Record<string, string | number | undefined | null>,
) {
  const query = Object.entries(params)
    .filter(
      ([, value]) =>
        value !== undefined && value !== null && String(value) !== '',
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&');
  return query ? `${path}?${query}` : path;
}

export function formatAssetNumber(
  value: number | null | undefined,
  precision = 4,
) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '--';
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

export function normalizeAssetAccountBalances(
  payload: unknown,
): AssetAccountBalance[] {
  const root = isRecord(payload) ? payload : null;
  const hasRowsContainer =
    Array.isArray(payload) ||
    Array.isArray(root?.items) ||
    Array.isArray(root?.data);
  if (!hasRowsContainer) {
    throw new ApiClientError(
      '资产余额响应格式无效，请稍后重试',
      'INVALID_ASSET_BALANCE_PAYLOAD',
    );
  }

  return readRows(payload, ['items', 'data']).map((row, index) => {
    if (!isRecord(row)) {
      throw new ApiClientError(
        `资产余额第 ${index + 1} 行格式无效`,
        'INVALID_ASSET_BALANCE_PAYLOAD',
      );
    }

    const symbol = readString(row, ['symbol', 'coin_symbol']).toUpperCase();
    const accountKey = readString(row, [
      'account_key',
      'accountKey',
      'account_type',
      'chain_key',
    ]).toLowerCase();
    const availableText = readRequiredNonNegativeDecimalField(
      row,
      ['available', 'available_amount'],
      'INVALID_ASSET_BALANCE_PAYLOAD',
      `资产余额第 ${index + 1} 行可用余额`,
    );
    const frozenText = readRequiredNonNegativeDecimalField(
      row,
      ['frozen', 'frozen_amount'],
      'INVALID_ASSET_BALANCE_PAYLOAD',
      `资产余额第 ${index + 1} 行冻结余额`,
    );
    const available = Number(availableText);
    const frozen = Number(frozenText);
    if (
      !/^[A-Z0-9._-]{1,32}$/.test(symbol) ||
      !/^[a-z0-9_-]{1,32}$/.test(accountKey) ||
      !VALUATION_ACCOUNT_KEYS.has(accountKey) ||
      !Number.isFinite(available) ||
      !Number.isFinite(frozen)
    ) {
      throw new ApiClientError(
        `资产余额第 ${index + 1} 行字段无效`,
        'INVALID_ASSET_BALANCE_PAYLOAD',
      );
    }

    return {
      symbol,
      accountKey,
      available,
      frozen,
      availableText,
      frozenText,
    };
  });
}

export async function fetchAssetAccountBalances(
  options?: ApiRequestOptions,
): Promise<AssetAccountBalance[]> {
  const payload = await apiClient.get<unknown>(
    '/asset/account-balances',
    options,
  );
  return normalizeAssetAccountBalances(payload);
}

export function normalizeAssetBalanceLogsResponse(
  payload: unknown,
): AssetBalanceLogResponse {
  const code = 'INVALID_ASSET_BALANCE_LOG_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '资产流水');
  const rows = readRequiredRowsField(root, ['items', 'data'], code, '资产流水');
  return {
    items: rows.map((row, index) => {
      const record = requirePayloadRecord(
        row,
        code,
        `资产流水第 ${index + 1} 行`,
      );
      return {
        id: String(
          readRequiredIntegerField(
            record,
            ['id'],
            code,
            `资产流水第 ${index + 1} 行单号`,
            1,
          ),
        ),
        createdAt: readString(record, ['created_at', 'createdAt']) || null,
        bizType: readRequiredStringField(
          record,
          ['biz_type', 'bizType', 'raw_biz_type'],
          code,
          `资产流水第 ${index + 1} 行类型`,
        ),
        coinSymbol: readRequiredAssetSymbolField(
          record,
          ['coin_symbol', 'coinSymbol'],
          code,
          `资产流水第 ${index + 1} 行币种`,
        ),
        accountKey: readRequiredChainKeyField(
          record,
          ['chain_key', 'account_key', 'accountKey'],
          code,
          `资产流水第 ${index + 1} 行账户`,
        ),
        changeAmount: readRequiredSignedDecimalField(
          record,
          ['change_amount', 'changeAmount'],
          code,
          `资产流水第 ${index + 1} 行变动金额`,
        ),
        afterAvailable: readRequiredSignedDecimalField(
          record,
          ['after_available', 'afterAvailable'],
          code,
          `资产流水第 ${index + 1} 行余额`,
        ),
        remark: readString(record, ['remark'], ''),
      };
    }),
    page: readRequiredIntegerField(root, ['page'], code, '资产流水页码', 1),
    pageSize: readRequiredIntegerField(
      root,
      ['page_size', 'pageSize'],
      code,
      '资产流水分页大小',
      1,
    ),
    total: readRequiredIntegerField(root, ['total'], code, '资产流水总数', 0),
  };
}

export async function fetchAssetBalanceLogs(
  page = 1,
  pageSize = 20,
  params: { bizType?: string; coinSymbol?: string; chainKey?: string } = {},
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
  return normalizeAssetBalanceLogsResponse(payload);
}

export function normalizeAssetInviteOverview(
  payload: unknown,
): AssetInviteOverview {
  const code = 'INVALID_ASSET_INVITE_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '邀请概览');
  const summary = requirePayloadRecord(root.summary, code, '邀请概览汇总');
  const commissionPercent = readRequiredInvitePercent(
    root,
    ['commission_percent', 'commissionPercent'],
    code,
  );
  const summaryCommissionPercent = readRequiredInvitePercent(
    summary,
    ['commission_percent', 'commissionPercent'],
    code,
  );
  if (Number(commissionPercent) !== Number(summaryCommissionPercent)) {
    invalidAssetPayload('邀请返佣比例不一致，请稍后重试', code);
  }
  const recentRecords = normalizeAssetInviteCommissionRecords(
    root.recent_records ?? root.recentRecords,
    code,
  );
  return {
    inviteCode: readString(root, ['invite_code', 'inviteCode']) || null,
    inviteLink: readString(root, ['invite_link', 'inviteLink']) || null,
    commissionPercent,
    invitedCount: readRequiredIntegerField(
      summary,
      ['invited_count', 'invitedCount'],
      code,
      '邀请人数',
      0,
    ),
    totalReward: readRequiredNonNegativeDecimalField(
      summary,
      ['total_commission_rcb', 'totalCommissionRcb'],
      code,
      '累计邀请奖励',
    ),
    pendingReward: readRequiredNonNegativeDecimalField(
      summary,
      ['pending_commission_rcb', 'pendingCommissionRcb'],
      code,
      '待发邀请奖励',
    ),
    paidReward: readRequiredNonNegativeDecimalField(
      summary,
      ['paid_commission_rcb', 'paidCommissionRcb'],
      code,
      '已发邀请奖励',
    ),
    rewardAsset: 'RCB',
    recentRecords,
  };
}

function readRequiredInvitePercent(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
) {
  const value = readRequiredNonNegativeDecimalField(
    row,
    keys,
    code,
    '邀请返佣比例',
  );
  if (Number(value) > 100) {
    invalidAssetPayload('邀请返佣比例无效，请稍后重试', code);
  }
  return value;
}

function normalizeAssetInviteCommissionRecords(
  value: unknown,
  code: string,
): AssetInviteCommissionRecord[] {
  if (!Array.isArray(value) || value.length > 10) {
    invalidAssetPayload('最近邀请奖励记录无效，请稍后重试', code);
  }
  const seen = new Set<number>();
  return value.map(item => {
    const row = requirePayloadRecord(item, code, '邀请奖励记录');
    const id = readRequiredIntegerField(
      row,
      ['id'],
      code,
      '邀请奖励记录编号',
      1,
    );
    if (seen.has(id)) {
      invalidAssetPayload('邀请奖励记录重复，请稍后重试', code);
    }
    seen.add(id);
    const status = readRequiredInviteCommissionStatus(row, code);
    const paidAt = readNullableInviteTimestamp(
      row.paid_at ?? row.paidAt,
      code,
      '邀请奖励发放时间',
    );
    if ((status === 'PAID') !== Boolean(paidAt)) {
      invalidAssetPayload('邀请奖励状态与发放时间不一致，请稍后重试', code);
    }
    return {
      id,
      inviteeUserId: readRequiredIntegerField(
        row,
        ['invitee_user_id', 'inviteeUserId'],
        code,
        '受邀用户编号',
        1,
      ),
      feeCoinSymbol: readRequiredAssetSymbolField(
        row,
        ['fee_coin_symbol', 'feeCoinSymbol'],
        code,
        '手续费币种',
      ),
      feeAmount: readRequiredNonNegativeDecimalField(
        row,
        ['fee_amount', 'feeAmount'],
        code,
        '手续费数量',
      ),
      feeUsdtValue: readRequiredNonNegativeDecimalField(
        row,
        ['fee_usdt_value', 'feeUsdtValue'],
        code,
        '手续费 USDT 价值',
      ),
      commissionRate: readRequiredNonNegativeDecimalField(
        row,
        ['commission_rate', 'commissionRate'],
        code,
        '邀请返佣费率',
      ),
      commissionRcbAmount: readRequiredNonNegativeDecimalField(
        row,
        ['commission_rcb_amount', 'commissionRcbAmount'],
        code,
        '邀请奖励数量',
      ),
      status,
      createdAt: readRequiredInviteTimestamp(
        row,
        ['created_at', 'createdAt'],
        code,
        '邀请奖励创建时间',
      ),
      paidAt,
    };
  });
}

function readRequiredInviteCommissionStatus(
  row: Record<string, unknown>,
  code: string,
): AssetInviteCommissionStatus {
  const value = readRequiredStringField(
    row,
    ['status'],
    code,
    '邀请奖励状态',
  ).toUpperCase();
  if (!['PENDING', 'PAID', 'FAILED'].includes(value)) {
    invalidAssetPayload('邀请奖励状态无效，请稍后重试', code);
  }
  return value as AssetInviteCommissionStatus;
}

function readRequiredInviteTimestamp(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  label: string,
) {
  return normalizeInviteTimestamp(
    readRequiredStringField(row, keys, code, label),
    code,
    label,
  );
}

function readNullableInviteTimestamp(
  value: unknown,
  code: string,
  label: string,
) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return normalizeInviteTimestamp(value.trim(), code, label);
}

function normalizeInviteTimestamp(value: string, code: string, label: string) {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value}Z`;
  if (Number.isNaN(new Date(normalized).getTime())) {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value;
}

export async function fetchAssetInviteOverview(): Promise<AssetInviteOverview> {
  return normalizeAssetInviteOverview(
    await apiClient.get<unknown>('/user/invite/overview'),
  );
}

export function normalizeAssetBdOverview(payload: unknown): AssetBdOverview {
  const code = 'INVALID_ASSET_BD_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '代理概览');
  const isBd = readRequiredBooleanField(
    root,
    ['is_bd', 'isBd'],
    code,
    '代理身份',
  );
  if (!isBd) {
    if (root.account === null || root.account === undefined) {
      return { isBd: false, accountStatus: null };
    }
    const account = requirePayloadRecord(root.account, code, '代理账户');
    return {
      isBd: false,
      accountStatus: readRequiredStringField(
        account,
        ['status'],
        code,
        '代理账户状态',
      ).toUpperCase(),
    };
  }

  const account = requirePayloadRecord(root.account, code, '代理账户');
  const summary = requirePayloadRecord(root.summary, code, '代理概览汇总');
  return {
    isBd: true,
    bdLevel: readRequiredStringField(
      account,
      ['bd_level', 'bdLevel'],
      code,
      '代理等级',
    ),
    inviteCode: readRequiredStringField(
      account,
      ['invite_code', 'inviteCode'],
      code,
      '代理邀请码',
    ),
    teamCount: readRequiredIntegerField(
      summary,
      ['bound_user_count', 'boundUserCount'],
      code,
      '代理团队人数',
      0,
    ),
    totalCommission: readCommissionDisplay(
      summary,
      ['total_commission_by_asset', 'totalCommissionByAsset'],
      code,
      '累计佣金',
    ),
    pendingCommission: readCommissionDisplay(
      summary,
      ['pending_commission_by_asset', 'pendingCommissionByAsset'],
      code,
      '待发佣金',
    ),
    paidCommission: readCommissionDisplay(
      summary,
      ['paid_commission_by_asset', 'paidCommissionByAsset'],
      code,
      '已发佣金',
    ),
  };
}

export async function fetchAssetBdOverview(): Promise<AssetBdOverview> {
  return normalizeAssetBdOverview(
    await apiClient.get<unknown>('/bd/my/team?page=1&page_size=5'),
  );
}

export function normalizeAssetBdApplication(
  payload: unknown,
): AssetBdApplication | null {
  if (payload === null || payload === undefined) return null;

  const code = 'INVALID_ASSET_BD_APPLICATION_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '代理申请');
  const applyLevel = readRequiredStringField(
    root,
    ['apply_level', 'applyLevel'],
    code,
    '代理申请等级',
  ).toUpperCase();
  if (!['BD1', 'BD2', 'BD3'].includes(applyLevel)) {
    invalidAssetPayload('代理申请等级无效，请稍后重试', code);
  }

  const status = readRequiredStringField(
    root,
    ['status'],
    code,
    '代理申请状态',
  ).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(status)) {
    invalidAssetPayload('代理申请状态无效，请稍后重试', code);
  }

  return {
    id: readRequiredIntegerField(root, ['id'], code, '代理申请编号', 1),
    applyLevel,
    depositCoinSymbol: readRequiredAssetSymbolField(
      root,
      ['deposit_coin_symbol', 'depositCoinSymbol'],
      code,
      '代理申请保证金币种',
    ),
    depositAmount: readRequiredNonNegativeDecimalField(
      root,
      ['deposit_amount', 'depositAmount'],
      code,
      '代理申请保证金',
    ),
    status,
    remark: readNullableBdApplicationText(root.remark, code, '代理申请说明'),
    adminRemark: readNullableBdApplicationText(
      root.admin_remark ?? root.adminRemark,
      code,
      '代理审核备注',
    ),
    createdAt: readNullableBdApplicationText(
      root.created_at ?? root.createdAt,
      code,
      '代理申请时间',
    ),
    updatedAt: readNullableBdApplicationText(
      root.updated_at ?? root.updatedAt,
      code,
      '代理申请更新时间',
    ),
    reviewedAt: readNullableBdApplicationText(
      root.reviewed_at ?? root.reviewedAt,
      code,
      '代理审核时间',
    ),
  };
}

export async function fetchAssetBdApplication(): Promise<AssetBdApplication | null> {
  return normalizeAssetBdApplication(
    await apiClient.get<unknown>('/bd/my/application'),
  );
}

export async function createAssetBdApplication(
  input: CreateAssetBdApplicationInput,
): Promise<AssetBdApplication> {
  if (!['BD1', 'BD2', 'BD3'].includes(input.applyLevel)) {
    throw new ApiClientError(
      '请选择有效的代理等级',
      'INVALID_ASSET_BD_APPLICATION_INPUT',
    );
  }
  if (!['USDT', 'RCB'].includes(input.depositCoinSymbol)) {
    throw new ApiClientError(
      '请选择有效的保证金币种',
      'INVALID_ASSET_BD_APPLICATION_INPUT',
    );
  }
  const depositAmount = normalizeNonNegativeDecimalText(input.depositAmount);
  if (depositAmount === null) {
    throw new ApiClientError(
      '请输入有效的预计保证金金额',
      'INVALID_ASSET_BD_APPLICATION_INPUT',
    );
  }
  const remark = String(input.remark || '').trim();
  if (remark.length > 255) {
    throw new ApiClientError(
      '申请说明不能超过 255 个字符',
      'INVALID_ASSET_BD_APPLICATION_INPUT',
    );
  }

  const result = normalizeAssetBdApplication(
    await apiClient.post<unknown>(
      '/bd/my/application',
      {
        apply_level: input.applyLevel,
        deposit_coin_symbol: input.depositCoinSymbol,
        deposit_amount: depositAmount,
        remark: remark || undefined,
      },
      { retry: 'none' },
    ),
  );
  if (!result) {
    throw new ApiClientError(
      '代理申请响应为空，请刷新后确认申请状态',
      'INVALID_ASSET_BD_APPLICATION_PAYLOAD',
    );
  }
  return result;
}

function readNullableBdApplicationText(
  value: unknown,
  code: string,
  label: string,
) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    invalidAssetPayload(`${label}无效，请稍后重试`, code);
  }
  return value.trim() || null;
}

function normalizeAssetOption(row: unknown, index: number): AssetChainOption {
  const code = 'INVALID_ASSET_OPTIONS_PAYLOAD';
  const record = requirePayloadRecord(row, code, `资产配置第 ${index + 1} 行`);
  return {
    coinSymbol: readRequiredAssetSymbolField(
      record,
      ['coin_symbol', 'coinSymbol', 'symbol'],
      code,
      `资产配置第 ${index + 1} 行币种`,
    ),
    coinName:
      readString(record, ['coin_name', 'coinName', 'name']) || undefined,
    displayPrecision: readNumber(record, [
      'display_precision',
      'displayPrecision',
      'precision',
    ]),
    chainKey: readRequiredChainKeyField(
      record,
      ['chain_key', 'chainKey', 'network', 'network_code'],
      code,
      `资产配置第 ${index + 1} 行网络`,
    ),
    chainName:
      readString(record, ['chain_name', 'chainName', 'network_name']) ||
      undefined,
    chainId: readString(record, ['chain_id', 'chainId']) || null,
    contractAddress:
      readString(record, ['contract_address', 'contractAddress']) || null,
    decimals: readNumber(record, ['decimals']),
    minDeposit: readRequiredNonNegativeDecimalField(
      record,
      ['min_deposit', 'minDeposit'],
      code,
      `资产配置第 ${index + 1} 行最小充值`,
    ),
    minWithdraw: readRequiredNonNegativeDecimalField(
      record,
      ['min_withdraw', 'minWithdraw'],
      code,
      `资产配置第 ${index + 1} 行最小提现`,
    ),
    withdrawFee: readRequiredNonNegativeDecimalField(
      record,
      ['withdraw_fee', 'withdrawFee'],
      code,
      `资产配置第 ${index + 1} 行提现手续费`,
    ),
    confirmations: readNumber(record, [
      'confirmations',
      'confirm_required',
      'confirmRequired',
    ]),
    depositEnabled: readRequiredBooleanField(
      record,
      ['deposit_enabled', 'depositEnabled'],
      code,
      `资产配置第 ${index + 1} 行充值开关`,
    ),
    withdrawEnabled: readRequiredBooleanField(
      record,
      ['withdraw_enabled', 'withdrawEnabled'],
      code,
      `资产配置第 ${index + 1} 行提现开关`,
    ),
    enabled: readRequiredBooleanField(
      record,
      ['enabled'],
      code,
      `资产配置第 ${index + 1} 行总开关`,
    ),
    assetEnabled: readRequiredBooleanField(
      record,
      ['asset_enabled', 'assetEnabled'],
      code,
      `资产配置第 ${index + 1} 行币种开关`,
    ),
    chainEnabled: readRequiredBooleanField(
      record,
      ['chain_enabled', 'chainEnabled'],
      code,
      `资产配置第 ${index + 1} 行网络开关`,
    ),
    assetChainEnabled: readRequiredBooleanField(
      record,
      ['asset_chain_enabled', 'assetChainEnabled'],
      code,
      `资产配置第 ${index + 1} 行币种网络开关`,
    ),
    depositSortOrder:
      readNumber(record, ['deposit_sort_order', 'depositSortOrder']) ??
      undefined,
    withdrawSortOrder:
      readNumber(record, ['withdraw_sort_order', 'withdrawSortOrder']) ??
      undefined,
    depositDefaultEnabled: readBoolean(record, [
      'deposit_default_enabled',
      'depositDefaultEnabled',
    ]),
    withdrawDefaultEnabled: readBoolean(record, [
      'withdraw_default_enabled',
      'withdrawDefaultEnabled',
    ]),
    memoRequired: readBoolean(record, [
      'memo_required',
      'memoRequired',
      'tag_required',
    ]),
    memoLabel:
      readString(record, ['memo_label', 'memoLabel', 'tag_label']) || null,
    riskTip:
      readString(record, ['risk_tip', 'riskTip', 'withdraw_risk_tip']) || null,
  };
}

export function normalizeAssetOptionsResponse(
  payload: unknown,
): AssetOptionsResponse {
  const code = 'INVALID_ASSET_OPTIONS_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '资产配置');
  const rows = readRequiredRowsField(root, ['items', 'data'], code, '资产配置');
  const items = rows.map(normalizeAssetOption);
  const defaultAssetSymbol = readString(root, [
    'default_asset_symbol',
    'defaultAssetSymbol',
  ]).toUpperCase();
  if (
    defaultAssetSymbol &&
    (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(defaultAssetSymbol) ||
      !items.some(item => item.coinSymbol === defaultAssetSymbol))
  ) {
    invalidAssetPayload('默认资产配置无效，请稍后重试', code);
  }
  return {
    items,
    defaultAssetSymbol: defaultAssetSymbol || null,
  };
}

export async function fetchDepositOptions(
  options?: ApiRequestOptions,
): Promise<AssetOptionsResponse> {
  return normalizeAssetOptionsResponse(
    await apiClient.get<unknown>('/asset/deposit/options', options),
  );
}

export async function fetchWithdrawOptions(
  options?: ApiRequestOptions,
): Promise<AssetOptionsResponse> {
  return normalizeAssetOptionsResponse(
    await apiClient.get<unknown>('/asset/withdraw/options', options),
  );
}

export function normalizeDepositAddress(
  payload: unknown,
  params: { symbol: string; network: string },
): DepositAddress {
  const code = 'INVALID_DEPOSIT_ADDRESS_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '充值地址');
  const symbol = readRequiredAssetSymbolField(
    root,
    ['symbol', 'coin_symbol'],
    code,
    '充值币种',
  );
  const network = readRequiredChainKeyField(
    root,
    ['network', 'chain_key', 'network_code'],
    code,
    '充值网络',
  );
  requireMatchingField(
    symbol,
    params.symbol.trim().toUpperCase(),
    code,
    '充值币种',
  );
  requireMatchingField(
    network,
    params.network.trim().toLowerCase(),
    code,
    '充值网络',
  );
  const depositEnabled = readRequiredBooleanField(
    root,
    ['deposit_enabled', 'depositEnabled'],
    code,
    '充值开关',
  );
  if (!depositEnabled) {
    invalidAssetPayload('充值网络当前不可用，请稍后重试', code);
  }

  return {
    symbol,
    network,
    chainId: readRequiredIntegerField(
      root,
      ['chain_id', 'chainId'],
      code,
      '充值网络 ID',
      0,
    ),
    address: readRequiredSafeAddressField(root, ['address'], code, '充值地址'),
    memo: readString(root, ['memo', 'tag']) || null,
    contractAddress:
      readString(root, ['contract_address', 'contractAddress']) || null,
    decimals: readRequiredIntegerField(
      root,
      ['decimals'],
      code,
      '充值币种精度',
      0,
    ),
    confirmRequired: readRequiredIntegerField(
      root,
      ['confirm_required', 'confirmRequired'],
      code,
      '充值确认数',
      0,
    ),
    depositEnabled,
    withdrawEnabled: readRequiredBooleanField(
      root,
      ['withdraw_enabled', 'withdrawEnabled'],
      code,
      '提现开关',
    ),
    minDeposit: readRequiredNonNegativeDecimalField(
      root,
      ['min_deposit', 'minDeposit'],
      code,
      '最小充值数量',
    ),
    notice: readStringList(root, ['notice', 'notices', 'tips']),
  };
}

export async function fetchDepositAddress(
  params: {
    symbol: string;
    network: string;
  },
  options?: ApiRequestOptions,
): Promise<DepositAddress> {
  const payload = await apiClient.get<unknown>(
    withQuery('/asset/deposit/address', {
      symbol: params.symbol.trim().toUpperCase(),
      network: params.network.trim().toLowerCase(),
    }),
    options,
  );
  return normalizeDepositAddress(payload, params);
}

export function normalizeWithdrawFeeEstimate(
  payload: unknown,
  expected?: { symbol: string; network: string; amount: string },
): WithdrawFeeEstimate {
  const code = 'INVALID_WITHDRAW_FEE_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '提现手续费');
  const symbol = readRequiredAssetSymbolField(
    root,
    ['symbol'],
    code,
    '提现币种',
  );
  const chainKey = readRequiredChainKeyField(
    root,
    ['chain_key', 'chainKey', 'network'],
    code,
    '提现网络',
  );
  const amount = readRequiredPositiveDecimalField(
    root,
    ['amount'],
    code,
    '提现数量',
  );
  const fee = readRequiredNonNegativeDecimalField(
    root,
    ['fee'],
    code,
    '提现手续费',
  );
  const feeCoin = readRequiredAssetSymbolField(
    root,
    ['fee_coin', 'feeCoin'],
    code,
    '手续费币种',
  );
  const feeCurrency = readRequiredAssetSymbolField(
    root,
    ['fee_currency', 'feeCurrency'],
    code,
    '手续费计价币种',
  );
  if (feeCurrency !== feeCoin) {
    invalidAssetPayload('手续费计价币种无效，请稍后重试', code);
  }
  if (expected) {
    requireMatchingField(
      symbol,
      expected.symbol.trim().toUpperCase(),
      code,
      '提现币种',
    );
    requireMatchingField(
      chainKey,
      expected.network.trim().toLowerCase(),
      code,
      '提现网络',
    );
    requireMatchingField(
      normalizeDecimalText(amount),
      normalizeDecimalText(expected.amount.trim()),
      code,
      '提现数量',
    );
  }
  return {
    symbol,
    chainKey,
    amount,
    fee,
    feeCoin,
    feeCurrency,
    receiveAmount: readString(root, ['receive_amount', 'receiveAmount']),
    netAmount: readString(root, ['net_amount', 'netAmount']),
    totalDeductAmount: readString(root, [
      'total_deduct_amount',
      'totalDeductAmount',
    ]),
    totalFeeUsdt: readString(root, ['total_fee_usdt', 'totalFeeUsdt']),
    totalDebit: readString(root, ['total_debit', 'totalDebit']),
    feeSource: readString(root, ['fee_source', 'feeSource']),
    fallbackReason:
      readString(root, ['fallback_reason', 'fallbackReason']) || null,
  };
}

export async function fetchWithdrawFee(
  params: {
    symbol: string;
    network: string;
    amount: string;
    toAddress?: string;
  },
  options?: ApiRequestOptions,
): Promise<WithdrawFeeEstimate> {
  const payload = await apiClient.get<unknown>(
    withQuery('/asset/withdraw/fee', {
      symbol: params.symbol.trim().toUpperCase(),
      network: params.network.trim().toLowerCase(),
      amount: params.amount,
      to_address: params.toAddress,
    }),
    options,
  );
  return normalizeWithdrawFeeEstimate(payload, params);
}

export function normalizeWithdrawCreateResponse(
  payload: unknown,
  params: {
    symbol: string;
    network: string;
    toAddress: string;
    amount: string;
  },
): WithdrawCreateResponse {
  const code = 'INVALID_WITHDRAW_CREATE_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '提现申请');
  const withdrawId = readRequiredIntegerField(
    root,
    ['withdraw_id', 'withdrawId'],
    code,
    '提现单号',
    1,
  );
  const symbol = readRequiredAssetSymbolField(
    root,
    ['symbol'],
    code,
    '提现币种',
  );
  const chainKey = readRequiredChainKeyField(
    root,
    ['chain_key', 'chainKey', 'network'],
    code,
    '提现网络',
  );
  const toAddress = readRequiredStringField(
    root,
    ['to_address', 'toAddress'],
    code,
    '提现地址',
  );
  const amount = readRequiredPositiveDecimalField(
    root,
    ['amount'],
    code,
    '提现数量',
  );
  const status = readRequiredStringField(
    root,
    ['status'],
    code,
    '提现状态',
  ).toUpperCase();
  if (!WITHDRAW_CREATE_STATUSES.has(status)) {
    invalidAssetPayload('提现状态无效，请稍后重试', code);
  }
  const needManualReview = readRequiredBooleanField(
    root,
    ['need_manual_review', 'needManualReview'],
    code,
    '人工审核标记',
  );
  if (
    (status === 'REVIEWING') !== needManualReview ||
    (status === 'VERIFYING') === needManualReview
  ) {
    invalidAssetPayload('提现审核状态不一致，请稍后重试', code);
  }
  const feeEstimate = readRequiredNonNegativeDecimalField(
    root,
    ['fee_estimate', 'feeEstimate'],
    code,
    '提现手续费',
  );
  const feeCoin = readRequiredAssetSymbolField(
    root,
    ['fee_coin', 'feeCoin'],
    code,
    '手续费币种',
  );

  requireMatchingField(
    symbol,
    params.symbol.trim().toUpperCase(),
    code,
    '提现币种',
  );
  requireMatchingField(
    chainKey,
    params.network.trim().toLowerCase(),
    code,
    '提现网络',
  );
  requireMatchingField(toAddress, params.toAddress.trim(), code, '提现地址');
  requireMatchingField(
    normalizeDecimalText(amount),
    normalizeDecimalText(params.amount.trim()),
    code,
    '提现数量',
  );

  return {
    withdrawId,
    symbol,
    chainKey,
    toAddress,
    amount,
    status,
    needManualReview,
    riskReason: readString(root, ['risk_reason', 'riskReason']),
    feeEstimate,
    feeCoin,
    receiveAmount: readString(root, ['receive_amount', 'receiveAmount']),
    totalDebitEstimate: readString(root, [
      'total_debit_estimate',
      'totalDebitEstimate',
    ]),
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
  return normalizeWithdrawCreateResponse(payload, params);
}

export function normalizeWithdrawCodeResponse(
  payload: unknown,
  expectedWithdrawId: number,
): WithdrawCodeResponse {
  const code = 'INVALID_WITHDRAW_CODE_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '提现验证码');
  const withdrawId = readRequiredIntegerField(
    root,
    ['withdraw_id', 'withdrawId'],
    code,
    '提现单号',
    1,
  );
  if (withdrawId !== expectedWithdrawId) {
    invalidAssetPayload('提现单号与请求不一致，请稍后重试', code);
  }
  const status = readRequiredStringField(
    root,
    ['status'],
    code,
    '提现状态',
  ).toUpperCase();
  if (status !== 'VERIFYING') {
    invalidAssetPayload('提现验证码状态无效，请稍后重试', code);
  }
  return {
    withdrawId,
    status,
    hint: readString(root, ['hint']),
  };
}

export async function sendWithdrawCode(
  withdrawId: number,
): Promise<WithdrawCodeResponse> {
  const payload = await apiClient.post<unknown>('/asset/withdraw/send_code', {
    withdraw_id: withdrawId,
  });
  return normalizeWithdrawCodeResponse(payload, withdrawId);
}

export function normalizeWithdrawConfirmResponse(
  payload: unknown,
  expectedWithdrawId: number,
): WithdrawConfirmResponse {
  const code = 'INVALID_WITHDRAW_CONFIRM_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '提现确认');
  const withdrawId = readRequiredIntegerField(
    root,
    ['withdraw_id', 'withdrawId'],
    code,
    '提现单号',
    1,
  );
  if (withdrawId !== expectedWithdrawId) {
    invalidAssetPayload('提现单号与请求不一致，请稍后重试', code);
  }
  const status = readRequiredStringField(
    root,
    ['status'],
    code,
    '提现状态',
  ).toUpperCase();
  if (status !== 'FROZEN') {
    invalidAssetPayload('提现确认状态无效，请稍后重试', code);
  }
  return {
    withdrawId,
    symbol: readRequiredAssetSymbolField(root, ['symbol'], code, '提现币种'),
    chainKey: readRequiredChainKeyField(
      root,
      ['chain_key', 'chainKey'],
      code,
      '提现网络',
    ),
    amount: readRequiredPositiveDecimalField(
      root,
      ['amount'],
      code,
      '提现数量',
    ),
    status,
    feeFinal: readRequiredNonNegativeDecimalField(
      root,
      ['fee_final', 'feeFinal'],
      code,
      '最终手续费',
    ),
    feeCoin: readRequiredAssetSymbolField(
      root,
      ['fee_coin', 'feeCoin'],
      code,
      '手续费币种',
    ),
    receiveAmount: readString(root, ['receive_amount', 'receiveAmount']),
    totalDebitFinal: readString(root, ['total_debit_final', 'totalDebitFinal']),
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
  return normalizeWithdrawConfirmResponse(payload, params.withdrawId);
}

export function normalizeAccountTransferResponse(
  payload: unknown,
  params: {
    fromAccount: 'funding' | 'spot';
    toAccount: 'funding' | 'spot';
    symbol: string;
    amount: string;
  },
): AccountTransferResponse {
  const code = 'INVALID_ACCOUNT_TRANSFER_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '账户划转');
  const record = requirePayloadRecord(root.record, code, '账户划转记录');
  const id = readRequiredIntegerField(record, ['id'], code, '划转记录 ID', 1);
  const transferNo = readRequiredTransferReference(
    record,
    ['transfer_no', 'transferNo'],
    code,
    '划转凭证',
  );
  const symbol = readRequiredAssetSymbolField(
    record,
    ['symbol'],
    code,
    '划转币种',
  );
  const fromAccount = readRequiredTransferAccount(
    record,
    ['from_account', 'fromAccount'],
    code,
    '转出账户',
  );
  const toAccount = readRequiredTransferAccount(
    record,
    ['to_account', 'toAccount'],
    code,
    '转入账户',
  );
  const amount = readRequiredPositiveDecimalField(
    record,
    ['amount'],
    code,
    '划转数量',
  );
  const status = readRequiredStringField(
    record,
    ['status'],
    code,
    '划转状态',
  ).toUpperCase();
  if (status !== 'SUCCESS') {
    invalidAssetPayload('划转状态不是成功，请稍后核对记录', code);
  }

  requireMatchingField(
    symbol,
    params.symbol.trim().toUpperCase(),
    code,
    '划转币种',
  );
  requireMatchingField(fromAccount, params.fromAccount, code, '转出账户');
  requireMatchingField(toAccount, params.toAccount, code, '转入账户');
  requireMatchingField(
    normalizeDecimalText(amount),
    normalizeDecimalText(params.amount.trim()),
    code,
    '划转数量',
  );

  return {
    record: {
      id,
      transferNo,
      symbol,
      fromAccount,
      toAccount,
      amount,
      status: 'SUCCESS',
      createdAt: readRequiredStringField(
        record,
        ['created_at', 'createdAt'],
        code,
        '划转时间',
      ),
    },
  };
}

export async function submitFundingSpotTransfer(params: {
  fromAccount: 'funding' | 'spot';
  toAccount: 'funding' | 'spot';
  symbol: string;
  amount: string;
}): Promise<AccountTransferResponse> {
  const payload = await apiClient.post<unknown>('/account/transfer', {
    from_account: params.fromAccount,
    to_account: params.toAccount,
    symbol: params.symbol.trim().toUpperCase(),
    amount: params.amount.trim(),
  });
  return normalizeAccountTransferResponse(payload, params);
}

export function normalizeContractTransferResponse(
  payload: unknown,
  params: {
    direction: 'in' | 'out';
    amount: string;
  },
): ContractTransferResponse {
  const code = 'INVALID_CONTRACT_TRANSFER_PAYLOAD';
  const root = requirePayloadRecord(payload, code, '合约划转');
  const transferNo = readRequiredTransferReference(
    root,
    ['transfer_no', 'transferNo'],
    code,
    '合约划转凭证',
  );
  const direction = readRequiredStringField(
    root,
    ['direction'],
    code,
    '合约划转方向',
  ).toUpperCase();
  const expectedDirection = params.direction === 'in' ? 'IN' : 'OUT';
  if (direction !== expectedDirection) {
    invalidAssetPayload('合约划转方向与请求不一致，请核对记录', code);
  }
  const marginAsset = readRequiredAssetSymbolField(
    root,
    ['margin_asset', 'marginAsset'],
    code,
    '合约保证金币种',
  );
  if (marginAsset !== 'USDT') {
    invalidAssetPayload('合约划转币种无效，请核对记录', code);
  }
  const amount = readRequiredPositiveDecimalField(
    root,
    ['amount'],
    code,
    '合约划转数量',
  );
  requireMatchingField(
    normalizeDecimalText(amount),
    normalizeDecimalText(params.amount.trim()),
    code,
    '合约划转数量',
  );

  return {
    transferNo,
    direction: expectedDirection,
    marginAsset: 'USDT',
    amount,
    fundingAvailableBefore: readRequiredSignedDecimalField(
      root,
      ['funding_available_before', 'fundingAvailableBefore'],
      code,
      '资金账户划转前余额',
    ),
    fundingAvailableAfter: readRequiredSignedDecimalField(
      root,
      ['funding_available_after', 'fundingAvailableAfter'],
      code,
      '资金账户划转后余额',
    ),
    contractAvailableBefore: readRequiredSignedDecimalField(
      root,
      ['contract_available_before', 'contractAvailableBefore'],
      code,
      '合约账户划转前余额',
    ),
    contractAvailableAfter: readRequiredSignedDecimalField(
      root,
      ['contract_available_after', 'contractAvailableAfter'],
      code,
      '合约账户划转后余额',
    ),
  };
}

export async function submitContractTransfer(params: {
  direction: 'in' | 'out';
  amount: string;
  account?: 'funding';
}): Promise<ContractTransferResponse> {
  const payload = await apiClient.post<unknown>(
    params.direction === 'in'
      ? '/contract/account/transfer-in'
      : '/contract/account/transfer-out',
    {
      amount: params.amount.trim(),
      account: params.account ?? 'funding',
    },
  );
  return normalizeContractTransferResponse(payload, params);
}
