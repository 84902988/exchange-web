import {
  MOBILE_ANNOUNCEMENT_DETAIL_PATH,
  MOBILE_CONTENT_BOOTSTRAP_PATH,
  MobileContentContractError,
  createMobileContentRepository,
  fetchMobileAnnouncementReadState,
  fetchMobileAnnouncements,
  fetchMobileAnnouncementDetail,
  fetchMobileMessageUnreadCounts,
  markAllMobileAnnouncementsRead,
  markMobileAnnouncementRead,
  normalizeMobileAnnouncementDetail,
  normalizeMobileContentBootstrap,
} from '../src/api/mobileContent';
import { ApiClientError, apiClient, publicApiClient } from '../src/api/client';

function mobileImage(
  variant: 'APP_LOGO' | 'HOME_HERO' | 'HOME_PROMO',
  overrides: Record<string, unknown> = {},
) {
  return {
    scope: 'MOBILE',
    variant,
    url: `/static/mobile/${variant.toLowerCase()}.webp`,
    width: 1200,
    height: 600,
    byte_size: 480_000,
    mime_type: 'image/webp',
    ...overrides,
  };
}

function validBootstrap(revision = 'mobile-r1') {
  return {
    channel: 'MOBILE',
    schema_version: 1,
    revision,
    locale: 'zh-CN',
    site: {
      display_name: ' Example   Mobile ',
      logo: mobileImage('APP_LOGO', {
        width: 256,
        height: 256,
        byte_size: 42_000,
        mime_type: 'image/png',
        url: '/static/mobile/logo.png',
      }),
    },
    home: {
      config: {
        version: 1,
        sections: {
          asset_summary: true,
          quick_entries: true,
          market_shortcuts: true,
          promos: true,
          announcements: true,
        },
        quick_entries: [
          { id: 'DEPOSIT', title: '充值', description: '充值资产' },
          { id: 'HISTORY', title: '资金记录', description: '查看流水' },
        ],
        bank_portal_url: 'https://bank.example.com/portal?source=mobile',
        market_shortcut_limit: 3,
        market_shortcut_symbols: [
          'BTCUSDT',
          'RCBUSDT',
          'ETHUSDT',
          'NVDAUSDT_PERP',
        ],
      },
      hero: {
        id: 'hero-1',
        scope: 'MOBILE',
        variant: 'HOME_HERO',
        title: '移动端   主视觉',
        subtitle: '专为手机布局提供',
        image: mobileImage('HOME_HERO'),
        action: { type: 'ROUTE', route: 'REGISTER' },
      },
      promos: [
        {
          id: 7,
          scope: 'MOBILE',
          variant: 'HOME_PROMO',
          title: '移动端活动',
          subtitle: '适配窄屏内容',
          image: mobileImage('HOME_PROMO', {
            url: 'https://cdn.example.com/mobile/promo.webp',
          }),
          action: { type: 'ROUTE', route: 'MARKETS' },
        },
      ],
    },
    announcements: [
      {
        id: 11,
        scope: 'MOBILE',
        title: '系统   公告',
        summary: '仅使用   纯文本摘要',
        category_label: '公告',
        is_pinned: true,
        published_at: '2026-07-31T10:30:00+08:00',
        content: '<p>Desktop HTML must not enter bootstrap output.</p>',
      },
    ],
  };
}

function validAnnouncementDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 11,
    scope: 'MOBILE',
    title: 'Service update',
    summary: 'Mobile clients will be upgraded gradually.',
    content_format: 'PLAIN_TEXT',
    content: 'Line one.\n\nLine two.',
    published_at: '2026-07-31T10:30:00+08:00',
    ...overrides,
  };
}

