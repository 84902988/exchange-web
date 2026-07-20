import { afterEach, describe, expect, it, jest } from '@jest/globals'

import {
  UTC_DISPLAY_TIME_ZONE,
  formatDisplayDateTime,
  formatDisplayTime,
  getDisplayTimeZone,
  parseApiDateTime,
  resolveDisplayTimeZone,
  setDisplayTimeZone,
  subscribeDisplayTimeZone,
} from './displayTimeZone'

afterEach(() => {
  setDisplayTimeZone(UTC_DISPLAY_TIME_ZONE)
})

describe('display timezone authority', () => {
  it('normalizes TradingView aliases and fails closed to UTC', () => {
    expect(resolveDisplayTimeZone('UTC')).toBe(UTC_DISPLAY_TIME_ZONE)
    expect(resolveDisplayTimeZone('exchange')).toBe('Asia/Shanghai')
    expect(resolveDisplayTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata')
    expect(resolveDisplayTimeZone('Unsupported/Zone')).toBe(UTC_DISPLAY_TIME_ZONE)
    expect(resolveDisplayTimeZone(undefined)).toBe(UTC_DISPLAY_TIME_ZONE)
  })

  it('treats API datetimes without an offset as UTC compatibility values', () => {
    expect(parseApiDateTime('2026-07-20T19:07:10')?.toISOString()).toBe(
      '2026-07-20T19:07:10.000Z',
    )
    expect(parseApiDateTime('2026-07-21T03:07:10+08:00')?.toISOString()).toBe(
      '2026-07-20T19:07:10.000Z',
    )
  })

  it('formats one instant consistently in the selected timezone', () => {
    const value = '2026-07-20T19:07:10Z'
    expect(formatDisplayDateTime(value, 'Asia/Shanghai', 'en-GB')).toBe(
      '21/07/2026, 03:07:10',
    )
    expect(formatDisplayTime(value, 'Etc/UTC', 'en-GB')).toBe('19:07:10')
  })

  it('notifies subscribers only when the selected timezone changes', () => {
    const listener = jest.fn()
    const unsubscribe = subscribeDisplayTimeZone(listener)

    setDisplayTimeZone('Asia/Shanghai')
    setDisplayTimeZone('Asia/Shanghai')
    expect(getDisplayTimeZone()).toBe('Asia/Shanghai')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setDisplayTimeZone('Etc/UTC')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
