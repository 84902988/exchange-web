import {
  __resetHelpContentCacheForTests,
  fetchHelpArticle,
  fetchHelpContent,
  HelpContentContractError,
  normalizeHelpContent,
} from '../src/api/help';
import { publicApiClient } from '../src/api/client';

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cms-1',
    article_id: 1,
    slug: 'create-account',
    category_id: 'account',
    category_title: '账户管理',
    title: '如何注册账户',
    summary: '使用邮箱创建账户并完成验证。',
    content: '注册流程\r\n1. 输入邮箱。\r\n2. 完成验证码。',
    tags: ['注册', '账户'],
    hot: true,
    sort_order: 10,
    enabled: true,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  const item = article();
  return {
    categories: [
      {
        id: 'account',
        category_key: 'account',
        title: '账户管理',
        description: '注册、登录与账户安全',
        sort_order: 10,
        enabled: true,
        articles: [item],
      },
    ],
    hotArticles: [item],
    ...overrides,
  };
}

describe('mobile help-content contract', () => {
  beforeEach(() => {
    __resetHelpContentCacheForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes enabled CMS categories, articles and hot references', () => {
    expect(normalizeHelpContent(payload())).toEqual({
      categories: [
        {
          id: 'account',
          title: '账户管理',
          description: '注册、登录与账户安全',
          sortOrder: 10,
          articles: [
            {
              id: 'cms-1',
              articleId: 1,
              slug: 'create-account',
              categoryId: 'account',
              categoryTitle: '账户管理',
              title: '如何注册账户',
              summary: '使用邮箱创建账户并完成验证。',
              content: '注册流程\n1. 输入邮箱。\n2. 完成验证码。',
              tags: ['注册', '账户'],
              hot: true,
              sortOrder: 10,
            },
          ],
        },
      ],
      hotArticles: [
        expect.objectContaining({ id: 'cms-1', title: '如何注册账户' }),
      ],
    });
  });

  it.each([
    payload({
      categories: [
        {
          id: 'account',
          category_key: 'different',
          title: '账户管理',
          description: '',
          sort_order: 0,
          enabled: true,
          articles: [],
        },
      ],
      hotArticles: [],
    }),
    payload({
      categories: [
        {
          id: 'account',
          category_key: 'account',
          title: '账户管理',
          description: '',
          sort_order: 0,
          enabled: false,
          articles: [],
        },
      ],
      hotArticles: [],
    }),
    payload({
      categories: [
        {
          id: 'account',
          category_key: 'account',
          title: '账户管理',
          description: '',
          sort_order: 0,
          enabled: true,
          articles: [article({ id: 'cms-2' })],
        },
      ],
      hotArticles: [],
    }),
    payload({
      categories: [
        {
          id: 'account',
          category_key: 'account',
          title: '账户管理',
          description: '',
          sort_order: 0,
          enabled: true,
          articles: [article({ content: '<script>unsafe</script>' })],
        },
      ],
      hotArticles: [],
    }),
    payload({ hotArticles: [article({ summary: '不一致' })] }),
    payload({ hotArticles: [article({ id: 'cms-9', article_id: 9 })] }),
    payload({
      categories: [
        {
          id: 'account',
          category_key: 'account',
          title: '账户管理',
          description: '',
          sort_order: 0,
          enabled: true,
          articles: [article({ tags: ['重复', '重复'] })],
        },
      ],
      hotArticles: [],
    }),
  ])('rejects unsafe or inconsistent CMS content %#', value => {
    expect(() => normalizeHelpContent(value)).toThrow(HelpContentContractError);
  });

  it('uses the public locale endpoint and reuses the bounded in-memory cache', async () => {
    const get = jest.spyOn(publicApiClient, 'get').mockResolvedValue(payload());
    const controller = new AbortController();

    await expect(
      fetchHelpContent({ locale: 'zh_CN', signal: controller.signal }),
    ).resolves.toMatchObject({ categories: [{ id: 'account' }] });
    await expect(
      fetchHelpArticle('cms-1', {
        locale: 'zh_CN',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ title: '如何注册账户' });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/help/content?lang=zh-CN', {
      signal: controller.signal,
    });

    await fetchHelpContent({ locale: 'zh_CN', forceRefresh: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails closed for a missing article or already-aborted request', async () => {
    jest.spyOn(publicApiClient, 'get').mockResolvedValue(payload());
    await expect(fetchHelpArticle('cms-404')).rejects.toThrow(
      '帮助文章不存在或已下线',
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchHelpContent({ signal: controller.signal, forceRefresh: true }),
    ).rejects.toThrow('帮助内容请求已取消');
  });
});
