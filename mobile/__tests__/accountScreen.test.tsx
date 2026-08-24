import React from 'react';
import { Alert, Image, StyleSheet, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LanguageProvider, MOBILE_LOCALE_STORAGE_KEY } from '../src/i18n';

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockLogout = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    canGoBack: mockCanGoBack,
    goBack: mockGoBack,
    navigate: mockNavigate,
  }),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({
    error: null,
    isLoggedIn: true,
    loading: false,
    logout: mockLogout,
    user: {
      id: 7,
      email: 'user@example.com',
      invite_code: 'INVITE_7',
      created_at: '2026-07-31T10:30:00+08:00',
      profile: {
        nickname: '移动用户',
        avatar_url: '/static/uploads/avatars/user_7.webp',
      },
    },
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

import AccountScreen, {
  formatAccountKycStatus,
  formatAccountDate,
  getAvatarLabel,
} from '../src/screens/account/AccountScreen';

describe('mobile account screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack.mockReturnValue(true);
    mockLogout.mockResolvedValue(undefined);
  });

  it('shows only real identity fields and performs confirmed logout', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<AccountScreen />);
    });

    const text = renderer.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('移动用户');
    expect(text).toContain('user@example.com');
    expect(text).toContain('INVITE_7');
    expect(text).toContain('身份认证');
    expect(text).toContain('账户安全');
    expect(text).toContain('登录活动');
    expect(text).not.toContain('账户已登录');
    expect(text).not.toContain('敬请期待');
    expect(renderer.root.findByType(Image).props.source.uri).toContain(
      '/static/uploads/avatars/user_7.webp',
    );

    const logoutButton = renderer.root.findByProps({
      accessibilityLabel: '退出登录',
    });
    act(() => {
      logoutButton.props.onPress();
      logoutButton.props.onPress();
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const buttons = alert.mock.calls[0][2]!;
    const confirm = buttons.find(button => button.text === '确认退出');
    await act(async () => {
      await Promise.all([confirm?.onPress?.(), confirm?.onPress?.()]);
    });

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    alert.mockRestore();
  });

  it('opens the real KYC flow from the account service row', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<AccountScreen />);
    });
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '打开身份认证' })
        .props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Kyc');
    act(() => renderer.unmount());
  });

  it('opens profile, security and login activity screens', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<AccountScreen />);
    });
    let editProfile!: ReactTestRenderer.ReactTestInstance;
    for (const [label, route] of [
      ['编辑个人资料', 'ProfileEdit'],
      ['打开账户安全', 'AccountSecurity'],
      ['打开登录记录', 'LoginActivity'],
    ]) {
      const entry = renderer.root.findByProps({ accessibilityLabel: label });
      if (route === 'ProfileEdit') editProfile = entry;
      act(() => entry.props.onPress());
      expect(mockNavigate).toHaveBeenLastCalledWith(route);
    }
    expect(
      StyleSheet.flatten(editProfile.props.style({ pressed: false })).height,
    ).toBeGreaterThanOrEqual(44);
    expect(
      StyleSheet.flatten(editProfile.props.style({ pressed: true })).transform,
    ).toEqual([{ scale: 0.99 }]);
    expect(editProfile.props.android_ripple).toBeDefined();
    act(() => renderer.unmount());
  });

  it('opens the real dividend record screen', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<AccountScreen />);
    });
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '打开我的分红' })
        .props.onPress();
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('DividendCenter');
    act(() => renderer.unmount());
  });

  it('renders account and security navigation in the selected language', async () => {
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AccountScreen />
        </LanguageProvider>,
      );
    });

    const text = renderer.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('Account security');
    expect(text).toContain('Login activity');
    expect(text).toContain('My Dividends');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Edit profile' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Log out' }),
    ).toBeTruthy();

    act(() => renderer.unmount());
    await AsyncStorage.removeItem(MOBILE_LOCALE_STORAGE_KEY);
  });

  it('formats account labels without leaking long identifiers', () => {
    expect(getAvatarLabel('user@example.com')).toBe('US');
    expect(getAvatarLabel('移动用户')).toBe('移动');
    expect(formatAccountDate('2026-07-31T10:30:00+08:00')).toBe('2026-07-31');
    expect(formatAccountDate('invalid')).toBe('--');
    expect(formatAccountKycStatus('PENDING', 0)).toBe('审核中');
    expect(formatAccountKycStatus('APPROVED', 1)).toBe('已认证');
    expect(formatAccountKycStatus(null, 0)).toBe('未认证');
  });
});
