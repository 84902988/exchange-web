'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import VipFeeNotice from '@/components/vip/VipFeeNotice';
import VipHero from '@/components/vip/VipHero';
import VipLevelColumn from '@/components/vip/VipLevelColumn';
import VipOverviewPanel from '@/components/vip/VipOverviewPanel';
import VipRulesColumn from '@/components/vip/VipRulesColumn';
import type {
  VipAuthState,
  VipHeroContent,
  VipLevelItem,
  VipOverviewPanelData,
  VipOverviewResponse,
  VipRuleItem,
  VipUserSummary,
} from '@/components/vip/vip.types';
import { formatAssetAmount, formatFeeRate, formatVolume } from '@/components/vip/vip.utils';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { refreshToken } from '@/lib/api/modules/auth';
import { getVipOverview, lockRcb } from '@/lib/api/modules/vip';

const EMPTY_USER_SUMMARY: VipUserSummary = {
  vip_level_code: null,
  svip_level_code: null,
  effective_level_code: null,
  effective_fee_source: null,
  effective_spot_maker_fee: null,
  effective_spot_taker_fee: null,
  volume_30d: null,
  rcb_available: null,
  rcb_funding_available: null,
  rcb_locked: null,
  rcb_lock_period_days: null,
};

const EMPTY_LEVELS: VipLevelItem[] = [];
const LOCK_PERIOD_OPTIONS = [365, 720, 1095];

function buildVipHeroContent(t: VipTranslator): VipHeroContent {
  return {
    eyebrow: 'VIP / SVIP',
    title: t('vipHeroTitle', 'user'),
    description: t('vipHeroDesc', 'user'),
    highlights: [
      { title: t('vipHeroHighlightDynamicTitle', 'user'), description: t('vipHeroHighlightDynamicDesc', 'user') },
      { title: t('vipHeroHighlightSvipTitle', 'user'), description: t('vipHeroHighlightSvipDesc', 'user') },
      { title: t('vipHeroHighlightFeeTitle', 'user'), description: t('vipHeroHighlightFeeDesc', 'user') },
    ],
  };
}

function buildVipRules(t: VipTranslator): VipRuleItem[] {
  return [
    {
      title: t('vipRuleCycleTitle', 'user'),
      description: t('vipRuleCycleDesc', 'user'),
    },
    {
      title: t('vipRuleSpotFeeTitle', 'user'),
      description: t('vipRuleSpotFeeDesc', 'user'),
    },
    {
      title: t('vipRuleRcbHoldTitle', 'user'),
      description: t('vipRuleRcbHoldDesc', 'user'),
    },
  ];
}

function buildSvipRules(t: VipTranslator): VipRuleItem[] {
  return [
    {
      title: t('svipRuleLockLevelTitle', 'user'),
      description: t('svipRuleLockLevelDesc', 'user'),
    },
    {
      title: t('svipRuleLockPeriodTitle', 'user'),
      description: t('svipRuleLockPeriodDesc', 'user'),
    },
    {
      title: t('svipRuleDividendTitle', 'user'),
      description: t('svipRuleDividendDesc', 'user'),
    },
  ];
}

