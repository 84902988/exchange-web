import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { type ReactNode } from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  messageCenterEn,
  messageCenterJa,
  messageCenterZhCN,
  messageCenterZhTW,
} from '../src/i18n/messageCenterCatalog';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
  useLanguage,
} from '../src/i18n';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockFetchAnnouncements = jest.fn();
const mockFetchReadState = jest.fn();
const mockFetchUnreadCounts = jest.fn();
const mockMarkAllRead = jest.fn();
const mockFetchSupportTickets = jest.fn();

jest.mock('@react-navigation/native', () => {
  const ReactModule = require('react');
  return {
    useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
    useRoute: () => ({ params: { initialTab: 'announcements' } }),
    useFocusEffect: (callback: () => void | (() => void)) =>
      ReactModule.useEffect(callback, [callback]),
  };
});

jest.mock('../src/api/mobileContent', () => ({
  fetchMobileAnnouncements: (...args: unknown[]) =>
    mockFetchAnnouncements(...args),
  fetchMobileAnnouncementReadState: (...args: unknown[]) =>
    mockFetchReadState(...args),
  fetchMobileMessageUnreadCounts: (...args: unknown[]) =>
    mockFetchUnreadCounts(...args),
  markAllMobileAnnouncementsRead: (...args: unknown[]) =>
    mockMarkAllRead(...args),
}));

jest.mock('../src/api/support', () => ({
  fetchSupportTickets: (...args: unknown[]) => mockFetchSupportTickets(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import HomeMessageCenterScreen, {
  formatMessageCenterDate,
} from '../src/screens/home/HomeMessageCenterScreen';

const announcements = [
  {
    id: '11',
    title: '未读公告',
    summary: '公告摘要',
    categoryLabel: '系统公告',
    isPinned: false,
    publishedAt: '2026-08-02T10:00:00Z',
  },
  {
    id: '12',
    title: '已读公告',
    summary: '公告摘要',
    categoryLabel: '活动公告',
    isPinned: false,
    publishedAt: '2026-08-01T10:00:00Z',
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe('HomeMessageCenterScreen read state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAnnouncements.mockResolvedValue({
      items: announcements,
      total: 2,
      page: 1,
      pageSize: 20,
      pages: 1,
    });
    mockFetchReadState.mockResolvedValue({
      unreadCount: 1,
      readIds: ['12'],
    });
    mockFetchUnreadCounts.mockResolvedValue({
      announcements: 1,
      supportReplies: 2,
      total: 3,
    });
    mockMarkAllRead.mockResolvedValue({ marked: 1, unreadCount: 0 });
    mockFetchSupportTickets.mockResolvedValue({
      items: [
        {
          id: 21,
          ticketNo: 'TK202608020001',
          category: 'ACCOUNT',
          categoryLabel: '账户问题',
          subject: '登录问题',
          content: '需要帮助',
          status: 'REPLIED',
          statusLabel: '已回复',
          createdAt: '2026-08-02T09:00:00',
          updatedAt: '2026-08-02T09:10:00',
          hasUnreadAdminReply: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      pages: 1,
      categories: [],
      statuses: [],
      unreadReplyCount: 1,
    });
  });

  it('keeps every message-center key explicit in all four languages', () => {
    const expectedKeys = Object.keys(messageCenterZhCN).sort();
    expect(expectedKeys).toHaveLength(32);
    expect(Object.keys(messageCenterZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(messageCenterEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(messageCenterJa).sort()).toEqual(expectedKeys);
    expect(createTranslator('ja')('messageCenter.title')).toBe(
      'メッセージセンター',
    );
    expect(
      formatMessageCenterDate('2026-08-02T09:10:00', createTranslator('en')),
    ).toBe('8/2 09:10');
  });

  it('renders authoritative announcement and support badges without writing', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<HomeMessageCenterScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findAllByProps({ accessibilityLabel: '未读' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: '全部已读' }).length,
    ).toBeGreaterThan(0);
    expect(mockMarkAllRead).not.toHaveBeenCalled();
    expect(mockFetchReadState).toHaveBeenCalledWith(
      ['11', '12'],
      expect.objectContaining({ signal: expect.any(Object) }),
    );

    act(() => renderer.unmount());
  });

  it('updates the visible state only after mark-all succeeds', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<HomeMessageCenterScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const markAll = renderer.root.findByProps({
      accessibilityLabel: '全部已读',
    });

    await act(async () => {
      markAll.props.onPress();
      await Promise.resolve();
    });
    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: '未读' }),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('locks duplicate mark-all taps and aborts the pending request on exit', async () => {
    const pending = deferred<{ marked: number; unreadCount: number }>();
    let signal: AbortSignal | undefined;
    mockMarkAllRead.mockImplementationOnce(
      (options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return pending.promise;
      },
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<HomeMessageCenterScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const markAll = renderer.root.findByProps({
      accessibilityLabel: '全部已读',
    });

    act(() => {
      markAll.props.onPress();
      markAll.props.onPress();
    });

    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    act(() => renderer.unmount());
    expect(signal?.aborted).toBe(true);
  });

  it('syncs deep announcement pagination in page-sized read-state batches', async () => {
    const pages = Array.from({ length: 3 }, (_page, pageIndex) =>
      Array.from({ length: 20 }, (_item, itemIndex) => {
        const id = String(pageIndex * 20 + itemIndex + 1);
        return {
          id,
          title: `公告 ${id}`,
          summary: '公告摘要',
          categoryLabel: '系统公告',
          isPinned: false,
          publishedAt: '2026-08-02T10:00:00Z',
        };
      }),
    );
    mockFetchAnnouncements.mockImplementation(
      ({ page = 1 }: { page?: number } = {}) =>
        Promise.resolve({
          items: pages[page - 1],
          total: 60,
          page,
          pageSize: 20,
          pages: 3,
        }),
    );
    mockFetchReadState.mockImplementation((ids: string[]) =>
      Promise.resolve({ unreadCount: 60, readIds: ids.slice(0, 1) }),
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<HomeMessageCenterScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    for (let page = 2; page <= 3; page += 1) {
      await act(async () => {
        renderer.root
          .findByProps({ accessibilityLabel: '加载更多' })
          .props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(mockFetchReadState).toHaveBeenCalledTimes(3);
    expect(
      mockFetchReadState.mock.calls.map(call => (call[0] as string[]).length),
    ).toEqual([20, 20, 20]);
    expect(mockFetchReadState.mock.calls[2][0]).toEqual(
      pages[2].map(item => item.id),
    );
    act(() => renderer.unmount());
  });

  it('renders English announcement and support lists without opening or writing', async () => {
    const renderer = await renderEnglish(<HomeMessageCenterScreen />);
    expect(textContent(renderer)).toContain('Message Center');
    expect(textContent(renderer)).toContain('All announcements');
    expect(textContent(renderer)).toContain('2 items');
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Mark all read' }),
    ).not.toHaveLength(0);

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Support tickets' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = textContent(renderer);
    expect(text).toContain('My requests');
    expect(text).toContain('1 item');
    expect(text).toContain('登录问题');
    expect(text).toContain('账户问题');
    expect(text).toContain('8/2 09:10');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockMarkAllRead).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

function textContent(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}

function Ready({ children }: { children: ReactNode }) {
  const { ready } = useLanguage();
  return ready ? <>{children}</> : null;
}

async function renderEnglish(element: React.ReactElement) {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <LanguageProvider>
        <Ready>{element}</Ready>
      </LanguageProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}
