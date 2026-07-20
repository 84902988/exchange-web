import {
  getDisplayTimeZone,
  setDisplayTimeZone,
} from '@/lib/displayTimeZone'

type TradingViewTimezoneInfo = {
  id: string
}

type TradingViewTimezoneSubscription = {
  subscribe: (context: object | null, listener: (timeZone: string) => void) => void
  unsubscribe: (context: object | null, listener: (timeZone: string) => void) => void
}

export type TradingViewTimezoneApi = {
  getTimezone: () => TradingViewTimezoneInfo
  setTimezone?: (timeZone: string) => void
  onTimezoneChanged: () => TradingViewTimezoneSubscription
}

export type TradingViewTimezoneChart = {
  getTimezoneApi?: () => TradingViewTimezoneApi
}

export function bindTradingViewDisplayTimeZone(chart: TradingViewTimezoneChart | null | undefined) {
  try {
    const timeZoneApi = chart?.getTimezoneApi?.()
    if (!timeZoneApi) return () => undefined

    const configuredTimeZone = getDisplayTimeZone()
    const currentTimeZone = timeZoneApi.getTimezone().id
    if (currentTimeZone !== configuredTimeZone && timeZoneApi.setTimezone) {
      timeZoneApi.setTimezone(configuredTimeZone)
      setDisplayTimeZone(configuredTimeZone)
    } else {
      setDisplayTimeZone(currentTimeZone)
    }

    const handleTimeZoneChanged = (timeZone: string) => {
      setDisplayTimeZone(timeZone)
    }
    const subscription = timeZoneApi.onTimezoneChanged()
    subscription.subscribe(null, handleTimeZoneChanged)

    return () => {
      try {
        subscription.unsubscribe(null, handleTimeZoneChanged)
      } catch {
        // TradingView may already have disposed the subscription during widget teardown.
      }
    }
  } catch {
    return () => undefined
  }
}
