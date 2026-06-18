'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import SpotPage from '@/components/spot/SpotPage';

function SpotTradePageContent() {
  const searchParams = useSearchParams();
  const symbol = (searchParams.get('symbol') || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const rawCategory = (searchParams.get('category') || '').trim().toLowerCase();
  const category = rawCategory === 'stock' ? '' : rawCategory;

  return (
    <div>
      <SpotPage
        key={`spot-${symbol || 'default'}-${category || 'all'}`}
        initialSymbol={symbol || undefined}
        initialCategory={category}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SpotTradePageContent />
    </Suspense>
  );
}
