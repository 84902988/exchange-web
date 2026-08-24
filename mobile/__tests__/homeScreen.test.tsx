import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { MobileContentSnapshot } from '../src/api/mobileContent';
import type { MarketInstrument } from '../src/api/market';
import SectionTitle from '../src/components/common/SectionTitle';
import HomeScreen, { getHomeHoldingSymbols } from '../src/screens/home/HomeScreen';
import type { AssetSnapshot } from '../src/services/assetSnapshot';

const mockNavigate = jest.fn();
const mockUseAuth = jest.fn();
const mockUseAssetSnapshot = jest.fn();
const mockUseMarketFavorites = jest.fn();
const mockUseMobileHomeData = jest.fn();
const mockUseMobileMessageUnreadCounts = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('../src/hooks/useMobileHomeData', () => ({
  useMobileHomeData: () => mockUseMobileHomeData(),
}));

jest.mock('../src/hooks/useAssetSnapshot', () => ({
  useAssetSnapshot: () => mockUseAssetSnapshot(),
}));

jest.mock('../src/hooks/useMarketFavorites', () => ({
  useMarketFavorites: () => mockUseMarketFavorites(),
}));

jest.mock('../src/hooks/useMobileMessageUnreadCounts', () => ({
  useMobileMessageUnreadCounts: () => mockUseMobileMessageUnreadCounts(),
}));

jest.mock('../src/components/home/AssetSummary', () => () => null);

function content(): MobileContentSnapshot {
  const image = {
    url: 'https://cdn.example.com/mobile/content.webp',
    width: 1200,
    height: 600,
    byteSize: 200_000,
    mimeType: 'image/webp' as const,
  };
  return {
    schemaVersion: 1,
    revision: 'home-r1',
    locale: 'zh-CN',
    site: { displayName: 'Mobile', logo: null },
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
        { id: 'WITHDRAW', title: '提现', description: '提现资产' },
        { id: 'TRANSFER', title: '划转', description: '账户划转' },
        { id: 'HISTORY', title: '资金流水', description: '查看记录' },
      ],
      marketShortcutLimit: 4,
      marketShortcutSymbols: ['BTCUSDT', 'RCBUSDT', 'ETHUSDT', 'NVDAUSDT_PERP'],
    },
    hero: {
      id: 'hero-1',
      title: 'Real hero',
      subtitle: 'Real hero subtitle',
      image,
      action: { type: 'ROUTE', route: 'REGISTER' },
    },
    promos: [
      {
        id: 'promo-1',
        title: 'Real promo',
        subtitle: 'Real promo subtitle',
        image,
        action: { type: 'ROUTE', route: 'MARKETS' },
      },
    ],
    announcements: [
      {
        id: 'notice-1',
        title: 'Real notice',
        summary: 'Real notice summary',
        categoryLabel: 'System',
        isPinned: false,
        publishedAt: '2026-07-31T10:30:00+08:00',
      },
    ],
    fetchedAt: 100,
  };
}

function market(
  id: string,
  category: MarketInstrument['category'],
  rank: number,
): MarketInstrument {
  return {
    id,
    symbol: id.toUpperCase(),
    displaySymbol: id,
    name: id,
    category,
    price: 100,
    changePercent: 1,
    pricePrecision: 2,
    source: 'api',
    overviewRank: rank,
  };
}

function renderHome() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<HomeScreen />);
  });
  return renderer;
}

