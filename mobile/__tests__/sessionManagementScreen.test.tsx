import React from 'react';
import { Alert, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

const mockFetchMyActiveSessions = jest.fn();
const mockRevokeMySession = jest.fn();
const mockRevokeMyOtherSessions = jest.fn();

jest.mock('../src/api', () => ({
  fetchMyActiveSessions: (...args: unknown[]) =>
    mockFetchMyActiveSessions(...args),
  revokeMySession: (...args: unknown[]) => mockRevokeMySession(...args),
  revokeMyOtherSessions: (...args: unknown[]) =>
    mockRevokeMyOtherSessions(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import SessionManagementScreen, {
  formatSessionTime,
  isMobileSession,
} from '../src/screens/account/SessionManagementScreen';

const sessions = [
  {
    id: 11,
    ipAddress: '203.0.113.11',
    userAgent: 'ExchangeMobile Android',
    deviceName: 'Unknown browser / Android',
    createdAt: '2026-08-01T12:00:00',
    lastUsedAt: '2026-08-02T12:00:00',
    expiresAt: '2026-08-12T12:00:00',
    isCurrent: true,
  },
  {
    id: 12,
    ipAddress: '203.0.113.12',
    userAgent: 'Chrome Windows',
    deviceName: 'Chrome / Windows',
    createdAt: '2026-08-01T12:00:00',
    lastUsedAt: null,
    expiresAt: '2026-08-12T12:00:00',
    isCurrent: false,
  },
];

describe('session management screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMyActiveSessions.mockResolvedValue({
      items: sessions,
      currentSessionId: 11,
      total: 2,
    });
    mockRevokeMySession.mockResolvedValue({ sessionId: 12, revoked: true });
    mockRevokeMyOtherSessions.mockResolvedValue({
      revokedCount: 1,
      currentSessionId: 11,
    });
  });

  it('shows the exact current session and only allows another device to exit', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SessionManagementScreen navigation={{ goBack: jest.fn() }} />,
      );
      await Promise.resolve();
    });

    const text = renderer.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('当前设备');
    expect(text).toContain('Chrome / Windows');
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: '退出设备 Chrome / Windows',
      }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: '退出设备 Unknown browser / Android',
      }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: '退出其他所有设备',
      }).length,
    ).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('requires confirmation before revoking another session', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SessionManagementScreen navigation={{ goBack: jest.fn() }} />,
      );
      await Promise.resolve();
    });

    const revokeButton = renderer.root.findAllByProps({
      accessibilityLabel: '退出设备 Chrome / Windows',
    })[0];
    act(() => {
      revokeButton.props.onPress();
      revokeButton.props.onPress();
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const confirm = alert.mock.calls[0][2]?.find(
      button => button.text === '确认退出',
    );
    await act(async () => {
      await Promise.all([confirm?.onPress?.(), confirm?.onPress?.()]);
    });
    expect(mockRevokeMySession).toHaveBeenCalledTimes(1);
    expect(mockRevokeMySession).toHaveBeenCalledWith(12);
    act(() => renderer.unmount());
    alert.mockRestore();
  });

  it('deduplicates rapid refresh requests and aborts the owned request on unmount', async () => {
    let resolveRequest!: (value: {
      items: typeof sessions;
      currentSessionId: number;
      total: number;
    }) => void;
    mockFetchMyActiveSessions.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRequest = resolve;
        }),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SessionManagementScreen navigation={{ goBack: jest.fn() }} />,
      );
    });

    const refresh = renderer.root
      .findAllByProps({ testID: 'sessions-refresh' })
      .find(node => typeof node.props.onPress === 'function');
    act(() => {
      refresh?.props.onPress();
      refresh?.props.onPress();
    });
    expect(mockFetchMyActiveSessions).toHaveBeenCalledTimes(1);
    const signal = mockFetchMyActiveSessions.mock.calls[0][0] as AbortSignal;

    act(() => renderer.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveRequest({ items: sessions, currentSessionId: 11, total: 2 });
      await Promise.resolve();
    });
  });

  it('formats session metadata without treating login history as live state', () => {
    expect(formatSessionTime(null)).toBe('--');
    expect(formatSessionTime('invalid')).toBe('--');
    expect(isMobileSession(sessions[0])).toBe(true);
    expect(isMobileSession(sessions[1])).toBe(false);
  });
});
