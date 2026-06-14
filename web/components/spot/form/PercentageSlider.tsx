'use client';

import React, { useEffect, useRef } from 'react';

type PercentageSliderProps = {
  value: number;
  side: 'buy' | 'sell';
  onChange: (value: number) => void;
  disabled?: boolean;
};

const TICKS = [0, 25, 50, 75, 100];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function PercentageSlider({
  value,
  side,
  onChange,
  disabled = false,
}: PercentageSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const accentColor = side === 'buy' ? '#16a34a' : '#dc2626';
  const safeValue = clamp(Number.isFinite(value) ? value : 0, 0, 100);

  const updateFromClientX = (clientX: number) => {
    if (disabled || !trackRef.current) {
      return;
    }

    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    onChange(Math.round(ratio * 100));
  };

  const bindPointerEvents = () => {
    cleanupRef.current?.();

    const handleMove = (event: PointerEvent) => {
      updateFromClientX(event.clientX);
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      cleanupRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    cleanupRef.current = handleUp;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    event.preventDefault();
    updateFromClientX(event.clientX);
    bindPointerEvents();
  };

  return (
    <div>
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        className={`relative flex h-6 items-center ${
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer touch-none'
        }`}
      >
        <div className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/10" />
        <div
          className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-[width] duration-150"
          style={{
            width: `${safeValue}%`,
            backgroundColor: accentColor,
          }}
        />

        {TICKS.map((tick) => {
          const active = safeValue >= tick;

          return (
            <button
              key={tick}
              type="button"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onChange(tick);
              }}
              className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors ${
                active ? 'border-transparent' : 'border-white/20 bg-[#0b0e11]'
              }`}
              style={{
                left: `${tick}%`,
                backgroundColor: active ? accentColor : '#0b0e11',
              }}
              aria-label={`${tick}%`}
            />
          );
        })}

        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(11,14,17,0.9)] transition-[left] duration-150"
          style={{
            left: `${safeValue}%`,
            backgroundColor: accentColor,
          }}
        />
      </div>

      <div className="relative mt-0.5 h-4 px-0.5 text-[10px] text-gray-500">
        {TICKS.map((tick) => {
          const active = safeValue >= tick;
          const edgeClassName =
            tick === 0
              ? 'left-0 translate-x-0 text-left'
              : tick === 100
              ? 'right-0 -translate-x-0 text-right'
              : '-translate-x-1/2 text-center';

          const style =
            tick === 0
              ? undefined
              : tick === 100
              ? undefined
              : { left: `${tick}%` };

          return (
            <button
              key={tick}
              type="button"
              disabled={disabled}
              onClick={() => onChange(tick)}
              className={`absolute top-0 font-medium transition-colors hover:text-white disabled:cursor-not-allowed disabled:hover:text-gray-500 ${edgeClassName}`}
              style={style}
            >
              <span
                style={{
                  color: active ? accentColor : undefined,
                }}
              >
                {tick}%
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
