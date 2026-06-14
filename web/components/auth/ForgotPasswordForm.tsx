'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, forgotPassword, sendVerificationCode } from '@/lib/api';
import { useLocaleContext } from '@/contexts/LocaleContext';

type FormData = {
  email: string;
  captcha: string;
  password: string;
  confirmPassword: string;
};

type FormErrors = Partial<FormData>;

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

function PasswordEyeIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {visible ? (
        <>
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="m3 3 18 18" />
          <path d="M10.6 5.2A10.5 10.5 0 0 1 12 5c6 0 9.5 7 9.5 7a16.9 16.9 0 0 1-2.7 3.6" />
          <path d="M6.5 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.5 9.5 0 0 0 4.1-.9" />
          <path d="M10.1 10.1A3 3 0 0 0 14 14" />
        </>
      )}
    </svg>
  );
}

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

const toErrorMessage = (
  error: unknown,
  fallback: string,
  t: (key: string, namespace?: 'auth') => string,
) => {
  const code = error instanceof ApiError ? String(error.code || '').toUpperCase() : '';
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

const formatText = (template: string, values: Record<string, string | number>) => (
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
);

export default function ForgotPasswordForm() {
  const router = useRouter();
  const { t } = useLocaleContext();
  const [formData, setFormData] = useState<FormData>({
    email: '',
    captcha: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState(3);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showSuffixDropdown, setShowSuffixDropdown] = useState(false);

  const strength = useMemo(() => passwordChecks(formData.password), [formData.password]);
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
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (!resetSuccess) return undefined;
    if (redirectCountdown <= 0) {
      router.replace('/login');
      return undefined;
    }
    const timer = window.setTimeout(() => setRedirectCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [redirectCountdown, resetSuccess, router]);

  const updateField = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setApiError(null);
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const validate = () => {
    const nextErrors: FormErrors = {};
    const email = formData.email.trim();

    if (!email) nextErrors.email = t('pleaseEnterEmail', 'auth');
    else if (!isValidEmail(email)) nextErrors.email = t('invalidEmail', 'auth');

    if (!formData.captcha.trim()) nextErrors.captcha = t('pleaseEnterCaptcha', 'auth');
    if (!formData.password) nextErrors.password = t('pleaseEnterNewPassword', 'auth');
    else if (!strength.valid) nextErrors.password = t('passwordStrengthError', 'auth');

    if (!formData.confirmPassword) nextErrors.confirmPassword = t('confirmNewPassword', 'auth');
    else if (formData.confirmPassword !== formData.password) nextErrors.confirmPassword = t('passwordMismatch', 'auth');

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
      await sendVerificationCode({ email, scene: 'reset' });
      setCountdown(60);
      setErrors((prev) => {
        const next = { ...prev };
        delete next.email;
        delete next.captcha;
        return next;
      });
    } catch (error) {
      setApiError(toErrorMessage(error, t('captchaSendFailed', 'auth'), t));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (resetSuccess || !validate()) return;

    setIsLoading(true);
    setApiError(null);
    try {
      await forgotPassword({
        email: formData.email.trim(),
        otp: formData.captcha.trim(),
        newPassword: formData.password,
        confirmPassword: formData.confirmPassword,
      });
      setErrors({});
      setRedirectCountdown(3);
      setResetSuccess(true);
    } catch (error) {
      setApiError(toErrorMessage(error, t('resetFailed', 'auth'), t));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {apiError && <div className="rounded-md bg-red-500/20 p-3 text-sm text-red-400">{apiError}</div>}

      {resetSuccess && (
        <div className="rounded-md bg-green-500/15 p-3 text-sm text-green-300">
          {formatText(t('resetSuccessRedirect', 'auth'), { seconds: Math.max(redirectCountdown, 1) })}
        </div>
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
            disabled={resetSuccess}
          />
          <button
            type="button"
            className="shrink-0 rounded bg-[#252b37] px-4 text-white transition-colors hover:bg-[#2f3746] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleSendCaptcha}
            disabled={isLoading || resetSuccess || countdown > 0 || !formData.email.trim()}
          >
            {countdown > 0 ? formatText(t('resendAfterSeconds', 'auth'), { seconds: countdown }) : t('sendCaptcha', 'auth')}
          </button>
        </div>
        {errors.captcha && <div className="mt-1 text-xs text-red-400">{errors.captcha}</div>}
      </div>

      <div>
        <div className="mb-2 text-sm text-white/50">{t('newPassword', 'auth')}</div>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('pleaseEnterNewPassword', 'auth')}
            className={`auth-password-input w-full rounded border bg-[#0f1319] p-3 pr-12 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
              errors.password ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
            }`}
            value={formData.password}
            onChange={(event) => updateField('password', event.target.value)}
            disabled={resetSuccess}
          />
          <button
            type="button"
            aria-label={showPassword ? t('hidePassword', 'auth') : t('showPassword', 'auth')}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-white/45 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setShowPassword((value) => !value)}
            disabled={resetSuccess}
          >
            <PasswordEyeIcon visible={showPassword} />
          </button>
        </div>
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
        <div className="relative">
          <input
            type={showConfirmPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('confirmNewPassword', 'auth')}
            className={`auth-password-input w-full rounded border bg-[#0f1319] p-3 pr-12 text-white placeholder-white/30 transition-all focus:outline-none focus:ring-2 ${
              errors.confirmPassword ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500'
            }`}
            value={formData.confirmPassword}
            onChange={(event) => updateField('confirmPassword', event.target.value)}
            disabled={resetSuccess}
          />
          <button
            type="button"
            aria-label={showConfirmPassword ? t('hidePassword', 'auth') : t('showPassword', 'auth')}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-white/45 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setShowConfirmPassword((value) => !value)}
            disabled={resetSuccess}
          >
            <PasswordEyeIcon visible={showConfirmPassword} />
          </button>
        </div>
        {errors.confirmPassword && <div className="mt-1 text-xs text-red-400">{errors.confirmPassword}</div>}
      </div>

      <button
        type="submit"
        className="w-full rounded bg-gradient-to-r from-amber-500 to-amber-600 py-3 font-semibold text-white transition-all hover:from-amber-600 hover:to-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isLoading || resetSuccess}
      >
        {isLoading ? t('resetLoading', 'auth') : t('resetPasswordNow', 'auth')}
      </button>

      <div className="mt-6 text-center text-sm text-white/70">
        {t('rememberPassword', 'auth')}{' '}
        <Link href="/login" className="text-amber-400 transition-colors hover:text-amber-300">
          {t('loginNow', 'auth')}
        </Link>
      </div>

      <style jsx global>{`
        .auth-password-input::-ms-reveal,
        .auth-password-input::-ms-clear {
          display: none;
        }
      `}</style>
    </form>
  );
}