function toNumber(value: string | null | undefined) {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAllowedLockDaysByTargetLevel(levelCode: string | null): number {
  if (!levelCode) return 365;
  if (levelCode === 'LP') return 1095;
  if (['SVIP6', 'SVIP7', 'SVIP8'].includes(levelCode)) return 720;
  if (['SVIP1', 'SVIP2', 'SVIP3', 'SVIP4', 'SVIP5'].includes(levelCode)) return 365;
  return 365;
}

function pickPredictedSvip(levels: VipLevelItem[], lockedAmount: number) {
  const matched = levels.filter((level) => {
    const minAmount = toNumber(level.condition.min_lock_amount);
    return minAmount > 0 && lockedAmount >= minAmount;
  });

  return matched.reduce<VipLevelItem | null>((best, level) => {
    if (!best) return level;
    if (level.sort_order !== best.sort_order) return level.sort_order > best.sort_order ? level : best;
    return level.level_code > best.level_code ? level : best;
  }, null);
}

type VipTranslator = (key: string, namespace?: 'user' | 'common') => string;

function authPlaceholder(authState: VipAuthState, t: VipTranslator) {
  return authState === 'expired' ? t('loginExpired', 'user') : t('loginToView', 'user');
}

function buildOverviewPanels(userSummary: VipUserSummary, authState: VipAuthState, t: VipTranslator): {
  vip: VipOverviewPanelData;
  svip: VipOverviewPanelData;
} {
  const isAuthenticated = authState === 'authenticated';
  const placeholder = authPlaceholder(authState, t);

  return {
    vip: {
      type: 'VIP',
      title: t('vipCurrentStatus', 'user'),
      subtitle: t('vipCurrentStatusDesc', 'user'),
      primaryLabel: t('currentVipLevel', 'user'),
      primaryValue: isAuthenticated ? userSummary.vip_level_code ?? '--' : placeholder,
      secondaryLabel: t('currentEffectiveLevel', 'user'),
      secondaryValue: isAuthenticated ? userSummary.effective_level_code ?? '--' : placeholder,
      metrics: [
        { label: t('currentFeeSource', 'user'), value: isAuthenticated ? userSummary.effective_fee_source ?? '--' : placeholder },
        { label: t('spotMaker', 'user'), value: isAuthenticated ? formatFeeRate(userSummary.effective_spot_maker_fee) : placeholder },
        { label: t('volume30d', 'user'), value: isAuthenticated ? formatVolume(userSummary.volume_30d) : placeholder },
        { label: t('rcbAvailable', 'user'), value: isAuthenticated ? formatAssetAmount(userSummary.rcb_available) : placeholder },
      ],
    },
    svip: {
      type: 'SVIP',
      title: t('svipCurrentStatus', 'user'),
      subtitle: t('svipCurrentStatusDesc', 'user'),
      primaryLabel: t('currentSvipLevel', 'user'),
      primaryValue: isAuthenticated ? userSummary.svip_level_code ?? '--' : placeholder,
      secondaryLabel: t('currentEffectiveLevel', 'user'),
      secondaryValue: isAuthenticated ? userSummary.effective_level_code ?? '--' : placeholder,
      metrics: [
        { label: t('currentFeeSource', 'user'), value: isAuthenticated ? userSummary.effective_fee_source ?? '--' : placeholder },
        { label: t('spotTaker', 'user'), value: isAuthenticated ? formatFeeRate(userSummary.effective_spot_taker_fee) : placeholder },
        { label: t('rcbLockedAmount', 'user'), value: isAuthenticated ? formatAssetAmount(userSummary.rcb_locked) : placeholder },
        { label: t('lockableRcb', 'user'), value: isAuthenticated ? formatAssetAmount(userSummary.rcb_funding_available) : placeholder },
      ],
    },
  };
}

function LoadingSection() {
  return (
    <div className="flex flex-col gap-8">
      <section className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="h-[292px] animate-pulse rounded-3xl border border-white/10 bg-white/[0.04]"
          />
        ))}
      </section>

      <section className="space-y-6">
        {[0, 1, 2].map((row) => (
          <div key={row} className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-2">
            <div className="h-[284px] animate-pulse rounded-[24px] border border-white/10 bg-white/[0.04]" />
            <div className="h-[284px] animate-pulse rounded-[24px] border border-white/10 bg-white/[0.04]" />
          </div>
        ))}
      </section>
    </div>
  );
}

