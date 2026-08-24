import {
  changeMyPassword,
  getMe,
  fetchLoginCaptcha,
  login,
  readLoginFailureState,
  register,
  resetPassword,
  sendOtp,
} from '../src/api/auth';
import {ApiClientError, apiClient, publicApiClient} from '../src/api/client';

const captchaSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44">\n' +
  '<rect width="132" height="44" rx="6" fill="#10141c"/>\n' +
  '<text x="66" y="29">AB2CD</text>\n</svg>';
const captchaSvgData =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMzIiIGhlaWdodD0iNDQiIHZpZXdCb3g9IjAgMCAxMzIgNDQiPgo8cmVjdCB3aWR0aD0iMTMyIiBoZWlnaHQ9IjQ0IiByeD0iNiIgZmlsbD0iIzEwMTQxYyIvPgo8dGV4dCB4PSI2NiIgeT0iMjkiPkFCMkNEPC90ZXh0Pgo8L3N2Zz4=';
const unsafeCaptchaSvgData =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMzIiIGhlaWdodD0iNDQiIHZpZXdCb3g9IjAgMCAxMzIgNDQiPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=';

describe('mobile auth API contracts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends register OTP with the backend scene and requires its receipt', async () => {
    const post = jest
      .spyOn(publicApiClient, 'post')
      .mockResolvedValueOnce({message: 'otp sent'})
      .mockResolvedValueOnce({message: 'queued'});

    await expect(
      sendOtp({email: 'mobile@example.com', scene: 'register'}),
    ).resolves.toEqual({message: 'otp sent'});
    expect(post).toHaveBeenNthCalledWith(1, '/auth/otp/send', {
      email: 'mobile@example.com',
      scene: 'register',
    });
    await expect(
      sendOtp({email: 'mobile@example.com', scene: 'register'}),
    ).rejects.toMatchObject({code: 'INVALID_OTP_SEND_RESPONSE'});
  });

  it('submits the canonical reset fields and rejects an ambiguous 200 response', async () => {
    const payload = {
      email: 'mobile@example.com',
      otp: '123456',
      new_password: 'Strong1!',
      confirm_password: 'Strong1!',
    };
    const post = jest
      .spyOn(publicApiClient, 'post')
      .mockResolvedValueOnce({
        message: '密码重置成功，请使用新密码登录',
      })
      .mockResolvedValueOnce({});

    await expect(resetPassword(payload)).resolves.toEqual({
      message: '密码重置成功，请使用新密码登录',
    });
    expect(post).toHaveBeenNthCalledWith(1, '/auth/reset-password', payload);
    await expect(resetPassword(payload)).rejects.toMatchObject({
      code: 'INVALID_RESET_PASSWORD_RESPONSE',
    });
  });

  it('requires login and registration to return a complete token pair', async () => {
    jest
      .spyOn(publicApiClient, 'post')
      .mockResolvedValueOnce({
        access_token: 'login-access',
        refresh_token: 'login-refresh',
        token_type: 'bearer',
      })
      .mockResolvedValueOnce({message: 'registered'})
      .mockResolvedValueOnce({access_token: 'register-access'});

    await expect(
      login({account: 'mobile@example.com', password: 'secret'}),
    ).resolves.toMatchObject({
      access_token: 'login-access',
      refresh_token: 'login-refresh',
    });
    await expect(
      register({
        email: 'mobile@example.com',
        otp: '123456',
        password: 'secret',
      }),
    ).rejects.toMatchObject({code: 'INVALID_REGISTER_RESPONSE'});
    await expect(
      register({
        email: 'mobile@example.com',
        otp: '123456',
        password: 'secret',
      }),
    ).rejects.toMatchObject({code: 'INVALID_REGISTER_RESPONSE'});
  });

  it('loads only the backend captcha ID, bounded expiry and safe SVG payload', async () => {
    const get = jest
      .spyOn(publicApiClient, 'get')
      .mockResolvedValueOnce({
        captcha_id: 'abcdefghijklmnopqrstuvwxyz_12345',
        image: captchaSvgData,
        expires_in: 300,
      })
      .mockResolvedValueOnce({
        captcha_id: 'abcdefghijklmnopqrstuvwxyz_12345',
        image: unsafeCaptchaSvgData,
        expires_in: 300,
      });

    await expect(fetchLoginCaptcha()).resolves.toEqual({
      captchaId: 'abcdefghijklmnopqrstuvwxyz_12345',
      svgXml: captchaSvg,
      expiresIn: 300,
    });
    expect(get).toHaveBeenNthCalledWith(1, '/auth/captcha');
    await expect(fetchLoginCaptcha()).rejects.toMatchObject({
      code: 'INVALID_LOGIN_CAPTCHA_RESPONSE',
    });
  });

  it('reads captcha and lock requirements only from typed login failures', () => {
    expect(
      readLoginFailureState(
        new ApiClientError('需要验证码', 'INVALID_CREDENTIALS', 401, {
          need_captcha: true,
          locked: false,
          remaining_attempts: 2,
          lock_seconds: 900,
        }),
      ),
    ).toEqual({
      code: 'INVALID_CREDENTIALS',
      needCaptcha: true,
      locked: false,
      lockSeconds: 900,
      remainingAttempts: 2,
    });
    expect(
      readLoginFailureState(
        new ApiClientError('已锁定', 'LOGIN_LOCKED', 429, {
          locked: true,
          lock_seconds: 900,
        }),
      ),
    ).toMatchObject({needCaptcha: true, locked: true, lockSeconds: 900});
    expect(
      readLoginFailureState(
        new ApiClientError('普通失败', 'INVALID_CREDENTIALS', 401, {
          need_captcha: false,
        }),
      ),
    ).toBeNull();
  });

  it('accepts only an active /me identity with a positive ID and account field', async () => {
    const get = jest
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({
        id: 7,
        email: 'mobile@example.com',
        status: 1,
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({id: -1, email: 'mobile@example.com', status: 1})
      .mockResolvedValueOnce({id: 7, status: 1});

    await expect(getMe()).resolves.toMatchObject({id: 7, status: 1});
    expect(get).toHaveBeenNthCalledWith(1, '/me');
    await expect(getMe()).rejects.toMatchObject({code: 'INVALID_ME_RESPONSE'});
    await expect(getMe()).rejects.toMatchObject({code: 'INVALID_ME_RESPONSE'});
    await expect(getMe()).rejects.toMatchObject({code: 'INVALID_ME_RESPONSE'});
  });

  it('retries password change once after an authenticated session refresh', async () => {
    const passwordChange = {
      old_password: 'OldPass!123',
      new_password: 'NewPass!456',
    };
    const refreshedError = new ApiClientError(
      '登录状态已更新，请确认后重新提交',
      'AUTH_REFRESHED_RETRY_REQUIRED',
    );
    const patch = jest
      .spyOn(apiClient, 'patch')
      .mockRejectedValueOnce(refreshedError)
      .mockResolvedValueOnce({password_changed_at: '2026-08-20T10:00:00Z'});

    await expect(changeMyPassword(passwordChange)).resolves.toEqual({
      password_changed_at: '2026-08-20T10:00:00Z',
    });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenNthCalledWith(
      1,
      '/me/password',
      passwordChange,
      {retry: 'none'},
    );
    expect(patch).toHaveBeenNthCalledWith(
      2,
      '/me/password',
      passwordChange,
      {retry: 'none'},
    );

    patch.mockReset().mockRejectedValue(refreshedError);
    await expect(changeMyPassword(passwordChange)).rejects.toBe(refreshedError);
    expect(patch).toHaveBeenCalledTimes(2);
  });
});
