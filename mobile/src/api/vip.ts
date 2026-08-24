import { apiClient } from './client';

export type VipLevel = {
  levelCode: string;
  levelName: string;
  sortOrder: number;
  spotMakerFee: string;
  spotTakerFee: string;
  min30dVolume: string | null;
  minRcbHold: string | null;
  minLockAmount: string | null;
  lockPeriodDays: number | null;
  userLimit?: number | null;
  dividendRate: string | null;
};

export type VipOverview = {
  effectiveLevelCode: string | null;
  effectiveFeeSource: string | null;
  effectiveSpotMakerFee: string | null;
  effectiveSpotTakerFee: string | null;
  volume30d: string | null;
  rcbAvailable: string | null;
  rcbFundingAvailable: string | null;
  rcbLocked: string | null;
  rcbLockPeriodDays: number | null;
  rcbFeePayPercent: string | null;
  vipLevels: VipLevel[];
  svipLevels: VipLevel[];
};

export type VipFeePreference = {
  useRcbFee: boolean;
};

export type RcbLockRecord = {
  id: number;
  assetSymbol: string;
  lockAmount: string;
  lockPeriodDays: number;
  startTime: string | null;
  endTime: string | null;
  status: 'LOCKED' | 'UNLOCKED' | 'EXPIRED' | 'CANCELED';
  currentSvip: string | null;
  createdAt: string | null;
};

export type RcbLockCreateResult = {
  lock: RcbLockRecord;
  rcbFundingAvailable: string | null;
  rcbLocked: string | null;
  svipLevelCode: string | null;
};

export type RcbReleaseResult = {
  releasedCount: number;
  releasedAmount: string;
  lockIds: number[];
};

export async function fetchVipOverview({
  signal,
}: { signal?: AbortSignal } = {}): Promise<VipOverview> {
  const payload = signal
    ? await apiClient.get<unknown>('/vip/overview', { signal })
    : await apiClient.get<unknown>('/vip/overview');
  return normalizeVipOverview(payload);
}

export async function fetchVipFeePreference({
  signal,
}: { signal?: AbortSignal } = {}): Promise<VipFeePreference> {
  const payload = signal
    ? await apiClient.get<unknown>('/vip/fee-preference', { signal })
    : await apiClient.get<unknown>('/vip/fee-preference');
  return normalizeVipFeePreference(payload);
}

export async function updateVipFeePreference(
  useRcbFee: boolean,
): Promise<VipFeePreference> {
  const payload = await apiClient.post<unknown>(
    '/vip/fee-preference',
    { use_rcb_fee: useRcbFee },
    { retry: 'none' },
  );
  return normalizeVipFeePreference(payload);
}

export async function fetchRcbLocks({
  signal,
}: { signal?: AbortSignal } = {}): Promise<RcbLockRecord[]> {
  const payload = signal
    ? await apiClient.get<unknown>('/vip/rcb-locks', { signal })
    : await apiClient.get<unknown>('/vip/rcb-locks');
  const root = requireRecord(payload, 'RCB 锁仓记录');
  return requireArray(root.items, 'RCB 锁仓记录').map((item, index) =>
    normalizeRcbLock(item, `RCB 锁仓记录 ${index + 1}`),
  );
}

export async function createRcbLock(input: {
  amount: string;
  lockPeriodDays: number;
}): Promise<RcbLockCreateResult> {
  const payload = await apiClient.post<unknown>(
    '/vip/lock-rcb',
    {
      amount: input.amount,
      lock_period_days: input.lockPeriodDays,
    },
    { retry: 'none' },
  );
  const root = requireRecord(payload, 'RCB 锁仓结果');
  const summary = requireRecord(root.summary, 'RCB 锁仓摘要');
  return {
    lock: normalizeRcbLock(root.lock, 'RCB 锁仓结果'),
    rcbFundingAvailable: optionalDecimal(summary.rcb_funding_available),
    rcbLocked: optionalDecimal(summary.rcb_locked),
    svipLevelCode: optionalString(summary.svip_level_code),
  };
}

export async function releaseMaturedRcbLocks(): Promise<RcbReleaseResult> {
  const payload = await apiClient.post<unknown>(
    '/vip/rcb-locks/release-matured',
    undefined,
    { retry: 'none' },
  );
  const root = requireRecord(payload, 'RCB 到期返还结果');
  return {
    releasedCount: requiredInteger(root.released_count, '返还笔数'),
    releasedAmount: requiredDecimal(root.released_amount, '返还数量'),
    lockIds: requireArray(root.lock_ids, '返还记录').map((value, index) =>
      requiredInteger(value, `返还记录 ${index + 1}`),
    ),
  };
}

