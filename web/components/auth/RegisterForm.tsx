'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, register, sendOtp, validateBdInvite, validateUserInvite } from '@/lib/api';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { getLegalPage, type LegalPageContent, type LegalPageKey } from '@/lib/api/modules/site';
import {
  REGISTER_PRIVACY_POLICY_CONTENT,
  REGISTER_USER_AGREEMENT_CONTENT,
} from './registerLegalContent';

type RegisterFormData = {
  email: string;
  password: string;
  confirmPassword: string;
  captcha: string;
  agree: boolean;
};

type RegisterErrors = Partial<Record<keyof RegisterFormData, string>>;
type InviteValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';
type LegalModalType = 'terms' | 'privacy';
type InviteInfo = {
  type: 'bd' | 'user';
  invite_code: string;
  inviter_name?: string | null;
};

const INVITE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const INVITE_QUERY_KEYS = ['invite_code', 'code', 'ref'] as const;
const emailSuffixes = [
  '@gmail.com',
  '@yahoo.com',
  '@hotmail.com',
  '@outlook.com',
  '@icloud.com',
  '@qq.com',
  '@163.com',
  '@126.com',
];

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

function passwordChecks(password: string) {
  const checks = {
    lengthValid: password.length >= 8 && password.length <= 16,
    hasLowercase: /[a-z]/.test(password),
    hasUppercase: /[A-Z]/.test(password),
    hasNumber: /\d/.test(password),
    hasSpecialChar: /[!@#$%^&*(),.?":{}|<>]/.test(password),
  };

  return {
    ...checks,
    valid: Object.values(checks).every(Boolean),
  };
}

const getInviteCodeFromSearchParams = (searchParams: ReturnType<typeof useSearchParams>) => {
  for (const key of INVITE_QUERY_KEYS) {
    if (searchParams.has(key)) return (searchParams.get(key) || '').trim();
  }
  return '';
};

const hasInviteCodeInSearchParams = (searchParams: ReturnType<typeof useSearchParams>) => (
  INVITE_QUERY_KEYS.some((key) => searchParams.has(key))
);

const getInviteTypeFromSearchParams = (searchParams: ReturnType<typeof useSearchParams>) => {
  const raw = (
    searchParams.get('invite_type') ||
    searchParams.get('referral_type') ||
    searchParams.get('source_type') ||
    ''
  ).trim().toLowerCase();

  if (raw === 'bd' || raw === 'bd_invite') return 'bd';
  if (raw === 'user' || raw === 'user_invite' || raw === 'normal' || raw === 'normal_invite') return 'user';
  return '';
};

const saveInviteCode = (code: string, inviteType: 'bd' | 'user') => {
  if (typeof window === 'undefined') return;
  localStorage.setItem('invite_code', code);
  localStorage.setItem('invite_type', inviteType);
  document.cookie = `invite_code=${encodeURIComponent(code)}; path=/; max-age=${INVITE_COOKIE_MAX_AGE}; SameSite=Lax`;
  document.cookie = `invite_type=${encodeURIComponent(inviteType)}; path=/; max-age=${INVITE_COOKIE_MAX_AGE}; SameSite=Lax`;
};

const removeSavedInviteCode = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('invite_code');
  localStorage.removeItem('invite_type');
  document.cookie = 'invite_code=; path=/; max-age=0; SameSite=Lax';
  document.cookie = 'invite_type=; path=/; max-age=0; SameSite=Lax';
};

const getErrorCode = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code || '');
  }
  return '';
};

const getErrorMessage = (
  error: unknown,
  fallback: string,
  t: (key: string, namespace?: 'auth') => string,
) => {
  const code = error instanceof ApiError ? String(error.code || '').toUpperCase() : getErrorCode(error).toUpperCase();
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (code.includes('CAPTCHA') || code.includes('OTP') || message.includes('captcha') || message.includes('otp')) {
    return t('captchaInvalid', 'auth');
  }
  if (code.includes('EMAIL') || message.includes('email')) return t('invalidEmail', 'auth');
  if (code.includes('PASSWORD') || message.includes('password')) return t('passwordStrengthError', 'auth');
  if (code.includes('NETWORK') || message.includes('network') || message.includes('timeout') || message.includes('failed to fetch')) {
    return t('networkError', 'auth');
  }

  return fallback;
};

