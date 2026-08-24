import { defaultLocale } from '../i18n';
import { publicApiClient } from './client';

export type LegalPageKey = 'terms' | 'privacy' | 'risk';

export type LegalPageContent = {
  key: LegalPageKey;
  title: string;
  content: string;
  locale: string;
};

const MAX_LEGAL_TITLE_LENGTH = 120;
const MAX_LEGAL_CONTENT_LENGTH = 200_000;
const MAX_LOCALE_LENGTH = 35;

export class LegalPageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalPageContractError';
  }
}

export async function fetchLegalPage(
  pageKey: LegalPageKey,
  options: { locale?: string; signal?: AbortSignal } = {},
) {
  const locale = normalizeLocale(options.locale || defaultLocale);
  const payload = await publicApiClient.get<unknown>(
    `/site/pages/legal/${pageKey}?lang=${encodeURIComponent(locale)}`,
    { signal: options.signal },
  );
  return normalizeLegalPage(payload, pageKey);
}

export function normalizeLegalPage(
  payload: unknown,
  expectedKey: LegalPageKey,
): LegalPageContent {
  if (typeof payload !== 'object' || payload === null) {
    throw new LegalPageContractError('协议内容格式无效');
  }
  const record = payload as Record<string, unknown>;
  if (record.key !== expectedKey) {
    throw new LegalPageContractError('协议类型与请求不一致');
  }
  const title = requirePlainText(
    record.title,
    MAX_LEGAL_TITLE_LENGTH,
    '协议标题无效',
  );
  const content = repairSplitSectionNumbers(
    requirePlainText(record.content, MAX_LEGAL_CONTENT_LENGTH, '协议正文无效', {
      preserveLines: true,
    }),
  );
  const locale = normalizeLocale(record.locale);

  return { key: expectedKey, title, content, locale };
}

export function repairSplitSectionNumbers(content: string) {
  // Some legacy admin content imported two-digit headings as separate
  // paragraphs (for example "1\n\n0. 数据安全"). Repair only that exact,
  // unambiguous heading shape; do not otherwise rewrite legal copy.
  return content.replace(
    /(^|\n{2,})(\d)\n{2,}(\d+\.\s*[^\d\s])/g,
    (_match, prefix: string, tens: string, remainder: string) =>
      `${prefix}${tens}${remainder}`,
  );
}

function requirePlainText(
  value: unknown,
  maxLength: number,
  message: string,
  { preserveLines = false }: { preserveLines?: boolean } = {},
) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new LegalPageContractError(message);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      throw new LegalPageContractError(message);
    }
  }
  const text = preserveLines
    ? value.replace(/\r\n?/g, '\n').trim()
    : value.replace(/\s+/g, ' ').trim();
  if (!text || /<(?:!--|!doctype\b|\/?[a-z][^>]*?)>/i.test(text)) {
    throw new LegalPageContractError(message);
  }
  return text;
}

function normalizeLocale(value: unknown) {
  if (typeof value !== 'string') {
    throw new LegalPageContractError('协议语言标识无效');
  }
  const locale = value.trim().replace(/_/g, '-');
  if (
    !locale ||
    locale.length > MAX_LOCALE_LENGTH ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
  ) {
    throw new LegalPageContractError('协议语言标识无效');
  }
  return locale;
}
