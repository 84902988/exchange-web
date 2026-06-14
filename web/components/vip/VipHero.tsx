import { VipHeroContent } from './vip.types';

interface VipHeroProps {
  hero: VipHeroContent;
}

export default function VipHero({ hero }: VipHeroProps) {
  return (
    <section className="relative overflow-hidden border-b border-white/10 bg-[#0b0b0f]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_transparent_38%),linear-gradient(135deg,rgba(120,53,15,0.2),transparent_45%,rgba(245,158,11,0.08))]" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(251,191,36,0.08),transparent)]" />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-14 sm:px-6 lg:px-8 lg:py-16">
        <div className="max-w-3xl">
          <div className="mb-4 inline-flex items-center rounded-full border border-amber-400/30 bg-amber-500/10 px-4 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-amber-300">
            {hero.eyebrow}
          </div>
          <h1 className="max-w-4xl text-4xl font-semibold leading-tight text-white md:text-5xl">
            <span className="bg-gradient-to-r from-amber-300 via-white to-amber-100 bg-clip-text text-transparent">
              {hero.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300 md:text-lg">
            {hero.description}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {hero.highlights.map((highlight) => (
            <div
              key={typeof highlight === 'string' ? highlight : highlight.title}
              className="min-h-[116px] rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.22)]"
            >
              {typeof highlight === 'string' ? (
                <div className="text-sm text-slate-200">{highlight}</div>
              ) : (
                <div>
                  <div className="text-sm font-semibold text-amber-200">{highlight.title}</div>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{highlight.description}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
