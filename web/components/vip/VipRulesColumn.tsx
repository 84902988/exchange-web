import { VipRuleItem } from './vip.types';

interface VipRulesColumnProps {
  title: string;
  subtitle: string;
  items: VipRuleItem[];
}

export default function VipRulesColumn({ title, subtitle, items }: VipRulesColumnProps) {
  return (
    <section className="flex h-full min-w-0 flex-col rounded-[28px] border border-slate-700/60 bg-[linear-gradient(180deg,rgba(18,18,24,0.95),rgba(10,10,15,0.98))] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.22)]">
      <div className="min-w-0 border-b border-white/10 pb-4">
        <h3 className="text-xl font-semibold text-white">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-300">{subtitle}</p>
      </div>

      <div className="mt-5 flex min-w-0 flex-1 flex-col gap-4">
        {items.map((item) => (
          <div key={item.title} className="min-h-[128px] min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="text-sm font-semibold text-amber-200">{item.title}</div>
            <p className="mt-2 text-sm leading-6 text-slate-300">{item.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