describe('HomeScreen real-data wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      isLoggedIn: false,
      loading: false,
      user: null,
    });
    mockUseMobileHomeData.mockReturnValue({
      content: null,
      markets: [],
      contentLoading: false,
      marketsLoading: false,
      contentError: null,
      marketsError: null,
    });
    mockUseAssetSnapshot.mockReturnValue({
      snapshot: null,
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
      reload: jest.fn(),
    });
    mockUseMarketFavorites.mockReturnValue({
      symbols: [],
      loading: false,
      error: false,
      toggle: jest.fn(async () => undefined),
    });
    mockUseMobileMessageUnreadCounts.mockReturnValue({
      counts: null,
      loading: false,
      error: null,
      hasUnread: false,
    });
  });

  it('derives positive held symbols from the trusted asset snapshot in value order', () => {
    const snapshot = {
      rows: [
        {symbol: 'ETH', totalAmount: 1, valueUsdt: 1900},
        {symbol: 'BTC', totalAmount: 0, valueUsdt: 0},
        {symbol: 'RCB', totalAmount: 2, valueUsdt: null},
        {symbol: 'ETH', totalAmount: 0.5, valueUsdt: 950},
      ],
    } as AssetSnapshot;

    expect(getHomeHoldingSymbols(snapshot)).toEqual(['ETH', 'RCB']);
  });

  it('does not render data section headings without successful data', () => {
    const renderer = renderHome();
    expect(renderer.root.findAllByType(SectionTitle)).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('未登录');

    const profile = renderer.root.findByProps({
      accessibilityLabel: '用户入口',
    });
    const search = renderer.root.findByProps({
      accessibilityLabel: '搜索市场',
    });
    const activityCenter = renderer.root.findByProps({
      accessibilityLabel: '活动中心，查看全部活动与奖励规则',
    });
    const aboutPage = renderer.root.findByProps({
      accessibilityLabel: '关于平台，了解 Exchange',
    });
    act(() => {
      profile.props.onPress();
      search.props.onPress();
      activityCenter.props.onPress();
      aboutPage.props.onPress();
    });
    expect(mockNavigate).toHaveBeenNthCalledWith(1, 'Auth', {
      screen: 'Login',
    });
    expect(mockNavigate).toHaveBeenNthCalledWith(2, 'Markets');
    expect(mockNavigate).toHaveBeenNthCalledWith(3, 'ActivityCenter');
    expect(mockNavigate).toHaveBeenNthCalledWith(4, 'AboutPage');

    act(() => {
      renderer.unmount();
    });
  });

  it('wires real content, announcements, markets and implemented asset entries', () => {
    mockUseAuth.mockReturnValue({
      isLoggedIn: true,
      loading: false,
      user: {
        id: 7,
        email: 'user@example.com',
        avatar_url: 'https://cdn.example.com/avatar.webp',
      },
    });
    mockUseMobileHomeData.mockReturnValue({
      content: content(),
      markets: [market('BTC/USDT', 'crypto', 1), market('CHAIN', 'onchain', 2)],
      contentLoading: false,
      marketsLoading: false,
      contentError: null,
      marketsError: null,
    });
    mockUseMobileMessageUnreadCounts.mockReturnValue({
      counts: { announcements: 2, supportReplies: 1, total: 3 },
      loading: false,
      error: null,
      hasUnread: true,
    });
    const renderer = renderHome();

    expect(
      renderer.root.findByProps({ accessibilityLabel: '用户头像' }).props
        .source,
    ).toEqual({
      uri: 'https://cdn.example.com/avatar.webp',
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain('已登录');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('user@example.com');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Real hero');

    expect(
      renderer.root.findAllByType(SectionTitle).map(node => node.props.title),
    ).toEqual(['市场速览', '活动', '行情榜单', '公告']);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('CHAIN');

    const marketButton = renderer.root.findAllByProps({
      accessibilityLabel: 'BTC/USDT，100.00',
    })[0];
    const noticeButton = renderer.root.findByProps({
      accessibilityLabel: 'Real notice',
    });
    const allAnnouncementsButton = renderer.root.findByProps({
      accessibilityLabel: '公告，查看全部',
    });
    const inviteButton = renderer.root.findByProps({
      accessibilityLabel: '邀请好友，邀请与奖励',
    });
    const profileButton = renderer.root.findByProps({
      accessibilityLabel: '用户入口',
    });
    act(() => {
      profileButton.props.onPress();
      marketButton.props.onPress();
      noticeButton.props.onPress();
      allAnnouncementsButton.props.onPress();
      inviteButton.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Account');
    expect(mockNavigate).toHaveBeenCalledWith('Markets', {
      category: 'crypto',
    });
    expect(mockNavigate).toHaveBeenCalledWith('MobileAnnouncementDetail', {
      announcementId: 'notice-1',
      title: 'Real notice',
    });
    expect(mockNavigate).toHaveBeenCalledWith('AnnouncementCenter');
    expect(mockNavigate).toHaveBeenCalledWith('Assets', {
      section: 'invite',
    });

    const supportButton = renderer.root.findByProps({
      accessibilityLabel: '客服与帮助中心',
    });
    const notificationsButton = renderer.root.findByProps({
      accessibilityLabel: '公告与客服回复',
    });
    expect(notificationsButton.props.badge).toBe(true);
    act(() => {
      supportButton.props.onPress();
      notificationsButton.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('HelpCenter');
    expect(mockNavigate).toHaveBeenCalledWith('HomeMessageCenter', {
      initialTab: 'announcements',
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('maps a real guest hero action through the Mobile route whitelist', () => {
    mockUseMobileHomeData.mockReturnValue({
      content: content(),
      markets: [],
      contentLoading: false,
      marketsLoading: false,
      contentError: null,
      marketsError: null,
    });
    const renderer = renderHome();
    expect(JSON.stringify(renderer.toJSON())).toContain('Mobile');
    const heroButton = renderer.root.findByProps({
      accessibilityLabel: 'Real hero，查看详情',
    });
    act(() => {
      heroButton.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Auth', { screen: 'Register' });

    act(() => {
      renderer.unmount();
    });
  });

  it('obeys backend-driven section visibility around real service shortcuts', () => {
    const configured = content();
    configured.homeConfig = {
      version: 1,
      sections: {
        assetSummary: false,
        quickEntries: true,
        marketShortcuts: false,
        promos: false,
        announcements: false,
      },
      quickEntries: [],
      marketShortcutLimit: 1,
      marketShortcutSymbols: ['ETHUSDT', 'BTCUSDT', 'RCBUSDT', 'NVDAUSDT_PERP'],
    };
    mockUseAuth.mockReturnValue({
      isLoggedIn: true,
      loading: false,
      user: { id: 7, email: 'user@example.com' },
    });
    mockUseMobileHomeData.mockReturnValue({
      content: configured,
      markets: [market('BTC/USDT', 'crypto', 1)],
      contentLoading: false,
      marketsLoading: false,
      contentError: null,
      marketsError: null,
    });

    const renderer = renderHome();

    expect(renderer.root.findAllByType(SectionTitle)).toHaveLength(0);
    const rewardsButton = renderer.root.findByProps({
      accessibilityLabel: '奖励记录，奖励流水',
    });
    const blackCardButton = renderer.root.findByProps({
      accessibilityLabel: 'BlackCard，会员权益',
    });
    act(() => {
      blackCardButton.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('BlackCard');
    act(() => {
      rewardsButton.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('AssetHistory', {
      initialFilter: 'inviteReward',
    });

    act(() => {
      renderer.unmount();
    });
  });
});
