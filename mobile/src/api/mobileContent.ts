import { apiClient, publicApiClient } from './client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config/env';
import { defaultLocale } from '../i18n';

export const MOBILE_CONTENT_BOOTSTRAP_PATH = '/mobile/content/bootstrap';
export const MOBILE_ANNOUNCEMENT_DETAIL_PATH = '/mobile/content/announcements';
export const MOBILE_ANNOUNCEMENT_READS_PATH = '/mobile/content/announcement-reads';
export const MOBILE_MESSAGE_UNREAD_COUNTS_PATH = '/mobile/content/unread-counts';
export const MOBILE_CONTENT_SCHEMA_VERSION = 1;

const DEFAULT_CACHE_TTL_MS = 120_000;
const DEFAULT_MAX_STALE_MS = 600_000;
const MOBILE_CONTENT_PERSISTENCE_VERSION = 1;
const MOBILE_CONTENT_PERSISTENCE_KEY_PREFIX = '@exchange/mobile-content/v1/';
const MAX_PERSISTED_BOOTSTRAP_BYTES = 512_000;
const MOBILE_CHANNEL = 'MOBILE';
const MOBILE_ANNOUNCEMENT_CONTENT_FORMATS = new Set([
  'PLAIN_TEXT',
  'SANITIZED_HTML',
]);
const MAX_ANNOUNCEMENT_TITLE_LENGTH = 180;
const MAX_ANNOUNCEMENT_SUMMARY_LENGTH = 280;
const MAX_ANNOUNCEMENT_CONTENT_LENGTH = 50_000;
const MAX_PUBLISHED_AT_LENGTH = 64;
const MAX_IMAGE_DIMENSION = 4_096;
const MAX_IMAGE_PIXELS = 12_000_000;
const MAX_IMAGE_BYTES = 2_000_000;
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/avif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const SUPPORTED_ROUTES = new Set([
  'LOGIN',
  'REGISTER',
  'MARKETS',
  'SPOT',
  'CONTRACT',
  'ASSETS',
]);
const MOBILE_HOME_CONFIG_VERSION = 1;
export const DEFAULT_MOBILE_HOME_MARKET_SHORTCUT_SYMBOLS = [
  'BTCUSDT',
  'RCBUSDT',
  'ETHUSDT',
  'NVDAUSDT_PERP',
] as const;
const MOBILE_HOME_MARKET_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const SUPPORTED_HOME_QUICK_ENTRY_IDS = new Set([
  'DEPOSIT',
  'WITHDRAW',
  'TRANSFER',
  'HISTORY',
]);

type MobileMediaVariant = 'APP_LOGO' | 'HOME_HERO' | 'HOME_PROMO';
type MobileRoute =
  | 'LOGIN'
  | 'REGISTER'
  | 'MARKETS'
  | 'SPOT'
  | 'CONTRACT'
  | 'ASSETS';
type Request = (path: string) => Promise<unknown>;

export type MobileContentAction = {
  type: 'ROUTE';
  route: MobileRoute;
};

export type MobileRasterImage = {
  url: string;
  width: number;
  height: number;
  byteSize: number;
  mimeType: 'image/avif' | 'image/jpeg' | 'image/png' | 'image/webp';
};

export type MobileSiteContent = {
  displayName: string;
  logo: MobileRasterImage | null;
};

export type MobileHomeQuickEntryId =
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'TRANSFER'
  | 'HISTORY';

export type MobileHomeQuickEntry = {
  id: MobileHomeQuickEntryId;
  title: string;
  description: string;
};

export type MobileHomeConfig = {
  version: 1;
  sections: {
    assetSummary: boolean;
    quickEntries: boolean;
    marketShortcuts: boolean;
    promos: boolean;
    announcements: boolean;
  };
  quickEntries: MobileHomeQuickEntry[];
  marketShortcutLimit: number;
  marketShortcutSymbols: string[];
};

export type MobileHeroContent = {
  id: string;
  title: string;
  subtitle: string;
  image: MobileRasterImage;
  action: MobileContentAction | null;
};

export type MobilePromoContent = {
  id: string;
  title: string;
  subtitle: string;
  image: MobileRasterImage;
  action: MobileContentAction | null;
};

export type MobileAnnouncementSummary = {
  id: string;
  title: string;
  summary: string;
  categoryLabel: string;
  isPinned: boolean;
  publishedAt: string | null;
};

export type MobileAnnouncementDetail = {
  id: string;
  scope: 'MOBILE';
  title: string;
  summary: string;
  contentFormat: 'PLAIN_TEXT' | 'SANITIZED_HTML';
  content: string;
  publishedAt: string | null;
};

export type MobileAnnouncementDetailOptions = {
  locale?: string;
  signal?: AbortSignal;
};

