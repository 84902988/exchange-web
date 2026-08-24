import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { MobileActivity, MobileActivityBanner } from '../src/api/activity';
import ActivityCenterScreen from '../src/screens/home/ActivityCenterScreen';
import ActivityDetailScreen from '../src/screens/home/ActivityDetailScreen';

const mockFetchActivities = jest.fn();
const mockFetchActivity = jest.fn();
const mockFetchActivityBanners = jest.fn();

jest.mock('../src/api/activity', () => ({
  ...jest.requireActual('../src/api/activity'),
  fetchActivities: (...args: unknown[]) => mockFetchActivities(...args),
  fetchActivity: (...args: unknown[]) => mockFetchActivity(...args),
  fetchActivityBanners: (...args: unknown[]) =>
    mockFetchActivityBanners(...args),
}));

function activity(overrides: Partial<MobileActivity> = {}): MobileActivity {
  return {
    id: 1,
    title: '新用户注册礼',
    subtitle: '完成注册与认证即可参与',
    description: '这是平台真实活动简介。',
    detailContent: '活动规则：\n1. 完成注册。\n2. 通过平台审核。',
    rewardText: '最高 10 USDT 体验金',
    status: 'active',
    startAt: null,
    endAt: '2026-12-31T23:59:00',
    ctaText: '立即参与',
    ctaUrl: '/register',
    ...overrides,
  };
}

function banner(
  overrides: Partial<MobileActivityBanner> = {},
): MobileActivityBanner {
  return {
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
    ...overrides,
  };
}

function navigation() {
  return { navigate: jest.fn(), goBack: jest.fn() };
}

function centerScreen(target = navigation()) {
  return (
    <ActivityCenterScreen
      navigation={target as never}
      route={{ key: 'activity-center', name: 'ActivityCenter' } as never}
    />
  );
}

function detailScreen(item: MobileActivity, target = navigation()) {
  return (
    <ActivityDetailScreen
      navigation={target as never}
      route={
        {
          key: `activity-${item.id}`,
          name: 'ActivityDetail',
          params: { activityId: item.id, title: item.title },
        } as never
      }
    />
  );
}

function textValues(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node =>
      typeof node.props.children === 'string' ? [node.props.children] : [],
    );
}

describe('mobile activity screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchActivityBanners.mockResolvedValue([]);
  });

  it('renders a real list item and opens its detail route', async () => {
    mockFetchActivities.mockResolvedValue([activity()]);
    mockFetchActivityBanners.mockResolvedValue([banner()]);
    const target = navigation();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(centerScreen(target));
      await Promise.resolve();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '活动中心',
        '热门福利、交易赛事与返佣活动',
        '新用户注册礼',
        '完成注册与认证即可参与',
        '最高 10 USDT 体验金',
      ]),
    );
    const button = renderer.root.findByProps({
      accessibilityLabel: '新用户注册礼，查看活动详情',
    });
    act(() => button.props.onPress());
    expect(target.navigate).toHaveBeenCalledWith('ActivityDetail', {
      activityId: 1,
      title: '新用户注册礼',
    });
    expect(mockFetchActivities).toHaveBeenCalledWith({
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
    });
    expect(mockFetchActivityBanners).toHaveBeenCalledWith({
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
    });
    act(() => renderer.unmount());
  });

  it('shows a truthful empty state for an empty public list', async () => {
    mockFetchActivities.mockResolvedValue([]);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(centerScreen());
      await Promise.resolve();
    });
    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '暂无进行中的活动',
        '新活动发布后会显示在这里。',
      ]),
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('模拟活动');
    act(() => renderer.unmount());
  });

  it('keeps the real activity list available when the optional banner fails', async () => {
    mockFetchActivities.mockResolvedValue([activity()]);
    mockFetchActivityBanners.mockRejectedValue(new Error('banner unavailable'));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(centerScreen());
      await Promise.resolve();
    });
    expect(textValues(renderer)).toEqual(
      expect.arrayContaining(['当前进行中', '新用户注册礼']),
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      'banner unavailable',
    );
    act(() => renderer.unmount());
  });

  it('shows a bounded error and retries without leaking transport text', async () => {
    mockFetchActivities
      .mockRejectedValueOnce(new Error('SQL traceback: secret'))
      .mockResolvedValueOnce([activity()]);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(centerScreen());
      await Promise.resolve();
    });
    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '活动暂不可用',
        '未能取得平台活动，请检查网络后重试。',
      ]),
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('SQL traceback');

    const retry = renderer.root.findByProps({ accessibilityLabel: '重新加载' });
    await act(async () => {
      retry.props.onPress();
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain('新用户注册礼');
    act(() => renderer.unmount());
  });

  it('renders activity rules and maps a supported CTA to the real app route', async () => {
    const item = activity({
      id: 2,
      title: '邀请好友返佣',
      ctaText: '查看邀请链接',
      ctaUrl: '/invite',
    });
    mockFetchActivity.mockResolvedValue(item);
    const target = navigation();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(detailScreen(item, target));
      await Promise.resolve();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '邀请好友返佣',
        '最高 10 USDT 体验金',
        '活动规则：\n1. 完成注册。\n2. 通过平台审核。',
        '2026-12-31 23:59',
      ]),
    );
    const cta = renderer.root.findByProps({
      accessibilityLabel: '查看邀请链接',
    });
    act(() => cta.props.onPress());
    expect(target.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Assets',
      params: { section: 'invite' },
    });
    expect(mockFetchActivity).toHaveBeenCalledWith(2, {
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
    });
    act(() => renderer.unmount());
  });

  it('does not render an actionable button for an unsupported CTA', async () => {
    const item = activity({ ctaText: '未知入口', ctaUrl: '/unknown' });
    mockFetchActivity.mockResolvedValue(item);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(detailScreen(item));
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: '未知入口' }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
