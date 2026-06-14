import { useLocaleContext } from "@/contexts/LocaleContext";

interface VipFeeNoticeProps {
  notice: string;
}

export default function VipFeeNotice({ notice }: VipFeeNoticeProps) {
  const { t } = useLocaleContext();

  return (
    <section className="rounded-[28px] border border-amber-400/12 bg-[linear-gradient(135deg,rgba(120,53,15,0.12),rgba(13,13,18,0.95))] px-8 py-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.28em] text-amber-300">{t("vipUnifiedNotice", "user")}</div>
          <p className="mt-2 text-base leading-7 text-slate-100">{notice}</p>
        </div>
        <div className="rounded-full border border-amber-300/15 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200">
          {t("vipFeePriorityRule", "user")}
        </div>
      </div>
    </section>
  );
}
