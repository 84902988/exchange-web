import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { MobileAboutPage } from '../src/api/about';
import AboutPageScreen from '../src/screens/home/AboutPageScreen';
import {branding} from '../src/config/brandingConfig';

const mockFetchAboutPage = jest.fn();
const mockFetchPublicSupportContact = jest.fn();

jest.mock('../src/api/about', () => ({
  ...jest.requireActual('../src/api/about'),
  fetchAboutPage: (...args: unknown[]) => mockFetchAboutPage(...args),
}));

jest.mock('../src/api/siteContact', () => ({
  fetchPublicSupportContact: (...args: unknown[]) =>
    mockFetchPublicSupportContact(...args),
}));

function page(): MobileAboutPage {
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
        body: ['真实平台介绍。'],
        items: [],
      },
      {
        id: 'story',
        title: '我们的故事',
        eyebrow: '',
        body: ['真实平台故事。'],
        items: [],
      },
      {
        id: 'vision',
        title: '我们的愿景',
        eyebrow: '',
        body: ['真实平台愿景。'],
        items: [],
      },
      {
        id: 'mission',
        title: '我们的使命',
        eyebrow: '',
        body: ['真实平台使命。'],
        items: [],
      },
      {
        id: 'values',
        title: '我们的价值观',
        eyebrow: '',
        body: [],
        items: [{ title: '用户至上', body: ['用户的信任是持续发展的动力。'] }],
      },
    ],
  };
}

function navigation() {
  return { navigate: jest.fn(), goBack: jest.fn() };
}

function screen(target = navigation()) {
  return (
    <AboutPageScreen
      navigation={target as never}
      route={{ key: 'about-page', name: 'AboutPage' } as never}
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

describe('mobile about page screen', () => {
  it('renders only explicitly supplied company notices', async () => {
    branding.complianceLicenses.push({title: '示例登记信息', subtitle: 'Example registration'});
    try {
      mockFetchAboutPage.mockResolvedValue(page());
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await act(async () => { renderer = ReactTestRenderer.create(screen()); });
      expect(textValues(renderer)).toContain('Example registration');
      expect(renderer.root.findAllByProps({testID: 'about-compliance-licenses'}).length).toBeGreaterThan(0);
      act(() => renderer.unmount());
    } finally {
      branding.complianceLicenses.length = 0;
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchPublicSupportContact.mockResolvedValue({
      email: 'info@service.example',
    });
  });

  it('renders validated backend sections and opens the public risk page', async () => {
    mockFetchAboutPage.mockResolvedValue(page());
    const target = navigation();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(screen(target));
      await Promise.resolve();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '关于平台',
        '我们是谁',
        '关于 Exchange',
        '我们的故事',
        '我们的愿景',
        '我们的使命',
        '我们的价值观',
        '用户至上',
        '用户的信任是持续发展的动力。',
        '联系支持',
        '官方支持邮箱',
        'info@service.example',
      ]),
    );
    expect(renderer.root.findAllByProps({ testID: 'about-compliance-licenses' })).toHaveLength(0);
    expect(textValues(renderer)).not.toContain('部分平台介绍内容暂未配置');
    expect(mockFetchAboutPage).toHaveBeenCalledWith({
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
      forceRefresh: false,
    });
    expect(mockFetchPublicSupportContact).toHaveBeenCalledWith({
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
    });
    act(() =>
      renderer.root
        .findByProps({
          accessibilityLabel: '风险提示，了解交易与资产风险',
        })
        .props.onPress(),
    );
    expect(target.navigate).toHaveBeenCalledWith('LegalPage', {
      pageKey: 'risk',
    });
    act(() => {
      renderer.root
        .findByProps({
          accessibilityLabel: '用户协议，查看平台服务条款',
        })
        .props.onPress();
      renderer.root
        .findByProps({
          accessibilityLabel: '隐私政策，了解数据处理规则',
        })
        .props.onPress();
    });
    expect(target.navigate).toHaveBeenCalledWith('LegalPage', {
      pageKey: 'terms',
    });
    expect(target.navigate).toHaveBeenCalledWith('LegalPage', {
      pageKey: 'privacy',
    });
    act(() => renderer.unmount());
  });

  it('shows a truthful partial-content note without fabricating sections', async () => {
    mockFetchAboutPage.mockResolvedValue({
      ...page(),
      sections: [page().sections[0]],
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain('部分平台介绍内容暂未配置');
    expect(textValues(renderer)).not.toContain('我们的使命');
    act(() => renderer.unmount());
  });

  it('keeps the platform introduction available when support contact fails', async () => {
    mockFetchAboutPage.mockResolvedValue(page());
    mockFetchPublicSupportContact.mockRejectedValue(
      new Error('raw site config error'),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain('我们的价值观');
    expect(textValues(renderer)).not.toContain('联系支持');
    expect(textValues(renderer)).not.toContain('raw site config error');
    act(() => renderer.unmount());
  });

  it('shows bounded empty and error states with force-refresh recovery', async () => {
    mockFetchAboutPage
      .mockResolvedValueOnce({ ...page(), sections: [] })
      .mockRejectedValueOnce(new Error('SQL traceback secret'))
      .mockResolvedValueOnce(page());

    let empty!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      empty = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });
    expect(textValues(empty)).toContain('暂无平台介绍');
    act(() => empty.unmount());

    let failed!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      failed = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });
    expect(textValues(failed)).toContain('平台介绍暂不可用');
    expect(JSON.stringify(failed.toJSON())).not.toContain('SQL traceback');
    await act(async () => {
      failed.root
        .findByProps({ accessibilityLabel: '重新加载' })
        .props.onPress();
      await Promise.resolve();
    });
    expect(mockFetchAboutPage).toHaveBeenLastCalledWith({
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
      forceRefresh: true,
    });
    expect(textValues(failed)).toContain('我们的价值观');
    act(() => failed.unmount());
  });
});
