import React from 'react';
import { Text, TextInput } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PrimaryButton from '../src/components/common/PrimaryButton';
import { ApiClientError } from '../src/api/client';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
} from '../src/i18n';

const mockRegister = jest.fn();
const mockLogin = jest.fn();
const mockSendOtp = jest.fn();
const mockResetPassword = jest.fn();
const mockFetchLoginCaptcha = jest.fn();
const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockGoBack = jest.fn();
const mockRootNavigate = jest.fn();
const mockRootReset = jest.fn();
const mockRootCanGoBack = jest.fn(() => true);

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ login: mockLogin, register: mockRegister, loading: false }),
}));

jest.mock('../src/api/auth', () => {
  const actual = jest.requireActual('../src/api/auth');
  return {
    ...actual,
    fetchLoginCaptcha: (...args: unknown[]) => mockFetchLoginCaptcha(...args),
    sendOtp: (...args: unknown[]) => mockSendOtp(...args),
    resetPassword: (...args: unknown[]) => mockResetPassword(...args),
  };
});

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import LoginScreen from '../src/screens/auth/LoginScreen';
import RegisterScreen from '../src/screens/auth/RegisterScreen';
import ResetPasswordScreen from '../src/screens/auth/ResetPasswordScreen';

const navigation = {
  navigate: mockNavigate,
  replace: mockReplace,
  getParent: () => ({
    canGoBack: mockRootCanGoBack,
    goBack: mockGoBack,
    navigate: mockRootNavigate,
    reset: mockRootReset,
  }),
};

function input(
  renderer: ReactTestRenderer.ReactTestRenderer,
  placeholder: string,
) {
  return renderer.root
    .findAllByType(TextInput)
    .find(node => node.props.placeholder === placeholder)!;
}

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}

function registerScreen() {
  return (
    <RegisterScreen navigation={navigation as never} route={{} as never} />
  );
}

function acceptRegistrationLegal(
  renderer: ReactTestRenderer.ReactTestRenderer,
) {
  renderer.root
    .findByProps({ accessibilityLabel: '同意用户协议与隐私政策' })
    .props.onPress();
}

function resetScreen() {
  return (
    <ResetPasswordScreen navigation={navigation as never} route={{} as never} />
  );
}

