'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { ApiError, getLoginCaptcha } from '@/lib/api';
import { useAuth } from '@/lib/authContext';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { LoginFormData } from '@/types';

const REMEMBERED_EMAIL_KEY = 'remembered_email';
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

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const formatText = (template: string, values: Record<string, string | number>) => (
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
);

const mapLoginError = (error: unknown, t: (key: string, namespace?: 'auth') => string) => {
  const message = error instanceof Error ? error.message : '';
  const normalized = message.toLowerCase();

  if (
    normalized.includes('invalid credential') ||
    normalized.includes('unauthorized') ||
    normalized.includes('account not found') ||
    normalized.includes('user not found') ||
    normalized.includes('password') ||
    normalized.includes('账号') ||
    normalized.includes('密码')
  ) {
    return t('invalidCredentials', 'auth');
  }

  if (normalized.includes('captcha_invalid')) return t('captchaInvalid', 'auth');
  if (normalized.includes('captcha')) return t('imageCaptchaRequired', 'auth');
  if (normalized.includes('login_locked')) return t('loginLocked', 'auth');
  if (normalized.includes('user_disabled')) return t('userDisabled', 'auth');
  if (normalized.includes('network') || normalized.includes('timeout') || normalized.includes('failed to fetch')) {
    return t('networkError', 'auth');
  }

  return t('loginFailed', 'auth');
};

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login: authLogin } = useAuth();
  const { t } = useLocaleContext();
  const [apiError, setApiError] = useState<string | null>(null);
  const [showSuffixDropdown, setShowSuffixDropdown] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const initializedRememberedEmailRef = useRef(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    control,
    setValue,
  } = useForm<LoginFormData>({
    mode: 'onChange',
    defaultValues: {
      emailOrPhone: '',
      password: '',
      captchaCode: '',
      rememberMe: false,
    },
  });

  const emailOrPhone = useWatch({ control, name: 'emailOrPhone' });
  const captchaCode = useWatch({ control, name: 'captchaCode' });

  useEffect(() => {
    if (initializedRememberedEmailRef.current) return;
    initializedRememberedEmailRef.current = true;
    const rememberedEmail = localStorage.getItem(REMEMBERED_EMAIL_KEY) || '';
    if (rememberedEmail) {
      setValue('emailOrPhone', rememberedEmail, { shouldValidate: false, shouldDirty: false });
      setValue('rememberMe', true, { shouldValidate: false, shouldDirty: false });
    }
  }, [setValue]);

  const refreshCaptcha = useCallback(async () => {
    setCaptchaLoading(true);
    try {
      const captcha = await getLoginCaptcha();
      setCaptchaId(captcha.captcha_id);
      setCaptchaImage(captcha.image);
      setValue('captchaCode', '', { shouldValidate: false, shouldDirty: false });
    } catch {
      setApiError(t('imageCaptchaLoadFailed', 'auth'));
    } finally {
      setCaptchaLoading(false);
    }
  }, [setValue, t]);

  useEffect(() => {
    if (needCaptcha && !captchaImage && !captchaLoading) {
      void refreshCaptcha();
    }
  }, [captchaImage, captchaLoading, needCaptcha, refreshCaptcha]);

  const emailSuggestionList = useMemo(() => {
    const raw = (emailOrPhone || '').trim();
    if (!raw) return [];
    const atIndex = raw.indexOf('@');
    const localPart = atIndex >= 0 ? raw.slice(0, atIndex) : raw;
    const domainPart = atIndex >= 0 ? raw.slice(atIndex + 1).toLowerCase() : '';
    if (!localPart) return [];
    const suffixes = domainPart
      ? emailSuffixes.filter((suffix) => suffix.slice(1).startsWith(domainPart))
      : emailSuffixes;
    return suffixes.map((suffix) => `${localPart}${suffix}`);
  }, [emailOrPhone]);

  const getRedirectTarget = () => {
    const next = (searchParams?.get('next') || '').trim();
    const redirect = (searchParams?.get('redirect') || '').trim();
    const candidate = next || redirect;
    if (candidate && candidate.startsWith('/')) return candidate;
    return '/user';
  };

  const onSubmit = async (data: LoginFormData) => {
    setApiError(null);
    try {
      await authLogin(
        data.emailOrPhone.trim(),
        data.password,
        needCaptcha ? { captcha_id: captchaId, captcha_code: data.captchaCode || '' } : undefined,
        Boolean(data.rememberMe),
      );

      if (data.rememberMe) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, data.emailOrPhone.trim());
      } else {
        localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }

      router.replace(getRedirectTarget());
    } catch (error) {
      const isLocked = error instanceof ApiError && (error.code === 'LOGIN_LOCKED' || error.data?.locked === true);
      const shouldShowCaptcha =
        error instanceof ApiError &&
        !isLocked &&
        (error.code === 'CAPTCHA_REQUIRED' || error.data?.need_captcha === true);

      if (isLocked) {
        setNeedCaptcha(false);
      } else if (shouldShowCaptcha) {
        setNeedCaptcha(true);
        await refreshCaptcha();
      }

      let message = mapLoginError(error, t);
      const remainingAttempts = error instanceof ApiError ? readNumber(error.data?.remaining_attempts) : null;
      const lockSeconds = error instanceof ApiError ? readNumber(error.data?.lock_seconds) : null;
      if (shouldShowCaptcha && remainingAttempts !== null && remainingAttempts > 0) {
        const lockMinutes = Math.max(1, Math.ceil((lockSeconds || 15 * 60) / 60));
        message = `${message}${formatText(t('remainingAttemptsLockHint', 'auth'), {
          attempts: remainingAttempts,
          minutes: lockMinutes,
        })}`;
      }

      setApiError(message);
    }
  };

  const emailField = register('emailOrPhone', {
    required: t('pleaseEnterEmail', 'auth'),
    validate: (value) => isValidEmail(value) || t('invalidEmail', 'auth'),
  });

  const passwordField = register('password', {
    required: t('pleaseEnterPassword', 'auth'),
    minLength: { value: 6, message: t('passwordMinLength', 'auth') },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div
        role="alert"
        aria-live="polite"
        className={`min-h-[44px] rounded-md p-3 text-sm transition-opacity ${
          apiError ? 'bg-red-500/20 text-red-400 opacity-100' : 'pointer-events-none bg-transparent text-transparent opacity-0'
        }`}
      >
        {apiError || ' '}
      </div>

      <div>
        <div className="mb-2 text-sm text-white/50">{t('emailAddress', 'auth')}</div>
        <div className="relative">
          <input
            type="email"
            autoComplete="email"
            placeholder={t('pleaseEnterEmail', 'auth')}
            className={`w-full rounded border bg-[#0f1319] p-3 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
              errors.emailOrPhone ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
            }`}
            {...emailField}
            onChange={(event) => {
              emailField.onChange(event);
              setApiError(null);
              setShowSuffixDropdown(Boolean(event.target.value.trim()));
            }}
            onFocus={() => {
              if ((emailOrPhone || '').trim()) setShowSuffixDropdown(true);
            }}
            onBlur={(event) => {
              emailField.onBlur(event);
              setShowSuffixDropdown(false);
            }}
          />

          {showSuffixDropdown && emailSuggestionList.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-md border border-white/10 bg-[#0f1319] shadow-lg">
              {emailSuggestionList.map((fullEmail) => (
                <button
                  key={fullEmail}
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm text-white transition-colors hover:bg-[#1a1f2e]"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setValue('emailOrPhone', fullEmail, { shouldValidate: true, shouldDirty: true });
                    setApiError(null);
                    setShowSuffixDropdown(false);
                  }}
                >
                  {fullEmail}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={`mt-1 min-h-[18px] text-xs text-red-400 ${errors.emailOrPhone ? 'visible' : 'invisible'}`}>
          {errors.emailOrPhone?.message || ' '}
        </div>
      </div>

      <div>
        <div className="mb-2 text-sm text-white/50">{t('password', 'auth')}</div>
        <input
          type="password"
          autoComplete="current-password"
          placeholder={t('pleaseEnterPassword', 'auth')}
          className={`w-full rounded border bg-[#0f1319] p-3 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
            errors.password ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
          }`}
          {...passwordField}
          onChange={(event) => {
            passwordField.onChange(event);
            setApiError(null);
          }}
        />
        <div className={`mt-1 min-h-[18px] text-xs text-red-400 ${errors.password ? 'visible' : 'invisible'}`}>
          {errors.password?.message || ' '}
        </div>
      </div>

      {needCaptcha && (
        <div>
          <div className="mb-2 text-sm text-white/50">{t('imageCaptcha', 'auth')}</div>
          <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
            <input
              type="text"
              autoComplete="off"
              placeholder={t('pleaseEnterImageCaptcha', 'auth')}
              className="w-full rounded border border-white/10 bg-[#0f1319] p-3 uppercase text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500"
              {...register('captchaCode', {
                validate: () => !needCaptcha || Boolean((captchaCode || '').trim()) || t('pleaseEnterImageCaptcha', 'auth'),
              })}
              onChange={(event) => {
                setValue('captchaCode', event.target.value.toUpperCase(), {
                  shouldValidate: true,
                  shouldDirty: true,
                });
                setApiError(null);
              }}
            />

            <button
              type="button"
              onClick={() => void refreshCaptcha()}
              className="h-[50px] overflow-hidden rounded border border-white/10 bg-[#0f1319] text-xs text-white/60 transition-colors hover:border-amber-500/60 disabled:opacity-50"
              disabled={captchaLoading}
              title={t('refreshCaptcha', 'auth')}
            >
              {captchaImage && !captchaLoading ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={captchaImage} alt={t('imageCaptcha', 'auth')} className="h-full w-full object-cover" />
              ) : (
                t('loading', 'common')
              )}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center">
          <input
            type="checkbox"
            id="remember"
            className="mr-2 cursor-pointer rounded border-white/10 bg-[#0f1319] text-amber-500 transition-colors hover:border-amber-500/50 focus:ring-amber-500"
            {...register('rememberMe')}
          />
          <label htmlFor="remember" className="text-sm text-white/70">
            {t('rememberMe', 'auth')}
          </label>
        </div>

        <Link href="/forgot-password" className="text-sm text-amber-400 transition-colors hover:text-amber-300">
          {t('forgotPassword', 'auth')}
        </Link>
      </div>

      <button
        type="submit"
        className="w-full rounded bg-gradient-to-r from-amber-500 to-amber-600 py-3 font-semibold text-white transition-all hover:from-amber-600 hover:to-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isSubmitting}
      >
        {isSubmitting ? t('loginLoading', 'auth') : t('loginButton', 'auth')}
      </button>

      <div className="mt-6 text-center text-sm text-white/70">
        {t('dontHaveAccount', 'auth')}{' '}
        <Link href="/register" className="text-amber-400 transition-colors hover:text-amber-300">
          {t('registerNow', 'auth')}
        </Link>
      </div>
    </form>
  );
}
