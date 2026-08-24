import React from 'react';
import { Text, TextInput } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { MobileHelpArticle, MobileHelpContent } from '../src/api/help';
import HelpArticleScreen from '../src/screens/home/HelpArticleScreen';
import HelpCenterScreen, {
  selectHelpArticles,
} from '../src/screens/home/HelpCenterScreen';

const mockFetchHelpContent = jest.fn();
const mockFetchHelpArticle = jest.fn();
const mockUseAuth = jest.fn();

jest.mock('../src/api/help', () => ({
  ...jest.requireActual('../src/api/help'),
  fetchHelpContent: (...args: unknown[]) => mockFetchHelpContent(...args),
  fetchHelpArticle: (...args: unknown[]) => mockFetchHelpArticle(...args),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => mockUseAuth(),
}));

function article(
  id: string,
  title: string,
  overrides: Partial<MobileHelpArticle> = {},
): MobileHelpArticle {
  const articleId = Number(id.replace('cms-', ''));
  return {
    id,
    articleId,
    slug: `article-${articleId}`,
    categoryId: 'account',
    categoryTitle: '账户管理',
    title,
    summary: `${title}摘要`,
    content: `${title}正文\n1. 第一步\n2. 第二步`,
    tags: ['帮助', '账户'],
    hot: false,
    sortOrder: articleId,
    ...overrides,
  };
}

function content(): MobileHelpContent {
  const register = article('cms-1', '如何注册账户', { hot: true });
  const fee = article('cms-24', '交易手续费说明', {
    categoryId: 'trading',
    categoryTitle: '交易指南',
    tags: ['手续费', '交易'],
  });
  return {
    categories: [
      {
        id: 'account',
        title: '账户管理',
        description: '注册与账户安全',
        sortOrder: 10,
        articles: [register],
      },
      {
        id: 'trading',
        title: '交易指南',
        description: '交易与手续费',
        sortOrder: 20,
        articles: [fee],
      },
    ],
    hotArticles: [register],
  };
}

function navigation() {
  return { navigate: jest.fn(), goBack: jest.fn() };
}

function centerScreen(target = navigation()) {
  return (
    <HelpCenterScreen
      navigation={target as never}
      route={{ key: 'help-center', name: 'HelpCenter' } as never}
    />
  );
}

function articleScreen(item: MobileHelpArticle, target = navigation()) {
  return (
    <HelpArticleScreen
      navigation={target as never}
      route={
        {
          key: `help-${item.id}`,
          name: 'HelpArticle',
          params: { articleId: item.id, title: item.title },
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

describe('mobile help center screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isLoggedIn: false });
  });

  it('renders the hot list and opens a real article route', async () => {
    mockFetchHelpContent.mockResolvedValue(content());
    const target = navigation();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(centerScreen(target));
      await Promise.resolve();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '帮助中心',
        '文章分类',
        '热门文章',
        '账户管理',
        '交易指南',
        '如何注册账户',
      ]),
    );
    const card = renderer.root.findByProps({
      accessibilityLabel: '如何注册账户，查看帮助文章',
    });
    act(() => card.props.onPress());
    expect(target.navigate).toHaveBeenCalledWith('HelpArticle', {
      articleId: 'cms-1',
      title: '如何注册账户',
    });
    expect(mockFetchHelpContent).toHaveBeenCalledWith({
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
      forceRefresh: false,
    });
    act(() => renderer.unmount());
  });

  it('searches across all categories without fabricating a fee table', async () => {
    mockFetchHelpContent.mockResolvedValue(content());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(centerScreen());
      await Promise.resolve();
    });
    const search = renderer.root.findByType(TextInput);
    act(() => search.props.onChangeText('手续费'));
    expect(textValues(renderer)).toContain('交易手续费说明');
    expect(textValues(renderer)).not.toContain('0.1%');
    act(() => renderer.unmount());
  });

  it('routes support through login for guests and to tickets for members', async () => {
    mockFetchHelpContent.mockResolvedValue(content());
    const guestTarget = navigation();
    let guest!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      guest = ReactTestRenderer.create(centerScreen(guestTarget));
      await Promise.resolve();
    });
    act(() =>
      guest.root
        .findByProps({
          accessibilityLabel: '联系客服，创建或查看客服工单',
        })
        .props.onPress(),
    );
    expect(guestTarget.navigate).toHaveBeenCalledWith('Auth', {
      screen: 'Login',
    });
    act(() => guest.unmount());

    mockUseAuth.mockReturnValue({ isLoggedIn: true });
    const memberTarget = navigation();
    let member!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      member = ReactTestRenderer.create(centerScreen(memberTarget));
      await Promise.resolve();
    });
    act(() =>
      member.root
        .findByProps({
          accessibilityLabel: '联系客服，创建或查看客服工单',
        })
        .props.onPress(),
    );
    expect(memberTarget.navigate).toHaveBeenCalledWith('HomeMessageCenter', {
      initialTab: 'support',
    });
    act(() => member.unmount());
  });

  it('shows truthful empty and bounded error states', async () => {
    mockFetchHelpContent
      .mockResolvedValueOnce({ categories: [], hotArticles: [] })
      .mockRejectedValueOnce(new Error('SQL traceback secret'));
    let empty!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      empty = ReactTestRenderer.create(centerScreen());
      await Promise.resolve();
    });
    expect(textValues(empty)).toContain('暂无帮助内容');
    act(() => empty.unmount());

    let failed!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      failed = ReactTestRenderer.create(centerScreen());
      await Promise.resolve();
    });
    expect(textValues(failed)).toContain('帮助内容暂不可用');
    expect(JSON.stringify(failed.toJSON())).not.toContain('SQL traceback');
    act(() => failed.unmount());
  });

  it('renders validated article content and member support routing', async () => {
    mockUseAuth.mockReturnValue({ isLoggedIn: true });
    const item = content().categories[1].articles[0];
    mockFetchHelpArticle.mockResolvedValue(item);
    const target = navigation();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(articleScreen(item, target));
      await Promise.resolve();
    });
    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '交易手续费说明',
        '交易指南',
        '交易手续费说明正文\n1. 第一步\n2. 第二步',
      ]),
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: '仍需帮助，联系客服' })
        .props.onPress(),
    );
    expect(target.navigate).toHaveBeenCalledWith('HomeMessageCenter', {
      initialTab: 'support',
    });
    expect(mockFetchHelpArticle).toHaveBeenCalledWith('cms-24', {
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
      forceRefresh: false,
    });
    act(() => renderer.unmount());
  });

  it('selects hot, category and search results deterministically', () => {
    const value = content();
    expect(selectHelpArticles(value, '', null).map(item => item.id)).toEqual([
      'cms-1',
    ]);
    expect(
      selectHelpArticles(value, '', 'trading').map(item => item.id),
    ).toEqual(['cms-24']);
    expect(
      selectHelpArticles(value, '手续费', null).map(item => item.id),
    ).toEqual(['cms-24']);
  });
});