export type MobileAnnouncementList = {
  items: MobileAnnouncementSummary[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type MobileAnnouncementReadState = {
  unreadCount: number;
  readIds: string[];
};

export type MobileMessageUnreadCounts = {
  announcements: number;
  supportReplies: number;
  total: number;
};

export type MobileContentSnapshot = {
  schemaVersion: 1;
  revision: string;
  locale: string;
  site: MobileSiteContent;
  homeConfig: MobileHomeConfig;
  hero: MobileHeroContent | null;
  promos: MobilePromoContent[];
  announcements: MobileAnnouncementSummary[];
  fetchedAt: number;
};

export type MobileContentLoadResult = {
  snapshot: MobileContentSnapshot | null;
  source: 'cache' | 'network' | 'stale-cache' | 'error';
  error: string | null;
};

export type MobileContentRepository = {
  load: (options?: {
    force?: boolean;
    locale?: string;
  }) => Promise<MobileContentLoadResult>;
  peek: (locale?: string) => MobileContentSnapshot | null;
  reset: () => void;
};

export type MobileContentPersistentStore = {
  get: (locale: string) => Promise<unknown>;
  remove: (locale: string) => Promise<void>;
  set: (locale: string, value: unknown) => Promise<void>;
};

type RepositoryOptions = {
  apiBaseUrl?: string;
  maxStaleMs?: number;
  now?: () => number;
  persistentStore?: MobileContentPersistentStore;
  request?: Request;
  ttlMs?: number;
};

type BootstrapNormalizerOptions = {
  apiBaseUrl?: string;
  expectedLocale?: string;
  fetchedAt?: number;
};

type CachedSnapshot = {
  snapshot: MobileContentSnapshot;
  fetchedAt: number;
};

type PersistedBootstrap = {
  persistence_version: 1;
  fetched_at: number;
  payload: unknown;
};

export class MobileContentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileContentContractError';
  }
}

/**
 * Strict Mobile-only bootstrap contract.
 *
 * The root channel/version gate prevents a PC site-content payload from being
 * accepted accidentally. Media also needs an explicit MOBILE scope and an
 * exact mobile variant. The bootstrap still contains bounded plain-text
 * metadata only; rich announcement bodies are loaded from the detail route.
 */
export function normalizeMobileContentBootstrap(
  payload: unknown,
  {
    apiBaseUrl = API_BASE_URL,
    expectedLocale = defaultLocale,
    fetchedAt = Date.now(),
  }: BootstrapNormalizerOptions = {},
): MobileContentSnapshot {
  const root = requireRecord(payload, 'bootstrap');
  if (readString(root.channel).toUpperCase() !== MOBILE_CHANNEL) {
    throw new MobileContentContractError(
      'Mobile content channel is missing or invalid',
    );
  }
  if (root.schema_version !== MOBILE_CONTENT_SCHEMA_VERSION) {
    throw new MobileContentContractError(
      'Mobile content schema version is unsupported',
    );
  }

  const locale = readString(root.locale);
  if (!locale || !localesMatch(locale, expectedLocale)) {
    throw new MobileContentContractError(
      'Mobile content locale does not match the request',
    );
  }

  const revision = readString(root.revision);
  if (!revision) {
    throw new MobileContentContractError('Mobile content revision is required');
  }

  const siteRecord = requireRecord(root.site, 'bootstrap.site');
  const homeRecord = requireRecord(root.home, 'bootstrap.home');
  const displayName = requireBoundedPlainText(
    siteRecord.display_name,
    'Mobile site display name',
    80,
    { collapseWhitespace: true, required: true },
  );
  const logo = normalizeRequiredNullableMedia(
    siteRecord.logo,
    'APP_LOGO',
    apiBaseUrl,
    'Mobile site logo',
  );
  const homeConfig = Object.prototype.hasOwnProperty.call(homeRecord, 'config')
    ? normalizeRequiredMobileHomeConfig(homeRecord.config)
    : createLegacyMobileHomeConfig();
  const hero = normalizeRequiredNullableHero(homeRecord.hero, apiBaseUrl);
  const promoValues = requireArray(homeRecord.promos, 'bootstrap.home.promos');
  const announcementValues = requireArray(
    root.announcements,
    'bootstrap.announcements',
  );

  return {
    schemaVersion: MOBILE_CONTENT_SCHEMA_VERSION,
    revision,
    locale,
    site: {
      displayName,
      logo,
    },
    homeConfig,
    hero,
    promos: promoValues.map((value, index) =>
      normalizeRequiredPromo(value, apiBaseUrl, index),
    ),
    announcements: announcementValues.map((value, index) =>
      normalizeRequiredAnnouncement(value, index),
    ),
    fetchedAt,
  };
}