const isInviteNotBdError = (error: unknown) => {
  const code = getErrorCode(error);
  return code === 'INVITE_CODE_NOT_FOUND' || code === 'INVITER_NOT_ACTIVE_BD';
};

const formatText = (template: string, values: Record<string, string | number>) => (
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
);

const getInviteValidationMessage = (error: unknown, t: (key: string, namespace?: 'auth') => string) => {
  const code = getErrorCode(error);
  if (code === 'INVITER_NOT_ACTIVE_BD' || code === 'INVITER_UNAVAILABLE') {
    return t('inviteUnavailable', 'auth');
  }
  if (code === 'NETWORK_ERROR') return t('inviteValidationFailed', 'auth');
  return t('inviteInvalid', 'auth');
};

const resolveInviteInfo = async (inviteCode: string, inviteType: string): Promise<InviteInfo> => {
  if (inviteType === 'user') {
    const userInvite = await validateUserInvite(inviteCode);
    if (!userInvite.valid) throw { code: 'INVITE_CODE_NOT_FOUND' };
    return {
      type: 'user',
      invite_code: (userInvite.invite_code || inviteCode).trim(),
      inviter_name: userInvite.inviter_name,
    };
  }

  if (inviteType === 'bd') {
    const bdInvite = await validateBdInvite(inviteCode);
    if (!bdInvite.valid) throw { code: 'INVITE_CODE_NOT_FOUND' };
    return { type: 'bd', invite_code: (bdInvite.invite_code || inviteCode).trim() };
  }

  try {
    const bdInvite = await validateBdInvite(inviteCode);
    if (!bdInvite.valid) throw { code: 'INVITE_CODE_NOT_FOUND' };
    return { type: 'bd', invite_code: (bdInvite.invite_code || inviteCode).trim() };
  } catch (bdError) {
    if (!isInviteNotBdError(bdError)) throw bdError;
  }

  const userInvite = await validateUserInvite(inviteCode);
  if (!userInvite.valid) throw { code: 'INVITE_CODE_NOT_FOUND' };
  return {
    type: 'user',
    invite_code: (userInvite.invite_code || inviteCode).trim(),
    inviter_name: userInvite.inviter_name,
  };
};

