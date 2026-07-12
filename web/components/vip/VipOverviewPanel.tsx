import type { ReactNode } from "react";

import { VipOverviewPanelData } from "./vip.types";

interface VipOverviewPanelProps {
  overview: VipOverviewPanelData;
  action?: ReactNode;
  children?: ReactNode;
}

export default function VipOverviewPanel({ overview, action, children }: VipOverviewPanelProps) {
  return (
    <section className="relative flex h-full min-h-[292px] min-w-0 flex-col rounded-3xl border border-slate-700/60 bg-[linear-gradient(160deg,rgba(20,20,26,0.96),rgba(12,12,18,0.92))] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.28)]">
      <div className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(circle_at_top_right,_rgba(245,158,11,0.08),_transparent_40%)]" />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-5">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-3 inline-flex items-center rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
              {overview.type}
            </div>
            <h2 className="text-2xl font-semibold text-white">{overview.title}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">{overview.subtitle}</p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-[168px]">
            {action ? <div className="flex justify-end">{action}</div> : null}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-3 text-right">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">{overview.primaryLabel}</div>
              <div className="mt-1.5 text-[24px] font-semibold tabular-nums text-white">{overview.primaryValue}</div>
              <div className="mt-3 text-[11px] uppercase tracking-[0.22em] text-slate-500">{overview.secondaryLabel}</div>
              <div className="mt-1.5 text-[13px] font-medium tabular-nums text-amber-300">{overview.secondaryValue}</div>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 auto-rows-fr content-start gap-4 sm:grid-cols-2">
          {overview.metrics.map((metric) => (
            <div key={metric.label} className="min-h-[64px] min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{metric.label}</div>
              <div className="mt-2 text-[20px] font-semibold tabular-nums text-white">{metric.value}</div>
              {metric.hint ? <div className="mt-2 text-xs leading-5 text-slate-400">{metric.hint}</div> : null}
            </div>
          ))}
        </div>

        {children ? <div className="mt-auto border-t border-white/[0.06] pt-4">{children}</div> : null}
      </div>
    </section>
  );
}
