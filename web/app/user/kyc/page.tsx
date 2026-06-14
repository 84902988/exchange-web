'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import {
  getMyKyc,
  KycIdType,
  KycSubmissionV1,
  submitMyKyc,
} from '@/lib/api';
import UserSidebar from '@/components/user/UserSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';

type StatusView = {
  title: string;
  badge: string;
  badgeClass: string;
  description: string;
};

type UploadBoxProps = {
  label: string;
  hint: string;
  file: File | null;
  previewUrl: string;
  disabled: boolean;
  required?: boolean;
  uploadedLabel: string;
  uploadLabel: string;
  removeLabel: string;
  fileTypesLabel: string;
  onChange: (file: File | null) => void;
  onRemove: () => void;
};

type UserTranslator = (key: string, namespace?: 'user') => string;

const statusView = (
  t: UserTranslator,
  status?: string | null,
  latest?: KycSubmissionV1 | null,
  kycLevel?: number,
): StatusView => {
  const normalized = (latest?.review_status || status || 'NONE').toUpperCase();
  if (normalized === 'PENDING') {
    return {
      title: t('kycStatusPendingTitle', 'user'),
      badge: t('kycStatusPendingBadge', 'user'),
      badgeClass: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
      description: t('kycStatusPendingDesc', 'user'),
    };
  }
  if (normalized === 'APPROVED' || (kycLevel ?? 0) > 0) {
    return {
      title: t('kycStatusApprovedTitle', 'user'),
      badge: t('kycStatusApprovedBadge', 'user'),
      badgeClass: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
      description: t('kycStatusApprovedDesc', 'user'),
    };
  }
  if (normalized === 'REJECTED') {
    return {
      title: t('kycStatusRejectedTitle', 'user'),
      badge: t('kycStatusRejectedBadge', 'user'),
      badgeClass: 'border-red-400/30 bg-red-400/10 text-red-300',
      description: latest?.review_note || t('kycStatusRejectedDesc', 'user'),
    };
  }
  return {
    title: t('kycStatusNoneTitle', 'user'),
    badge: t('kycStatusNoneBadge', 'user'),
    badgeClass: 'border-white/10 bg-white/[0.04] text-white/60',
    description: t('kycStatusNoneDesc', 'user'),
  };
};

const formatDateTime = (value?: string | null, locale = 'en') => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getErrorMessage = (error: unknown, t: UserTranslator) => {
  const code = String((error as { code?: unknown })?.code || '');
  const message = String((error as { message?: unknown })?.message || '');
  if (code === 'KYC_PENDING_EXISTS') return t('kycErrorPendingExists', 'user');
  if (code === 'KYC_LEVEL_APPROVED') return t('kycErrorAlreadyApproved', 'user');
  if (code === 'INVALID_IMAGE') return t('kycErrorInvalidImage', 'user');
  if (code === 'IMAGE_REQUIRED') return t('kycErrorFrontRequired', 'user');
  if (code === 'KYC_BACK_IMAGE_REQUIRED') return t('kycErrorBackRequired', 'user');
  if (code === 'KYC_SELFIE_IMAGE_REQUIRED') return t('kycErrorSelfieRequired', 'user');
  if (code === 'IMAGE_TOO_LARGE') return t('kycErrorImageTooLarge', 'user');
  if (code === 'VALIDATION_ERROR') return t('kycErrorValidation', 'user');
  return message || t('kycErrorSubmitFailed', 'user');
};

const getFilePreviewUrl = (file: File | null) => {
  if (!file) return '';
  return URL.createObjectURL(file);
};

