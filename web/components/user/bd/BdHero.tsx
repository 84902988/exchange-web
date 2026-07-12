'use client';

import { useLocaleContext } from "@/contexts/LocaleContext";
import type { MyBdAccount } from "@/lib/api/modules/bd";
import { formatRatePercent } from "@/lib/utils/format";

type BdHeroProps = {
  isBd: boolean;
  account?: MyBdAccount | null;
  inviteLink?: string;
  copied?: boolean;
  onCopyInvite?: () => void;
  onApplyClick?: () => void;
};

export default function BdHero({
  isBd,
  account,
  inviteLink,
  copied,
  onCopyInvite,
  onApplyClick,
}: BdHeroProps) {
  const { t } = useLocaleContext();
  const accountStatus = String(account?.status || "").trim().toUpperCase();
  const isBdDisabled = Boolean(account && !isBd && accountStatus && accountStatus !== "ACTIVE");

  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-[#f0b90b]/20 bg-[#090b10] p-6 shadow-2xl shadow-black/30 md:p-8">
      <div className="absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#f0b90b]/20 blur-3xl" />
      <div className="absolute bottom-0 left-1/3 h-48 w-48 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="relative grid grid-cols-1 items-center gap-8 xl:grid-cols-[minmax(0,1fr)_420px] xl:gap-10 2xl:grid-cols-[minmax(0,1fr)_480px] 2xl:gap-14">
        <div className="min-w-0 w-full">
          <div className="inline-flex rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-[#f0b90b]">
            {t('bdHeroEyebrow', 'user')}
          </div>
          <h1 className="mt-5 max-w-[920px] break-keep text-4xl font-black leading-tight tracking-tight text-white sm:text-5xl 2xl:text-6xl">
            {t('bdHeroTitle', 'user')}
          </h1>
          <div className="mt-3 max-w-[760px] break-keep text-2xl font-black leading-tight text-[#f0b90b] sm:text-3xl 2xl:text-4xl">
            {t('bdHeroSubtitle', 'user')}
          </div>
          <p className="mt-5 max-w-[760px] text-sm leading-7 text-white/62 md:text-base">
            {t('bdHeroDesc', 'user')}
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            {isBd ? (
              inviteLink && onCopyInvite ? (
                <button
                  type="button"
                  onClick={onCopyInvite}
                  className="rounded-2xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#ffd55a]"
                >
                  {copied ? t('bdInviteLinkCopied', 'user') : t('bdCopyInviteLink', 'user')}
                </button>
              ) : (
                <div className="rounded-2xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black">
                  {t('bdIdentityActive', 'user')}
                </div>
              )
            ) : isBdDisabled ? (
              <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 px-5 py-3 text-sm font-bold text-amber-100">
                {t('bdIdentityDisabled', 'user')}
              </div>
            ) : (
              <button
                type="button"
                onClick={onApplyClick}
                className="rounded-2xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#ffd55a]"
              >
                {t('bdApplyNow', 'user')}
              </button>
            )}
            <a
              href="#bd-benefits"
              className="rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08]"
            >
              {t('bdViewBenefits', 'user')}
            </a>
          </div>
        </div>

        <div className="w-full rounded-[1.5rem] border border-white/10 bg-white/[0.045] p-5 backdrop-blur xl:max-w-[430px] xl:justify-self-end 2xl:max-w-[480px]">
          <div className="text-sm text-white/50">
            {isBd || isBdDisabled ? t('bdIdentityStatus', 'user') : t('bdProgram', 'user')}
          </div>
          {isBd ? (
            <div className="mt-4 space-y-4">
              <InfoRow label={t('bdLevel', 'user')} value={account?.bd_level || "--"} />
              <InfoRow label={t('bdCommissionRate', 'user')} value={formatRatePercent(account?.commission_rate)} />
              <InviteLinkRow inviteLink={inviteLink} onCopyInvite={onCopyInvite} />
              {account?.invite_code ? (
                <div className="px-1 text-xs text-white/38">
                  {t('inviteCode', 'user')}: <span className="font-mono text-white/52">{account.invite_code}</span>
                </div>
              ) : null}
            </div>
          ) : isBdDisabled ? (
            <div className="mt-4 grid gap-3">
              <InfoRow label={t('currentStatus', 'user')} value={t('disabled', 'user')} highlight />
              <InfoRow label={t('bdLevel', 'user')} value={account?.bd_level || "--"} />
              <InfoRow label={t('bdCommissionRate', 'user')} value={formatRatePercent(account?.commission_rate)} />
              <p className="pt-2 text-xs leading-6 text-white/45">
                {t('bdDisabledDesc', 'user')}
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              <InfoRow label={t('bdAvailableLevels', 'user')} value="BD1 / BD2 / BD3" />
              <InfoRow label={t('bdCommissionRate', 'user')} value="BD1 30% / BD2 40% / BD3 50%" highlight />
              <InfoRow label={t('bdCommissionPayout', 'user')} value={t('bdPayoutFlow', 'user')} />
              <p className="pt-2 text-xs leading-6 text-white/45">
                {t('bdApplyReviewDesc', 'user')}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function InviteLinkRow({
  inviteLink,
  onCopyInvite,
}: {
  inviteLink?: string;
  onCopyInvite?: () => void;
}) {
  const { t } = useLocaleContext();
  const canCopy = Boolean(inviteLink && onCopyInvite);

  return (
    <div className="rounded-2xl bg-black/25 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm text-white/48">{t('inviteLink', 'user')}</span>
        <button
          type="button"
          disabled={!canCopy}
          onClick={onCopyInvite}
          className="shrink-0 rounded-lg border border-[#f0b90b]/30 bg-[#f0b90b]/10 px-3 py-1 text-xs font-semibold text-[#f0b90b] transition hover:bg-[#f0b90b]/18 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35"
        >
          {t('copy', 'common')}
        </button>
      </div>
      <div
        title={inviteLink || undefined}
        className="truncate rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white/86"
      >
        {inviteLink || "--"}
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl bg-black/25 px-4 py-3">
      <span className="text-sm text-white/48">{label}</span>
      <span className={`text-right text-[14px] font-medium tabular-nums ${highlight ? "text-[#f0b90b]" : "text-white"}`}>
        {value}
      </span>
    </div>
  );
}
