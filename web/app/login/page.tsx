import { Suspense } from 'react';
import LoginClient from './LoginClient';
import LoginLoadingFallback from './LoginLoadingFallback';

export default function Page() {
  return (
    <Suspense fallback={<LoginLoadingFallback />}>
      <LoginClient />
    </Suspense>
  );
}
