import React from 'react';
import { Alert, TextInput } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

const mockSendCurrent = jest.fn();
const mockConfirmCurrent = jest.fn();
const mockSendChange = jest.fn();
const mockConfirmChange = jest.fn();
const mockRefreshUser = jest.fn();
const mockLogout = jest.fn();
let mockUser: Record<string, unknown>;

jest.mock('../src/api', () => ({
  sendCurrentEmailVerification: (...args: unknown[]) =>
    mockSendCurrent(...args),
  confirmCurrentEmailVerification: (...args: unknown[]) =>
    mockConfirmCurrent(...args),
  sendEmailChangeVerification: (...args: unknown[]) => mockSendChange(...args),
  confirmEmailChange: (...args: unknown[]) => mockConfirmChange(...args),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({
    user: mockUser,
    refreshUser: mockRefreshUser,
    logout: mockLogout,
  }),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import EmailSecurityScreen from '../src/screens/account/EmailSecurityScreen';
import { createTranslator } from '../src/i18n';

describe('email security screen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockUser = {
      id: 7,
      email: 'member@example.com',
      email_verified_at: null,
    };
    mockSendCurrent.mockResolvedValue({ message: 'verification code sent' });
    mockConfirmCurrent.mockResolvedValue({
      email: 'member@example.com',
      email_verified_at: '2026-08-02T13:00:00',
    });
    mockSendChange.mockResolvedValue({ message: 'verification code sent' });
    mockConfirmChange.mockResolvedValue({
      email: 'next@example.com',
      email_verified_at: '2026-08-02T13:05:00',
      reauthenticate: true,
    });
    mockRefreshUser.mockResolvedValue({
      ...mockUser,
      email_verified_at: '2026-08-02T13:00:00',
    });
    mockLogout.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('verifies the current email only after a real OTP response', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <EmailSecurityScreen
          navigation={{ goBack: jest.fn(), reset: jest.fn() }}
        />,
      );
    });

    await act(async () => {
      await renderer.root
        .findAllByProps({ accessibilityLabel: '发送验证码' })[0]
        .props.onPress();
    });
    expect(mockSendCurrent).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.root
        .findAllByType(TextInput)
        .find(node => node.props.accessibilityLabel === '邮箱验证码')
        ?.props.onChangeText('123456');
    });
    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: '验证邮箱' })
        .props.onPress();
    });
    expect(mockConfirmCurrent).toHaveBeenCalledWith('123456');
    expect(mockRefreshUser).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('requires password, a code sent to the unchanged target, and confirmation', async () => {
    mockUser = {
      id: 7,
      email: 'member@example.com',
      email_verified_at: '2026-08-01T12:00:00',
    };
    const reset = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <EmailSecurityScreen navigation={{ goBack: jest.fn(), reset }} />,
      );
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '新邮箱' })
        .props.onChangeText(' Next@Example.com ');
      renderer.root
        .findByProps({ accessibilityLabel: '当前登录密码' })
        .props.onChangeText('OldPass!123');
    });
    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: '发送验证码' })
        .props.onPress();
    });
    expect(mockSendChange).toHaveBeenCalledWith({
      new_email: 'next@example.com',
      current_password: 'OldPass!123',
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '邮箱验证码' })
        .props.onChangeText('654321');
    });
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '更换登录邮箱' })
        .props.onPress();
    });
    const confirm = alert.mock.calls[0][2]?.find(
      button => button.text === '确认更换',
    );
    await act(async () => {
      await confirm?.onPress?.();
    });
    expect(mockConfirmChange).toHaveBeenCalledWith({
      new_email: 'next@example.com',
      current_password: 'OldPass!123',
      code: '654321',
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    alert.mockRestore();
  });

  it('deduplicates rapid change confirmations and mutations', async () => {
    mockUser = {
      id: 7,
      email: 'member@example.com',
      email_verified_at: '2026-08-01T12:00:00',
    };
    const t = createTranslator('zh-CN');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <EmailSecurityScreen
          navigation={{ goBack: jest.fn(), reset: jest.fn() }}
        />,
      );
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: t('emailSecurity.newEmail') })
        .props.onChangeText('next@example.com');
      renderer.root
        .findByProps({ accessibilityLabel: t('emailSecurity.currentPassword') })
        .props.onChangeText('OldPass!123');
    });
    await act(async () => {
      await renderer.root
        .findAllByProps({ accessibilityLabel: t('auth.sendOtp') })
        .find(node => typeof node.props.onPress === 'function')
        ?.props.onPress();
    });
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: t('auth.emailOtp') })
        .props.onChangeText('654321');
    });

    const change = renderer.root.findByProps({
      accessibilityLabel: t('emailSecurity.changeButton'),
    });
    act(() => {
      change.props.onPress();
      change.props.onPress();
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const confirm = alert.mock.calls[0][2]?.find(
      button => button.text === t('emailSecurity.confirmChange'),
    );
    await act(async () => {
      await Promise.all([confirm?.onPress?.(), confirm?.onPress?.()]);
    });

    expect(mockConfirmChange).toHaveBeenCalledTimes(1);
    expect(mockLogout).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    alert.mockRestore();
  });
});