function UploadBox({
  label,
  hint,
  file,
  previewUrl,
  disabled,
  required,
  uploadedLabel,
  uploadLabel,
  removeLabel,
  fileTypesLabel,
  onChange,
  onRemove,
}: UploadBoxProps) {
  return (
    <label
      className={`group flex min-h-[126px] cursor-pointer flex-col rounded-lg border border-dashed p-3 transition-colors duration-200 ${
        disabled
          ? 'cursor-not-allowed border-white/10 bg-white/[0.02] opacity-60'
          : file
          ? 'border-emerald-400/35 bg-emerald-400/10 hover:border-emerald-300/50'
          : 'border-white/15 bg-white/[0.03] hover:border-amber-400/50'
      }`}
    >
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.files?.[0] || null);
          event.target.value = '';
        }}
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-white">
            {label}
            {required ? <span className="text-amber-300"> *</span> : null}
          </div>
          <div className="mt-1 text-xs text-white/45">{hint}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-1 text-xs ${
              file
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                : 'border-white/10 bg-white/[0.04] text-white/50'
            }`}
          >
            {file ? uploadedLabel : uploadLabel}
          </span>
          {file && !disabled ? (
            <button
              type="button"
              className="rounded-full border border-red-400/25 bg-red-400/10 px-2.5 py-1 text-xs text-red-200 hover:bg-red-400/20"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove();
              }}
            >
              {removeLabel}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-1 items-center justify-center overflow-hidden rounded border border-white/[0.06] bg-black/20">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt={label} className="h-16 max-w-full object-contain" />
        ) : (
          <div className="px-3 text-center text-xs text-white/35">{fileTypesLabel}</div>
        )}
      </div>
    </label>
  );
}

export default function UserKycPage() {
  const { locale, t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [kycStatus, setKycStatus] = useState('NONE');
  const [kycLevelValue, setKycLevelValue] = useState(0);
  const [latestSubmission, setLatestSubmission] = useState<KycSubmissionV1 | null>(null);

  const [fullName, setFullName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [idType, setIdType] = useState<KycIdType>('ID_CARD');
  const [idNumber, setIdNumber] = useState('');
  const [frontImage, setFrontImage] = useState<File | null>(null);
  const [backImage, setBackImage] = useState<File | null>(null);
  const [selfieImage, setSelfieImage] = useState<File | null>(null);

  const view = useMemo(
    () => statusView(t, kycStatus, latestSubmission, kycLevelValue),
    [kycLevelValue, kycStatus, latestSubmission, t],
  );
  const verificationSteps = useMemo(
    () => [
      { title: t('kycStepSubmitTitle', 'user'), description: t('kycStepSubmitDesc', 'user') },
      { title: t('kycStepReviewTitle', 'user'), description: t('kycStepReviewDesc', 'user') },
      { title: t('kycStepCompleteTitle', 'user'), description: t('kycStepCompleteDesc', 'user') },
    ],
    [t],
  );
  const accountBenefits = useMemo(
    () => [
      t('kycBenefitSecurity', 'user'),
      t('kycBenefitWithdraw', 'user'),
      t('kycBenefitTrust', 'user'),
      t('kycBenefitVerification', 'user'),
    ],
    [t],
  );
  const verificationRequirements = useMemo(
    () => [
      t('kycRequirementRealName', 'user'),
      t('kycRequirementValidId', 'user'),
      t('kycRequirementClearPhoto', 'user'),
      t('kycRequirementSelfie', 'user'),
    ],
    [t],
  );
  const kycFaqs = useMemo(
    () => [
      { question: t('kycFaqWhyQuestion', 'user'), answer: t('kycFaqWhyAnswer', 'user') },
      { question: t('kycFaqReviewQuestion', 'user'), answer: t('kycFaqReviewAnswer', 'user') },
      { question: t('kycFaqIdQuestion', 'user'), answer: t('kycFaqIdAnswer', 'user') },
      { question: t('kycFaqRejectedQuestion', 'user'), answer: t('kycFaqRejectedAnswer', 'user') },
    ],
    [t],
  );

  const currentStatus = (latestSubmission?.review_status || kycStatus).toUpperCase();
  const isPending = currentStatus === 'PENDING';
  const isApproved = currentStatus === 'APPROVED';
  const isRejected = currentStatus === 'REJECTED';
  const isBackImageRequired = idType !== 'PASSPORT';
  const activeStepIndex = isApproved ? 2 : isPending ? 1 : 0;

  const [frontPreviewUrl, setFrontPreviewUrl] = useState('');
  const [backPreviewUrl, setBackPreviewUrl] = useState('');
  const [selfiePreviewUrl, setSelfiePreviewUrl] = useState('');

  const toggleSidebar = () => setIsSidebarCollapsed((v) => !v);

  useEffect(() => {
    const nextFront = getFilePreviewUrl(frontImage);
    const nextBack = getFilePreviewUrl(backImage);
    const nextSelfie = getFilePreviewUrl(selfieImage);
    setFrontPreviewUrl(nextFront);
    setBackPreviewUrl(nextBack);
    setSelfiePreviewUrl(nextSelfie);

    return () => {
      if (nextFront) URL.revokeObjectURL(nextFront);
      if (nextBack) URL.revokeObjectURL(nextBack);
      if (nextSelfie) URL.revokeObjectURL(nextSelfie);
    };
  }, [backImage, frontImage, selfieImage]);

  const loadKyc = async () => {
    const data = await getMyKyc();
    setKycStatus(data.kyc_status || 'NONE');
    setKycLevelValue(data.kyc_level || 0);
    setLatestSubmission(data.latest_submission);
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadKyc()
      .catch((loadError) => {
        if (!alive) return;
        console.error('Failed to fetch KYC:', loadError);
        setError(t('kycLoadFailed', 'user'));
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const scrollToForm = () => {
    document.getElementById('kyc-submit-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage('');
    setError('');

    if (!fullName.trim() || !countryCode.trim() || !idNumber.trim()) {
      setError(t('kycErrorValidation', 'user'));
      return;
    }
    if (!frontImage) {
      setError(t('kycErrorFrontRequired', 'user'));
      return;
    }
    if (isBackImageRequired && !backImage) {
      setError(t('kycErrorBackRequired', 'user'));
      return;
    }
    if (!selfieImage) {
      setError(t('kycErrorSelfieRequired', 'user'));
      return;
    }

    setSubmitting(true);
    try {
      await submitMyKyc({
        kycLevel: 'PRIMARY',
        fullName: fullName.trim(),
        countryCode: countryCode.trim().toUpperCase(),
        idType,
        idNumber: idNumber.trim(),
        frontImage,
        backImage,
        selfieImage,
      });
      setMessage(t('kycSubmitSuccess', 'user'));
      await loadKyc();
    } catch (submitError) {
      console.error('Failed to submit KYC:', submitError);
      setError(getErrorMessage(submitError, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10 text-white">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <section className="rounded-lg border border-white/10 bg-[#0a0a0d] p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-2xl font-semibold">{t('kycPageTitle', 'user')}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                  {t('kycPageDesc', 'user')}
                </p>
              </div>
              <Link
                href="/user"
                className="w-fit rounded bg-amber-500 px-4 py-2 text-sm text-white transition-colors duration-200 hover:bg-amber-600"
              >
                {t('backToUserCenter', 'user')}
              </Link>
            </div>
          </section>

          <section className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
            <div className="grid gap-4 md:grid-cols-3">
              {verificationSteps.map((step, index) => {
                const completed = index < activeStepIndex;
                const active = index === activeStepIndex;
                return (
                  <div key={step.title} className="flex gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-4">
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
                        completed
                          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                          : active
                          ? 'border-amber-300/30 bg-amber-300/10 text-amber-200'
                          : 'border-white/10 bg-white/[0.04] text-white/45'
                      }`}
                    >
                      {completed ? t('kycStepDone', 'user') : index + 1}
                    </div>
                    <div>
                      <div className="font-medium text-white">{step.title}</div>
                      <div className="mt-1 text-xs leading-relaxed text-white/50">{step.description}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="text-lg font-semibold">{t('kycCurrentStatus', 'user')}</h2>
                  <span className={`rounded-full border px-3 py-1 text-xs ${view.badgeClass}`}>
                    {view.badge}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-white/60">{view.description}</p>
                {isRejected && latestSubmission?.review_note ? (
                  <div className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                    {t('kycRejectReason', 'user')}: {latestSubmission.review_note}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-col items-start gap-3 md:items-end">
                {latestSubmission ? (
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-white/60">
                    <div>{t('kycSubmissionLevel', 'user')}: {latestSubmission.kyc_level}</div>
                    <div className="mt-1">
                      {t('kycSubmissionTime', 'user')}: {formatDateTime(latestSubmission.created_at, locale)}
                    </div>
                  </div>
                ) : null}
                {isRejected ? (
                  <button
                    type="button"
                    className="rounded bg-amber-500 px-4 py-2 text-sm text-white transition-colors duration-200 hover:bg-amber-600"
                    onClick={scrollToForm}
                  >
                    {t('kycResubmit', 'user')}
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          {isApproved ? (
            <section className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-emerald-200">{t('kycApprovedPanelTitle', 'user')}</h2>
                  <p className="mt-2 text-sm text-emerald-100/70">{t('kycApprovedPanelDesc', 'user')}</p>
                </div>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-300">
                  {t('kycStatusApprovedBadge', 'user')}
                </span>
              </div>
            </section>
          ) : (
            <section id="kyc-submit-form" className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">{t('kycSubmitSectionTitle', 'user')}</h2>
                  {isPending ? (
                    <p className="mt-2 text-sm text-amber-200">{t('kycFormPendingNotice', 'user')}</p>
                  ) : null}
                </div>
              </div>

              <form className="grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
                <label className="text-sm text-white/70">
                  {t('kycFullName', 'user')}
                  <input
                    className="mt-2 w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none focus:border-amber-500 disabled:opacity-60"
                    value={fullName}
                    disabled={isPending || submitting}
                    onChange={(event) => setFullName(event.target.value)}
                    placeholder={t('kycFullNamePlaceholder', 'user')}
                  />
                </label>

                <label className="text-sm text-white/70">
                  {t('kycCountryRegion', 'user')}
                  <input
                    className="mt-2 w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none focus:border-amber-500 disabled:opacity-60"
                    value={countryCode}
                    disabled={isPending || submitting}
                    onChange={(event) => setCountryCode(event.target.value)}
                    placeholder={t('kycCountryPlaceholder', 'user')}
                  />
                </label>

                <label className="text-sm text-white/70">
                  {t('kycIdType', 'user')}
                  <select
                    className="mt-2 w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none focus:border-amber-500 disabled:opacity-60"
                    value={idType}
                    disabled={isPending || submitting}
                    onChange={(event) => setIdType(event.target.value as KycIdType)}
                  >
                    <option className="bg-[#111] text-white" value="PASSPORT">{t('kycIdTypePassport', 'user')}</option>
                    <option className="bg-[#111] text-white" value="ID_CARD">{t('kycIdTypeIdCard', 'user')}</option>
                    <option className="bg-[#111] text-white" value="DRIVER_LICENSE">{t('kycIdTypeDriverLicense', 'user')}</option>
                  </select>
                </label>

                <label className="text-sm text-white/70 md:col-span-2">
                  {t('kycIdNumber', 'user')}
                  <input
                    className="mt-2 w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-white outline-none focus:border-amber-500 disabled:opacity-60"
                    value={idNumber}
                    disabled={isPending || submitting}
                    onChange={(event) => setIdNumber(event.target.value)}
                    placeholder={t('kycIdNumberPlaceholder', 'user')}
                  />
                </label>

                <div className="grid gap-4 md:col-span-2 md:grid-cols-3">
                  <UploadBox
                    label={t('kycFrontImage', 'user')}
                    hint={t('kycFrontImageHint', 'user')}
                    file={frontImage}
                    previewUrl={frontPreviewUrl}
                    disabled={isPending || submitting}
                    required
                    uploadedLabel={t('kycUploaded', 'user')}
                    uploadLabel={t('kycClickUpload', 'user')}
                    removeLabel={t('kycRemove', 'user')}
                    fileTypesLabel={t('kycFileTypes', 'user')}
                    onChange={setFrontImage}
                    onRemove={() => setFrontImage(null)}
                  />
                  <UploadBox
                    label={t('kycBackImage', 'user')}
                    hint={isBackImageRequired ? t('kycBackImageHint', 'user') : t('kycBackImageOptionalHint', 'user')}
                    file={backImage}
                    previewUrl={backPreviewUrl}
                    disabled={isPending || submitting}
                    required={isBackImageRequired}
                    uploadedLabel={t('kycUploaded', 'user')}
                    uploadLabel={t('kycClickUpload', 'user')}
                    removeLabel={t('kycRemove', 'user')}
                    fileTypesLabel={t('kycFileTypes', 'user')}
                    onChange={setBackImage}
                    onRemove={() => setBackImage(null)}
                  />
                  <UploadBox
                    label={t('kycSelfieImage', 'user')}
                    hint={t('kycSelfieImageHint', 'user')}
                    file={selfieImage}
                    previewUrl={selfiePreviewUrl}
                    disabled={isPending || submitting}
                    required
                    uploadedLabel={t('kycUploaded', 'user')}
                    uploadLabel={t('kycClickUpload', 'user')}
                    removeLabel={t('kycRemove', 'user')}
                    fileTypesLabel={t('kycFileTypes', 'user')}
                    onChange={setSelfieImage}
                    onRemove={() => setSelfieImage(null)}
                  />
                </div>

                {message ? (
                  <div className="md:col-span-2 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
                    {message}
                  </div>
                ) : null}

                {error ? (
                  <div className="md:col-span-2 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                    {error}
                  </div>
                ) : null}

                <div className="md:col-span-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={loading || isPending || submitting}
                    className="rounded bg-amber-500 px-5 py-2 text-sm text-white transition-colors duration-200 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPending
                      ? t('kycStatusPendingBadge', 'user')
                      : submitting
                      ? t('kycSubmitting', 'user')
                      : isRejected
                      ? t('kycResubmitData', 'user')
                      : t('kycSubmitData', 'user')}
                  </button>
                </div>
              </form>
            </section>
          )}

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
              <h2 className="text-lg font-semibold text-white">{t('kycBenefitsTitle', 'user')}</h2>
              <div className="mt-4 grid gap-3">
                {accountBenefits.map((item) => (
                  <div key={item} className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white/65">
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
              <h2 className="text-lg font-semibold text-white">{t('kycRequirementsTitle', 'user')}</h2>
              <div className="mt-4 grid gap-3">
                {verificationRequirements.map((item) => (
                  <div key={item} className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-white/65">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-white/10 bg-[#0a0a0d] p-5">
            <h2 className="text-lg font-semibold text-white">{t('kycFaqTitle', 'user')}</h2>
            <div className="mt-4 grid gap-3">
              {kycFaqs.map((item) => (
                <details key={item.question} className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium text-white">{item.question}</summary>
                  <p className="mt-3 text-sm leading-relaxed text-white/55">{item.answer}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