export function createMobileContentRepository({
  apiBaseUrl = API_BASE_URL,
  maxStaleMs = DEFAULT_MAX_STALE_MS,
  now = Date.now,
  persistentStore,
  request = path => publicApiClient.get<unknown>(path),
  ttlMs = DEFAULT_CACHE_TTL_MS,
}: RepositoryOptions = {}): MobileContentRepository {
  const cache = new Map<string, CachedSnapshot>();
  const inFlight = new Map<string, Promise<MobileContentLoadResult>>();

  function peek(locale: string = defaultLocale) {
    const cacheKey = normalizeLocale(locale);
    const cached = cache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (now() - cached.fetchedAt > Math.max(0, maxStaleMs)) {
      cache.delete(cacheKey);
      return null;
    }
    return cached.snapshot;
  }

  function load({
    force = false,
    locale = defaultLocale,
  }: {
    force?: boolean;
    locale?: string;
  } = {}): Promise<MobileContentLoadResult> {
    const cacheKey = normalizeLocale(locale);
    const requestedAt = now();
    const cached = cache.get(cacheKey);

    if (
      !force &&
      cached &&
      requestedAt - cached.fetchedAt < Math.max(0, ttlMs)
    ) {
      return Promise.resolve({
        snapshot: cached.snapshot,
        source: 'cache',
        error: null,
      });
    }

    const existing = inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<MobileContentLoadResult> => {
      let fallback = cache.get(cacheKey);
      if (!fallback && persistentStore) {
        const persisted = await persistentStore.get(cacheKey).catch(() => null);
        const restored = normalizePersistedBootstrap(
          persisted,
          requestedAt,
          Math.max(0, maxStaleMs),
        );
        if (restored) {
          try {
            const snapshot = normalizeMobileContentBootstrap(restored.payload, {
              apiBaseUrl,
              expectedLocale: cacheKey,
              fetchedAt: restored.fetched_at,
            });
            fallback = { snapshot, fetchedAt: restored.fetched_at };
            cache.set(cacheKey, fallback);
          } catch {
            await persistentStore.remove(cacheKey).catch(() => undefined);
          }
        } else if (persisted !== null && persisted !== undefined) {
          await persistentStore.remove(cacheKey).catch(() => undefined);
        }
      }

      if (
        !force &&
        fallback &&
        requestedAt - fallback.fetchedAt < Math.max(0, ttlMs)
      ) {
        return {
          snapshot: fallback.snapshot,
          source: 'cache',
          error: null,
        };
      }

      const path = `${MOBILE_CONTENT_BOOTSTRAP_PATH}?locale=${encodeURIComponent(
        cacheKey,
      )}`;
      try {
        const payload = await request(path);
        const fetchedAt = now();
        const snapshot = normalizeMobileContentBootstrap(payload, {
          apiBaseUrl,
          expectedLocale: cacheKey,
          fetchedAt,
        });
        cache.set(cacheKey, { snapshot, fetchedAt });
        if (persistentStore) {
          await persistentStore
            .set(cacheKey, {
              persistence_version: MOBILE_CONTENT_PERSISTENCE_VERSION,
              fetched_at: fetchedAt,
              payload,
            } satisfies PersistedBootstrap)
            .catch(() => undefined);
        }
        return {
          snapshot,
          source: 'network' as const,
          error: null,
        };
      } catch {
        const canUseStale =
          Boolean(fallback) &&
          now() - fallback!.fetchedAt <= Math.max(0, maxStaleMs);
        return {
          snapshot: canUseStale ? fallback!.snapshot : null,
          source: canUseStale ? ('stale-cache' as const) : ('error' as const),
          error: '移动端内容更新失败，请稍后重试',
        };
      }
    })().finally(() => {
      if (inFlight.get(cacheKey) === promise) {
        inFlight.delete(cacheKey);
      }
    });

    inFlight.set(cacheKey, promise);
    return promise;
  }

  return {
    load,
    peek,
    reset: () => {
      cache.clear();
      inFlight.clear();
    },
  };
}

