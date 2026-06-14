'use client';

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import UserSidebar from '@/components/user/UserSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { changePassword, logout } from '@/lib/api';

type PasswordFormData = {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type PasswordStrength = {
  valid: boolean;
  hasLowercase: boolean;
  hasUppercase: boolean;
  hasNumber: boolean;
  hasSpecialChar: boolean;
  lengthValid: boolean;
};

const initialFormData: PasswordFormData = {
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
};

const checkPasswordStrength = (password: string): PasswordStrength => {
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecialChar = /[^A-Za-z0-9]/.test(password);
  const lengthValid = password.length >= 8;

  return {
    valid: hasLowercase && hasUppercase && hasNumber && hasSpecialChar && lengthValid,
    hasLowercase,
    hasUppercase,
    hasNumber,
    hasSpecialChar,
    lengthValid,
  };
};

export default function SecurityPasswordPage() {
  const router = useRouter();
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [formData, setFormData] = useState<PasswordFormData>(initialFormData);
  const [errors, setErrors] = useState<Partial<PasswordFormData>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength>(
    checkPasswordStrength(''),
  );

  const toggleSidebar = () => setIsSidebarCollapsed((value) => !value);

  const redirectToLogin = async () => {
    try {
      await logout();
    } catch {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
    } finally {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      router.replace('/login');
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
    setSuccessMessage('');
    setErrorMessage('');

    if (name === 'newPassword') {
      setPasswordStrength(checkPasswordStrength(value));
    }

    if (errors[name as keyof PasswordFormData]) {
      setErrors((current) => ({ ...current, [name]: undefined }));
    }
  };

  const validateForm = () => {
    const nextErrors: Partial<PasswordFormData> = {};
    const strength = checkPasswordStrength(formData.newPassword);

    if (!formData.oldPassword.trim()) {
      nextErrors.oldPassword = t('pleaseEnterOldPassword', 'user');
    }
    if (!formData.newPassword.trim()) {
      nextErrors.newPassword = t('pleaseEnterNewPassword', 'auth');
    } else if (!strength.valid) {
      nextErrors.newPassword = t('newPasswordWeak', 'user');
    } else if (formData.newPassword === formData.oldPassword) {
      nextErrors.newPassword = t('newPasswordSameAsOld', 'user');
    }
    if (!formData.confirmPassword.trim()) {
      nextErrors.confirmPassword = t('pleaseEnterNewPasswordAgain', 'user');
    } else if (formData.confirmPassword !== formData.newPassword) {
      nextErrors.confirmPassword = t('passwordMismatchShort', 'user');
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const getErrorMessage = (error: unknown) => {
    const maybeError = error as { code?: string; message?: string };
    if (maybeError?.code === 'INVALID_OLD_PASSWORD') return t('oldPasswordIncorrect', 'user');
    if (maybeError?.code === 'PASSWORD_UNCHANGED') return t('newPasswordSameAsOld', 'user');
    if (maybeError?.code === 'VALIDATION_ERROR') return t('newPasswordWeak', 'user');
    return t('changePasswordFailed', 'user');
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validateForm() || isSubmitting) return;

    setIsSubmitting(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      await changePassword({
        oldPassword: formData.oldPassword,
        newPassword: formData.newPassword,
      });
      setFormData(initialFormData);
      setPasswordStrength(checkPasswordStrength(''));
      setSuccessMessage(t('passwordChangedRelogin', 'user'));
      window.setTimeout(() => {
        void redirectToLogin();
      }, 1500);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const strengthItems = [
    { key: 'lengthValid', label: t('passwordLengthAtLeast8', 'user'), active: passwordStrength.lengthValid },
    { key: 'hasLowercase', label: t('passwordHasLowercase', 'user'), active: passwordStrength.hasLowercase },
    { key: 'hasUppercase', label: t('passwordHasUppercase', 'user'), active: passwordStrength.hasUppercase },
    { key: 'hasNumber', label: t('passwordHasNumber', 'user'), active: passwordStrength.hasNumber },
    { key: 'hasSpecialChar', label: t('passwordHasSpecial', 'user'), active: passwordStrength.hasSpecialChar },
  ];

  return (
    <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white">{t('changeLoginPassword', 'user')}</h1>
              <p className="mt-2 text-sm text-white/50">{t('changeLoginPasswordDesc', 'user')}</p>
            </div>
            <Link
              href="/user"
              className="rounded border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors hover:border-amber-500/50 hover:text-amber-400"
            >
              {t('backToUserCenter', 'user')}
            </Link>
          </div>

          <div className="rounded-lg border border-white/10 bg-[#0a0a0d] p-6">
            {successMessage ? (
              <div className="mb-6 rounded-md border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-300">
                {successMessage}
              </div>
            ) : null}
            {errorMessage ? (
              <div className="mb-6 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-300">
                {errorMessage}
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="oldPassword" className="mb-2 block text-sm font-medium text-white/90">
                  {t('oldPassword', 'auth')}
                </label>
                <input
                  id="oldPassword"
                  name="oldPassword"
                  type="password"
                  value={formData.oldPassword}
                  onChange={handleInputChange}
                  disabled={isSubmitting}
                  autoComplete="current-password"
                  className="w-full rounded-md border border-white/20 bg-white/10 px-4 py-3 text-white outline-none transition-all placeholder:text-white/40 focus:border-transparent focus:ring-2 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={t('pleaseEnterOldPassword', 'user')}
                />
                {errors.oldPassword ? <p className="mt-2 text-sm text-red-400">{errors.oldPassword}</p> : null}
              </div>

              <div>
                <label htmlFor="newPassword" className="mb-2 block text-sm font-medium text-white/90">
                  {t('newPassword', 'auth')}
                </label>
                <input
                  id="newPassword"
                  name="newPassword"
                  type="password"
                  value={formData.newPassword}
                  onChange={handleInputChange}
                  disabled={isSubmitting}
                  autoComplete="new-password"
                  className="w-full rounded-md border border-white/20 bg-white/10 px-4 py-3 text-white outline-none transition-all placeholder:text-white/40 focus:border-transparent focus:ring-2 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={t('pleaseEnterNewPassword', 'auth')}
                />
                {errors.newPassword ? <p className="mt-2 text-sm text-red-400">{errors.newPassword}</p> : null}

                <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                  {strengthItems.map((item) => (
                    <div
                      key={item.key}
                      className={item.active ? 'text-emerald-400' : 'text-white/40'}
                    >
                      {item.active ? t('requirementMet', 'user') : t('requirementUnmet', 'user')} · {item.label}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="mb-2 block text-sm font-medium text-white/90">
                  {t('confirmNewPasswordLabel', 'user')}
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  disabled={isSubmitting}
                  autoComplete="new-password"
                  className="w-full rounded-md border border-white/20 bg-white/10 px-4 py-3 text-white outline-none transition-all placeholder:text-white/40 focus:border-transparent focus:ring-2 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={t('pleaseEnterNewPasswordAgain', 'user')}
                />
                {errors.confirmPassword ? (
                  <p className="mt-2 text-sm text-red-400">{errors.confirmPassword}</p>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-md bg-amber-500 px-4 py-3 font-medium text-white transition-colors duration-200 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? t('submitting', 'user') : t('confirmChange', 'user')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
