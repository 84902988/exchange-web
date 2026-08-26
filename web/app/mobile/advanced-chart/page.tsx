import type { Viewport } from 'next';
import { Suspense } from 'react';

import MobileAdvancedChartClient from './MobileAdvancedChartClient';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

function AdvancedChartShell() {
  return (
    <main className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-[#0b0e11] text-white">
      <div className="min-h-0 flex-1 animate-pulse bg-[#0f1318]" />
      <div className="h-11 shrink-0 animate-pulse border-t border-white/10 bg-[#0b0e11] landscape:h-10" />
    </main>
  );
}

export default function MobileAdvancedChartPage() {
  return (
    <Suspense fallback={<AdvancedChartShell />}>
      <MobileAdvancedChartClient />
    </Suspense>
  );
}