const asyncStorageMobileContentStore: MobileContentPersistentStore = {
  async get(locale) {
    const key = `${MOBILE_CONTENT_PERSISTENCE_KEY_PREFIX}${locale}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw || raw.length > MAX_PERSISTED_BOOTSTRAP_BYTES) {
      return raw ? { invalid: true } : null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return { invalid: true };
    }
  },
  async remove(locale) {
    await AsyncStorage.removeItem(
      `${MOBILE_CONTENT_PERSISTENCE_KEY_PREFIX}${locale}`,
    );
  },
  async set(locale, value) {
    const raw = JSON.stringify(value);
    if (raw.length > MAX_PERSISTED_BOOTSTRAP_BYTES) {
      await this.remove(locale);
      return;
    }
    await AsyncStorage.setItem(
      `${MOBILE_CONTENT_PERSISTENCE_KEY_PREFIX}${locale}`,
      raw,
    );
  },
};

const repository = createMobileContentRepository({
  persistentStore: asyncStorageMobileContentStore,
});

export const loadMobileContentBootstrap = repository.load;
export const getCachedMobileContent = repository.peek;

export function __resetMobileContentForTests() {
  repository.reset();
}

export async function fetchMobileAnnouncements(
  {
    page = 1,
    pageSize = 20,
    locale = defaultLocale,
    signal,
  }: {
    page?: number;
    pageSize?: number;
    locale?: string;
    signal?: AbortSignal;
  } = {},
): Promise<MobileAnnouncementList> {
  const expectedPage = requireBoundedPage(page, 1, Number.MAX_SAFE_INTEGER, 1);
  const expectedPageSize = requireBoundedPage(pageSize, 1, 50, 20);
  const normalizedLocale = normalizeLocale(locale);
  const path = `${MOBILE_ANNOUNCEMENT_DETAIL_PATH}?page=${expectedPage}&page_size=${expectedPageSize}&locale=${encodeURIComponent(normalizedLocale)}`;
  const root = requireRecord(
    await publicApiClient.get<unknown>(path, {signal}),
    'mobile announcement list',
  );
  const responsePage = requirePositiveIntegerValue(
    root.page,
    'mobile announcement page',
  );
  const responsePageSize = requirePositiveIntegerValue(
    root.page_size,
    'mobile announcement page size',
  );
  if (responsePage !== expectedPage || responsePageSize !== expectedPageSize) {
    throw new MobileContentContractError(
      'Mobile announcement pagination does not match the request',
    );
  }
  return {
    items: requireArray(root.items, 'mobile announcement items').map(
      (value, index) => normalizeRequiredAnnouncement(value, index),
    ),
    total: requireNonNegativeInteger(
      root.total,
      'mobile announcement total',
    ),
    page: responsePage,
    pageSize: responsePageSize,
    pages: requirePositiveIntegerValue(
      root.pages,
      'mobile announcement pages',
    ),
  };
}

export async function fetchMobileAnnouncementReadState(
  announcementIds: readonly (string | number)[],
  {signal}: {signal?: AbortSignal} = {},
): Promise<MobileAnnouncementReadState> {
  const ids = Array.from(
    new Set(announcementIds.map(value => normalizeMobileAnnouncementId(value))),
  );
  if (ids.length > 50) {
    throw new MobileContentContractError(
      'Mobile announcement read state request is too large',
    );
  }
  const query = ids.map(id => `announcement_id=${encodeURIComponent(id)}`).join('&');
  const root = requireRecord(
    await apiClient.get<unknown>(
      `${MOBILE_ANNOUNCEMENT_READS_PATH}${query ? `?${query}` : ''}`,
      {signal},
    ),
    'mobile announcement read state',
  );
  const requested = new Set(ids);
  const readIds = requireArray(
    root.read_ids,
    'mobile announcement read ids',
  ).map(value => normalizeMobileAnnouncementId(value));
  if (
    new Set(readIds).size !== readIds.length ||
    readIds.some(id => !requested.has(id))
  ) {
    throw new MobileContentContractError(
      'Mobile announcement read ids are invalid',
    );
  }
  return {
    unreadCount: requireNonNegativeInteger(
      root.unread_count,
      'mobile announcement unread count',
    ),
    readIds,
  };
}

export async function fetchMobileMessageUnreadCounts(
  {signal}: {signal?: AbortSignal} = {},
): Promise<MobileMessageUnreadCounts> {
  const root = requireRecord(
    await apiClient.get<unknown>(MOBILE_MESSAGE_UNREAD_COUNTS_PATH, {signal}),
    'mobile message unread counts',
  );
  const announcements = requireNonNegativeInteger(
    root.announcements,
    'mobile announcement unread count',
  );
  const supportReplies = requireNonNegativeInteger(
    root.support_replies,
    'support reply unread count',
  );
  const total = requireNonNegativeInteger(root.total, 'mobile unread total');
  if (total !== announcements + supportReplies) {
    throw new MobileContentContractError('Mobile unread total is inconsistent');
  }
  return {announcements, supportReplies, total};
}

export async function markMobileAnnouncementRead(
  announcementId: string | number,
  {signal}: {signal?: AbortSignal} = {},
) {
  const id = normalizeMobileAnnouncementId(announcementId);
  const root = requireRecord(
    await apiClient.post<unknown>(
      `${MOBILE_ANNOUNCEMENT_READS_PATH}/${encodeURIComponent(id)}`,
      {},
      {retry: 'none', signal},
    ),
    'mobile announcement read result',
  );
  if (root.ok !== true) {
    throw new MobileContentContractError(
      'Mobile announcement read result is invalid',
    );
  }
  return {
    unreadCount: requireNonNegativeInteger(
      root.unread_count,
      'mobile announcement unread count',
    ),
  };
}

export async function markAllMobileAnnouncementsRead(
  {signal}: {signal?: AbortSignal} = {},
) {
  const root = requireRecord(
    await apiClient.post<unknown>(
      `${MOBILE_ANNOUNCEMENT_READS_PATH}/read-all`,
      {},
      {retry: 'none', signal},
    ),
    'mobile announcement read-all result',
  );
  return {
    marked: requireNonNegativeInteger(
      root.marked,
      'mobile announcement marked count',
    ),
    unreadCount: requireNonNegativeInteger(
      root.unread_count,
      'mobile announcement unread count',
    ),
  };
}

/**
 * Loads one published Mobile announcement without synthesizing a fallback.
 *
 * Transport failures (including the public endpoint's 404) intentionally
 * propagate to the caller. A successful response is still rejected unless it
 * matches the requested id and one of the explicit Mobile content formats.
 */
export async function fetchMobileAnnouncementDetail(
  announcementId: string | number,
  { locale = defaultLocale, signal }: MobileAnnouncementDetailOptions = {},
): Promise<MobileAnnouncementDetail> {
  const expectedId = normalizeMobileAnnouncementId(announcementId);
  const normalizedLocale = normalizeLocale(locale);
  const path = `${MOBILE_ANNOUNCEMENT_DETAIL_PATH}/${encodeURIComponent(
    expectedId,
  )}?locale=${encodeURIComponent(normalizedLocale)}`;
  const payload = await publicApiClient.get<unknown>(path, { signal });
  return normalizeMobileAnnouncementDetail(payload, { expectedId });
}

export function normalizeMobileAnnouncementDetail(
  payload: unknown,
  { expectedId }: { expectedId: string | number },
): MobileAnnouncementDetail {
  const requestedId = normalizeMobileAnnouncementId(expectedId);
  const record = requireRecord(payload, 'mobile announcement detail');
  const responseId = normalizeMobileAnnouncementId(record.id);

  if (responseId !== requestedId) {
    throw new MobileContentContractError(
      'Mobile announcement id does not match the request',
    );
  }
  if (readString(record.scope) !== MOBILE_CHANNEL) {
    throw new MobileContentContractError(
      'Mobile announcement scope is missing or invalid',
    );
  }
  const contentFormat = readString(record.content_format);
  if (!MOBILE_ANNOUNCEMENT_CONTENT_FORMATS.has(contentFormat)) {
    throw new MobileContentContractError(
      'Mobile announcement content format is unsupported',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'summary')) {
    throw new MobileContentContractError(
      'Mobile announcement summary is required',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'published_at')) {
    throw new MobileContentContractError(
      'Mobile announcement published time is required',
    );
  }

  const title = requireBoundedPlainText(
    record.title,
    'Mobile announcement title',
    MAX_ANNOUNCEMENT_TITLE_LENGTH,
    { collapseWhitespace: true, required: true },
  );
  const summary =
    record.summary === null
      ? ''
      : requireBoundedPlainText(
          record.summary,
          'Mobile announcement summary',
          MAX_ANNOUNCEMENT_SUMMARY_LENGTH,
          { collapseWhitespace: true, required: false },
        );
  const content =
    contentFormat === 'PLAIN_TEXT'
      ? requireBoundedPlainText(
          record.content,
          'Mobile announcement content',
          MAX_ANNOUNCEMENT_CONTENT_LENGTH,
          { collapseWhitespace: false, required: true },
        )
      : requireBoundedSanitizedHtml(
          record.content,
          'Mobile announcement content',
          MAX_ANNOUNCEMENT_CONTENT_LENGTH,
        );

  return {
    id: responseId,
    scope: MOBILE_CHANNEL,
    title,
    summary,
    contentFormat: contentFormat as MobileAnnouncementDetail['contentFormat'],
    content,
    publishedAt: requirePublishedAt(record.published_at),
  };
}

function normalizePersistedBootstrap(
  value: unknown,
  requestedAt: number,
  maxStaleMs: number,
): PersistedBootstrap | null {
  const record = optionalRecord(value);
  if (
    !record ||
    record.persistence_version !== MOBILE_CONTENT_PERSISTENCE_VERSION ||
    typeof record.fetched_at !== 'number' ||
    !Number.isSafeInteger(record.fetched_at) ||
    record.fetched_at < 0 ||
    record.fetched_at > requestedAt ||
    requestedAt - record.fetched_at > maxStaleMs ||
    !Object.prototype.hasOwnProperty.call(record, 'payload')
  ) {
    return null;
  }
  return {
    persistence_version: MOBILE_CONTENT_PERSISTENCE_VERSION,
    fetched_at: record.fetched_at,
    payload: record.payload,
  };
}

function createLegacyMobileHomeConfig(): MobileHomeConfig {
  return {
    version: MOBILE_HOME_CONFIG_VERSION,
    sections: {
      assetSummary: true,
      quickEntries: true,
      marketShortcuts: true,
      promos: true,
      announcements: true,
    },
    quickEntries: [
      { id: 'DEPOSIT', title: '充值', description: '充值资产' },
      { id: 'WITHDRAW', title: '提现', description: '提现资产' },
      { id: 'TRANSFER', title: '划转', description: '账户划转' },
      { id: 'HISTORY', title: '资金流水', description: '查看记录' },
    ],
    marketShortcutLimit: 4,
    marketShortcutSymbols: [...DEFAULT_MOBILE_HOME_MARKET_SHORTCUT_SYMBOLS],
  };
}

function normalizeRequiredMobileHomeConfig(value: unknown): MobileHomeConfig {
  const label = 'bootstrap.home.config';
  const record = requireRecord(value, label);
  if (record.version !== MOBILE_HOME_CONFIG_VERSION) {
    throw new MobileContentContractError(`${label}.version is invalid`);
  }
  const sections = requireRecord(record.sections, `${label}.sections`);
  const sectionKeys = [
    'asset_summary',
    'quick_entries',
    'market_shortcuts',
    'promos',
    'announcements',
  ] as const;
  if (sectionKeys.some(key => typeof sections[key] !== 'boolean')) {
    throw new MobileContentContractError(`${label}.sections is invalid`);
  }

  const marketShortcutLimit = readPositiveInteger(record.market_shortcut_limit);
  if (marketShortcutLimit === null || marketShortcutLimit > 4) {
    throw new MobileContentContractError(
      `${label}.market_shortcut_limit is invalid`,
    );
  }

  const rawMarketShortcutSymbols = Object.prototype.hasOwnProperty.call(
    record,
    'market_shortcut_symbols',
  )
    ? requireArray(
        record.market_shortcut_symbols,
        `${label}.market_shortcut_symbols`,
      )
    : [...DEFAULT_MOBILE_HOME_MARKET_SHORTCUT_SYMBOLS];
  const marketShortcutSymbols = rawMarketShortcutSymbols.map(
    (rawSymbol, index) => {
      const symbol = readString(rawSymbol).trim().toUpperCase();
      if (!MOBILE_HOME_MARKET_SYMBOL_PATTERN.test(symbol)) {
        throw new MobileContentContractError(
          `${label}.market_shortcut_symbols[${index}] is invalid`,
        );
      }
      return symbol;
    },
  );
  if (
    marketShortcutSymbols.length !== 4 ||
    new Set(marketShortcutSymbols).size !== marketShortcutSymbols.length
  ) {
    throw new MobileContentContractError(
      `${label}.market_shortcut_symbols is invalid`,
    );
  }

  const entries = requireArray(record.quick_entries, `${label}.quick_entries`);
  if (entries.length > SUPPORTED_HOME_QUICK_ENTRY_IDS.size) {
    throw new MobileContentContractError(`${label}.quick_entries is invalid`);
  }
  const seen = new Set<string>();
  const quickEntries = entries.map((entry, index) => {
    const entryLabel = `${label}.quick_entries[${index}]`;
    const item = requireRecord(entry, entryLabel);
    const id = readString(item.id).toUpperCase();
    if (!SUPPORTED_HOME_QUICK_ENTRY_IDS.has(id) || seen.has(id)) {
      throw new MobileContentContractError(`${entryLabel}.id is invalid`);
    }
    seen.add(id);
    return {
      id: id as MobileHomeQuickEntryId,
      title: requireBoundedPlainText(item.title, `${entryLabel}.title`, 12, {
        collapseWhitespace: true,
        required: true,
      }),
      description: requireBoundedPlainText(
        item.description,
        `${entryLabel}.description`,
        24,
        { collapseWhitespace: true, required: true },
      ),
    };
  });

  return {
    version: MOBILE_HOME_CONFIG_VERSION,
    sections: {
      assetSummary: sections.asset_summary as boolean,
      quickEntries: sections.quick_entries as boolean,
      marketShortcuts: sections.market_shortcuts as boolean,
      promos: sections.promos as boolean,
      announcements: sections.announcements as boolean,
    },
    quickEntries,
    marketShortcutLimit,
    marketShortcutSymbols,
  };
}

function normalizeHero(
  value: unknown,
  apiBaseUrl: string,
): MobileHeroContent | null {
  const record = optionalRecord(value);
  if (!record || !hasMobileVariant(record, 'HOME_HERO')) {
    return null;
  }
  const id = readRequiredId(record);
  const title = toPlainText(record.title, 120);
  const image = normalizeMobileRasterImage(
    record.image,
    'HOME_HERO',
    apiBaseUrl,
  );
  if (!id || !title || !image) {
    return null;
  }

  return {
    id,
    title,
    subtitle: toPlainText(record.subtitle, 220),
    image,
    action: normalizeAction(record.action),
  };
}

function normalizeRequiredNullableHero(value: unknown, apiBaseUrl: string) {
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, 'bootstrap.home.hero');
  if (
    readString(record.scope) !== MOBILE_CHANNEL ||
    readString(record.variant) !== 'HOME_HERO' ||
    typeof record.subtitle !== 'string'
  ) {
    throw new MobileContentContractError('Mobile hero contract is invalid');
  }
  requireBoundedPlainText(record.title, 'Mobile hero title', 120, {
    collapseWhitespace: true,
    required: true,
  });
  requireBoundedPlainText(record.subtitle, 'Mobile hero subtitle', 220, {
    collapseWhitespace: true,
    required: false,
  });
  requireStrictMediaEnvelope(record.image, 'HOME_HERO', 'Mobile hero image');
  requireStrictAction(record.action, 'Mobile hero action');
  const hero = normalizeHero(record, apiBaseUrl);
  if (!hero) {
    throw new MobileContentContractError('Mobile hero contract is invalid');
  }
  return hero;
}

function normalizePromo(
  value: unknown,
  apiBaseUrl: string,
): MobilePromoContent | null {
  const record = optionalRecord(value);
  if (!record || !hasMobileVariant(record, 'HOME_PROMO')) {
    return null;
  }
  const id = readRequiredId(record);
  const title = toPlainText(record.title, 120);
  const image = normalizeMobileRasterImage(
    record.image,
    'HOME_PROMO',
    apiBaseUrl,
  );
  if (!id || !title || !image) {
    return null;
  }

  return {
    id,
    title,
    subtitle: toPlainText(record.subtitle, 180),
    image,
    action: normalizeAction(record.action),
  };
}

function normalizeRequiredPromo(
  value: unknown,
  apiBaseUrl: string,
  index: number,
) {
  const label = `bootstrap.home.promos[${index}]`;
  const record = requireRecord(value, label);
  if (
    readString(record.scope) !== MOBILE_CHANNEL ||
    readString(record.variant) !== 'HOME_PROMO' ||
    typeof record.subtitle !== 'string'
  ) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  requireBoundedPlainText(record.title, `${label}.title`, 120, {
    collapseWhitespace: true,
    required: true,
  });
  requireBoundedPlainText(record.subtitle, `${label}.subtitle`, 180, {
    collapseWhitespace: true,
    required: false,
  });
  requireStrictMediaEnvelope(record.image, 'HOME_PROMO', `${label}.image`);
  requireStrictAction(record.action, `${label}.action`);
  const promo = normalizePromo(record, apiBaseUrl);
  if (!promo) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return promo;
}

function normalizeAnnouncement(
  value: unknown,
): MobileAnnouncementSummary | null {
  const record = optionalRecord(value);
  if (readString(record?.scope).toUpperCase() !== MOBILE_CHANNEL) {
    return null;
  }
  const id = record ? readRequiredId(record) : '';
  const title = toPlainText(record?.title, 180);
  if (!record || !id || !title) {
    return null;
  }

  return {
    id,
    title,
    summary: toPlainText(record.summary, 280),
    categoryLabel: toPlainText(record.category_label, 40),
    isPinned: record.is_pinned === true,
    publishedAt: normalizeDateString(record.published_at),
  };
}

function normalizeRequiredAnnouncement(value: unknown, index: number) {
  const label = `bootstrap.announcements[${index}]`;
  const record = requireRecord(value, label);
  if (
    readString(record.scope) !== MOBILE_CHANNEL ||
    typeof record.title !== 'string' ||
    typeof record.summary !== 'string' ||
    typeof record.category_label !== 'string' ||
    typeof record.is_pinned !== 'boolean' ||
    !Object.prototype.hasOwnProperty.call(record, 'published_at') ||
    (record.published_at !== null &&
      normalizeDateString(record.published_at) === null)
  ) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  const id = normalizeMobileAnnouncementId(record.id);
  requireBoundedPlainText(
    record.title,
    `${label}.title`,
    MAX_ANNOUNCEMENT_TITLE_LENGTH,
    { collapseWhitespace: true, required: true },
  );
  requireBoundedPlainText(
    record.summary,
    `${label}.summary`,
    MAX_ANNOUNCEMENT_SUMMARY_LENGTH,
    { collapseWhitespace: true, required: false },
  );
  requireBoundedPlainText(
    record.category_label,
    `${label}.category_label`,
    40,
    { collapseWhitespace: true, required: false },
  );
  const announcement = normalizeAnnouncement(record);
  if (!announcement) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return { ...announcement, id };
}

function normalizeRequiredNullableMedia(
  value: unknown,
  variant: MobileMediaVariant,
  apiBaseUrl: string,
  label: string,
) {
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, label);
  if (
    readString(record.scope) !== MOBILE_CHANNEL ||
    readString(record.variant) !== variant
  ) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  const image = normalizeMobileRasterImage(record, variant, apiBaseUrl);
  if (!image) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return image;
}

function requireStrictMediaEnvelope(
  value: unknown,
  variant: MobileMediaVariant,
  label: string,
) {
  const record = requireRecord(value, label);
  if (
    readString(record.scope) !== MOBILE_CHANNEL ||
    readString(record.variant) !== variant
  ) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return record;
}

function requireStrictAction(value: unknown, label: string) {
  if (value === null) {
    return null;
  }
  const action = normalizeAction(value);
  if (!action) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return action;
}

function normalizeMobileRasterImage(
  value: unknown,
  variant: MobileMediaVariant,
  apiBaseUrl: string,
): MobileRasterImage | null {
  const record = optionalRecord(value);
  if (!record || !hasMobileVariant(record, variant)) {
    return null;
  }

  const width = readPositiveInteger(record.width);
  const height = readPositiveInteger(record.height);
  const byteSize = readPositiveInteger(record.byte_size);
  const mimeType = readString(record.mime_type).toLowerCase();
  const url = resolveMobileRasterUrl(record.url, apiBaseUrl);

  if (
    !url ||
    !SUPPORTED_IMAGE_TYPES.has(mimeType) ||
    width === null ||
    height === null ||
    byteSize === null ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS ||
    byteSize > MAX_IMAGE_BYTES
  ) {
    return null;
  }

  return {
    url,
    width,
    height,
    byteSize,
    mimeType: mimeType as MobileRasterImage['mimeType'],
  };
}

function normalizeAction(value: unknown): MobileContentAction | null {
  const record = optionalRecord(value);
  if (readString(record?.type).toUpperCase() !== 'ROUTE') {
    return null;
  }
  const route = readString(record?.route).toUpperCase();
  return SUPPORTED_ROUTES.has(route)
    ? { type: 'ROUTE', route: route as MobileRoute }
    : null;
}

function resolveMobileRasterUrl(
  candidate: unknown,
  apiBaseUrl: string,
): string | null {
  const value = readString(candidate);
  if (!value || hasUnsafeUrlCharacters(value) || isSvgPath(value)) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    const absolute = parseHttpUrl(value);
    return absolute && !absolute.authority.includes('@') ? value : null;
  }

  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.split(/[?#]/, 1)[0].split('/').includes('..')
  ) {
    return null;
  }

  const base = parseHttpUrl(apiBaseUrl);
  return base ? `${base.scheme}://${base.authority}${value}` : null;
}

function hasMobileVariant(
  record: Record<string, unknown> | null,
  variant: MobileMediaVariant,
) {
  return (
    readString(record?.scope).toUpperCase() === MOBILE_CHANNEL &&
    readString(record?.variant).toUpperCase() === variant
  );
}

function toPlainText(value: unknown, maxLength: number) {
  const text = readString(value);
  if (!text) {
    return '';
  }

  return decodeCommonEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function decodeCommonEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function normalizeDateString(value: unknown): string | null {
  const text = readString(value);
  if (!text || Number.isNaN(Date.parse(text))) {
    return null;
  }
  return text;
}

function readRequiredId(record: Record<string, unknown>) {
  return typeof record.id === 'number' || typeof record.id === 'string'
    ? String(record.id).trim()
    : '';
}

function readPositiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function requirePositiveIntegerValue(value: unknown, label: string) {
  const result = readPositiveInteger(value);
  if (result === null) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return result;
}

function requireNonNegativeInteger(value: unknown, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new MobileContentContractError(`${label} is invalid`);
  }
  return value;
}

function requireBoundedPage(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new MobileContentContractError(`${label} must be an array`);
  }
  return value;
}

