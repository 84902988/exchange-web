'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  getInvitedFriends,
  getMyKyc,
  getUserInfo,
  getUserLoginLogs,
  UserInfo,
  type InvitedFriendItem,
} from '@/lib/api';
import {
  getVipFeePreference,
  getVipOverview,
  updateVipFeePreference,
} from '@/lib/api/modules/vip';
import type { VipOverviewResponse } from '@/components/vip/vip.types';
import { formatFeeRate, formatRcbFeePayPercent, resolveRcbFeePayPercent } from '@/components/vip/vip.utils';
import { useLocaleContext } from '@/contexts/LocaleContext';
import UserSidebar from '@/components/user/UserSidebar';
import EmptyState from '@/components/ui/EmptyState';
import UserAvatar from '@/components/user/UserAvatar';
import { useAuth } from '@/lib/authContext';
import { getUserAvatarUrl, getUserDisplayName } from '@/lib/userAvatar';

const MOCK_USER_INFO: UserInfo = {
  id: '0000000000',
  username: 'Anduin01',
  email: 'test@example.com',
  phone: '13800138000',
  createdAt: '2026-01-01T00:00:00Z',
  lastLoginAt: '2026-01-05T12:34:56Z',
  kycLevel: 1,
  kycStatus: 'APPROVED',
  nickname: 'Anduin01',
  avatar: '',
  accountStatus: 'active',
  usernameReviewStatus: 'none',
  nicknameReviewStatus: 'none',
  avatarReviewStatus: 'none',
  usernameChangeRecords: [],
  nicknameChangeRecords: [],
  avatarChangeRecords: [],
  lastUsernameChange: '2026-01-01T00:00:00Z',
  lastNicknameChange: '2026-01-01T00:00:00Z',
  usernameChangeCount: 0,
  nicknameChangeCount: 0,
  usernameChangeResetDate: '2027-01-01T00:00:00Z',
  nicknameChangeResetDate: '2026-01-08T00:00:00Z',
  withdrawLocked: false,
  withdrawLockedReason: '',
};

