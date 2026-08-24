import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { MobileAnnouncementDetail } from '../src/api/mobileContent';
import MobileAnnouncementDetailScreen from '../src/screens/home/MobileAnnouncementDetailScreen';
import { WebView } from 'react-native-webview';
import { createTranslator } from '../src/i18n';

const mockFetchMobileAnnouncementDetail = jest.fn();
const mockMarkMobileAnnouncementRead = jest.fn();

jest.mock('../src/api/mobileContent', () => ({
  fetchMobileAnnouncementDetail: (...args: unknown[]) =>
    mockFetchMobileAnnouncementDetail(...args),
  markMobileAnnouncementRead: (...args: unknown[]) =>
    mockMarkMobileAnnouncementRead(...args),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ isLoggedIn: true }),
}));

function detail(
  id: string,
  title = `Announcement ${id}`,
): MobileAnnouncementDetail {
  return {
    id,
    scope: 'MOBILE',
    title,
    summary: `Summary ${id}`,
    contentFormat: 'PLAIN_TEXT',
    content: `Plain text body ${id}.\nSecond paragraph.`,
    publishedAt: '2026-07-31T10:30:00+08:00',
  };
}

function screen(
  announcementId: string,
  title: string,
  navigation = { goBack: jest.fn() },
) {
  return (
    <MobileAnnouncementDetailScreen
      navigation={navigation as never}
      route={
        {
          key: `announcement-${announcementId}`,
          name: 'MobileAnnouncementDetail',
          params: { announcementId, title },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('MobileAnnouncementDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarkMobileAnnouncementRead.mockResolvedValue({ unreadCount: 0 });
  });

  it('renders only the validated plain-text detail returned by the client', async () => {
    mockFetchMobileAnnouncementDetail.mockResolvedValue(detail('11'));
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(screen('11', 'Route title'));
      await Promise.resolve();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        'Announcement 11',
        'Summary 11',
        'Plain text body 11.\nSecond paragraph.',
      ]),
    );
    expect(mockFetchMobileAnnouncementDetail).toHaveBeenCalledWith('11', {
      locale: 'zh-CN',
      signal: expect.any(AbortSignal),
    });
    expect(mockMarkMobileAnnouncementRead).toHaveBeenCalledWith('11', {
      signal: expect.any(AbortSignal),
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('shows a retry state without fabricating a body after failure', async () => {
    mockFetchMobileAnnouncementDetail
      .mockRejectedValueOnce(new Error('404 raw transport text'))
      .mockResolvedValueOnce(detail('12'));
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(screen('12', 'Route title'));
      await Promise.resolve();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining([
        '加载失败',
        '公告加载失败，请稍后重试。',
        '重试',
      ]),
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('404 raw');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Plain text body');

    const retry = renderer.root.findByProps({
      accessibilityLabel: '重试加载公告',
    });
    await act(async () => {
      retry.props.onPress();
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain(
      'Plain text body 12.\nSecond paragraph.',
    );
    expect(mockFetchMobileAnnouncementDetail).toHaveBeenCalledTimes(2);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders sanitized rich text in a JavaScript-disabled WebView', async () => {
    mockFetchMobileAnnouncementDetail.mockResolvedValue({
      ...detail('13'),
      contentFormat: 'SANITIZED_HTML',
      content: '<p>富文本<strong>正文</strong></p>',
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(screen('13', 'Route title'));
      await Promise.resolve();
    });

    const webView = renderer.root.findByType(WebView);
    expect(webView.props.javaScriptEnabled).toBe(false);
    expect(webView.props.allowFileAccess).toBe(false);
    expect(webView.props.source.html).toContain(
      '<p>富文本<strong>正文</strong></p>',
    );

    act(() => renderer.unmount());
  });

  it('aborts and ignores an older announcement request after route change', async () => {
    const oldRequest = deferred<MobileAnnouncementDetail>();
    const newRequest = deferred<MobileAnnouncementDetail>();
    mockFetchMobileAnnouncementDetail
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(screen('21', 'Old title'));
      await Promise.resolve();
    });
    const oldSignal = mockFetchMobileAnnouncementDetail.mock.calls[0][1]
      .signal as AbortSignal;

    await act(async () => {
      renderer.update(screen('22', 'New title'));
      await Promise.resolve();
    });
    expect(oldSignal.aborted).toBe(true);

    await act(async () => {
      oldRequest.resolve(detail('21', 'Stale announcement'));
      await oldRequest.promise;
      newRequest.resolve(detail('22', 'Current announcement'));
      await newRequest.promise;
    });
    expect(textValues(renderer)).toContain('Current announcement');
    expect(textValues(renderer)).not.toContain('Stale announcement');

    act(() => {
      renderer.unmount();
    });
  });

  it('deduplicates read retries and aborts the owned retry on unmount', async () => {
    mockFetchMobileAnnouncementDetail.mockResolvedValue(detail('31'));
    const retryRequest = deferred<{ unreadCount: number }>();
    mockMarkMobileAnnouncementRead
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(retryRequest.promise);
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(screen('31', 'Route title'));
      await Promise.resolve();
      await Promise.resolve();
    });

    const retry = renderer.root.findByProps({
      accessibilityLabel: createTranslator('zh-CN')(
        'announcement.retryReadA11y',
      ),
    });
    act(() => {
      retry.props.onPress();
      retry.props.onPress();
    });
    expect(mockMarkMobileAnnouncementRead).toHaveBeenCalledTimes(2);
    const retrySignal = mockMarkMobileAnnouncementRead.mock.calls[1][1]
      .signal as AbortSignal;

    act(() => renderer.unmount());
    expect(retrySignal.aborted).toBe(true);
    await act(async () => {
      retryRequest.resolve({ unreadCount: 0 });
      await retryRequest.promise;
    });
  });
});
