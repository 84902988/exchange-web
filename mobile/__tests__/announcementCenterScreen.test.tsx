import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { MobileAnnouncementList } from '../src/api/mobileContent';
import AnnouncementCenterScreen, {
  formatAnnouncementDate,
} from '../src/screens/home/AnnouncementCenterScreen';

const mockFetchMobileAnnouncements = jest.fn();
const navigation = { goBack: jest.fn(), navigate: jest.fn() };

jest.mock('../src/api/mobileContent', () => ({
  fetchMobileAnnouncements: (...args: unknown[]) =>
    mockFetchMobileAnnouncements(...args),
}));

function list(page = 1, pages = 1): MobileAnnouncementList {
  return {
    items: [
      {
        id: String(page),
        title: `公告 ${page}`,
        summary: `摘要 ${page}`,
        categoryLabel: '平台公告',
        isPinned: page === 1,
        publishedAt: '2026-08-03T18:53:32+08:00',
      },
    ],
    total: pages,
    page,
    pageSize: 20,
    pages,
  };
}

function screen() {
  return (
    <AnnouncementCenterScreen
      navigation={navigation as never}
      route={{ key: 'announcements', name: 'AnnouncementCenter' } as never}
    />
  );
}

function texts(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node =>
      typeof node.props.children === 'string' ? [node.props.children] : [],
    );
}

describe('AnnouncementCenterScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads public announcements and opens the existing public detail route', async () => {
    mockFetchMobileAnnouncements.mockResolvedValue(list());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });

    expect(mockFetchMobileAnnouncements).toHaveBeenCalledWith({
      locale: 'zh-CN',
      page: 1,
      pageSize: 20,
      signal: expect.any(AbortSignal),
    });
    expect(texts(renderer)).toEqual(
      expect.arrayContaining([
        '平台公告',
        '公开公告，只读浏览',
        '公告 1',
        '摘要 1',
      ]),
    );
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '公告 1，查看公告详情' })
        .props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith(
      'MobileAnnouncementDetail',
      { announcementId: '1', title: '公告 1' },
    );
    act(() => renderer.unmount());
  });

  it('paginates without accepting duplicate items', async () => {
    mockFetchMobileAnnouncements
      .mockResolvedValueOnce(list(1, 2))
      .mockResolvedValueOnce(list(1, 2));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: '加载更多公告' })
        .props.onPress();
      await Promise.resolve();
    });
    expect(mockFetchMobileAnnouncements).toHaveBeenNthCalledWith(2, {
      locale: 'zh-CN',
      page: 2,
      pageSize: 20,
    });
    expect(texts(renderer)).toContain('更多公告暂不可用，请重试');
    act(() => renderer.unmount());
  });

  it('fails closed without exposing a raw transport error', async () => {
    mockFetchMobileAnnouncements.mockRejectedValue(
      new Error('raw upstream 502'),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(screen());
      await Promise.resolve();
    });
    expect(texts(renderer)).toEqual(
      expect.arrayContaining(['公告暂不可用', '重新加载']),
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('raw upstream');
    act(() => renderer.unmount());
  });

  it('formats the published instant in the device timezone', () => {
    const value = formatAnnouncementDate('2026-08-03T18:53:32+08:00');
    expect(value).toMatch(/^2026-08-03 \d{2}:53$/);
    expect(formatAnnouncementDate(null)).toBe('发布时间待定');
  });
});
