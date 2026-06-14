'use client';

import React, { useMemo } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { Language } from '@/types';
import type { UserInfo } from '@/lib/api';
import UserAvatar from '@/components/user/UserAvatar';
import { getUserDisplayName } from '@/lib/userAvatar';

type Props = {
  userInfo: UserInfo;
  currentLanguage: Language;
  onEditUsername: () => void;
  onEditNickname: () => void;
  onPickAvatar: () => void;
  avatarPreview?: string | null;
};

export default function UserProfileHeader({
  userInfo,
  currentLanguage,
  onEditUsername,
  onEditNickname,
  onPickAvatar,
  avatarPreview,
}: Props) {
  const { t } = useLocaleContext();
  const createdDate = useMemo(() => {
    if (!userInfo.createdAt) return '-';
    const d = new Date(userInfo.createdAt);
    if (Number.isNaN(d.getTime())) return userInfo.createdAt;
    return d.toLocaleDateString(
      currentLanguage === 'en' ? 'en-US' : currentLanguage === 'zh-TW' ? 'zh-TW' : 'zh-CN'
    );
  }, [userInfo.createdAt, currentLanguage]);
  const displayName = getUserDisplayName(userInfo) || '-';
  const nicknameText = (userInfo.nickname || '').trim();
  const usernameText = (userInfo.username || '').trim();
  const shouldShowUsername = Boolean(nicknameText && usernameText && nicknameText !== usernameText);

  return (
    <div className="rounded-lg p-6 bg-[#0a0a0d] border border-white/10 mb-6">
      <div className="flex flex-col md:flex-row items-center gap-6">
        {/* Avatar */}
        <div className="relative">
          <UserAvatar
            user={userInfo}
            src={avatarPreview || userInfo.avatar}
            className="h-24 w-24"
            fallbackClassName="text-3xl"
          />

          {/* Upload btn */}
          <button
            className="absolute bottom-0 right-0 bg-amber-500 text-white rounded-full w-9 h-9 flex items-center justify-center hover:bg-amber-600 transition-colors"
            onClick={onPickAvatar}
            aria-label={t('profileUploadAvatar', 'user')}
            title={t('profileUploadAvatar', 'user')}
          >
            ✓
          </button>
        </div>

        {/* Display name */}
        <div className="flex-1 w-full">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <div className="text-white/50 text-sm mb-1">
                {t('profileDisplayName', 'user')}
              </div>
              <div className="flex items-center gap-3">
                <div className="text-white text-3xl font-semibold">{displayName}</div>
                <button className="text-amber-400 hover:text-amber-300 text-sm" onClick={onEditNickname}>
                  {t('profileEdit', 'user')}
                </button>
              </div>
              {shouldShowUsername ? (
                <div className="text-white/60 text-sm mt-2">
                  {t('profileUsername', 'user')}: {usernameText}
                  <button className="ml-3 text-amber-400 hover:text-amber-300" onClick={onEditUsername}>
                    {t('profileEdit', 'user')}
                  </button>
                </div>
              ) : null}
            </div>

            <div>
              <div className="text-white/50 text-sm mb-1">
                UID
              </div>
              <div className="text-white text-3xl font-semibold">{userInfo.id || '-'}</div>
              <div className="text-white/60 text-sm mt-2">
                {t('profileNicknameChangeInterval', 'user')}
              </div>
              <div className="text-white/50 text-sm mt-1">
                {t('profileRegisterTime', 'user')}: {createdDate}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
