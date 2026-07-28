'use client';

export type HeroBackgroundVideoProps = {
  src?: string;
  onReady?: () => void;
  onError?: () => void;
};

export default function HeroBackgroundVideo({
  src = "",
  onReady,
  onError,
}: HeroBackgroundVideoProps) {
  if (!src) return null;

  return (
    <video
      className="
        absolute inset-0 z-0
        w-full h-full
        object-cover
        pointer-events-none
        select-none
      "
      src={src}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      onLoadedData={onReady}
      onError={onError}
      data-testid="home-hero-video"
      aria-hidden="true"
    />
  );
}
