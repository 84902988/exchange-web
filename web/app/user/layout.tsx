'use client';

import type { ReactNode } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';

export default function UserLayout({ children }: { children: ReactNode }) {
  return <AuthGuard requireLogin>{children}</AuthGuard>;
}
