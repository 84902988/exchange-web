import { afterEach, describe, expect, it, jest } from '@jest/globals'

import {
  getDisplayTimeZone,
  setDisplayTimeZone,
} from '@/lib/displayTimeZone'
import { bindTradingViewDisplayTimeZone } from './displayTimeZoneSync'

afterEach(() => {
  setDisplayTimeZone('Etc/UTC')
})

describe('TradingView display timezone synchronization', () => {
  it('applies the current display timezone and follows later chart changes', () => {
    setDisplayTimeZone('Asia/Shanghai')
    let activeTimeZone = 'Etc/UTC'
    let listener: (timeZone: string) => void = () => undefined
    const setTimezone = jest.fn((timeZone: string) => {
      activeTimeZone = timeZone
    })
    const unsubscribe = jest.fn()

    const release = bindTradingViewDisplayTimeZone({
      getTimezoneApi: () => ({
        getTimezone: () => ({ id: activeTimeZone }),
        setTimezone,
        onTimezoneChanged: () => ({
          subscribe: (_context, nextListener) => {
            listener = nextListener
          },
          unsubscribe,
        }),
      }),
    })

    expect(setTimezone).toHaveBeenCalledWith('Asia/Shanghai')
    expect(getDisplayTimeZone()).toBe('Asia/Shanghai')

    listener('Europe/London')
    expect(getDisplayTimeZone()).toBe('Europe/London')

    release()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('is fail-safe when the chart timezone API is unavailable', () => {
    expect(() => bindTradingViewDisplayTimeZone(null)()).not.toThrow()
    expect(() => bindTradingViewDisplayTimeZone({
      getTimezoneApi: () => {
        throw new Error('disposed')
      },
    })()).not.toThrow()
  })
})
