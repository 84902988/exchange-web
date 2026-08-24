import {
  changeMyPassword,
  confirmCurrentEmailVerification,
  confirmEmailChange,
  fetchMyActiveSessions,
  fetchMyLoginLogs,
  fetchMySecurityEvents,
  revokeMyOtherSessions,
  revokeMySession,
  sendCurrentEmailVerification,
  sendEmailChangeVerification,
  updateMyProfile,
  uploadMyAvatar,
  normalizeSessionDeviceName,
} from '../src/api/auth';
import {apiClient, setApiAuthTokens} from '../src/api/client';
import {getPasswordChecks} from '../src/screens/account/ChangePasswordScreen';
import {
  formatDeviceName,
  formatLoginFailureReason,
  formatLoginTime,
  recentDevices,
} from '../src/screens/account/LoginActivityScreen';
import {normalizeAvatarAsset} from '../src/screens/account/ProfileEditScreen';
import {getAccountSecurityProgress} from '../src/screens/account/AccountSecurityScreen';

const activeUser = {
  id: 7,
  email: 'mobile@example.com',
  status: 1,
  profile: {username: 'mobile-user', nickname: '移动用户'},
};

describe('mobile account security contracts', () => {
  beforeEach(() => {
    setApiAuthTokens({accessToken: 'access-token', refreshToken: 'refresh-token'});
  });

  afterEach(() => {
    setApiAuthTokens(null);
    jest.restoreAllMocks();
  });

  it('updates only profile display fields through PATCH without retry', async () => {
    const patch = jest.spyOn(apiClient, 'patch').mockResolvedValue(activeUser);
    await expect(
      updateMyProfile({username: 'mobile-user', nickname: '新昵称'}),
    ).resolves.toMatchObject({id: 7});
    expect(patch).toHaveBeenCalledWith(
      '/me',
      {username: 'mobile-user', nickname: '新昵称'},
      {retry: 'none'},
    );
  });

  it('uploads a multipart avatar and requires a valid user response', async () => {
    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({...activeUser, avatar_url: '/static/avatar.jpg'})
      .mockResolvedValueOnce({ok: true});
    const file = {
      uri: 'file:///avatar.jpg',
      name: 'avatar.jpg',
      type: 'image/jpeg' as const,
    };
    await expect(uploadMyAvatar(file)).resolves.toMatchObject({id: 7});
    expect(post.mock.calls[0][0]).toBe('/me/avatar');
    expect(post.mock.calls[0][1]).toBeInstanceOf(FormData);
    expect(post.mock.calls[0][2]).toEqual({retry: 'none', timeoutMs: 30_000});
    await expect(uploadMyAvatar(file)).rejects.toMatchObject({
      code: 'INVALID_ME_RESPONSE',
    });
  });

  it('changes a password once and rejects ambiguous success payloads', async () => {
    const patch = jest
      .spyOn(apiClient, 'patch')
      .mockResolvedValueOnce({password_changed_at: '2026-08-02T12:00:00'})
      .mockResolvedValueOnce({});
    const payload = {old_password: 'OldPass1!', new_password: 'NewPass2@'};
    await expect(changeMyPassword(payload)).resolves.toEqual({
      password_changed_at: '2026-08-02T12:00:00',
    });
    expect(patch).toHaveBeenNthCalledWith(1, '/me/password', payload, {
      retry: 'none',
    });
    await expect(changeMyPassword(payload)).rejects.toMatchObject({
      code: 'INVALID_PASSWORD_CHANGE_RESPONSE',
    });
  });

  it('strictly parses bounded login history and fails closed on bad rows', async () => {
    const get = jest
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({
        items: [
          {
            id: 9,
            user_id: 7,
            email: 'mobile@example.com',
            ip_address: '203.0.113.10',
            user_agent: 'ExchangeMobile/1',
            device_name: 'Android',
            country_code: 'CN',
            login_status: 'SUCCESS',
            failure_reason: null,
            created_at: '2026-08-02T12:00:00',
          },
        ],
      })
      .mockResolvedValueOnce({items: [{id: 10, login_status: 'UNKNOWN'}]});
    await expect(fetchMyLoginLogs(999)).resolves.toMatchObject([
      {id: 9, userId: 7, status: 'SUCCESS', deviceName: 'Android'},
    ]);
    expect(get).toHaveBeenNthCalledWith(1, '/me/login-logs?limit=100', {
      signal: undefined,
    });
    await expect(fetchMyLoginLogs()).rejects.toMatchObject({
      code: 'INVALID_LOGIN_LOG_RESPONSE',
    });
  });

  it('strictly parses cursor-paginated security events and rejects unknown types', async () => {
    const get = jest
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({
        items: [
          {
            id: 12,
            event_type: 'EMAIL_CHANGED',
            ip_address: '203.0.113.12',
            user_agent: 'ExchangeMobile Android',
            details: {
              old_email: 'ol***@example.com',
              new_email: 'ne***@example.com',
              secret: 'ignored',
            },
            created_at: '2026-08-02T12:00:00Z',
          },
        ],
        has_more: true,
        next_cursor: 12,
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 11,
            event_type: 'INTERNAL_ONLY',
            ip_address: '203.0.113.11',
            user_agent: '',
            details: {},
            created_at: '2026-08-02T11:00:00Z',
          },
        ],
        has_more: false,
        next_cursor: null,
      });

    await expect(fetchMySecurityEvents(999, 42)).resolves.toEqual({
      items: [
        {
          id: 12,
          eventType: 'EMAIL_CHANGED',
          ipAddress: '203.0.113.12',
          userAgent: 'ExchangeMobile Android',
          details: {
            old_email: 'ol***@example.com',
            new_email: 'ne***@example.com',
          },
          createdAt: '2026-08-02T12:00:00Z',
        },
      ],
      hasMore: true,
      nextCursor: 12,
    });
    expect(get).toHaveBeenNthCalledWith(
      1,
      '/me/security-events?limit=50&before_id=42',
      {signal: undefined},
    );
    await expect(fetchMySecurityEvents()).rejects.toMatchObject({
      code: 'INVALID_SECURITY_EVENT_RESPONSE',
    });
    await expect(fetchMySecurityEvents(20, 0)).rejects.toMatchObject({
      code: 'INVALID_SECURITY_EVENT_CURSOR',
    });
  });

  it('enforces avatar and password presentation rules', () => {
    expect(
      normalizeAvatarAsset({
        uri: 'file:///avatar.png',
        fileName: 'avatar.png',
        fileSize: 900_000,
        type: 'image/png',
      }),
    ).toMatchObject({type: 'image/png'});
    expect(() =>
      normalizeAvatarAsset({
        uri: 'file:///avatar.png',
        fileSize: 1_100_000,
        type: 'image/png',
      }),
    ).toThrow('1 MB');
    expect(getPasswordChecks('Strong1!').every(item => item.passed)).toBe(true);
  });

  it('scores only implemented password, email and KYC security capabilities', () => {
    expect(getAccountSecurityProgress(false, false)).toEqual({
      completed: 1,
      total: 3,
      percent: 33,
    });
    expect(getAccountSecurityProgress(true, false)).toEqual({
      completed: 2,
      total: 3,
      percent: 67,
    });
    expect(getAccountSecurityProgress(true, true)).toEqual({
      completed: 3,
      total: 3,
      percent: 100,
    });
  });

  it('labels device aggregation as history rather than live sessions', () => {
    const rows = [
      {
        id: 3,
        userId: 7,
        email: null,
        ipAddress: '203.0.113.3',
        userAgent: 'UA-1',
        deviceName: 'Android',
        countryCode: 'CN',
        status: 'SUCCESS' as const,
        failureReason: null,
        createdAt: '2026-08-02T12:00:00',
      },
      {
        id: 2,
        userId: 7,
        email: null,
        ipAddress: '203.0.113.2',
        userAgent: 'UA-1',
        deviceName: 'Android',
        countryCode: 'CN',
        status: 'SUCCESS' as const,
        failureReason: null,
        createdAt: '2026-08-01T12:00:00',
      },
    ];
    expect(recentDevices(rows)).toHaveLength(1);
    expect(formatLoginTime('invalid')).toBe('--');
    expect(formatDeviceName('Unknown browser / Unknown OS')).toBe('未知设备');
    expect(formatLoginFailureReason('invalid credentials')).toBe('账号或密码验证失败');
  });

  it('strictly lists active sessions and proves the current refresh session', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      current_session_id: 11,
      total: 2,
      items: [
        {
          id: 11,
          ip_address: '203.0.113.11',
          user_agent: 'ExchangeMobile Android',
          device_name: 'Unknown browser / Android',
          created_at: '2026-08-01T12:00:00',
          last_used_at: '2026-08-02T12:00:00',
          expires_at: '2026-08-12T12:00:00',
          is_current: true,
        },
        {
          id: 12,
          ip_address: '203.0.113.12',
          user_agent: 'Chrome Windows',
          device_name: 'Chrome / Windows',
          created_at: '2026-08-01T12:00:00',
          last_used_at: null,
          expires_at: '2026-08-12T12:00:00',
          is_current: false,
        },
      ],
    });

    await expect(fetchMyActiveSessions()).resolves.toMatchObject({
      currentSessionId: 11,
      total: 2,
      items: [
        {id: 11, isCurrent: true, deviceName: 'ExchangeMobile / Android'},
        {id: 12, isCurrent: false},
      ],
    });
    expect(post).toHaveBeenCalledWith(
      '/auth/sessions/list',
      {refresh_token: 'refresh-token'},
      {retry: 'none', signal: undefined},
    );
  });

  it('normalizes native transport user agents without guessing web devices', () => {
    expect(
      normalizeSessionDeviceName('Unknown browser / Unknown OS', 'okhttp/4.12'),
    ).toBe('ExchangeMobile / Android');
    expect(
      normalizeSessionDeviceName('Unknown browser / Android', 'okhttp/4.12'),
    ).toBe('ExchangeMobile / Android');
    expect(
      normalizeSessionDeviceName(
        'Unknown browser / Unknown OS',
        'ExchangeMobile CFNetwork Darwin',
      ),
    ).toBe('ExchangeMobile / iOS');
    expect(normalizeSessionDeviceName('Chrome / Windows', 'Mozilla')).toBe(
      'Chrome / Windows',
    );
  });

  it('rejects ambiguous session lists and confirms revoke writes without retry', async () => {
    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({current_session_id: 11, total: 0, items: []})
      .mockResolvedValueOnce({session_id: 12, revoked: true})
      .mockResolvedValueOnce({revoked_count: 2, current_session_id: 11});

    await expect(fetchMyActiveSessions()).rejects.toMatchObject({
      code: 'INVALID_SESSION_LIST_RESPONSE',
    });
    await expect(revokeMySession(12)).resolves.toEqual({
      sessionId: 12,
      revoked: true,
    });
    await expect(revokeMyOtherSessions()).resolves.toEqual({
      revokedCount: 2,
      currentSessionId: 11,
    });
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/auth/sessions/12/revoke',
      {refresh_token: 'refresh-token'},
      {retry: 'none'},
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      '/auth/sessions/revoke-others',
      {refresh_token: 'refresh-token'},
      {retry: 'none'},
    );
  });

  it('uses dedicated non-retrying email verification and change contracts', async () => {
    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({
        message: 'verification code sent',
        email: 'mo***@example.com',
      })
      .mockResolvedValueOnce({
        email: 'mobile@example.com',
        email_verified_at: '2026-08-02T13:00:00',
      })
      .mockResolvedValueOnce({
        message: 'verification code sent',
        email: 'ne***@example.com',
      })
      .mockResolvedValueOnce({
        email: 'next@example.com',
        email_verified_at: '2026-08-02T13:05:00',
        reauthenticate: true,
      });

    await expect(sendCurrentEmailVerification()).resolves.toEqual({
      message: 'verification code sent',
      email: 'mo***@example.com',
    });
    await expect(confirmCurrentEmailVerification(' 123456 ')).resolves.toEqual({
      email: 'mobile@example.com',
      email_verified_at: '2026-08-02T13:00:00',
    });
    await expect(
      sendEmailChangeVerification({
        new_email: ' NEXT@Example.com ',
        current_password: 'OldPass!123',
      }),
    ).resolves.toMatchObject({email: 'ne***@example.com'});
    await expect(
      confirmEmailChange({
        new_email: ' NEXT@Example.com ',
        current_password: 'OldPass!123',
        code: ' 654321 ',
      }),
    ).resolves.toEqual({
      email: 'next@example.com',
      email_verified_at: '2026-08-02T13:05:00',
      reauthenticate: true,
    });

    expect(post).toHaveBeenNthCalledWith(
      1,
      '/me/email/verification/send',
      {},
      {retry: 'none'},
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/me/email/verification/confirm',
      {code: '123456'},
      {retry: 'none'},
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      '/me/email/change/send',
      {new_email: 'next@example.com', current_password: 'OldPass!123'},
      {retry: 'none'},
    );
    expect(post).toHaveBeenNthCalledWith(
      4,
      '/me/email/change/confirm',
      {
        new_email: 'next@example.com',
        current_password: 'OldPass!123',
        code: '654321',
      },
      {retry: 'none'},
    );
  });

  it('fails closed when an email change response does not revoke login state', async () => {
    jest.spyOn(apiClient, 'post').mockResolvedValue({
      email: 'next@example.com',
      email_verified_at: '2026-08-02T13:05:00',
      reauthenticate: false,
    });
    await expect(
      confirmEmailChange({
        new_email: 'next@example.com',
        current_password: 'OldPass!123',
        code: '654321',
      }),
    ).rejects.toMatchObject({code: 'INVALID_EMAIL_SECURITY_RESPONSE'});
  });
});
