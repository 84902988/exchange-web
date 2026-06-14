'use client';

import { UserInfo } from '@/lib/api';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { getUserDisplayName } from '@/lib/userAvatar';

interface UserProfileProps {
  userInfo: UserInfo | null;
}

type KycTone = 'green' | 'yellow' | 'red' | 'gray';
type UserTranslate = ReturnType<typeof useLocaleContext>['t'];

function formatUserTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

function getKycBadge(userInfo: UserInfo | null | undefined, t: UserTranslate): { label: string; tone: KycTone } {
  const status = userInfo?.kycStatus;
  if (status === 'approved') return { label: t('kycStatusApprovedBadge', 'user'), tone: 'green' };
  if (status === 'pending') return { label: t('kycStatusPendingBadge', 'user'), tone: 'yellow' };
  if (status === 'rejected') return { label: t('kycStatusNotApproved', 'user'), tone: 'red' };

  const level = userInfo?.kycLevel;
  if (typeof level === 'number') {
    if (level >= 2) {
      return { label: formatUserTemplate(t('kycLevelVerified', 'user'), { level: String(level) }), tone: 'green' };
    }
    if (level === 1) {
      return { label: formatUserTemplate(t('kycLevelBasicVerified', 'user'), { level: String(level) }), tone: 'yellow' };
    }
    return { label: `Level ${level}`, tone: 'gray' };
  }

  return { label: t('kycStatusNoneBadge', 'user'), tone: 'gray' };
}

function toneClass(tone: KycTone) {
  if (tone === 'green') return 'text-green-400';
  if (tone === 'yellow') return 'text-yellow-400';
  if (tone === 'red') return 'text-red-400';
  return 'text-white';
}

export default function UserProfile({ userInfo }: UserProfileProps) {
  const { t } = useLocaleContext();

  if (!userInfo) return null;

  const kyc = getKycBadge(userInfo, t);
  const displayName = getUserDisplayName(userInfo) || '-';

  return (
    <div className="bg-[#0a0a0d] rounded-lg p-6 mb-6">
      <div className="flex flex-col md:flex-row items-start gap-6">
        <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center">
          <div className="text-white/70 text-2xl font-bold">
            {(displayName || 'U').charAt(0).toUpperCase()}
          </div>
        </div>

        <div className="flex-1 text-center md:text-left">
          <h2 className="text-2xl font-bold text-white mb-2">
            {displayName}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <div className="bg-black rounded p-3">
              <div className="text-sm text-white/50 mb-1">
                {t('email', 'user')}
              </div>
              <div className="text-white">{userInfo.email || '-'}</div>
            </div>

            <div className="bg-black rounded p-3">
              <div className="text-sm text-white/50 mb-1">
                {t('userId', 'user')}
              </div>
              <div className="text-white">{userInfo.id ?? '-'}</div>
            </div>

            <div className="bg-black rounded p-3">
              <div className="text-sm text-white/50 mb-1">
                {t('kycLevel', 'user')}
              </div>
              <div className={toneClass(kyc.tone)}>{kyc.label}</div>
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-4 md:mt-[56px]">
          <button className="bg-black hover:bg-[#1a1f2e] text-white py-2 px-4 rounded transition-colors duration-200">
            {t('editProfile', 'user')}
          </button>
        </div>
      </div>
    </div>
  );
}
