import {
  __resetAboutPageCacheForTests,
  fetchAboutPage,
  normalizeAboutPage,
} from '../src/api/about';
import { publicApiClient } from '../src/api/client';

function payload() {
  return {
    slug: 'who-we-are',
    title: '我们是谁',
    subtitle: '关于 Exchange',
    locale: 'zh',
    sections: [
      {
        id: 'who',
        title: '关于 Exchange',
        eyebrow: '我们是谁',
        body: ['平台介绍第一段。', '平台介绍第二段。'],
        items: [],
      },
      {
        id: 'values',
        title: '我们的价值观',
        eyebrow: '',
        body: [],
        items: [
          { title: '用户至上', body: ['用户的信任是持续发展的动力。'] },
          { title: '安全为本', body: ['安全是数字金融发展的生命线。'] },
        ],
      },
    ],
  };
}

describe('mobile about page contracts', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    __resetAboutPageCacheForTests();
  });

  it('normalizes a validated partial page without inventing missing sections', () => {
    const page = normalizeAboutPage(payload());
    expect(page).toEqual({
      slug: 'who-we-are',
      title: '我们是谁',
      subtitle: '关于 Exchange',
      locale: 'zh',
      sections: [
        {
          id: 'who',
          title: '关于 Exchange',
          eyebrow: '我们是谁',
          body: ['平台介绍第一段。', '平台介绍第二段。'],
          items: [],
        },
        {
          id: 'values',
          title: '我们的价值观',
          eyebrow: '',
          body: [],
          items: [
            { title: '用户至上', body: ['用户的信任是持续发展的动力。'] },
            { title: '安全为本', body: ['安全是数字金融发展的生命线。'] },
          ],
        },
      ],
    });
  });

  it('allows a truthful empty page for the mobile empty state', () => {
    const value = payload();
    value.sections = [];
    expect(normalizeAboutPage(value).sections).toEqual([]);
  });

  it.each([
    ['wrong slug', { slug: 'other' }],
    [
      'unknown section',
      {
        sections: [
          {
            id: 'team',
            title: '团队',
            eyebrow: '',
            body: ['正文'],
            items: [],
          },
        ],
      },
    ],
    [
      'duplicate section',
      {
        sections: [payload().sections[0], payload().sections[0]],
      },
    ],
    [
      'raw html',
      {
        sections: [
          {
            ...payload().sections[0],
            body: ['<script>alert(1)</script>'],
          },
        ],
      },
    ],
    [
      'encoded html',
      {
        sections: [
          {
            ...payload().sections[0],
            body: ['&lt;img src=x&gt;'],
          },
        ],
      },
    ],
    [
      'duplicate item',
      {
        sections: [
          {
            ...payload().sections[1],
            items: [
              payload().sections[1].items[0],
              payload().sections[1].items[0],
            ],
          },
        ],
      },
    ],
  ])('fails closed for %s', (_label, overrides) => {
    expect(() => normalizeAboutPage({ ...payload(), ...overrides })).toThrow();
  });

  it('rejects empty or oversized structures', () => {
    expect(() =>
      normalizeAboutPage({
        ...payload(),
        sections: [
          {
            id: 'who',
            title: '关于平台',
            eyebrow: '',
            body: [],
            items: [],
          },
        ],
      }),
    ).toThrow('没有正文');
    expect(() =>
      normalizeAboutPage({
        ...payload(),
        sections: [
          {
            ...payload().sections[0],
            body: Array.from({ length: 21 }, () => '段落'),
          },
        ],
      }),
    ).toThrow('格式无效');
  });

  it('requests the public localized route and caches only completed results', async () => {
    const get = jest.spyOn(publicApiClient, 'get').mockResolvedValue(payload());
    const controller = new AbortController();

    await expect(
      fetchAboutPage({ locale: 'zh_CN', signal: controller.signal }),
    ).resolves.toMatchObject({ title: '我们是谁' });
    await fetchAboutPage({ locale: 'zh-CN' });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/site/pages/about?lang=zh-CN', {
      signal: controller.signal,
    });

    await fetchAboutPage({ locale: 'zh-CN', forceRefresh: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails before transport when the request is already aborted', async () => {
    const get = jest.spyOn(publicApiClient, 'get');
    const controller = new AbortController();
    controller.abort();
    await expect(fetchAboutPage({ signal: controller.signal })).rejects.toThrow(
      '平台介绍请求已取消',
    );
    expect(get).not.toHaveBeenCalled();
  });
});