export default function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { locale, t } = useLocaleContext();
  const [formData, setFormData] = useState<RegisterFormData>({
    email: '',
    password: '',
    confirmPassword: '',
    captcha: '',
    agree: false,
  });
  const [errors, setErrors] = useState<RegisterErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [captchaSent, setCaptchaSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showSuffixDropdown, setShowSuffixDropdown] = useState(false);
  const [hasUrlInviteCode, setHasUrlInviteCode] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<InviteValidationStatus>('idle');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [legalModalType, setLegalModalType] = useState<LegalModalType | null>(null);
  const [legalModalContent, setLegalModalContent] = useState<LegalPageContent | null>(null);
  const [legalModalLoading, setLegalModalLoading] = useState(false);
  const [legalModalError, setLegalModalError] = useState('');

  const strength = useMemo(() => passwordChecks(formData.password), [formData.password]);
  const inviteRegisterBlocked = hasUrlInviteCode && inviteStatus !== 'valid';
  const inviteStatusMessage = inviteStatus === 'checking' ? t('inviteChecking', 'auth') : inviteError;
  const inviteSuccessMessage = inviteStatus === 'valid' && inviteInfo
    ? inviteInfo.inviter_name
      ? formatText(t('inviteConfirmedWithName', 'auth'), { name: inviteInfo.inviter_name })
      : t('inviteConfirmed', 'auth')
    : null;
  const legalModal = useMemo(() => {
    const fallback = legalModalType === 'privacy'
      ? {
        title: t('privacyPolicy', 'auth'),
        content: REGISTER_PRIVACY_POLICY_CONTENT,
      }
      : {
        title: t('userAgreement', 'auth'),
        content: REGISTER_USER_AGREEMENT_CONTENT,
      };

    if (legalModalType === 'terms') {
      return {
        title: legalModalContent?.title || fallback.title,
        content: legalModalContent?.content || fallback.content,
      };
    }
    if (legalModalType === 'privacy') {
      return {
        title: legalModalContent?.title || fallback.title,
        content: legalModalContent?.content || fallback.content,
      };
    }
    return null;
  }, [legalModalContent, legalModalType, t]);

  const emailParts = useMemo(() => {
    const raw = formData.email.trim();
    const atIndex = raw.indexOf('@');
    return {
      localPart: atIndex >= 0 ? raw.slice(0, atIndex) : raw,
      domain: atIndex >= 0 ? raw.slice(atIndex + 1).toLowerCase() : '',
      hasAt: atIndex >= 0,
    };
  }, [formData.email]);

  const suffixSuggestions = useMemo(() => {
    if (!emailParts.localPart) return [];
    if (!emailParts.hasAt || !emailParts.domain) return emailSuffixes;
    return emailSuffixes.filter((suffix) => suffix.slice(1).startsWith(emailParts.domain));
  }, [emailParts]);

  useEffect(() => {
    const emailFromQuery = (searchParams.get('email') || searchParams.get('emailOrPhone') || '').trim();
    if (emailFromQuery) {
      setFormData((prev) => ({ ...prev, email: emailFromQuery }));
    }

    const hasInviteParam = hasInviteCodeInSearchParams(searchParams);
    setHasUrlInviteCode(hasInviteParam);

    if (!hasInviteParam) {
      removeSavedInviteCode();
      setInviteStatus('idle');
      setInviteError(null);
      setInviteInfo(null);
      return undefined;
    }

    removeSavedInviteCode();
    const inviteCode = getInviteCodeFromSearchParams(searchParams);
    const inviteType = getInviteTypeFromSearchParams(searchParams);
    if (!inviteCode) {
      setInviteStatus('invalid');
      setInviteError(t('inviteInvalid', 'auth'));
      setInviteInfo(null);
      return undefined;
    }

    let cancelled = false;
    setApiError(null);
    setInviteStatus('checking');
    setInviteError(null);
    setInviteInfo(null);

    resolveInviteInfo(inviteCode, inviteType)
      .then((result) => {
        if (cancelled) return;
        saveInviteCode(result.invite_code, result.type);
        setInviteInfo(result);
        setInviteStatus('valid');
      })
      .catch((error) => {
        if (cancelled) return;
        removeSavedInviteCode();
        setInviteInfo(null);
        setInviteStatus('invalid');
        setInviteError(getInviteValidationMessage(error, t));
      });

    return () => {
      cancelled = true;
    };
  }, [searchParams, t]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (!legalModalType) {
      setLegalModalContent(null);
      setLegalModalError('');
      setLegalModalLoading(false);
      return;
    }

    let alive = true;
    const pageKey: LegalPageKey = legalModalType === 'privacy' ? 'privacy' : 'terms';
    setLegalModalContent(null);
    setLegalModalError('');
    setLegalModalLoading(true);

    getLegalPage(pageKey, locale)
      .then((data) => {
        if (!alive) return;
        if (data.content?.trim()) {
          setLegalModalContent(data);
        }
      })
      .catch(() => {
        if (!alive) return;
        setLegalModalError(t('legalPageError', 'common'));
      })
      .finally(() => {
        if (alive) setLegalModalLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [legalModalType, locale, t]);

  const updateField = (field: keyof RegisterFormData, value: string | boolean) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'email' && prev.email !== value) {
        next.captcha = '';
      }
      return next;
    });

    if (field === 'email' && captchaSent) {
      setCaptchaSent(false);
      setCountdown(0);
    }

    setApiError(null);
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const validate = () => {
    const nextErrors: RegisterErrors = {};
    const email = formData.email.trim();

    if (!email) nextErrors.email = t('pleaseEnterEmail', 'auth');
    else if (!isValidEmail(email)) nextErrors.email = t('invalidEmail', 'auth');

    if (!formData.password) nextErrors.password = t('pleaseEnterPassword', 'auth');
    else if (!strength.valid) nextErrors.password = t('passwordStrengthError', 'auth');

    if (!formData.confirmPassword) nextErrors.confirmPassword = t('pleaseEnterConfirmPassword', 'auth');
    else if (formData.confirmPassword !== formData.password) nextErrors.confirmPassword = t('passwordMismatch', 'auth');

    if (!captchaSent) nextErrors.captcha = t('pleaseSendCaptchaFirst', 'auth');
    else if (!formData.captcha.trim()) nextErrors.captcha = t('pleaseEnterCaptcha', 'auth');

    if (!formData.agree) nextErrors.agree = t('pleaseAgreeTerms', 'auth');

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSendCaptcha = async () => {
    const email = formData.email.trim();
    if (!email) {
      setErrors((prev) => ({ ...prev, email: t('pleaseEnterEmail', 'auth') }));
      return;
    }
    if (!isValidEmail(email)) {
      setErrors((prev) => ({ ...prev, email: t('invalidEmail', 'auth') }));
      return;
    }

    setIsLoading(true);
    setApiError(null);
    try {
      await sendOtp({ email });
      setCaptchaSent(true);
      setCountdown(60);
      setErrors((prev) => {
        const next = { ...prev };
        delete next.email;
        delete next.captcha;
        return next;
      });
    } catch (error) {
      setApiError(getErrorMessage(error, t('captchaSendFailed', 'auth'), t));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (inviteRegisterBlocked) {
      setApiError(inviteStatusMessage || t('inviteValidationFailed', 'auth'));
      return;
    }

    if (!validate()) return;

    setIsLoading(true);
    setApiError(null);
    try {
      await register({
        email: formData.email.trim(),
        otp: formData.captcha.trim(),
        password: formData.password,
        ...(inviteInfo ? { invite_code: inviteInfo.invite_code, invite_type: inviteInfo.type } : {}),
      });
      removeSavedInviteCode();
      router.replace('/login');
    } catch (error) {
      setApiError(getErrorMessage(error, t('registerFailed', 'auth'), t));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-4">
      {apiError && <div className="rounded-md bg-red-500/20 p-3 text-sm text-red-400">{apiError}</div>}

      {hasUrlInviteCode && inviteStatusMessage && (
        <div
          className={`rounded-md p-3 text-sm ${
            inviteStatus === 'checking' ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/20 text-red-400'
          }`}
        >
          {inviteStatusMessage}
        </div>
      )}

      {hasUrlInviteCode && inviteSuccessMessage && (
        <div className="rounded-md bg-green-500/15 p-3 text-sm text-green-300">{inviteSuccessMessage}</div>
      )}

      <div>
        <div className="mb-2 text-sm text-white/50">{t('emailAddress', 'auth')}</div>
        <div className="relative">
          <input
            type="email"
            autoComplete="email"
            placeholder={t('pleaseEnterEmail', 'auth')}
            className={`w-full rounded border bg-[#0f1319] p-3 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
              errors.email ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
            }`}
            value={formData.email}
            onChange={(event) => {
              updateField('email', event.target.value);
              setShowSuffixDropdown(true);
            }}
            onFocus={() => setShowSuffixDropdown(true)}
            onBlur={() => setShowSuffixDropdown(false)}
          />

          {showSuffixDropdown && suffixSuggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-md border border-white/10 bg-[#0f1319] shadow-lg">
              {suffixSuggestions.map((suffix) => (
                <button
                  key={suffix}
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm text-white transition-colors hover:bg-[#1a1f2e]"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    updateField('email', `${emailParts.localPart}${suffix}`);
                    setShowSuffixDropdown(false);
                  }}
                >
                  {emailParts.localPart}
                  {suffix}
                </button>
              ))}
            </div>
          )}
        </div>
        {errors.email && <div className="mt-1 text-xs text-red-400">{errors.email}</div>}
      </div>

      <div>
        <div className="mb-2 text-sm text-white/50">{t('password', 'auth')}</div>
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t('pleaseEnterPassword', 'auth')}
          className={`w-full rounded border bg-[#0f1319] p-3 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
            errors.password ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
          }`}
          value={formData.password}
          onChange={(event) => updateField('password', event.target.value)}
        />
        {errors.password && <div className="mt-1 text-xs text-red-400">{errors.password}</div>}

        {formData.password && (
          <div className="mt-2 space-y-1 text-xs">
            <div className="text-white/50">{t('passwordRequirements', 'auth')}</div>
            <div className={strength.lengthValid ? 'text-green-400' : 'text-red-400'}>{t('passwordLength', 'auth')}</div>
            <div className={strength.hasLowercase ? 'text-green-400' : 'text-red-400'}>{t('passwordLowercase', 'auth')}</div>
            <div className={strength.hasUppercase ? 'text-green-400' : 'text-red-400'}>{t('passwordUppercase', 'auth')}</div>
            <div className={strength.hasNumber ? 'text-green-400' : 'text-red-400'}>{t('passwordNumber', 'auth')}</div>
            <div className={strength.hasSpecialChar ? 'text-green-400' : 'text-red-400'}>{t('passwordSpecial', 'auth')}</div>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-sm text-white/50">{t('confirmPassword', 'auth')}</div>
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t('pleaseEnterConfirmPassword', 'auth')}
          className={`w-full rounded border bg-[#0f1319] p-3 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
            errors.confirmPassword ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
          }`}
          value={formData.confirmPassword}
          onChange={(event) => updateField('confirmPassword', event.target.value)}
        />
        {errors.confirmPassword && <div className="mt-1 text-xs text-red-400">{errors.confirmPassword}</div>}
      </div>

      <div>
        <div className="mb-2 text-sm text-white/50">{t('captcha', 'auth')}</div>
        <div className="flex gap-3">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('pleaseEnterCaptcha', 'auth')}
            className={`min-w-0 flex-1 rounded border bg-[#0f1319] p-3 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
              errors.captcha ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
            }`}
            value={formData.captcha}
            onChange={(event) => updateField('captcha', event.target.value)}
          />
          <button
            type="button"
            className="shrink-0 rounded bg-[#252b37] px-4 text-white transition-colors hover:bg-[#2f3746] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleSendCaptcha}
            disabled={isLoading || countdown > 0 || !formData.email.trim()}
          >
            {countdown > 0 ? formatText(t('resendAfterSeconds', 'auth'), { seconds: countdown }) : t('sendCaptcha', 'auth')}
          </button>
        </div>
        {errors.captcha && <div className="mt-1 text-xs text-red-400">{errors.captcha}</div>}
      </div>

      <div className="flex items-start">
        <input
          type="checkbox"
          id="agree"
          className="mr-2 mt-1 rounded border-white/10 bg-[#0f1319] text-amber-500 focus:ring-amber-500"
          checked={formData.agree}
          onChange={(event) => updateField('agree', event.target.checked)}
        />
        <div className="text-sm text-white/70">
          <label htmlFor="agree">{t('agreeTerms', 'auth')}</label>{' '}
          <button
            type="button"
            onClick={() => setLegalModalType('terms')}
            className="text-amber-400 transition-colors hover:text-amber-300"
          >
            {t('userAgreement', 'auth')}
          </button>{' '}
          {t('and', 'auth')}{' '}
          <button
            type="button"
            onClick={() => setLegalModalType('privacy')}
            className="text-amber-400 transition-colors hover:text-amber-300"
          >
            {t('privacyPolicy', 'auth')}
          </button>
        </div>
      </div>
      {errors.agree && <div className="text-xs text-red-400">{errors.agree}</div>}

      <button
        type="submit"
        className="w-full rounded bg-gradient-to-r from-amber-500 to-amber-600 py-3 font-semibold text-white transition-all hover:from-amber-600 hover:to-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isLoading || inviteRegisterBlocked}
      >
        {isLoading ? t('registerLoading', 'auth') : t('register', 'common')}
      </button>

      <div className="mt-6 text-center text-sm text-white/70">
        {t('alreadyHaveAccount', 'auth')}{' '}
        <Link href="/login" className="text-amber-400 transition-colors hover:text-amber-300">
          {t('loginNow', 'auth')}
        </Link>
      </div>
    </form>
    {legalModal ? (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="register-legal-modal-title"
      >
        <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#10141b] shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <h2 id="register-legal-modal-title" className="text-lg font-semibold text-white">
              {legalModal.title}
            </h2>
            <button
              type="button"
              onClick={() => setLegalModalType(null)}
              className="rounded-md px-3 py-1 text-sm text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              {t('close', 'common')}
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-5 text-sm leading-7 text-white/70">
            {legalModalLoading ? (
              <div className="mb-4 rounded-md border border-white/10 bg-white/[0.04] px-4 py-3 text-white/50">
                {t('legalPageLoading', 'common')}
              </div>
            ) : null}
            {legalModalError ? (
              <div className="mb-4 rounded-md border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-amber-200">
                {legalModalError}
              </div>
            ) : null}
            <div className="whitespace-pre-line">{legalModal.content}</div>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
