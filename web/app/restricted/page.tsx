export default function RestrictedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0b0b0f] px-4 py-16 text-white sm:px-6">
      <section className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10 text-2xl font-semibold text-amber-300">
          !
        </div>

        <h1 className="mt-5 text-3xl font-bold text-white sm:text-4xl">
          Service unavailable in your region
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-white/65">
          Due to regional restrictions, this service is currently unavailable in your location.
        </p>
      </section>
    </main>
  );
}
