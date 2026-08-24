import { defaultLocale } from '../i18n';
import { publicApiClient } from './client';

export const ACTIVITY_LIST_PATH = '/activities';
export const ACTIVITY_LIST_LIMIT = 20;
export const ACTIVITY_BANNERS_PATH = '/activities/banners';
export const ACTIVITY_BANNERS_LIMIT = 10;

const MAX_TITLE_LENGTH = 180;
const MAX_SUBTITLE_LENGTH = 280;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_DETAIL_LENGTH = 50_000;
const MAX_REWARD_LENGTH = 240;
const MAX_CTA_TEXT_LENGTH = 80;
const MAX_CTA_URL_LENGTH = 256;
const MAX_LOCALE_LENGTH = 35;
const MAX_MEDIA_URL_LENGTH = 512;

export type MobileActivity = {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  detailContent: string;
  rewardText: string;
  status: 'active';
  startAt: string | null;
  endAt: string | null;
  ctaText: string;
  ctaUrl: string;
};

export type MobileActivityBanner = {
  id: number;
  title: string;
  subtitle: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  linkUrl: string;
  sortOrder: number;
  enabled: true;
  startAt: string | null;
  endAt: string | null;
};

export class ActivityContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityContractError';
  }
}

export async function fetchActivities(
  options: { locale?: string; signal?: AbortSignal } = {},
) {
  const locale = normalizeLocale(options.locale || defaultLocale);
  const payload = await publicApiClient.get<unknown>(
    `${ACTIVITY_LIST_PATH}?limit=${ACTIVITY_LIST_LIMIT}&lang=${encodeURIComponent(
      locale,
    )}`,
    { signal: options.signal },
  );
  return normalizeActivityList(payload);
}

export async function fetchActivity(
  activityId: number,
  options: { locale?: string; signal?: AbortSignal } = {},
) {
  const expectedId = requireActivityId(activityId);
  const locale = normalizeLocale(options.locale || defaultLocale);
  const payload = await publicApiClient.get<unknown>(
    `${ACTIVITY_LIST_PATH}/${expectedId}?lang=${encodeURIComponent(locale)}`,
    { signal: options.signal },
  );
  return normalizeActivityDetail(payload, expectedId);
}

export async function fetchActivityBanners(
  options: { locale?: string; signal?: AbortSignal } = {},
) {
  const locale = normalizeLocale(options.locale || defaultLocale);
  const payload = await publicApiClient.get<unknown>(
    `${ACTIVITY_BANNERS_PATH}?limit=${ACTIVITY_BANNERS_LIMIT}&lang=${encodeURIComponent(
      locale,
    )}`,
    { signal: options.signal },
  );
  return normalizeActivityBanners(payload);
}

export function normalizeActivityList(payload: unknown): MobileActivity[] {
  const record = requireRecord(payload, '活动列表');
  if (
    !Array.isArray(record.items) ||
    record.items.length > ACTIVITY_LIST_LIMIT
  ) {
    throw new ActivityContractError('活动列表格式无效');
  }

  const seenIds = new Set<number>();
  return record.items.map((item, index) => {
    const activity = normalizeActivity(item, `活动列表第 ${index + 1} 项`);
    if (seenIds.has(activity.id)) {
      throw new ActivityContractError('活动列表包含重复项目');
    }
    seenIds.add(activity.id);
    return activity;
  });
}

export function normalizeActivityDetail(
  payload: unknown,
  expectedId: number,
): MobileActivity {
  const record = requireRecord(payload, '活动详情');
  const activity = normalizeActivity(record.item, '活动详情');
  if (activity.id !== requireActivityId(expectedId)) {
    throw new ActivityContractError('活动详情与请求不一致');
  }
  return activity;
}

export function normalizeActivityBanners(
  payload: unknown,
): MobileActivityBanner[] {
  const record = requireRecord(payload, '活动横幅列表');
  if (
    !Array.isArray(record.items) ||
    record.items.length > ACTIVITY_BANNERS_LIMIT
  ) {
    throw new ActivityContractError('活动横幅列表格式无效');
  }
  const seenIds = new Set<number>();
  return record.items.map((value, index) => {
    const label = `活动横幅第 ${index + 1} 项`;
    const item = requireRecord(value, label);
    const id = requireActivityId(item.id);
    if (seenIds.has(id)) {
      throw new ActivityContractError('活动横幅列表包含重复项目');
    }
    seenIds.add(id);
    if (item.enabled !== true) {
      throw new ActivityContractError(`${label}不是启用状态`);
    }
    const mediaType = readCollapsedText(
      item.media_type,
      16,
      `${label}媒体类型`,
      true,
    ).toLowerCase();
    if (mediaType !== 'image' && mediaType !== 'video') {
      throw new ActivityContractError(`${label}媒体类型无效`);
    }
    const sortOrder = item.sort_order;
    if (
      !Number.isSafeInteger(sortOrder) ||
      Math.abs(Number(sortOrder)) > 1_000_000
    ) {
      throw new ActivityContractError(`${label}排序值无效`);
    }
    return {
      id,
      title: readCollapsedText(
        item.title,
        MAX_TITLE_LENGTH,
        `${label}标题`,
        true,
      ),
      subtitle: readCollapsedText(
        item.subtitle,
        MAX_SUBTITLE_LENGTH,
        `${label}副标题`,
        false,
      ),
      mediaType,
      mediaUrl: readMediaUrl(item.media_url, `${label}媒体地址`),
      linkUrl: readCtaUrl(item.link_url, `${label}跳转地址`),
      sortOrder: Number(sortOrder),
      enabled: true,
      startAt: readDateTime(item.start_at, `${label}开始时间`),
      endAt: readDateTime(item.end_at, `${label}结束时间`),
    };
  });
}