describe('mobile content bootstrap contract', () => {
  it('normalizes only the dedicated versioned Mobile payload', () => {
    const snapshot = normalizeMobileContentBootstrap(validBootstrap(), {
      apiBaseUrl: 'http://10.0.2.2:8000/api',
      expectedLocale: 'zh-CN',
      fetchedAt: 123,
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      revision: 'mobile-r1',
      locale: 'zh-CN',
      fetchedAt: 123,
      site: {
        displayName: 'Example Mobile',
        logo: {
          url: 'http://10.0.2.2:8000/static/mobile/logo.png',
          width: 256,
          height: 256,
          byteSize: 42_000,
          mimeType: 'image/png',
        },
      },
      homeConfig: {
        version: 1,
        sections: {
          assetSummary: true,
          quickEntries: true,
          marketShortcuts: true,
          promos: true,
          announcements: true,
        },
        quickEntries: [
          { id: 'DEPOSIT', title: '充值', description: '充值资产' },
          { id: 'HISTORY', title: '资金记录', description: '查看流水' },
        ],
        bankPortalUrl: 'https://bank.example.com/portal?source=mobile',
        marketShortcutLimit: 3,
        marketShortcutSymbols: ['BTCUSDT', 'RCBUSDT', 'ETHUSDT', 'NVDAUSDT_PERP'],
      },
      hero: {
        id: 'hero-1',
        title: '移动端 主视觉',
        action: { type: 'ROUTE', route: 'REGISTER' },
      },
      promos: [
        {
          id: '7',
          title: '移动端活动',
          image: {
            url: 'https://cdn.example.com/mobile/promo.webp',
          },
          action: { type: 'ROUTE', route: 'MARKETS' },
        },
      ],
      announcements: [
        {
          id: '11',
          title: '系统 公告',
          summary: '仅使用 纯文本摘要',
          categoryLabel: '公告',
          isPinned: true,
        },
      ],
    });
    expect(snapshot.announcements[0]).not.toHaveProperty('content');
  });

  it('rejects the existing PC site-content shape instead of using it as fallback', () => {
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          site_name: 'PC Site',
          home_hero_title: 'Desktop hero',
          home_hero_image: '/homepage-bg480.mp4',
          items: [],
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow(MobileContentContractError);
  });

  it('rejects unsupported schema versions and locale mismatches', () => {
    expect(() =>
      normalizeMobileContentBootstrap(
        { ...validBootstrap(), schema_version: 2 },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('schema version');
    expect(() =>
      normalizeMobileContentBootstrap(validBootstrap(), {
        expectedLocale: 'en-US',
      }),
    ).toThrow('locale');
  });

  it('allows explicit empty Mobile content without fabricating records', () => {
    const payload = validBootstrap();
    const snapshot = normalizeMobileContentBootstrap(
      {
        ...payload,
        site: { ...payload.site, logo: null },
        home: { hero: null, promos: [] },
        announcements: [],
      },
      { expectedLocale: 'zh-CN' },
    );

    expect(snapshot.site.logo).toBeNull();
    expect(snapshot.hero).toBeNull();
    expect(snapshot.promos).toEqual([]);
    expect(snapshot.announcements).toEqual([]);
  });

  it('keeps a bounded legacy home layout during a rolling backend upgrade', () => {
    const payload = validBootstrap();
    delete (payload.home as { config?: unknown }).config;

    const snapshot = normalizeMobileContentBootstrap(payload, {
      expectedLocale: 'zh-CN',
    });

    expect(snapshot.homeConfig).toMatchObject({
      version: 1,
      marketShortcutLimit: 4,
      marketShortcutSymbols: ['BTCUSDT', 'RCBUSDT', 'ETHUSDT', 'NVDAUSDT_PERP'],
      sections: { quickEntries: true, announcements: true },
      bankPortalUrl: null,
    });
    expect(snapshot.homeConfig.quickEntries.map(item => item.id)).toEqual([
      'DEPOSIT',
      'WITHDRAW',
      'TRANSFER',
      'HISTORY',
    ]);
  });

  it('accepts an older version-one home config without a bank portal', () => {
    const payload = validBootstrap();
    delete (payload.home.config as {bank_portal_url?: unknown}).bank_portal_url;

    const snapshot = normalizeMobileContentBootstrap(payload, {
      expectedLocale: 'zh-CN',
    });

    expect(snapshot.homeConfig.bankPortalUrl).toBeNull();
  });

  it.each([
    ['unknown config version', { version: 2 }, 'version'],
    [
      'arbitrary quick-entry route',
      {
        quick_entries: [
          { id: 'EXTERNAL_URL', title: '外链', description: '不允许' },
        ],
      },
      'id',
    ],
    ['oversized market count', { market_shortcut_limit: 5 }, 'limit'],
    [
      'non-HTTPS bank portal',
      {bank_portal_url: 'http://bank.example.com/portal'},
      'bank_portal_url',
    ],
    [
      'credential-bearing bank portal',
      {bank_portal_url: 'https://user:secret@bank.example.com/portal'},
      'bank_portal_url',
    ],
    [
      'duplicate market shortcuts',
      {
        market_shortcut_symbols: [
          'BTCUSDT',
          'BTCUSDT',
          'ETHUSDT',
          'NVDAUSDT_PERP',
        ],
      },
      'market_shortcut_symbols',
    ],
  ])('rejects unsafe home configuration: %s', (_case, overrides, error) => {
    const payload = validBootstrap();
    const config = payload.home.config;
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: {
            ...payload.home,
            config: { ...config, ...overrides },
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow(error);
  });

  it.each([
    [
      'missing site',
      (payload: ReturnType<typeof validBootstrap>) => ({
        ...payload,
        site: undefined,
      }),
    ],
    [
      'malformed home',
      (payload: ReturnType<typeof validBootstrap>) => ({
        ...payload,
        home: [],
      }),
    ],
    [
      'missing promos',
      (payload: ReturnType<typeof validBootstrap>) => ({
        ...payload,
        home: { ...payload.home, promos: undefined },
      }),
    ],
    [
      'malformed announcements',
      (payload: ReturnType<typeof validBootstrap>) => ({
        ...payload,
        announcements: {},
      }),
    ],
  ])('rejects a %s bootstrap container', (_case, mutate) => {
    expect(() =>
      normalizeMobileContentBootstrap(mutate(validBootstrap()), {
        expectedLocale: 'zh-CN',
      }),
    ).toThrow(MobileContentContractError);
  });

  it('rejects malformed non-null media instead of turning it into an empty state', () => {
    const payload = validBootstrap();
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          site: {
            ...payload.site,
            logo: mobileImage('APP_LOGO', {
              url: '/icons/default.svg',
              mime_type: 'image/svg+xml',
            }),
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('logo');

    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: {
            ...payload.home,
            hero: {
              ...payload.home.hero,
              image: mobileImage('HOME_HERO', { width: 5_000 }),
            },
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('hero');

    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: {
            ...payload.home,
            hero: {
              ...payload.home.hero,
              image: mobileImage('HOME_HERO', {
                byte_size: 2_000_001,
              }),
            },
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('hero');
  });

  it('rejects any invalid declared promo or announcement record', () => {
    const payload = validBootstrap();
    const invalidPromo = {
      id: 8,
      scope: 'DESKTOP',
      variant: 'HOME_PROMO',
      title: 'PC banner',
      subtitle: 'must not be accepted',
      image: mobileImage('HOME_PROMO'),
      action: null,
    };
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: { ...payload.home, promos: [invalidPromo] },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('promos[0]');

    const invalidAnnouncement = {
      id: 12,
      scope: 'DESKTOP',
      title: 'PC announcement',
      summary: 'must not be accepted',
      category_label: '公告',
      is_pinned: false,
      published_at: '2026-07-30T10:00:00+08:00',
    };
    expect(() =>
      normalizeMobileContentBootstrap(
        { ...payload, announcements: [invalidAnnouncement] },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('announcements[0]');
  });

  it('rejects a non-null invalid navigation action', () => {
    const payload = validBootstrap();
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: {
            ...payload.home,
            hero: {
              ...payload.home.hero,
              action: {
                type: 'URL',
                route: 'https://example.invalid/mobile',
              },
            },
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('action');
  });

  it('rejects unsafe or overlong operator content instead of sanitizing it', () => {
    const payload = validBootstrap();
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          site: { ...payload.site, display_name: 'Example <b>Mobile</b>' },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('display name');
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: {
            ...payload.home,
            hero: { ...payload.home.hero, title: '移动端 <b>主视觉</b>' },
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('hero title');
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          site: { ...payload.site, display_name: 'A'.repeat(81) },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('display name');
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          home: {
            ...payload.home,
            hero: { ...payload.home.hero, title: 'H'.repeat(121) },
          },
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('hero title');
    expect(() =>
      normalizeMobileContentBootstrap(
        {
          ...payload,
          announcements: [
            { ...payload.announcements[0], summary: 'S'.repeat(281) },
          ],
        },
        { expectedLocale: 'zh-CN' },
      ),
    ).toThrow('summary');
  });
});

describe('mobile announcement read contracts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the complete paged Mobile announcement list', async () => {
    const get = jest.spyOn(publicApiClient, 'get').mockResolvedValue({
      items: [
        {
          id: 11,
          scope: 'MOBILE',
          title: '系统维护公告',
          summary: '维护窗口说明',
          category_label: '系统公告',
          is_pinned: true,
          published_at: '2026-08-02T10:00:00Z',
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      pages: 1,
    });

    await expect(fetchMobileAnnouncements()).resolves.toMatchObject({
      total: 1,
      items: [{id: '11', title: '系统维护公告', isPinned: true}],
    });
    expect(get).toHaveBeenCalledWith(
      `${MOBILE_ANNOUNCEMENT_DETAIL_PATH}?page=1&page_size=20&locale=zh-CN`,
      {signal: undefined},
    );
  });

  it('keeps read ids scoped to the requested Mobile announcement ids', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      unread_count: 2,
      read_ids: [11],
    });
    await expect(
      fetchMobileAnnouncementReadState([11, '12']),
    ).resolves.toEqual({unreadCount: 2, readIds: ['11']});

    jest.spyOn(apiClient, 'get').mockResolvedValueOnce({
      unread_count: 2,
      read_ids: [99],
    });
    await expect(fetchMobileAnnouncementReadState([11, 12])).rejects.toThrow(
      'read ids are invalid',
    );
  });

  it('validates the combined badge count and disables POST replay', async () => {
    const get = jest.spyOn(apiClient, 'get').mockResolvedValue({
      announcements: 2,
      support_replies: 1,
      total: 3,
    });
    await expect(fetchMobileMessageUnreadCounts()).resolves.toEqual({
      announcements: 2,
      supportReplies: 1,
      total: 3,
    });
    expect(get).toHaveBeenCalledWith('/mobile/content/unread-counts', {
      signal: undefined,
    });

    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({ok: true, unread_count: 1})
      .mockResolvedValueOnce({marked: 1, unread_count: 0});
    await expect(markMobileAnnouncementRead(11)).resolves.toEqual({
      unreadCount: 1,
    });
    await expect(markAllMobileAnnouncementsRead()).resolves.toEqual({
      marked: 1,
      unreadCount: 0,
    });
    expect(post).toHaveBeenNthCalledWith(
      1,
      '/mobile/content/announcement-reads/11',
      {},
      {retry: 'none', signal: undefined},
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/mobile/content/announcement-reads/read-all',
      {},
      {retry: 'none', signal: undefined},
    );
  });
});

describe('mobile content repository', () => {
  it('requests only the dedicated Mobile bootstrap endpoint and caches by TTL', async () => {
    let now = 1_000;
    const request = jest.fn().mockResolvedValue(validBootstrap());
    const repository = createMobileContentRepository({
      apiBaseUrl: 'http://10.0.2.2:8000',
      now: () => now,
      request,
      ttlMs: 100,
    });

    const first = await repository.load({ locale: 'zh-CN' });
    const second = await repository.load({ locale: 'zh-CN' });
    now += 101;
    const third = await repository.load({ locale: 'zh-CN' });

    expect(first.source).toBe('network');
    expect(second.source).toBe('cache');
    expect(third.source).toBe('network');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      `${MOBILE_CONTENT_BOOTSTRAP_PATH}?locale=zh-CN`,
    );
    const requestedPaths = request.mock.calls.flat().join(' ');
    expect(requestedPaths).not.toContain('/site/config');
    expect(requestedPaths).not.toContain('/home/banners');
    expect(requestedPaths).not.toContain('/announcements');
  });

  it('single-flights concurrent loads for the same locale', async () => {
    let release!: (payload: unknown) => void;
    const gate = new Promise<unknown>(resolve => {
      release = resolve;
    });
    const request = jest.fn().mockReturnValue(gate);
    const repository = createMobileContentRepository({
      apiBaseUrl: 'http://10.0.2.2:8000',
      request,
    });

    const first = repository.load({ locale: 'zh-CN' });
    const second = repository.load({ locale: 'zh-CN' });

    expect(first).toBe(second);
    expect(request).toHaveBeenCalledTimes(1);
    release(validBootstrap());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.source).toBe('network');
  });

  it('retains the last successful snapshot after transport failure', async () => {
    let now = 5_000;
    const request = jest
      .fn()
      .mockResolvedValueOnce(validBootstrap('mobile-r1'))
      .mockRejectedValueOnce(new Error('offline'));
    const repository = createMobileContentRepository({
      now: () => now,
      request,
      ttlMs: 100,
    });

    const success = await repository.load();
    now += 101;
    const stale = await repository.load();

    expect(stale.source).toBe('stale-cache');
    expect(stale.error).toBeTruthy();
    expect(stale.snapshot).toBe(success.snapshot);
    expect(repository.peek()?.revision).toBe('mobile-r1');
  });

  it('keeps the previous snapshot when a refresh violates the contract', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(validBootstrap('mobile-r1'))
      .mockResolvedValueOnce({ channel: 'DESKTOP' });
    const repository = createMobileContentRepository({ request });

    const success = await repository.load();
    const stale = await repository.load({ force: true });

    expect(stale.source).toBe('stale-cache');
    expect(stale.snapshot).toBe(success.snapshot);
    expect(repository.peek()?.revision).toBe('mobile-r1');
  });

  it('stops serving expired operator content after the bounded stale window', async () => {
    let now = 1_000;
    const request = jest
      .fn()
      .mockResolvedValueOnce(validBootstrap('mobile-r1'))
      .mockRejectedValueOnce(new Error('offline'));
    const repository = createMobileContentRepository({
      maxStaleMs: 200,
      now: () => now,
      request,
      ttlMs: 100,
    });

    await repository.load();
    now += 201;
    const expired = await repository.load();

    expect(expired).toEqual({
      snapshot: null,
      source: 'error',
      error: '移动端内容更新失败，请稍后重试',
    });
    expect(repository.peek()).toBeNull();
  });

  it('returns an explicit error with no fabricated snapshot on first-load failure', async () => {
    const repository = createMobileContentRepository({
      request: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(repository.load()).resolves.toEqual({
      snapshot: null,
      source: 'error',
      error: '移动端内容更新失败，请稍后重试',
    });
    expect(repository.peek()).toBeNull();
  });

  it('restores a validated last-good bootstrap across repository restarts', async () => {
    let now = 1_000;
    const records = new Map<string, unknown>();
    const persistentStore = {
      get: jest.fn(async (locale: string) => records.get(locale) ?? null),
      remove: jest.fn(async (locale: string) => {
        records.delete(locale);
      }),
      set: jest.fn(async (locale: string, value: unknown) => {
        records.set(locale, value);
      }),
    };
    const first = createMobileContentRepository({
      now: () => now,
      persistentStore,
      request: jest.fn().mockResolvedValue(validBootstrap('mobile-r1')),
      ttlMs: 100,
    });

    await expect(first.load({ locale: 'zh-CN' })).resolves.toMatchObject({
      source: 'network',
      snapshot: { revision: 'mobile-r1' },
    });
    expect(persistentStore.set).toHaveBeenCalledTimes(1);

    now += 101;
    const secondRequest = jest.fn().mockRejectedValue(new Error('offline'));
    const second = createMobileContentRepository({
      maxStaleMs: 500,
      now: () => now,
      persistentStore,
      request: secondRequest,
      ttlMs: 100,
    });
    await expect(second.load({ locale: 'zh-CN' })).resolves.toMatchObject({
      source: 'stale-cache',
      snapshot: { revision: 'mobile-r1' },
    });
    expect(secondRequest).toHaveBeenCalledTimes(1);
    expect(persistentStore.remove).not.toHaveBeenCalled();
  });

  it('removes expired or contract-invalid persisted content before fallback', async () => {
    const persistentStore = {
      get: jest.fn().mockResolvedValue({
        persistence_version: 1,
        fetched_at: 100,
        payload: { channel: 'DESKTOP' },
      }),
      remove: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const repository = createMobileContentRepository({
      maxStaleMs: 200,
      now: () => 1_000,
      persistentStore,
      request: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(repository.load()).resolves.toEqual({
      snapshot: null,
      source: 'error',
      error: '移动端内容更新失败，请稍后重试',
    });
    expect(persistentStore.remove).toHaveBeenCalledTimes(1);
  });
});

describe('mobile announcement detail contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the public client with a canonical locale and validates the response id', async () => {
    const get = jest
      .spyOn(publicApiClient, 'get')
      .mockResolvedValue(validAnnouncementDetail());

    await expect(
      fetchMobileAnnouncementDetail('11', { locale: ' zh_cn ' }),
    ).resolves.toEqual({
      id: '11',
      scope: 'MOBILE',
      title: 'Service update',
      summary: 'Mobile clients will be upgraded gradually.',
      contentFormat: 'PLAIN_TEXT',
      content: 'Line one.\n\nLine two.',
      publishedAt: '2026-07-31T10:30:00+08:00',
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      `${MOBILE_ANNOUNCEMENT_DETAIL_PATH}/11?locale=zh-CN`,
      { signal: undefined },
    );
  });

  it('rejects an invalid request id before starting transport', async () => {
    const get = jest.spyOn(publicApiClient, 'get');

    await expect(fetchMobileAnnouncementDetail('../desktop')).rejects.toThrow(
      'id is invalid',
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('accepts only the explicit server-sanitized rich-text format', () => {
    expect(
      normalizeMobileAnnouncementDetail(
        validAnnouncementDetail({
          content_format: 'SANITIZED_HTML',
          content: '<p>安全<strong>正文</strong></p>',
        }),
        {expectedId: 11},
      ),
    ).toMatchObject({
      contentFormat: 'SANITIZED_HTML',
      content: '<p>安全<strong>正文</strong></p>',
    });

    expect(() =>
      normalizeMobileAnnouncementDetail(
        validAnnouncementDetail({
          content_format: 'SANITIZED_HTML',
          content: '<img src="x" onerror="steal()">',
        }),
        {expectedId: 11},
      ),
    ).toThrow('not sanitized');
  });

  it('rejects a response for a different announcement id', () => {
    expect(() =>
      normalizeMobileAnnouncementDetail(validAnnouncementDetail({ id: 12 }), {
        expectedId: 11,
      }),
    ).toThrow('does not match');
  });

  it.each([
    ['desktop scope', { scope: 'DESKTOP' }, 'scope'],
    ['lowercase scope', { scope: 'mobile' }, 'scope'],
    ['HTML format', { content_format: 'HTML' }, 'content format'],
    [
      'lowercase content format',
      { content_format: 'plain_text' },
      'content format',
    ],
  ])(
    'rejects a non-Mobile plain-text contract: %s',
    (_case, overrides, error) => {
      expect(() =>
        normalizeMobileAnnouncementDetail(validAnnouncementDetail(overrides), {
          expectedId: 11,
        }),
      ).toThrow(error);
    },
  );

  it.each([
    ['empty title', { title: '   ' }, 'title'],
    ['HTML title', { title: '<b>Title</b>' }, 'title'],
    ['oversized title', { title: 'A'.repeat(256) }, 'title'],
    ['empty content', { content: '' }, 'content'],
    ['HTML content', { content: '<p>HTML body</p>' }, 'content'],
    [
      'encoded HTML content',
      { content: '&lt;script&gt;bad&lt;/script&gt;' },
      'content',
    ],
    [
      'control character in title',
      { title: `A${String.fromCharCode(0)}B` },
      'title',
    ],
    ['oversized content', { content: 'A'.repeat(50_001) }, 'content'],
  ])('rejects unsafe or unbounded text: %s', (_case, overrides, error) => {
    expect(() =>
      normalizeMobileAnnouncementDetail(validAnnouncementDetail(overrides), {
        expectedId: 11,
      }),
    ).toThrow(error);
  });

  it('allows an absent summary value but requires all response fields', () => {
    expect(
      normalizeMobileAnnouncementDetail(
        validAnnouncementDetail({ summary: null, published_at: null }),
        { expectedId: 11 },
      ),
    ).toMatchObject({ summary: '', publishedAt: null });

    const missingSummary = validAnnouncementDetail();
    delete missingSummary.summary;
    expect(() =>
      normalizeMobileAnnouncementDetail(missingSummary, { expectedId: 11 }),
    ).toThrow('summary is required');
  });

  it('propagates a public 404 without fabricating announcement content', async () => {
    const notFound = new ApiClientError(
      'Mobile announcement not found',
      'MOBILE_ANNOUNCEMENT_NOT_FOUND',
      404,
    );
    jest.spyOn(publicApiClient, 'get').mockRejectedValue(notFound);

    await expect(fetchMobileAnnouncementDetail(11)).rejects.toBe(notFound);
  });
});
