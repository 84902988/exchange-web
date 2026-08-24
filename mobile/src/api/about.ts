import { defaultLocale } from '../i18n';
import { publicApiClient } from './client';

export const ABOUT_PAGE_PATH = '/site/pages/about';

const CACHE_TTL_MS = 120_000;
const MAX_SECTIONS = 5;
const MAX_PARAGRAPHS_PER_SECTION = 20;
const MAX_ITEMS_PER_SECTION = 12;
const MAX_PARAGRAPHS_PER_ITEM = 12;
const MAX_TITLE_LENGTH = 200;
const MAX_EYEBROW_LENGTH = 120;
const MAX_PARAGRAPH_LENGTH = 10_000;
const MAX_TOTAL_CONTENT_LENGTH = 200_000;
const MAX_LOCALE_LENGTH = 35;
const SECTION_IDS = ['who', 'story', 'vision', 'mission', 'values'] as const;

export type MobileAboutSectionId = (typeof SECTION_IDS)[number];

export type MobileAboutSectionItem = {
  title: string;
  body: string[];
};

export type MobileAboutSection = {
  id: MobileAboutSectionId;
  title: string;
  eyebrow: string;
  body: string[];
  items: MobileAboutSectionItem[];
};

export type MobileAboutPage = {
  slug: 'who-we-are';
  title: string;
  subtitle: string;
  sections: MobileAboutSection[];
  locale: string;
};

type AboutPageCache = {
  requestedLocale: string;
  value: MobileAboutPage;
  fetchedAt: number;
};

let cache: AboutPageCache | null = null;

export class AboutPageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AboutPageContractError';
  }
}

export async function fetchAboutPage(
  options: {
    locale?: string;
    signal?: AbortSignal;
    forceRefresh?: boolean;
  } = {},
) {
  const requestedLocale = normalizeLocale(options.locale || defaultLocale);
  if (options.signal?.aborted) {
    throw new AboutPageContractError('平台介绍请求已取消');
  }
  if (
    !options.forceRefresh &&
    cache?.requestedLocale === requestedLocale &&
    Date.now() - cache.fetchedAt <= CACHE_TTL_MS
  ) {
    return cache.value;
  }

  const payload = await publicApiClient.get<unknown>(
    `${ABOUT_PAGE_PATH}?lang=${encodeURIComponent(requestedLocale)}`,
    { signal: options.signal },
  );
  const value = normalizeAboutPage(payload);
  cache = { requestedLocale, value, fetchedAt: Date.now() };
  return value;
}

export function normalizeAboutPage(payload: unknown): MobileAboutPage {
  const root = requireRecord(payload, '平台介绍');
  if (root.slug !== 'who-we-are') {
    throw new AboutPageContractError('平台介绍页面标识无效');
  }
  if (!Array.isArray(root.sections) || root.sections.length > MAX_SECTIONS) {
    throw new AboutPageContractError('平台介绍章节格式无效');
  }

  const seenSectionIds = new Set<MobileAboutSectionId>();
  let totalContentLength = 0;
  const sections = root.sections.map((value, sectionIndex) => {
    const record = requireRecord(
      value,
      `平台介绍第 ${sectionIndex + 1} 个章节`,
    );
    const id = requireSectionId(record.id);
    if (seenSectionIds.has(id)) {
      throw new AboutPageContractError('平台介绍包含重复章节');
    }
    seenSectionIds.add(id);

    const title = readPlainText(
      record.title,
      MAX_TITLE_LENGTH,
      `平台介绍章节 ${id} 标题`,
      true,
    );
    const eyebrow = readPlainText(
      record.eyebrow,
      MAX_EYEBROW_LENGTH,
      `平台介绍章节 ${id} 引导文字`,
      false,
    );
    const body = readParagraphs(
      record.body,
      MAX_PARAGRAPHS_PER_SECTION,
      `平台介绍章节 ${id} 正文`,
    );
    const items = readSectionItems(record.items, id);
    if (body.length === 0 && items.length === 0) {
      throw new AboutPageContractError(`平台介绍章节 ${id} 没有正文`);
    }

    totalContentLength +=
      title.length +
      eyebrow.length +
      body.reduce((sum, paragraph) => sum + paragraph.length, 0) +
      items.reduce(
        (sum, item) =>
          sum +
          item.title.length +
          item.body.reduce(
            (bodySum, paragraph) => bodySum + paragraph.length,
            0,
          ),
        0,
      );

    return { id, title, eyebrow, body, items };
  });

  const title = readPlainText(
    root.title,
    MAX_TITLE_LENGTH,
    '平台介绍标题',
    true,
  );
  const subtitle = readPlainText(
    root.subtitle,
    MAX_TITLE_LENGTH,
    '平台介绍副标题',
    false,
  );
  totalContentLength += title.length + subtitle.length;
  if (totalContentLength > MAX_TOTAL_CONTENT_LENGTH) {
    throw new AboutPageContractError('平台介绍超过移动端安全上限');
  }

  return {
    slug: 'who-we-are',
    title,
    subtitle,
    sections,
    locale: normalizeLocale(root.locale),
  };
}

