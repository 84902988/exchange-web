'use client';

import AuthGuard from '@/components/auth/AuthGuard';

export default function AssetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard requireLogin>
      {children}
    </AuthGuard>
  );
}