describe('mobile auth screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRootCanGoBack.mockReturnValue(true);
  });

  it('renders the registration body and validation in the selected language', async () => {
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>{registerScreen()}</LanguageProvider>,
      );
    });

    expect(input(renderer, 'Email')).toBeTruthy();
    expect(renderedText(renderer)).toContain('Create an account');
    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(renderedText(renderer)).toContain('Enter a valid email address');

    act(() => renderer.unmount());
    await AsyncStorage.removeItem(MOBILE_LOCALE_STORAGE_KEY);
  });

  it('sends a real register OTP once and starts countdown only after receipt', async () => {
    let release!: (value: { message: string }) => void;
    mockSendOtp.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText(' Mobile@Example.com ');
    });

    const send = renderer.root.findByProps({
      accessibilityLabel: '发送验证码',
    });
    let firstRequest!: Promise<void>;
    let duplicateRequest!: Promise<void>;
    await act(async () => {
      firstRequest = send.props.onPress();
      duplicateRequest = send.props.onPress();
      release({ message: 'otp sent' });
      await Promise.all([firstRequest, duplicateRequest]);
    });

    expect(mockSendOtp).toHaveBeenCalledTimes(1);
    expect(mockSendOtp).toHaveBeenCalledWith({
      email: 'mobile@example.com',
      scene: 'register',
    });
    expect(
      renderer.root.findByProps({ accessibilityLabel: '60 秒后重试' }).props
        .disabled,
    ).toBe(true);
    expect(renderedText(renderer)).toContain('验证码已发送');

    act(() => renderer.unmount());
  });

  it('keeps registration fields and does not navigate when OTP or register fails', async () => {
    mockSendOtp.mockRejectedValue(new Error('邮件服务暂不可用'));
    mockRegister.mockRejectedValue(new Error('注册响应无法确认'));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '邮箱验证码').props.onChangeText('123456');
      input(renderer, '密码').props.onChangeText('Strong1!');
      acceptRegistrationLegal(renderer);
    });

    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: '发送验证码' })
        .props.onPress();
    });
    expect(renderedText(renderer)).toContain('邮件服务暂不可用');
    expect(input(renderer, '邮箱').props.value).toBe('mobile@example.com');

    const submit = renderer.root.findByType(PrimaryButton);
    await act(async () => {
      await submit.props.onPress();
    });
    expect(mockRegister).toHaveBeenCalledWith({
      email: 'mobile@example.com',
      otp: '123456',
      password: 'Strong1!',
    });
    expect(input(renderer, '邮箱验证码').props.value).toBe('123456');
    expect(input(renderer, '密码').props.value).toBe('Strong1!');
    expect(renderedText(renderer)).toContain('注册响应无法确认');
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith('Login');

    act(() => renderer.unmount());
  });

  it('closes the auth flow only after register establishes a real session', async () => {
    mockRegister.mockResolvedValue(undefined);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '邮箱验证码').props.onChangeText('123456');
      input(renderer, '密码').props.onChangeText('Strong1!');
      acceptRegistrationLegal(renderer);
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('submits a manually entered invite code explicitly as a normal user invitation', async () => {
    mockRegister.mockResolvedValue(undefined);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '邮箱验证码').props.onChangeText('123456');
      input(renderer, '密码').props.onChangeText('Strong1!');
      input(renderer, '好友邀请码（选填，仅用于普通邀请）').props.onChangeText(
        ' Invite_2026 ',
      );
      acceptRegistrationLegal(renderer);
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });

    expect(mockRegister).toHaveBeenCalledWith({
      email: 'mobile@example.com',
      otp: '123456',
      password: 'Strong1!',
      invite_code: 'Invite_2026',
      invite_type: 'user',
    });
    act(() => renderer.unmount());
  });

  it('requires legal consent before registration and opens backend-driven documents', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '邮箱验证码').props.onChangeText('123456');
      input(renderer, '密码').props.onChangeText('Strong1!');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain(
      '请先阅读并同意用户协议与隐私政策',
    );

    act(() => {
      renderer.root
        .findByProps({ accessibilityRole: 'link', children: '《用户协议》' })
        .props.onPress();
      renderer.root
        .findByProps({ accessibilityRole: 'link', children: '《隐私政策》' })
        .props.onPress();
    });
    expect(mockRootNavigate).toHaveBeenNthCalledWith(1, 'LegalPage', {
      pageKey: 'terms',
    });
    expect(mockRootNavigate).toHaveBeenNthCalledWith(2, 'LegalPage', {
      pageKey: 'privacy',
    });
    act(() => renderer.unmount());
  });

  it('enforces the mobile production password policy before registration', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '邮箱验证码').props.onChangeText('123456');
      input(renderer, '密码').props.onChangeText('weakpass');
      acceptRegistrationLegal(renderer);
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });

    expect(mockRegister).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain(
      '密码需为 8-64 位，并包含大小写字母、数字和特殊字符',
    );
    act(() => renderer.unmount());
  });

  it('supports password-manager autofill and an accessible visibility toggle', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(registerScreen());
    });

    const passwordInput = input(renderer, '密码');
    expect(passwordInput.props.autoComplete).toBe('new-password');
    expect(passwordInput.props.textContentType).toBe('newPassword');
    expect(passwordInput.props.secureTextEntry).toBe(true);

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '显示密码' })
        .props.onPress();
    });
    expect(input(renderer, '密码').props.secureTextEntry).toBe(false);
    expect(
      renderer.root.findByProps({ accessibilityLabel: '隐藏密码' }),
    ).toBeDefined();
    act(() => renderer.unmount());
  });

  it('opens password reset from both login and registration', async () => {
    let loginRenderer!: ReactTestRenderer.ReactTestRenderer;
    let registerRenderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      loginRenderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
      registerRenderer = ReactTestRenderer.create(registerScreen());
    });

    const pressForgot = (renderer: ReactTestRenderer.ReactTestRenderer) => {
      renderer.root
        .findByProps({ accessibilityLabel: '忘记密码' })
        .props.onPress();
    };
    act(() => {
      pressForgot(loginRenderer);
      pressForgot(registerRenderer);
    });
    expect(mockNavigate).toHaveBeenNthCalledWith(1, 'ResetPassword');
    expect(mockNavigate).toHaveBeenNthCalledWith(2, 'ResetPassword');

    act(() => {
      loginRenderer.unmount();
      registerRenderer.unmount();
    });
  });

  it('submits the backend email login field after local normalization', async () => {
    mockLogin.mockResolvedValue(undefined);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText(' MOBILE@example.com ');
      input(renderer, '密码').props.onChangeText('secret1');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockLogin).toHaveBeenCalledWith(
      'mobile@example.com',
      'secret1',
      undefined,
    );
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('returns to Main after forced re-login leaves Auth as the only root route', async () => {
    mockLogin.mockResolvedValue(undefined);
    mockRootCanGoBack.mockReturnValue(false);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '密码').props.onChangeText('secret1');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });

    expect(mockLogin).toHaveBeenCalledWith(
      'mobile@example.com',
      'secret1',
      undefined,
    );
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockRootReset).toHaveBeenCalledWith({
      index: 0,
      routes: [{ name: 'Main' }],
    });

    act(() => renderer.unmount());
  });

  it('deduplicates rapid login and registration submissions', async () => {
    const t = createTranslator('zh-CN');
    let releaseLogin!: () => void;
    let releaseRegister!: () => void;
    mockLogin.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseLogin = resolve;
        }),
    );
    mockRegister.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseRegister = resolve;
        }),
    );
    let loginRenderer!: ReactTestRenderer.ReactTestRenderer;
    let registerRenderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      loginRenderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
      registerRenderer = ReactTestRenderer.create(registerScreen());
    });
    act(() => {
      loginRenderer.root
        .findByProps({ accessibilityLabel: t('auth.email') })
        .props.onChangeText('login@example.com');
      loginRenderer.root
        .findByProps({ accessibilityLabel: t('auth.password') })
        .props.onChangeText('secret1');
      registerRenderer.root
        .findByProps({ accessibilityLabel: t('auth.email') })
        .props.onChangeText('new@example.com');
      registerRenderer.root
        .findByProps({
          accessibilityLabel: t('auth.emailOtp'),
        })
        .props.onChangeText('123456');
      registerRenderer.root
        .findByProps({ accessibilityLabel: t('auth.password') })
        .props.onChangeText('Strong1!');
      acceptRegistrationLegal(registerRenderer);
    });

    let firstLogin!: Promise<void>;
    let duplicateLogin!: Promise<void>;
    let firstRegister!: Promise<void>;
    let duplicateRegister!: Promise<void>;
    act(() => {
      firstLogin = loginRenderer.root.findByType(PrimaryButton).props.onPress();
      duplicateLogin = loginRenderer.root
        .findByType(PrimaryButton)
        .props.onPress();
      firstRegister = registerRenderer.root
        .findByType(PrimaryButton)
        .props.onPress();
      duplicateRegister = registerRenderer.root
        .findByType(PrimaryButton)
        .props.onPress();
    });

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseLogin();
      releaseRegister();
      await Promise.all([
        firstLogin,
        duplicateLogin,
        firstRegister,
        duplicateRegister,
      ]);
    });
    expect(mockGoBack).toHaveBeenCalledTimes(2);

    act(() => {
      loginRenderer.unmount();
      registerRenderer.unmount();
    });
  });

  it('enters captcha mode from server evidence and submits only the refreshed challenge', async () => {
    mockLogin
      .mockRejectedValueOnce(
        new ApiClientError(
          '账号或密码错误，请输入图形验证码',
          'INVALID_CREDENTIALS',
          401,
          {
            need_captcha: true,
            locked: false,
            remaining_attempts: 2,
            lock_seconds: 900,
          },
        ),
      )
      .mockResolvedValueOnce(undefined);
    mockFetchLoginCaptcha
      .mockResolvedValueOnce({
        captchaId: 'captcha-challenge-first-123456',
        svgXml:
          '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44"><text>AB2CD</text></svg>',
        expiresIn: 300,
      })
      .mockResolvedValueOnce({
        captchaId: 'captcha-challenge-second-12345',
        svgXml:
          '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44"><text>EF3GH</text></svg>',
        expiresIn: 300,
      });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '密码').props.onChangeText('secret1');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockLogin).toHaveBeenNthCalledWith(
      1,
      'mobile@example.com',
      'secret1',
      undefined,
    );
    expect(mockFetchLoginCaptcha).toHaveBeenCalledTimes(1);
    expect(input(renderer, '图形验证码').props.value).toBe('');
    expect(mockGoBack).not.toHaveBeenCalled();

    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: '刷新图形验证码' })
        .props.onPress();
    });
    act(() => {
      input(renderer, '图形验证码').props.onChangeText('ef3gh');
    });
    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockLogin).toHaveBeenNthCalledWith(
      2,
      'mobile@example.com',
      'secret1',
      {
        captchaId: 'captcha-challenge-second-12345',
        captchaCode: 'EF3GH',
      },
    );
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('accepts a captcha response after StrictMode effect replay', async () => {
    mockLogin.mockRejectedValueOnce(
      new ApiClientError('需要图形验证码', 'CAPTCHA_REQUIRED', 400, {
        need_captcha: true,
        locked: false,
        remaining_attempts: 2,
        lock_seconds: 900,
      }),
    );
    mockFetchLoginCaptcha.mockResolvedValue({
      captchaId: 'captcha-strict-mode-123456789',
      svgXml:
        '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44"><text>AB2CD</text></svg>',
      expiresIn: 300,
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <React.StrictMode>
          <LoginScreen navigation={navigation as never} route={{} as never} />
        </React.StrictMode>,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '密码').props.onChangeText('secret1');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });

    expect(mockFetchLoginCaptcha).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findByProps({ accessibilityLabel: '图形验证码图片' }),
    ).toBeDefined();
    expect(input(renderer, '图形验证码').props.editable).toBe(true);

    act(() => renderer.unmount());
  });

  it('fails closed when captcha loading is invalid or unavailable', async () => {
    mockLogin.mockRejectedValueOnce(
      new ApiClientError('请完成图形验证', 'CAPTCHA_REQUIRED', 400, {
        need_captcha: true,
        locked: false,
        remaining_attempts: 1,
        lock_seconds: 900,
      }),
    );
    mockFetchLoginCaptcha.mockRejectedValue(
      new ApiClientError(
        '图形验证码响应格式无效，请刷新后重试',
        'INVALID_LOGIN_CAPTCHA_RESPONSE',
      ),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '密码').props.onChangeText('secret1');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    const submit = renderer.root.findByType(PrimaryButton);
    expect(submit.props.disabled).toBe(true);
    expect(renderedText(renderer)).toContain('图形验证码响应格式无效');
    await act(async () => {
      await submit.props.onPress();
    });
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockGoBack).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('discards a consumed captcha after rejection and requires a new challenge', async () => {
    mockLogin
      .mockRejectedValueOnce(
        new ApiClientError('需要图形验证码', 'INVALID_CREDENTIALS', 401, {
          need_captcha: true,
          locked: false,
          remaining_attempts: 2,
          lock_seconds: 900,
        }),
      )
      .mockRejectedValueOnce(
        new ApiClientError('验证码错误', 'CAPTCHA_INVALID', 400, {
          need_captcha: true,
          locked: false,
          remaining_attempts: 1,
          lock_seconds: 900,
        }),
      )
      .mockResolvedValueOnce(undefined);
    mockFetchLoginCaptcha
      .mockResolvedValueOnce({
        captchaId: 'captcha-consumed-first-123456',
        svgXml:
          '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44"><text>AB2CD</text></svg>',
        expiresIn: 300,
      })
      .mockResolvedValueOnce({
        captchaId: 'captcha-consumed-second-12345',
        svgXml:
          '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44"><text>EF3GH</text></svg>',
        expiresIn: 300,
      });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '密码').props.onChangeText('secret1');
    });
    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    act(() => {
      input(renderer, '图形验证码').props.onChangeText('AB2CD');
    });
    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });

    expect(mockFetchLoginCaptcha).toHaveBeenCalledTimes(2);
    expect(input(renderer, '图形验证码').props.value).toBe('');
    expect(mockGoBack).not.toHaveBeenCalled();
    act(() => {
      input(renderer, '图形验证码').props.onChangeText('EF3GH');
    });
    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockLogin).toHaveBeenNthCalledWith(
      3,
      'mobile@example.com',
      'secret1',
      {
        captchaId: 'captcha-consumed-second-12345',
        captchaCode: 'EF3GH',
      },
    );
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('keeps captcha mandatory and blocks submission while server lock is active', async () => {
    mockLogin.mockRejectedValueOnce(
      new ApiClientError('登录失败次数过多，请稍后再试', 'LOGIN_LOCKED', 429, {
        need_captcha: true,
        locked: true,
        remaining_attempts: 0,
        lock_seconds: 900,
      }),
    );
    mockFetchLoginCaptcha.mockResolvedValue({
      captchaId: 'captcha-challenge-locked-123456',
      svgXml:
        '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44"><text>AB2CD</text></svg>',
      expiresIn: 300,
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginScreen navigation={navigation as never} route={{} as never} />,
      );
    });
    act(() => {
      input(renderer, '邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '密码').props.onChangeText('secret1');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(renderer.root.findByType(PrimaryButton).props.disabled).toBe(true);
    expect(renderedText(renderer)).toContain('登录已被锁定，900 秒后可重试');
    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(input(renderer, '图形验证码').props.editable).toBe(false);

    act(() => renderer.unmount());
  });

  it('uses reset OTP and submits the exact reset-password contract', async () => {
    mockSendOtp.mockResolvedValue({ message: 'otp sent' });
    mockResetPassword.mockResolvedValue({
      message: '密码重置成功，请使用新密码登录',
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(resetScreen());
    });
    act(() => {
      input(renderer, '注册邮箱').props.onChangeText(' MOBILE@example.com ');
      input(renderer, '邮箱验证码').props.onChangeText('654321');
      input(renderer, '新密码').props.onChangeText('Strong1!');
      input(renderer, '确认新密码').props.onChangeText('Strong1!');
    });

    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: '发送验证码' })
        .props.onPress();
    });
    expect(mockSendOtp).toHaveBeenCalledWith({
      email: 'mobile@example.com',
      scene: 'reset',
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockResetPassword).toHaveBeenCalledWith({
      email: 'mobile@example.com',
      otp: '654321',
      new_password: 'Strong1!',
      confirm_password: 'Strong1!',
    });
    expect(mockReplace).toHaveBeenCalledWith('Login');

    act(() => renderer.unmount());
  });

  it('retains all reset inputs and never navigates on an unconfirmed response', async () => {
    mockResetPassword.mockRejectedValue(new Error('密码重置响应无法确认'));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(resetScreen());
    });
    act(() => {
      input(renderer, '注册邮箱').props.onChangeText('mobile@example.com');
      input(renderer, '邮箱验证码').props.onChangeText('654321');
      input(renderer, '新密码').props.onChangeText('Strong1!');
      input(renderer, '确认新密码').props.onChangeText('Strong1!');
    });

    await act(async () => {
      await renderer.root.findByType(PrimaryButton).props.onPress();
    });

    expect(input(renderer, '注册邮箱').props.value).toBe('mobile@example.com');
    expect(input(renderer, '邮箱验证码').props.value).toBe('654321');
    expect(input(renderer, '新密码').props.value).toBe('Strong1!');
    expect(input(renderer, '确认新密码').props.value).toBe('Strong1!');
    expect(renderedText(renderer)).toContain('密码重置响应无法确认');
    expect(mockReplace).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });
});