function normalizeLocale(value: string) {
  const candidate = (readString(value) || defaultLocale).replace(/_/g, '-');
  if (
    candidate.length > 35 ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(candidate)
  ) {
    throw new MobileContentContractError('Mobile content locale is invalid');
  }

  return candidate
    .split('-')
    .map((part, index) => {
      if (index === 0) {
        return part.toLowerCase();
      }
      if (/^[A-Za-z]{4}$/.test(part)) {
        return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
      }
      if (/^[A-Za-z]{2}$/.test(part)) {
        return part.toUpperCase();
      }
      return part.toLowerCase();
    })
    .join('-');
}

function localesMatch(left: string, right: string) {
  return (
    normalizeLocaleForComparison(left) === normalizeLocaleForComparison(right)
  );
}

function normalizeLocaleForComparison(value: string) {
  return readString(value).replace(/_/g, '-').toLowerCase();
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMobileAnnouncementId(value: unknown) {
  const candidate =
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value > 0
        ? String(value)
        : ''
      : readString(value);
  if (!/^[1-9]\d{0,15}$/.test(candidate)) {
    throw new MobileContentContractError('Mobile announcement id is invalid');
  }

  const numericId = Number(candidate);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new MobileContentContractError('Mobile announcement id is invalid');
  }
  return String(numericId);
}