export function normalizeVipOverview(payload: unknown): VipOverview {
  const root = requireRecord(payload, 'VIP 概览');
  if (root.auth_state !== 'authenticated') {
    throw new Error('登录状态已失效，请重新登录');
  }

  const summary = requireRecord(root.user_summary, 'VIP 用户摘要');
  return {
    effectiveLevelCode: optionalString(summary.effective_level_code),
    effectiveFeeSource: optionalString(summary.effective_fee_source),
    effectiveSpotMakerFee: optionalDecimal(summary.effective_spot_maker_fee),
    effectiveSpotTakerFee: optionalDecimal(summary.effective_spot_taker_fee),
    volume30d: optionalDecimal(summary.volume_30d),
    rcbAvailable: optionalDecimal(summary.rcb_available),
    rcbFundingAvailable: optionalDecimal(summary.rcb_funding_available),
    rcbLocked: optionalDecimal(summary.rcb_locked),
    rcbLockPeriodDays: optionalInteger(summary.rcb_lock_period_days),
    rcbFeePayPercent: optionalDecimal(root.rcb_fee_pay_percent),
    vipLevels: requireArray(root.vip_levels, 'VIP 等级').map((item, index) =>
      normalizeLevel(item, `VIP 等级 ${index + 1}`),
    ),
    svipLevels: requireArray(root.svip_levels, 'SVIP 等级').map((item, index) =>
      normalizeLevel(item, `SVIP 等级 ${index + 1}`),
    ),
  };
}

export function normalizeVipFeePreference(payload: unknown): VipFeePreference {
  const root = requireRecord(payload, 'RCB 手续费抵扣偏好');
  if (typeof root.use_rcb_fee !== 'boolean') {
    throw new Error('RCB 手续费抵扣偏好响应格式无效');
  }
  return { useRcbFee: root.use_rcb_fee };
}

function normalizeLevel(payload: unknown, label: string): VipLevel {
  const level = requireRecord(payload, label);
  const condition = requireRecord(level.condition, `${label}条件`);
  const levelCode = requiredString(level.level_code, `${label}编码`);
  return {
    levelCode,
    levelName: requiredString(level.level_name, `${label}名称`),
    sortOrder:
      typeof level.sort_order === 'number' &&
      Number.isSafeInteger(level.sort_order)
        ? level.sort_order
        : 0,
    spotMakerFee: requiredDecimal(
      level.spot_maker_fee,
      `${levelCode} Maker 费率`,
    ),
    spotTakerFee: requiredDecimal(
      level.spot_taker_fee,
      `${levelCode} Taker 费率`,
    ),
    min30dVolume: optionalDecimal(condition.min_30d_volume),
    minRcbHold: optionalDecimal(condition.min_rcb_hold),
    minLockAmount: optionalDecimal(condition.min_lock_amount),
    lockPeriodDays: optionalInteger(condition.lock_period_days),
    userLimit: optionalInteger(condition.user_limit),
    dividendRate: optionalDecimal(condition.dividend_rate),
  };
}

function normalizeRcbLock(payload: unknown, label: string): RcbLockRecord {
  const item = requireRecord(payload, label);
  const rawStatus = requiredString(item.status, `${label}状态`).toUpperCase();
  if (!['LOCKED', 'UNLOCKED', 'EXPIRED', 'CANCELED'].includes(rawStatus)) {
    throw new Error(`${label}状态响应格式无效`);
  }
  return {
    id: requiredInteger(item.id, `${label}编号`),
    assetSymbol: requiredString(item.asset_symbol, `${label}币种`),
    lockAmount: requiredDecimal(item.lock_amount, `${label}数量`),
    lockPeriodDays: requiredInteger(item.lock_period_days, `${label}周期`),
    startTime: optionalString(item.start_time),
    endTime: optionalString(item.end_time),
    status: rawStatus as RcbLockRecord['status'],
    currentSvip: optionalString(item.current_svip),
    createdAt: optionalString(item.created_at),
  };
}

function optionalDecimal(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))
    ? text
    : null;
}

function requiredDecimal(value: unknown, label: string) {
  const decimal = optionalDecimal(value);
  if (decimal === null) throw new Error(`${label}响应格式无效`);
  return decimal;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalInteger(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function requiredInteger(value: unknown, label: string) {
  const parsed = optionalInteger(value);
  if (parsed === null) throw new Error(`${label}响应格式无效`);
  return parsed;
}

function requiredString(value: unknown, label: string) {
  const text = optionalString(value);
  if (!text) throw new Error(`${label}响应格式无效`);
  return text;
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label}响应格式无效`);
  return value;
}

function requireRecord(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}响应格式无效`);
  }
  return value as Record<string, unknown>;
}
