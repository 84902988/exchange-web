import type { MeOut } from '@/lib/api';

export function getUserIdentityKey(user: Pick<MeOut, 'id'> | null) {
  if (user?.id === null || user?.id === undefined) return null;
  const identity = String(user.id).trim();
  return identity || null;
}

export function hasAuthIdentityChanged(previous: string | null, next: string | null) {
  return previous !== next;
}