function requireBoundedPlainText(
  value: unknown,
  label: string,
  maxLength: number,
  {
    collapseWhitespace,
    required,
  }: { collapseWhitespace: boolean; required: boolean },
) {
  if (typeof value !== 'string') {
    throw new MobileContentContractError(`${label} must be plain text`);
  }
  if (value.length > maxLength || hasDisallowedPlainTextControl(value)) {
    throw new MobileContentContractError(`${label} exceeds safe limits`);
  }

  const text = collapseWhitespace
    ? value.replace(/\s+/g, ' ').trim()
    : value.replace(/\r\n?/g, '\n').trim();
  if ((required && !text) || containsHtmlMarkup(text)) {
    throw new MobileContentContractError(`${label} must be plain text`);
  }
  return text;
}

function requireBoundedSanitizedHtml(
  value: unknown,
  label: string,
  maxLength: number,
) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    hasDisallowedPlainTextControl(value)
  ) {
    throw new MobileContentContractError(`${label} exceeds safe limits`);
  }
  if (
    /<\s*(?:script|iframe|object|embed|form|input|button|style|link|meta)\b/i.test(
      value,
    ) ||
    /\son[a-z]+\s*=/i.test(value) ||
    /(?:javascript|data)\s*:/i.test(value)
  ) {
    throw new MobileContentContractError(`${label} is not sanitized`);
  }
  return value.trim();
}

