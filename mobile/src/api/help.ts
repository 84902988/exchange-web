import { defaultLocale } from '../i18n';
import { publicApiClient } from './client';

export const HELP_CONTENT_PATH = '/help/content';

const CACHE_TTL_MS = 120_000;
const MAX_CATEGORIES = 30;
const MAX_ARTICLES_PER_CATEGORY = 100;
const MAX_TOTAL_ARTICLES = 500;
const MAX_HOT_ARTICLES = 20;
const MAX_TOTAL_CONTENT_LENGTH = 1_000_000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_LOCALE_LENGTH = 35;

export type MobileHelpArticle = {
  id: string;
  articleId: number;
  slug: string;
  categoryId: string;
  categoryTitle: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  hot: boolean;
  sortOrder: number;
};

export type MobileHelpCategory = {
  id: string;
  title: string;
  description: string;
  sortOrder: number;
  articles: MobileHelpArticle[];
};

export type MobileHelpContent = {
  categories: MobileHelpCategory[];
  hotArticles: MobileHelpArticle[];
};

type HelpCache = {
  locale: string;
  value: MobileHelpContent;
  fetchedAt: number;
};

let cache: HelpCache | null = null;

export class HelpContentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelpContentContractError';
  }
}

export async function fetchHelpContent(
  options: {
    locale?: string;
    signal?: AbortSignal;
    forceRefresh?: boolean;
  } = {},
) {
  const locale = normalizeLocale(options.locale || defaultLocale);
  if (options.signal?.aborted) {
    throw new HelpContentContractError('帮助内容请求已取消');
  }
  if (
    !options.forceRefresh &&
    cache?.locale === locale &&
    Date.now() - cache.fetchedAt <= CACHE_TTL_MS
  ) {
    return cache.value;
  }

  const payload = await publicApiClient.get<unknown>(
    `${HELP_CONTENT_PATH}?lang=${encodeURIComponent(locale)}`,
    { signal: options.signal },
  );
  const value = normalizeHelpContent(payload);
  cache = { locale, value, fetchedAt: Date.now() };
  return value;
}

export async function fetchHelpArticle(
  articleId: string,
  options: {
    locale?: string;
    signal?: AbortSignal;
    forceRefresh?: boolean;
  } = {},
) {
  const expectedId = requireIdentifier(articleId, '帮助文章编号');
  const content = await fetchHelpContent(options);
  const article = content.categories
    .flatMap(category => category.articles)
    .find(item => item.id === expectedId);
  if (!article) {
    throw new HelpContentContractError('帮助文章不存在或已下线');
  }
  return article;
}

export function normalizeHelpContent(payload: unknown): MobileHelpContent {
  const root = requireRecord(payload, '帮助内容');
  if (
    !Array.isArray(root.categories) ||
    root.categories.length > MAX_CATEGORIES ||
    !Array.isArray(root.hotArticles) ||
    root.hotArticles.length > MAX_HOT_ARTICLES
  ) {
    throw new HelpContentContractError('帮助内容格式无效');
  }

  const categoryIds = new Set<string>();
  const articleById = new Map<string, MobileHelpArticle>();
  let totalContentLength = 0;
  const categories = root.categories.map((value, categoryIndex) => {
    const record = requireRecord(value, `帮助分类第 ${categoryIndex + 1} 项`);
    const id = requireIdentifier(record.id, '帮助分类编号');
    const categoryKey = requireIdentifier(record.category_key, '帮助分类 Key');
    if (id !== categoryKey || categoryIds.has(id)) {
      throw new HelpContentContractError('帮助分类编号重复或不一致');
    }
    categoryIds.add(id);
    requireEnabled(record.enabled, '帮助分类');
    if (
      !Array.isArray(record.articles) ||
      record.articles.length > MAX_ARTICLES_PER_CATEGORY
    ) {
      throw new HelpContentContractError('帮助分类文章格式无效');
    }

    const title = readPlainText(
      record.title,
      MAX_TITLE_LENGTH,
      '帮助分类标题',
      true,
    );
    const articles = record.articles.map((articleValue, articleIndex) => {
      const article = normalizeArticle(
        articleValue,
        id,
        title,
        `帮助分类 ${id} 第 ${articleIndex + 1} 篇文章`,
      );
      if (articleById.has(article.id)) {
        throw new HelpContentContractError('帮助文章编号重复');
      }
      articleById.set(article.id, article);
      totalContentLength += article.content.length;
      return article;
    });

    return {
      id,
      title,
      description: readPlainText(
        record.description,
        MAX_DESCRIPTION_LENGTH,
        '帮助分类说明',
        false,
      ),
      sortOrder: requireSortOrder(record.sort_order, '帮助分类排序'),
      articles,
    };
  });

  if (
    articleById.size > MAX_TOTAL_ARTICLES ||
    totalContentLength > MAX_TOTAL_CONTENT_LENGTH
  ) {
    throw new HelpContentContractError('帮助内容超过移动端安全上限');
  }

  const hotIds = new Set<string>();
  const hotArticles = root.hotArticles.map((value, index) => {
    const record = requireRecord(value, `热门帮助文章第 ${index + 1} 项`);
    const id = requireIdentifier(record.id, '热门帮助文章编号');
    const expected = articleById.get(id);
    if (!expected || hotIds.has(id)) {
      throw new HelpContentContractError('热门帮助文章重复或不存在');
    }
    const normalized = normalizeArticle(
      record,
      expected.categoryId,
      expected.categoryTitle,
      `热门帮助文章 ${id}`,
    );
    if (!normalized.hot || !sameArticle(normalized, expected)) {
      throw new HelpContentContractError('热门帮助文章与分类内容不一致');
    }
    hotIds.add(id);
    return expected;
  });

  return { categories, hotArticles };
}

