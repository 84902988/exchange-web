export default function ContractLoading() {
  return (
    <main
      aria-label="Loading futures market"
      aria-live="polite"
      className="min-h-[calc(100vh-64px)] bg-[#070b10] p-3"
      role="status"
    >
      <div className="mb-3 h-16 animate-pulse rounded-lg border border-white/5 bg-[#111820]" />
      <div className="grid min-h-[680px] grid-cols-[minmax(0,1fr)_240px_260px] gap-3">
        <div className="animate-pulse rounded-lg border border-white/5 bg-[#0d131a]" />
        <div className="animate-pulse rounded-lg border border-white/5 bg-[#111820]" />
        <div className="animate-pulse rounded-lg border border-white/5 bg-[#111820]" />
      </div>
      <span className="sr-only">Loading futures market</span>
    </main>
  );
}