function requirePublishedAt(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const publishedAt = readString(value);
  if (
    !publishedAt ||
    publishedAt.length > MAX_PUBLISHED_AT_LENGTH ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    throw new MobileContentContractError(
      'Mobile announcement published time is invalid',
    );
  }
  return publishedAt;
}

function hasDisallowedPlainTextControl(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}

function containsHtmlMarkup(value: string) {
  const decodedMarkers = value
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>');
  return /<(?:!--|!doctype\b|\/?[a-z][^>]*?)>/i.test(decodedMarkers);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function requireRecord(value: unknown, label: string) {
  const record = optionalRecord(value);
  if (!record) {
    throw new MobileContentContractError(`${label} must be an object`);
  }
  return record;
}

function isSvgPath(value: string) {
  const path = value.split(/[?#]/, 1)[0].toLowerCase();
  return path.endsWith('.svg') || path.endsWith('.svgz');
}

function hasUnsafeUrlCharacters(value: string) {
  if (value.includes('\\')) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function parseHttpUrl(value: string) {
  const match = readString(value).match(
    /^(https?):\/\/([^/?#\s]+)(?:[/?#]|$)/i,
  );
  if (!match) {
    return null;
  }
  return {
    scheme: match[1].toLowerCase(),
    authority: match[2],
  };
}