function LevelColumnIntro({
  type,
  title,
  subtitle,
}: {
  type: 'VIP' | 'SVIP';
  title: string;
  subtitle: string;
}) {
  return (
    <div className="h-full min-w-0 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(18,18,24,0.95),rgba(10,10,15,0.98))] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.28)] sm:p-6">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="inline-flex w-fit items-center rounded-full border border-amber-400/25 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-amber-300">
          {type}
        </div>
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-white">{title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

function VipBenefitsSection({ t }: { t: VipTranslator }) {
  const benefits = [
    t('vipBenefitLowerSpotFee', 'user'),
    t('vipBenefitHigherWithdrawLimit', 'user'),
    t('vipBenefitExclusiveActivities', 'user'),
    t('vipBenefitHigherApiRate', 'user'),
  ];

  return (
    <div className="min-w-0 space-y-3">
      <div className="text-sm font-semibold text-white">{t('vipBenefits', 'user')}</div>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {benefits.map((benefit) => (
          <div
            key={benefit}
            className="flex min-h-12 min-w-0 items-center rounded-xl border border-white/[0.06] bg-white/[0.035] px-3 py-2 text-sm font-medium text-slate-200"
          >
            {benefit}
          </div>
        ))}
      </div>
    </div>
  );
}

function SvipPanelWithRcbEntry({
  overview,
  onOpenLock,
  t,
}: {
  overview: VipOverviewPanelData;
  onOpenLock: () => void;
  t: VipTranslator;
}) {
  return (
    <VipOverviewPanel overview={overview}>
      <div className="flex min-h-[96px] min-w-0 flex-col justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
        <div className="text-sm font-semibold text-white">{t('rcbLock', 'user')}</div>

        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <button
            type="button"
            onClick={onOpenLock}
            className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-black transition hover:bg-amber-300"
          >
            {t('lockNow', 'user')}
          </button>
          <Link href="/asset/rcb-locks" className="text-sm font-medium text-amber-300 hover:text-amber-200">
            {t('viewLockRecords', 'user')} &gt;
          </Link>
        </div>
      </div>
    </VipOverviewPanel>
  );
}

function RcbLockModal({
  open,
  userSummary,
  svipLevels,
  onClose,
  onLocked,
  t,
}: {
  open: boolean;
  userSummary: VipUserSummary;
  svipLevels: VipLevelItem[];
  onClose: () => void;
  onLocked: () => Promise<void>;
  t: VipTranslator;
}) {
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState(365);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const amountNumber = toNumber(amount);
  const fundingAvailable = toNumber(userSummary.rcb_funding_available);
  const currentLocked = toNumber(userSummary.rcb_locked);
  const currentLockPeriodDays = Number(userSummary.rcb_lock_period_days ?? 0);
  const predictedLocked = currentLocked + Math.max(amountNumber, 0);
  const predictedSvip = pickPredictedSvip(svipLevels, predictedLocked);
  const predictedLevelCode = predictedSvip?.level_code ?? t('notQualifiedYet', 'user');
  const allowedLockDays = getAllowedLockDaysByTargetLevel(predictedSvip?.level_code ?? null);
  const selectedPeriod = allowedLockDays;
  const predictedMakerFee = predictedSvip?.spot_maker_fee ?? null;
  const predictedTakerFee = predictedSvip?.spot_taker_fee ?? null;
  const predictedDividendRate = predictedSvip?.condition.dividend_rate ?? null;
  const shouldShowRenewalNotice = Boolean(
    predictedSvip && currentLocked > 0 && allowedLockDays > 365 && allowedLockDays > currentLockPeriodDays,
  );

  useEffect(() => {
    if (!open) return;
    setError('');
  }, [open]);

  useEffect(() => {
    if (!open || period === allowedLockDays) return;
    setPeriod(allowedLockDays);
  }, [allowedLockDays, open, period]);

  if (!open) return null;

  const submitLock = async () => {
    setError('');
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setError(t('enterPositiveLockAmount', 'user'));
      return;
    }
    if (amountNumber > fundingAvailable) {
      setError(t('insufficientRcbFundingBalance', 'user'));
      return;
    }

    setSubmitting(true);
    try {
      await lockRcb(amount, selectedPeriod);
      setAmount('');
      await onLocked();
      onClose();
    } catch {
      setError(t('rcbLockSubmitFailed', 'user'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-[#101014] shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-300">{t('svipBoost', 'user')}</div>
            <h2 className="mt-2 text-2xl font-semibold text-white">{t('lockNow', 'user')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/[0.06]"
          >
            {t('close', 'common')}
          </button>
        </div>

        <div className="space-y-5 px-6 py-6">
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('availableRcb', 'user')}</div>
            <div className="mt-2 text-[24px] font-semibold tabular-nums text-white">
              {formatAssetAmount(userSummary.rcb_funding_available)} RCB
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('lockAmount', 'user')}</label>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={t('enterRcbAmount', 'user')}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-[14px] font-medium tabular-nums text-white outline-none transition focus:border-amber-300/50"
              />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('periodSelection', 'user')}</div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {LOCK_PERIOD_OPTIONS.map((days) => {
                  const disabled = days !== allowedLockDays;

                  return (
                    <button
                      key={days}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        if (disabled) return;
                        setPeriod(days);
                      }}
                      className={[
                        'rounded-2xl border px-3 py-2 text-[13px] font-medium tabular-nums transition',
                        selectedPeriod === days
                          ? 'border-amber-300/50 bg-amber-400/15 text-amber-200'
                          : 'border-white/10 bg-white/[0.03] text-white/70',
                        disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/[0.07]',
                      ].join(' ')}
                    >
                      {days} {t('days', 'user')}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {shouldShowRenewalNotice ? (
            <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
              {t('rcbLockRenewalPrefix', 'user')} {allowedLockDays} {t('rcbLockRenewalSuffix', 'user')}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('estimatedSvipLevel', 'user')}</div>
              <div className="mt-2 text-[20px] font-semibold tabular-nums text-amber-200">{predictedLevelCode}</div>
            </div>
            <div className="rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('rcbAfterLock', 'user')}</div>
              <div className="mt-2 text-[20px] font-semibold tabular-nums text-white">{formatAssetAmount(String(predictedLocked))} RCB</div>
            </div>
            <div className="rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('estimatedFeeBenefits', 'user')}</div>
              <div className="mt-2 text-[14px] font-medium tabular-nums text-white">
                Maker {formatFeeRate(predictedMakerFee)} / Taker {formatFeeRate(predictedTakerFee)}
              </div>
            </div>
            <div className="rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('dividendBenefitDesc', 'user')}</div>
              <div className="mt-2 text-[14px] font-medium tabular-nums text-emerald-200">
                {predictedDividendRate
                  ? `${t('estimatedDividendRate', 'user')} ${formatFeeRate(predictedDividendRate)}`
                  : t('joinDividendAfterSvip', 'user')}
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-white/10 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs leading-5 text-slate-400">{t('rcbLockConfirmDesc', 'user')}</div>
          <button
            type="button"
            onClick={() => void submitLock()}
            disabled={submitting}
            className="rounded-full bg-amber-400 px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? t('locking', 'user') : t('confirmLock', 'user')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VipPage() {
  const { t } = useLocaleContext();
  const [overview, setOverview] = useState<VipOverviewResponse | null>(null);
  const [lockModalOpen, setLockModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(false);

    try {
      let response = await getVipOverview();
      if (response.auth_state === 'expired') {
        try {
          await refreshToken();
          response = await getVipOverview();
        } catch {
          // Keep the expired response so the page can show an explicit logged-out state.
        }
      }
      setOverview(response);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const userSummary = overview?.user_summary ?? EMPTY_USER_SUMMARY;
  const authState = overview?.auth_state ?? 'anonymous';
  const panels = buildOverviewPanels(userSummary, authState, t);
  const vipLevels = useMemo(() => overview?.vip_levels ?? EMPTY_LEVELS, [overview?.vip_levels]);
  const svipLevels = useMemo(() => overview?.svip_levels ?? EMPTY_LEVELS, [overview?.svip_levels]);
  const heroContent = useMemo(() => buildVipHeroContent(t), [t]);
  const vipRules = useMemo(() => buildVipRules(t), [t]);
  const svipRules = useMemo(() => buildSvipRules(t), [t]);
  const levelRows = useMemo(() => {
    const rowCount = Math.max(vipLevels.length, svipLevels.length, 1);
    return Array.from({ length: rowCount }, (_, index) => ({
      key: `${vipLevels[index]?.level_code ?? 'vip-empty'}-${svipLevels[index]?.level_code ?? 'svip-empty'}-${index}`,
      vip: vipLevels[index] ?? null,
      svip: svipLevels[index] ?? null,
    }));
  }, [svipLevels, vipLevels]);

  return (
    <div className="vip-page-shell min-h-screen bg-[#0b0b0f] text-white">
      <VipHero hero={heroContent} />

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        {loading ? <LoadingSection /> : null}

        {!loading && error ? (
          <section className="rounded-[28px] border border-red-400/20 bg-red-500/5 px-6 py-10 text-center">
            <h2 className="text-xl font-semibold text-white">{t('vipDataLoadFailed', 'user')}</h2>
            <button
              type="button"
              onClick={() => void loadOverview()}
              className="mt-5 rounded-full border border-amber-300/30 bg-amber-400/10 px-5 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-400/15"
            >
              {t('reload', 'user')}
            </button>
          </section>
        ) : null}

        {!loading && !error ? (
          <>
            {authState !== 'authenticated' ? (
              <section className="rounded-[20px] border border-amber-300/20 bg-amber-400/10 px-5 py-4 text-sm leading-6 text-amber-100">
                {authState === 'expired'
                  ? t('vipLoginExpiredNotice', 'user')
                  : t('vipAnonymousNotice', 'user')}
              </section>
            ) : null}

            <section className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
              <div className="min-w-0">
                <VipOverviewPanel overview={panels.vip}>
                  <VipBenefitsSection t={t} />
                </VipOverviewPanel>
              </div>

              <div className="min-w-0">
                <SvipPanelWithRcbEntry
                  overview={panels.svip}
                  onOpenLock={() => setLockModalOpen(true)}
                  t={t}
                />
              </div>
            </section>

            <section className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
              <LevelColumnIntro
                type="VIP"
                title={t('vipDynamicLevelSystem', 'user')}
                subtitle={t('vipDynamicLevelSystemDesc', 'user')}
              />

              <LevelColumnIntro
                type="SVIP"
                title={t('svipStaticLevelSystem', 'user')}
                subtitle={t('svipStaticLevelSystemDesc', 'user')}
              />
            </section>

            <section className="space-y-6">
              {levelRows.map((row) => (
                <div key={row.key} className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-2">
                  <VipLevelColumn
                    type="VIP"
                    level={row.vip}
                    currentLevelCode={userSummary.vip_level_code}
                  />
                  <VipLevelColumn
                    type="SVIP"
                    level={row.svip}
                    currentLevelCode={userSummary.svip_level_code}
                  />
                </div>
              ))}
            </section>

            <section className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
              <VipRulesColumn
                title={t('vipRulesTitle', 'user')}
                subtitle={t('vipRulesSubtitle', 'user')}
                items={vipRules}
              />

              <VipRulesColumn
                title={t('svipRulesTitle', 'user')}
                subtitle={t('svipRulesSubtitle', 'user')}
                items={svipRules}
              />
            </section>

            <VipFeeNotice notice={t('vipFeeNotice', 'user')} />
          </>
        ) : null}
      </main>

      <RcbLockModal
        open={lockModalOpen}
        userSummary={userSummary}
        svipLevels={svipLevels}
        onClose={() => setLockModalOpen(false)}
        onLocked={loadOverview}
        t={t}
      />
    </div>
  );
}
