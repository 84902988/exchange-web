import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {SecurityEventPage} from '../src/api/auth';

const mockFetchMySecurityEvents = jest.fn();

jest.mock('../src/api', () => ({
  fetchMySecurityEvents: (...args: unknown[]) =>
    mockFetchMySecurityEvents(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({children}: {children?: React.ReactNode}) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import SecurityEventsScreen, {
  describeSecurityEvent,
  formatSecurityEventDevice,
  formatSecurityEventTime,
} from '../src/screens/account/SecurityEventsScreen';

const firstPage: SecurityEventPage = {
  items: [
    {
      id: 10,
      eventType: 'EMAIL_VERIFIED' as const,
      ipAddress: '203.0.113.10',
      userAgent: 'okhttp/4.12',
      details: {email: 'me***@example.com'},
      createdAt: '2026-08-02T12:00:00Z',
    },
    {
      id: 9,
      eventType: 'PASSWORD_CHANGED' as const,
      ipAddress: '203.0.113.9',
      userAgent: 'Chrome Windows',
      details: {revoked_sessions: 3},
      createdAt: '2026-08-02T11:00:00Z',
    },
  ],
  hasMore: true,
  nextCursor: 9,
};

describe('security events screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMySecurityEvents
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({
        items: [
          {
            id: 8,
            eventType: 'SESSION_REVOKED',
            ipAddress: '203.0.113.8',
            userAgent: 'ExchangeMobile iOS CFNetwork',
            details: {target_device: 'Chrome / Windows'},
            createdAt: '2026-08-02T10:00:00Z',
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
  });

  it('renders only safe event summaries and appends an older cursor page', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SecurityEventsScreen navigation={{goBack: jest.fn()}} />,
      );
      await Promise.resolve();
    });

    let text = renderer.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('登录邮箱已验证');
    expect(text).toContain('me***@example.com');
    expect(text).toContain('登录密码已修改');
    expect(text).toContain('已撤销 3 个登录会话');
    expect(text).not.toContain('secret');

    await act(async () => {
      renderer.root.findByProps({accessibilityLabel: '加载更多'}).props.onPress();
      await Promise.resolve();
    });
    expect(mockFetchMySecurityEvents).toHaveBeenNthCalledWith(
      2,
      20,
      9,
      undefined,
    );
    text = renderer.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('已退出一台设备');
    expect(text).toContain('Chrome / Windows');
    expect(renderer.root.findAllByProps({accessibilityLabel: '加载更多'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('formats devices, time and password descriptions conservatively', () => {
    expect(formatSecurityEventDevice('okhttp/4.12')).toBe(
      'ExchangeMobile / Android',
    );
    expect(formatSecurityEventDevice('')).toBe('未知客户端');
    expect(formatSecurityEventTime('invalid')).toBe('--');
    expect(describeSecurityEvent(firstPage.items[1])).toMatchObject({
      title: '登录密码已修改',
      description: '已撤销 3 个登录会话',
    });
  });
});