export function __resetAboutPageCacheForTests() {
  cache = null;
}

function readSectionItems(
  value: unknown,
  sectionId: MobileAboutSectionId,
): MobileAboutSectionItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS_PER_SECTION) {
    throw new AboutPageContractError(`平台介绍章节 ${sectionId} 子项格式无效`);
  }
  const seenTitles = new Set<string>();
  return value.map((itemValue, itemIndex) => {
    const item = requireRecord(
      itemValue,
      `平台介绍章节 ${sectionId} 第 ${itemIndex + 1} 个子项`,
    );
    const title = readPlainText(
      item.title,
      MAX_TITLE_LENGTH,
      `平台介绍章节 ${sectionId} 子项标题`,
      true,
    );
    if (seenTitles.has(title)) {
      throw new AboutPageContractError(
        `平台介绍章节 ${sectionId} 包含重复子项`,
      );
    }
    seenTitles.add(title);
    const body = readParagraphs(
      item.body,
      MAX_PARAGRAPHS_PER_ITEM,
      `平台介绍章节 ${sectionId} 子项 ${title} 正文`,
    );
    if (body.length === 0) {
      throw new AboutPageContractError(
        `平台介绍章节 ${sectionId} 子项 ${title} 没有正文`,
      );
    }
    return { title, body };
  });
}

function readParagraphs(value: unknown, maxItems: number, label: string) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AboutPageContractError(`${label}格式无效`);
  }
  return value.map((paragraph, index) =>
    readPlainText(
      paragraph,
      MAX_PARAGRAPH_LENGTH,
      `${label}第 ${index + 1} 段`,
      true,
    ),
  );
}

function readPlainText(
  value: unknown,
  maxLength: number,
  label: string,
  required: boolean,
) {
  if (value === null || value === undefined) {
    if (required) throw new AboutPageContractError(`${label}无效`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new AboutPageContractError(`${label}无效`);
  }
  assertSafePlainText(value, label);
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new AboutPageContractError(`${label}无效`);
  return text;
}

function assertSafePlainText(value: string, label: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      throw new AboutPageContractError(`${label}包含无效字符`);
    }
  }
  const decodedMarkers = value
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>');
  if (/<(?:!--|!doctype\b|\/?[a-z][^>]*?)>/i.test(decodedMarkers)) {
    throw new AboutPageContractError(`${label}必须是纯文本`);
  }
}

function requireSectionId(value: unknown): MobileAboutSectionId {
  if (
    typeof value !== 'string' ||
    !SECTION_IDS.includes(value as MobileAboutSectionId)
  ) {
    throw new AboutPageContractError('平台介绍章节编号无效');
  }
  return value as MobileAboutSectionId;
}

function normalizeLocale(value: unknown) {
  if (typeof value !== 'string') {
    throw new AboutPageContractError('平台介绍语言标识无效');
  }
  const locale = value.trim().replace(/_/g, '-');
  if (
    !locale ||
    locale.length > MAX_LOCALE_LENGTH ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
  ) {
    throw new AboutPageContractError('平台介绍语言标识无效');
  }
  return locale;
}

function requireRecord(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AboutPageContractError(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}