export function formatActivityDateTime(value: string | null) {
  if (!value) return '长期有效';
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/,
  );
  return match
    ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`
    : '--';
}

function normalizeActivity(value: unknown, label: string): MobileActivity {
  const record = requireRecord(value, label);
  const status = readCollapsedText(record.status, 20, `${label}状态`, true);
  if (status.toLowerCase() !== 'active') {
    throw new ActivityContractError(`${label}不是进行中活动`);
  }

  return {
    id: requireActivityId(record.id),
    title: readCollapsedText(
      record.title,
      MAX_TITLE_LENGTH,
      `${label}标题`,
      true,
    ),
    subtitle: readCollapsedText(
      record.subtitle,
      MAX_SUBTITLE_LENGTH,
      `${label}副标题`,
      false,
    ),
    description: readCollapsedText(
      record.description,
      MAX_DESCRIPTION_LENGTH,
      `${label}简介`,
      false,
    ),
    detailContent: readMultilineText(
      record.detail_content,
      MAX_DETAIL_LENGTH,
      `${label}规则`,
    ),
    rewardText: readCollapsedText(
      record.reward_text,
      MAX_REWARD_LENGTH,
      `${label}奖励说明`,
      false,
    ),
    status: 'active',
    startAt: readDateTime(record.start_at, `${label}开始时间`),
    endAt: readDateTime(record.end_at, `${label}结束时间`),
    ctaText: readCollapsedText(
      record.cta_text,
      MAX_CTA_TEXT_LENGTH,
      `${label}操作文案`,
      false,
    ),
    ctaUrl: readCtaUrl(record.cta_url, `${label}操作地址`),
  };
}

function requireActivityId(value: unknown) {
  const id = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ActivityContractError('活动编号无效');
  }
  return id;
}

function readCollapsedText(
  value: unknown,
  maxLength: number,
  label: string,
  required: boolean,
) {
  if (value === null || value === undefined) {
    if (required) throw new ActivityContractError(`${label}无效`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ActivityContractError(`${label}无效`);
  }
  assertSafePlainText(value, label);
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new ActivityContractError(`${label}无效`);
  return text;
}

function readMultilineText(value: unknown, maxLength: number, label: string) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ActivityContractError(`${label}无效`);
  }
  assertSafePlainText(value, label);
  return value.replace(/\r\n?/g, '\n').trim();
}

function assertSafePlainText(value: string, label: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      throw new ActivityContractError(`${label}包含无效字符`);
    }
  }
  const decodedMarkers = value
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>');
  if (/<(?:!--|!doctype\b|\/?[a-z][^>]*?)>/i.test(decodedMarkers)) {
    throw new ActivityContractError(`${label}必须是纯文本`);
  }
}

function readDateTime(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) {
    throw new ActivityContractError(`${label}无效`);
  }
  const text = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(
      text,
    ) ||
    Number.isNaN(Date.parse(text))
  ) {
    throw new ActivityContractError(`${label}无效`);
  }
  return text;
}

function readCtaUrl(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_CTA_URL_LENGTH) {
    throw new ActivityContractError(`${label}无效`);
  }
  const text = value.trim();
  if (!/^\/[A-Za-z0-9/_-]*$/.test(text)) {
    throw new ActivityContractError(`${label}不是安全的站内路径`);
  }
  return text;
}

function readMediaUrl(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_MEDIA_URL_LENGTH) {
    throw new ActivityContractError(`${label}无效`);
  }
  const text = value.trim();
  if (/^\/[A-Za-z0-9/_.%-]*$/.test(text)) {
    return text;
  }
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error('unsafe');
    }
    return url.toString();
  } catch {
    throw new ActivityContractError(`${label}无效`);
  }
}

function normalizeLocale(value: unknown) {
  if (typeof value !== 'string') {
    throw new ActivityContractError('活动语言标识无效');
  }
  const locale = value.trim().replace(/_/g, '-');
  if (
    !locale ||
    locale.length > MAX_LOCALE_LENGTH ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
  ) {
    throw new ActivityContractError('活动语言标识无效');
  }
  return locale;
}

function requireRecord(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ActivityContractError(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}
