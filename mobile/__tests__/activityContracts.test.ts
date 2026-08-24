import {
  ActivityContractError,
  fetchActivities,
  fetchActivity,
  fetchActivityBanners,
  formatActivityDateTime,
  normalizeActivityDetail,
  normalizeActivityList,
  normalizeActivityBanners,
} from '../src/api/activity';
import { publicApiClient } from '../src/api/client';
import { resolveActivityCtaTarget } from '../src/navigation/activityRoute';

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: '新用户注册礼',
    subtitle: '完成注册即可参与',
    description: '平台真实活动简介。',
    detail_content: '活动规则：\r\n1. 完成注册。\r\n2. 通过审核。',
    reward_text: '最高 10 USDT 体验金',
    status: 'active',
    start_at: null,
    end_at: '2026-12-31T23:59:00',
    cta_text: '立即参与',
    cta_url: '/register',
    ...overrides,
  };
}

function banner(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: '活动中心',
    subtitle: '热门福利、交易赛事与返佣活动',
    media_type: 'image',
    media_url: '',
    link_url: '/activity',
    sort_order: 10,
    enabled: true,
    start_at: null,
    end_at: null,
    ...overrides,
  };
}

describe('mobile activity contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes the public activity payload without inventing fields', () => {
    expect(normalizeActivityList({ items: [activity()] })).toEqual([
      {
        id: 1,
        title: '新用户注册礼',
        subtitle: '完成注册即可参与',
        description: '平台真实活动简介。',
        detailContent: '活动规则：\n1. 完成注册。\n2. 通过审核。',
        rewardText: '最高 10 USDT 体验金',
        status: 'active',
        startAt: null,
        endAt: '2026-12-31T23:59:00',
        ctaText: '立即参与',
        ctaUrl: '/register',
      },
    ]);
    expect(normalizeActivityDetail({ item: activity() }, 1).id).toBe(1);
  });

  it.each([
    { items: [activity(), activity()] },
    { items: [activity({ status: 'inactive' })] },
    { items: [activity({ title: '<script>unsafe</script>' })] },
    { items: [activity({ detail_content: '&lt;iframe&gt;x&lt;/iframe&gt;' })] },
    { items: [activity({ cta_url: 'https://evil.example/redirect' })] },
    { items: [activity({ end_at: '2026-13-50T99:99:00' })] },
  ])('rejects an unsafe or inconsistent list payload %#', payload => {
    expect(() => normalizeActivityList(payload)).toThrow(ActivityContractError);
  });

  it('rejects a detail response for a different activity id', () => {
    expect(() =>
      normalizeActivityDetail({ item: activity({ id: 2 }) }, 1),
    ).toThrow('活动详情与请求不一致');
  });

  it('normalizes only enabled, safe public activity banners', () => {
    expect(normalizeActivityBanners({ items: [banner()] })).toEqual([
      {
        id: 1,
        title: '活动中心',
        subtitle: '热门福利、交易赛事与返佣活动',
        mediaType: 'image',
        mediaUrl: '',
        linkUrl: '/activity',
        sortOrder: 10,
        enabled: true,
        startAt: null,
        endAt: null,
      },
    ]);
  });

  it.each([
    { items: [banner(), banner()] },
    { items: [banner({ enabled: false })] },
    { items: [banner({ title: '<script>bad</script>' })] },
    { items: [banner({ media_type: 'html' })] },
    { items: [banner({ media_url: ['java', 'script:alert(1)'].join('') })] },
    { items: [banner({ link_url: 'https://evil.example' })] },
  ])('rejects an unsafe activity banner payload %#', payload => {
    expect(() => normalizeActivityBanners(payload)).toThrow(
      ActivityContractError,
    );
  });

  it('uses the public endpoints, locale and abort signal', async () => {
    const get = jest
      .spyOn(publicApiClient, 'get')
      .mockResolvedValueOnce({ items: [activity()] })
      .mockResolvedValueOnce({ item: activity() })
      .mockResolvedValueOnce({ items: [banner()] });
    const controller = new AbortController();

    await expect(
      fetchActivities({ locale: 'zh_CN', signal: controller.signal }),
    ).resolves.toHaveLength(1);
    await expect(
      fetchActivity(1, { locale: 'zh_CN', signal: controller.signal }),
    ).resolves.toMatchObject({ id: 1 });
    await expect(
      fetchActivityBanners({
        locale: 'zh_CN',
        signal: controller.signal,
      }),
    ).resolves.toHaveLength(1);
    expect(get).toHaveBeenNthCalledWith(1, '/activities?limit=20&lang=zh-CN', {
      signal: controller.signal,
    });
    expect(get).toHaveBeenNthCalledWith(2, '/activities/1?lang=zh-CN', {
      signal: controller.signal,
    });
    expect(get).toHaveBeenNthCalledWith(
      3,
      '/activities/banners?limit=10&lang=zh-CN',
      { signal: controller.signal },
    );
  });

  it('formats platform wall-clock values without applying a device-timezone shift', () => {
    expect(formatActivityDateTime('2026-12-31T23:59:00')).toBe(
      '2026-12-31 23:59',
    );
    expect(formatActivityDateTime(null)).toBe('长期有效');
  });

  it.each([
    ['/register', { type: 'auth', screen: 'Register' }],
    [
      '/invite',
      { type: 'main', screen: 'Assets', params: { section: 'invite' } },
    ],
    ['/trade/spot', { type: 'main', screen: 'Trade' }],
    ['/trade/futures', { type: 'main', screen: 'Contract' }],
    ['/asset/deposit', { type: 'root', screen: 'AssetDeposit' }],
  ] as const)(
    'maps supported CTA %s to an implemented route',
    (url, target) => {
      expect(resolveActivityCtaTarget(url)).toEqual(target);
    },
  );

  it('fails closed for an unsupported CTA', () => {
    expect(resolveActivityCtaTarget('/unknown/path')).toBeNull();
    expect(resolveActivityCtaTarget('https://evil.example')).toBeNull();
  });
});
