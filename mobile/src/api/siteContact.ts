import { defaultLocale } from '../i18n';
import { publicApiClient } from './client';

export const PUBLIC_SITE_CONFIG_PATH = '/site/config';

const MAX_EMAIL_LENGTH = 191;
const MAX_LOCALE_LENGTH = 35;
const PLACEHOLDER_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'localhost',
]);

export type PublicSupportContact = {
  email: string | null;
};

export class PublicSupportContactContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSupportContactContractError';
  }
}

export async function fetchPublicSupportContact(
  options: { locale?: string; signal?: AbortSignal } = {},
): Promise<PublicSupportContact> {
  if (options.signal?.aborted) {
    throw new PublicSupportContactContractError('支持联系方式请求已取消');
  }
  const locale = normalizeLocale(options.locale || defaultLocale);
  const payload = await publicApiClient.get<unknown>(
    `${PUBLIC_SITE_CONFIG_PATH}?lang=${encodeURIComponent(locale)}`,
    { signal: options.signal },
  );
  return normalizePublicSupportContact(payload);
}

export function normalizePublicSupportContact(
  payload: unknown,
): PublicSupportContact {
  const root = requireRecord(payload);
  const value = root.support_email;
  if (value === null || value === undefined || value === '') {
    return { email: null };
  }
  if (typeof value !== 'string' || value.length > MAX_EMAIL_LENGTH) {
    throw new PublicSupportContactContractError('支持邮箱格式无效');
  }
  const email = value.trim();
  if (!email || hasUnsafeCharacter(email) || !isValidEmail(email)) {
    throw new PublicSupportContactContractError('支持邮箱格式无效');
  }
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (
    PLACEHOLDER_DOMAINS.has(domain) ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.test')
  ) {
    throw new PublicSupportContactContractError('支持邮箱仍是占位地址');
  }
  return { email };
}

function isValidEmail(value: string) {
  const match = value.match(/^([^\s@]+)@([^\s@]+)$/);
  if (!match || match[1].length > 64) return false;
  const domain = match[2];
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.')
  ) {
    return false;
  }
  return domain
    .split('.')
    .every(label =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    );
}

function hasUnsafeCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 33 || code === 127 || code > 126) return true;
  }
  return /[<>"'`\\]/.test(value);
}

function normalizeLocale(value: unknown) {
  if (typeof value !== 'string') {
    throw new PublicSupportContactContractError('支持联系方式语言标识无效');
  }
  const locale = value.trim().replace(/_/g, '-');
  if (
    !locale ||
    locale.length > MAX_LOCALE_LENGTH ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
  ) {
    throw new PublicSupportContactContractError('支持联系方式语言标识无效');
  }
  return locale;
}

function requireRecord(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublicSupportContactContractError('站点设置格式无效');
  }
  return value as Record<string, unknown>;
}
