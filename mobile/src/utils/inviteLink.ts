import { createTranslator, type Translator } from '../i18n';

export type InviteRegistrationType = 'user' | 'bd';

export function inferInviteRegistrationType(
  inviteCode: string,
): InviteRegistrationType {
  return inviteCode.trim().toUpperCase().startsWith('BD') ? 'bd' : 'user';
}

export function buildInviteRegistrationLink(
  webBaseUrl: string,
  inviteCode: string,
  inviteType: InviteRegistrationType,
) {
  const normalizedCode = inviteCode.trim();
  if (!normalizedCode) return '';

  try {
    const url = new URL('/register', webBaseUrl.trim());
    url.searchParams.set('invite_code', normalizedCode);
    url.searchParams.set('invite_type', inviteType);
    return url.toString();
  } catch {
    return '';
  }
}

export function buildInviteShareMessage(
  inviteCode: string,
  inviteLink: string,
  t: Translator = createTranslator('zh-CN'),
) {
  return t('invite.shareMessage', {
    code: inviteCode.trim(),
    link: inviteLink.trim(),
  });
}
