'use client'

import { useSyncExternalStore } from 'react'
import {
  getDisplayTimeZone,
  getServerDisplayTimeZone,
  subscribeDisplayTimeZone,
} from '@/lib/displayTimeZone'

export function useDisplayTimeZone() {
  return useSyncExternalStore(
    subscribeDisplayTimeZone,
    getDisplayTimeZone,
    getServerDisplayTimeZone,
  )
}
