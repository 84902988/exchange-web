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
): Promise<AssetBalanceLogResponse> {
  const payload = await apiClient.get<unknown>(
    withQuery('/asset/my/balance-logs', {page, page_size: pageSize}),
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