const formatDateTime = (value?: string | null, localeCode = 'zh-CN') => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(localeCode, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getInviteSourceLabel = (sourceType: string | null | undefined, t: (key: string, namespace?: 'user') => string) => {
  if (sourceType === 'BD') return 'BD';
  if (sourceType === 'USER_INVITE') return t('normalInvite', 'user');
  return t('invite', 'user');
};

const getInviteSourceClassName = (sourceType?: string | null) => {
  if (sourceType === 'BD') {
    return 'border-sky-300/25 bg-sky-300/10 text-sky-200';
  }
  if (sourceType === 'USER_INVITE') {
    return 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200';
  }
  return 'border-white/10 bg-white/[0.04] text-white/60';
};

const getSuccessfulDeviceCount = (
  logs: Array<{ login_status: string; device_name?: string | null; ip_address?: string | null }>,
) => {
  const devices = new Set<string>();

  logs.forEach((item) => {
    if (item.login_status !== 'SUCCESS') return;
    devices.add(`${item.device_name || 'unknown'}::${item.ip_address || '-'}`);
  });

  return devices.size;
};

const getIdentityCard = (
  kycStatus: string | null | undefined,
  kycLevel: number | null | undefined,
  t: (key: string, namespace?: 'user') => string,
) => {
  const normalized = (kycStatus || '').toUpperCase();
  if (normalized === 'PENDING') {
    return {
      badge: t('verifying', 'user'),
      badgeClass: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
      button: t('viewDetails', 'user'),
      description: t('kycReviewingDesc', 'user'),
    };
  }
  if (normalized === 'APPROVED' || (kycLevel ?? 0) > 0) {
    return {
      badge: t('verified', 'user'),
      badgeClass: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
      button: t('viewDetails', 'user'),
      description: t('kycVerifiedDesc', 'user'),
    };
  }
  if (normalized === 'REJECTED') {
    return {
      badge: t('rejected', 'user'),
      badgeClass: 'border-red-400/30 bg-red-400/10 text-red-300',
      button: t('viewDetails', 'user'),
      description: t('kycRejectedDesc', 'user'),
    };
  }
  return {
    badge: t('notVerified', 'user'),
    badgeClass: 'border-white/10 bg-white/[0.04] text-white/60',
    button: t('goVerify', 'user'),
    description: t('kycNotVerifiedDesc', 'user'),
  };
};

export default function UserPage() {
  const { locale, t } = useLocaleContext();
  const router = useRouter();
  const { user: authUser } = useAuth();

  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isRcbDeductionEnabled, setIsRcbDeductionEnabled] = useState(false);
  const [vipOverview, setVipOverview] = useState<VipOverviewResponse | null>(null);
  const [feePreferenceLoading, setFeePreferenceLoading] = useState(false);
  const [feePreferenceMessage, setFeePreferenceMessage] = useState('');
  const [lastSuccessfulLoginAt, setLastSuccessfulLoginAt] = useState<string | null>(null);
  const [successfulDeviceCount, setSuccessfulDeviceCount] = useState<number | null>(null);
  const [kycStatus, setKycStatus] = useState<string>('NONE');
  const [kycLevel, setKycLevel] = useState<number>(0);
  const [invitedFriends, setInvitedFriends] = useState<InvitedFriendItem[]>([]);
  const [invitedFriendsLoading, setInvitedFriendsLoading] = useState(false);
  const [invitedFriendsMessage, setInvitedFriendsMessage] = useState('');

  const toggleSidebar = () => setIsSidebarCollapsed((v) => !v);

  useEffect(() => {
    const authAvatar = getUserAvatarUrl(authUser);
    if (!authAvatar) return;
    setUserInfo((prev) => {
      if (!prev || prev.avatar === authAvatar) return prev;
      return { ...prev, avatar: authAvatar };
    });
  }, [authUser]);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      setLoading(true);

      try {
        const info = await getUserInfo();
        if (!alive) return;
        setUserInfo(info);
        setKycStatus(info.kycStatus || 'NONE');
        setKycLevel(info.kycLevel || 0);

        try {
          const kyc = await getMyKyc();
          if (!alive) return;
          setKycStatus(kyc.kyc_status || 'NONE');
          setKycLevel(kyc.kyc_level || 0);
        } catch (kycError) {
          if (!alive) return;
          console.error('Failed to fetch KYC status:', kycError);
        }

        try {
          const loginLogs = await getUserLoginLogs(20);
          if (!alive) return;
          const latestSuccess = loginLogs.find((item) => item.login_status === 'SUCCESS');
          setLastSuccessfulLoginAt(latestSuccess?.created_at ?? null);
          setSuccessfulDeviceCount(getSuccessfulDeviceCount(loginLogs));
        } catch (loginLogError) {
          if (!alive) return;
          console.error('Failed to fetch login logs:', loginLogError);
          setLastSuccessfulLoginAt(null);
          setSuccessfulDeviceCount(null);
        }

        if (info.id) {
          setInvitedFriendsLoading(true);
          setInvitedFriendsMessage('');
          try {
            const invitedFriendsData = await getInvitedFriends();
            if (!alive) return;
            setInvitedFriends(invitedFriendsData.items || []);
          } catch (invitedFriendsError) {
            if (!alive) return;
            console.error('Failed to fetch invited friends:', invitedFriendsError);
            setInvitedFriends([]);
            setInvitedFriendsMessage(t('invitedFriendsLoadFailed', 'user'));
          } finally {
            if (alive) {
              setInvitedFriendsLoading(false);
            }
          }
        } else {
          setInvitedFriends([]);
          setInvitedFriendsLoading(false);
        }

        try {
          const [overview, preference] = await Promise.all([
            getVipOverview(),
            getVipFeePreference(),
          ]);
          if (!alive) return;
          setVipOverview(overview);
          setIsRcbDeductionEnabled(Boolean(preference.use_rcb_fee));
        } catch (vipError) {
          if (!alive) return;
          console.error('Failed to fetch VIP fee data:', vipError);
          setFeePreferenceMessage(t('vipFeeLoadFailed', 'user'));
        }
      } catch (e: unknown) {
        if (!alive) return;

        const error = e as {
          code?: unknown;
          status?: unknown;
          response?: { status?: unknown };
          message?: unknown;
        };
        const code = error?.code ?? '';
        const httpStatus = error?.status ?? error?.response?.status ?? '';
        const message = (error?.message ?? '').toString();
        const isUnauthorized =
          code === 'UNAUTHORIZED' ||
          code === 'TOKEN_EXPIRED' ||
          String(code).includes('401') ||
          String(httpStatus) === '401' ||
          message.toLowerCase().includes('unauthorized');

        if (isUnauthorized) {
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          router.replace('/login?next=/user');
          return;
        }

        console.error('Failed to fetch user center data:', e);
        setUserInfo(MOCK_USER_INFO);
        setFeePreferenceMessage(t('vipFeeLoadFailed', 'user'));
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    };

    run();

    return () => {
      alive = false;
    };
  }, [router, t]);

  const handleRcbDeductionToggle = async () => {
    if (feePreferenceLoading) {
      return;
    }

    const previous = isRcbDeductionEnabled;
    const next = !previous;
    setIsRcbDeductionEnabled(next);
    setFeePreferenceLoading(true);
    setFeePreferenceMessage('');

    try {
      const preference = await updateVipFeePreference(next);
      setIsRcbDeductionEnabled(Boolean(preference.use_rcb_fee));
      setFeePreferenceMessage(t('rcbFeePreferenceUpdated', 'user'));
    } catch (error) {
      console.error('Failed to update RCB fee preference:', error);
      setIsRcbDeductionEnabled(previous);
      setFeePreferenceMessage(t('rcbFeePreferenceUpdateFailed', 'user'));
    } finally {
      setFeePreferenceLoading(false);
    }
  };

  const userSummary = vipOverview?.user_summary;
  const currentLevel = userSummary?.effective_level_code ?? '--';
  const vipLevel = userSummary?.vip_level_code ?? '--';
  const svipLevel = userSummary?.svip_level_code ?? '--';
  const makerFee = formatFeeRate(userSummary?.effective_spot_maker_fee ?? null);
  const takerFee = formatFeeRate(userSummary?.effective_spot_taker_fee ?? null);
  const rcbFeePayPercent = resolveRcbFeePayPercent(
    vipOverview?.rcb_fee_pay_percent,
    vipOverview?.rcb_discount_percent,
  );
  const rcbFeePayPercentText = formatRcbFeePayPercent(rcbFeePayPercent);
  const localeCode = locale === 'zh-TW' ? 'zh-TW' : locale === 'ja' ? 'ja-JP' : locale === 'en' ? 'en-US' : 'zh-CN';
  const rcbFeeStatusText = isRcbDeductionEnabled
    ? `${t('rcbFeeEnabledPrefix', 'user')} ${rcbFeePayPercentText}${t('rcbFeeEnabledSuffix', 'user')}`
    : t('rcbFeeDisabledDesc', 'user');
  const identityCard = getIdentityCard(kycStatus, kycLevel, t);

  if (loading) {
    return (
      <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
        <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
        <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10">
          <div className="w-full text-white/70">{t('loading', 'common')}</div>
        </div>
      </main>
    );
  }

  if (!userInfo) {
    return (
      <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
        <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
        <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10">
          <div className="w-full text-white/70">
            {t('noUserInfoRetry', 'user')}
          </div>
        </div>
      </main>
    );
  }

  const displayName = getUserDisplayName(userInfo) || '-';
  const nicknameText = (userInfo.nickname || '').trim();
  const usernameText = (userInfo.username || '').trim();
  const shouldShowUsername = Boolean(nicknameText && usernameText && nicknameText !== usernameText);

  return (
    <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10">
        <div className="w-full">
          <div className="bg-[#0a0a0d] rounded-lg p-4 mb-6 border border-white/10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <UserAvatar user={userInfo} className="h-12 w-12" fallbackClassName="text-xl" />

                <div>
                  <div className="text-white font-semibold">
                    {displayName}
                  </div>
                  {shouldShowUsername ? (
                    <div className="text-white/70 text-sm">
                      {t('username', 'user') as string}: {usernameText}
                    </div>
                  ) : null}
                  <div className="text-white/60 text-sm">
                    UID: {userInfo.id}
                  </div>

                  <div className="text-white/60 text-sm mt-1">
                    {userInfo.kycLevel === 0 ? (
                      <>
                        <span className="text-gray-400">{t('notVerified', 'user')}</span>{' '}
                        {t('kycVerification', 'user') as string} - {t('notVerified', 'user') as string}
                      </>
                    ) : userInfo.kycLevel === 1 ? (
                      <>
                        <span className="text-yellow-500">{t('basicVerification', 'user')}</span>{' '}
                        {t('kycVerification', 'user') as string} - {t('basicVerified', 'user') as string}
                      </>
                    ) : (
                      <>
                        <span className="text-green-500">{t('advancedVerification', 'user')}</span>{' '}
                        {t('kycVerification', 'user') as string} - {t('advancedVerified', 'user') as string}
                      </>
                    )}
                  </div>
                </div>
              </div>

              <Link
                href="/user/profile"
                className="bg-amber-500 hover:bg-amber-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm inline-block"
              >
                {t('personalProfile', 'user') as string}
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            <div className="flex min-h-[180px] flex-col rounded-lg border border-white/10 bg-[#0a0a0d] p-4">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-white font-semibold">{t('securityCenter', 'user') as string}</h3>
              </div>
              <div className="flex flex-1 flex-col gap-3 text-sm">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-white/80">{t('loginPassword', 'user')}</div>
                    <div className="mt-1 text-xs text-white/45">{t('loginPasswordProtectDesc', 'user')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-300">
                      {t('set', 'user')}
                    </span>
                    <Link
                      href="/user/security/password"
                      className="text-amber-500 transition-colors duration-200 hover:text-amber-400"
                    >
                      {t('change', 'user')}
                    </Link>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-white/80">{t('loginLogs', 'user')}</div>
                    <div className="mt-1 truncate text-xs text-white/45">{t('recentSuccessfulLogin', 'user')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/60">
                      {lastSuccessfulLoginAt ? formatDateTime(lastSuccessfulLoginAt, localeCode) : t('noRecords', 'user')}
                    </span>
                    <Link
                      href="/user/security/login-logs"
                      className="text-amber-500 transition-colors duration-200 hover:text-amber-400"
                    >
                      {t('view', 'user')}
                    </Link>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-white/80">{t('deviceManagement', 'user')}</div>
                    <div className="mt-1 text-xs text-white/45">{t('deviceIdentifiedByLoginDesc', 'user')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/60">
                      {successfulDeviceCount === null
                        ? t('noRecords', 'user')
                        : `${successfulDeviceCount} ${t('deviceUnit', 'user')}`}
                    </span>
                    <Link
                      href="/user/security/devices"
                      className="text-amber-500 transition-colors duration-200 hover:text-amber-400"
                    >
                      {t('manage', 'user')}
                    </Link>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex min-h-[180px] flex-col rounded-lg border border-white/10 bg-[#0a0a0d] p-4">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-white font-semibold">{t('identityVerification', 'user') as string}</h3>
                <button
                  className="bg-amber-500 hover:bg-amber-600 text-white py-1 px-3 rounded transition-colors duration-200 text-xs"
                  onClick={() => router.push('/user/kyc')}
                >
                  {identityCard.button}
                </button>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-3 text-sm text-white/60">
                <span className={`w-fit rounded-full border px-3 py-1 text-xs ${identityCard.badgeClass}`}>
                  {identityCard.badge}
                </span>
                <p>{identityCard.description}</p>
              </div>
              <div className="mt-auto flex justify-end">
                <button
                  className="text-amber-500 hover:text-amber-400 text-sm transition-colors duration-200"
                  onClick={() => router.push('/user/kyc')}
                >
                  {t('viewDetails', 'user') as string}
                </button>
              </div>
            </div>

            <div className="flex min-h-[180px] flex-col rounded-lg border border-white/10 bg-[#0a0a0d] p-4">
              <h3 className="text-white font-semibold mb-4">{t('fees', 'user') as string}</h3>
              <div className="space-y-4">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="text-white/60 text-sm">{t('currentEffectiveLevel', 'user')}</div>
                    <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-sm font-semibold text-amber-200">
                      {currentLevel}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-black/20 px-3 py-2">
                      <div className="text-[11px] text-white/40">{t('vipLevel', 'user')}</div>
                      <div className="mt-1 text-sm font-semibold text-white">{vipLevel}</div>
                    </div>
                    <div className="rounded-lg bg-black/20 px-3 py-2">
                      <div className="text-[11px] text-white/40">{t('svipLevel', 'user')}</div>
                      <div className="mt-1 text-sm font-semibold text-white">{svipLevel}</div>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <div className="text-white/60 text-sm">{t('makerFee', 'user')}</div>
                    <div className="text-amber-300 font-semibold">{makerFee}</div>
                  </div>
                  <div className="flex justify-between items-center">
                    <div className="text-white/60 text-sm">{t('takerFee', 'user')}</div>
                    <div className="text-amber-300 font-semibold">{takerFee}</div>
                  </div>
                  <div className="border-t border-white/10 pt-3 text-xs leading-relaxed text-white/50">
                    {t('bestVipFeeAutoSelected', 'user')}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-white/70 text-sm">{t('rcbDeduction', 'user') as string}</div>
                    <div className="text-white/40 text-xs mt-1">
                      {t('rcbDeductionDiscountPrefix', 'user')} {rcbFeePayPercentText} {t('rcbDeductionDiscountSuffix', 'user')}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={feePreferenceLoading}
                    className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 ${
                      isRcbDeductionEnabled ? 'bg-amber-500' : 'bg-white/20'
                    } ${feePreferenceLoading ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                    onClick={handleRcbDeductionToggle}
                    aria-pressed={isRcbDeductionEnabled}
                  >
                    <span
                      className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                        isRcbDeductionEnabled ? 'translate-x-7' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-white/50">
                  {rcbFeeStatusText}
                </div>

                {feePreferenceMessage ? (
                  <div
                    className={`text-xs ${
                      feePreferenceMessage === t('rcbFeePreferenceUpdateFailed', 'user') ||
                      feePreferenceMessage === t('vipFeeLoadFailed', 'user') ? 'text-red-400' : 'text-emerald-400'
                    }`}
                  >
                    {feePreferenceMessage}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex min-h-[180px] flex-col rounded-lg border border-white/10 bg-[#0a0a0d] p-4 md:col-span-2 xl:col-span-2">
              <div className="mb-4">
                <h3 className="font-semibold text-white">{t('inviteFriends', 'user') as string}</h3>
                <p className="mt-1 text-sm text-white/50">{t('invitedFriendsRecentDesc', 'user')}</p>
              </div>

              {invitedFriendsLoading ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-8 text-sm text-white/50">
                  {t('invitedFriendsLoading', 'user')}
                </div>
              ) : invitedFriends.length ? (
                <div className="space-y-3">
                  {invitedFriends.slice(0, 10).map((friend) => (
                    <div
                      key={`${friend.source_type}-${friend.user_id}`}
                      className="grid gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-3 text-sm md:grid-cols-3"
                    >
                      <div>
                        <div className="text-white font-medium">{friend.email || '-'}</div>
                        <div className="mt-1 text-xs text-white/40">{t('userId', 'user')}：{friend.user_id}</div>
                      </div>
                      <div>
                        <div className="text-xs text-white/40">{t('bindTime', 'user')}</div>
                        <div className="mt-1 text-white/70">{formatDateTime(friend.bound_at, localeCode)}</div>
                        {friend.invite_code ? (
                          <div className="mt-1 text-xs text-white/40">{t('inviteCode', 'user')}：{friend.invite_code}</div>
                        ) : null}
                      </div>
                      <div className="flex flex-col gap-1 md:items-end">
                        <span className={`w-fit rounded-full border px-3 py-1 text-xs ${getInviteSourceClassName(friend.source_type)}`}>
                          {getInviteSourceLabel(friend.source_type, t)}
                        </span>
                        {friend.registered_at ? (
                          <div className="text-xs text-white/50">{t('registerTime', 'user')}：{formatDateTime(friend.registered_at, localeCode)}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-8">
                  <EmptyState
                    title={t('noInvitedFriends', 'user')}
                    description={invitedFriendsMessage || t('noInvitedFriendsDesc', 'user')}
                    icon={null}
                    size="small"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