export function __resetHelpContentCacheForTests() {
  cache = null;
}

function normalizeArticle(
  value: unknown,
  categoryId: string,
  categoryTitle: string,
  label: string,
): MobileHelpArticle {
  const record = requireRecord(value, label);
  requireEnabled(record.enabled, label);
  const id = requireIdentifier(record.id, `${label}编号`);
  const articleId = requirePositiveInteger(
    record.article_id,
    `${label}数字编号`,
  );
  if (id !== `cms-${articleId}`) {
    throw new HelpContentContractError(`${label}编号不一致`);
  }
  if (requireIdentifier(record.category_id, `${label}分类`) !== categoryId) {
    throw new HelpContentContractError(`${label}分类不一致`);
  }
  const serializedCategoryTitle = readPlainText(
    record.category_title,
    MAX_TITLE_LENGTH,
    `${label}分类标题`,
    true,
  );
  if (serializedCategoryTitle !== categoryTitle) {
    throw new HelpContentContractError(`${label}分类标题不一致`);
  }

  return {
    id,
    articleId,
    slug: requireSlug(record.slug, `${label} slug`),
    categoryId,
    categoryTitle: serializedCategoryTitle,
    title: readPlainText(record.title, MAX_TITLE_LENGTH, `${label}标题`, true),
    summary: readPlainText(
      record.summary,
      MAX_DESCRIPTION_LENGTH,
      `${label}摘要`,
      false,
    ),
    content: readMultilineText(
      record.content,
      MAX_CONTENT_LENGTH,
      `${label}正文`,
      true,
    ),
    tags: readTags(record.tags, `${label}标签`),
    hot: requireBoolean(record.hot, `${label}热门状态`),
    sortOrder: requireSortOrder(record.sort_order, `${label}排序`),
  };
}

function sameArticle(left: MobileHelpArticle, right: MobileHelpArticle) {
  return (
    left.id === right.id &&
    left.articleId === right.articleId &&
    left.slug === right.slug &&
    left.categoryId === right.categoryId &&
    left.categoryTitle === right.categoryTitle &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.content === right.content &&
    left.hot === right.hot &&
    left.sortOrder === right.sortOrder &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  );
}

function readTags(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new HelpContentContractError(`${label}格式无效`);
  }
  const seen = new Set<string>();
  return value.map((tag, index) => {
    const text = readPlainText(
      tag,
      MAX_TAG_LENGTH,
      `${label}第 ${index + 1} 项`,
      true,
    );
    if (seen.has(text)) {
      throw new HelpContentContractError(`${label}包含重复项`);
    }
    seen.add(text);
    return text;
  });
}

function readPlainText(
  value: unknown,
  maxLength: number,
  label: string,
  required: boolean,
) {
  if (value === null || value === undefined) {
    if (required) throw new HelpContentContractError(`${label}无效`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HelpContentContractError(`${label}无效`);
  }
  assertSafePlainText(value, label);
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new HelpContentContractError(`${label}无效`);
  return text;
}

function readMultilineText(
  value: unknown,
  maxLength: number,
  label: string,
  required: boolean,
) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HelpContentContractError(`${label}无效`);
  }
  assertSafePlainText(value, label);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (required && !text) throw new HelpContentContractError(`${label}无效`);
  return text;
}

function assertSafePlainText(value: string, label: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      throw new HelpContentContractError(`${label}包含无效字符`);
    }
  }
  const decodedMarkers = value
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>');
  if (/<(?:!--|!doctype\b|\/?[a-z][^>]*?)>/i.test(decodedMarkers)) {
    throw new HelpContentContractError(`${label}必须是纯文本`);
  }
}

function requireIdentifier(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new HelpContentContractError(`${label}无效`);
  }
  const text = value.trim();
  if (!/^[A-Za-z0-9\u3400-\u9fff._-]{1,191}$/u.test(text)) {
    throw new HelpContentContractError(`${label}无效`);
  }
  return text;
}

function requireSlug(value: unknown, label: string) {
  return requireIdentifier(value, label);
}

function requirePositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new HelpContentContractError(`${label}无效`);
  }
  return Number(value);
}

function requireSortOrder(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Math.abs(Number(value)) > 1_000_000) {
    throw new HelpContentContractError(`${label}无效`);
  }
  return Number(value);
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw new HelpContentContractError(`${label}无效`);
  }
  return value;
}

function requireEnabled(value: unknown, label: string) {
  if (value !== true) {
    throw new HelpContentContractError(`${label}不是启用内容`);
  }
}

function normalizeLocale(value: unknown) {
  if (typeof value !== 'string') {
    throw new HelpContentContractError('帮助内容语言标识无效');
  }
  const locale = value.trim().replace(/_/g, '-');
  if (
    !locale ||
    locale.length > MAX_LOCALE_LENGTH ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
  ) {
    throw new HelpContentContractError('帮助内容语言标识无效');
  }
  return locale;
}

function requireRecord(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HelpContentContractError(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}
