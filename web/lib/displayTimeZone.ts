export const UTC_DISPLAY_TIME_ZONE = 'Etc/UTC'

const TRADINGVIEW_TIME_ZONES = new Set([
  UTC_DISPLAY_TIME_ZONE,
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Africa/Tunis',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Caracas',
  'America/Chicago',
  'America/El_Salvador',
  'America/Halifax',
  'America/Juneau',
  'America/Lima',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Almaty',
  'Asia/Ashkhabad',
  'Asia/Bahrain',
  'Asia/Bangkok',
  'Asia/Chongqing',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Kabul',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Kuala_Lumpur',
  'Asia/Kuwait',
  'Asia/Manila',
  'Asia/Muscat',
  'Asia/Nicosia',
  'Asia/Qatar',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Asia/Yangon',
  'Atlantic/Azores',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Europe/Bratislava',
  'Europe/Brussels',
  'Europe/Bucharest',
  'Europe/Budapest',
  'Europe/Copenhagen',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/Ljubljana',
  'Europe/London',
  'Europe/Luxembourg',
  'Europe/Madrid',
  'Europe/Malta',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Prague',
  'Europe/Riga',
  'Europe/Rome',
  'Europe/Sofia',
  'Europe/Stockholm',
  'Europe/Tallinn',
  'Europe/Vienna',
  'Europe/Vilnius',
  'Europe/Warsaw',
  'Europe/Zagreb',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Fakaofo',
  'Pacific/Honolulu',
  'Pacific/Norfolk',
  'US/Mountain',
])

const TIME_ZONE_ALIASES: Record<string, string> = {
  UTC: UTC_DISPLAY_TIME_ZONE,
  GMT: UTC_DISPLAY_TIME_ZONE,
  exchange: 'Asia/Shanghai',
  'Etc/GMT': UTC_DISPLAY_TIME_ZONE,
  'Etc/UCT': UTC_DISPLAY_TIME_ZONE,
  'Etc/Universal': UTC_DISPLAY_TIME_ZONE,
  'Etc/Zulu': UTC_DISPLAY_TIME_ZONE,
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
}

type DateTimeValue = string | number | Date | null | undefined
type DisplayTimeZoneListener = () => void

let activeDisplayTimeZone: string | null = null
const listeners = new Set<DisplayTimeZoneListener>()
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function isIntlTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

export function resolveDisplayTimeZone(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return UTC_DISPLAY_TIME_ZONE
  const normalized = TIME_ZONE_ALIASES[raw] || raw
  if (!TRADINGVIEW_TIME_ZONES.has(normalized)) return UTC_DISPLAY_TIME_ZONE
  return isIntlTimeZone(normalized) ? normalized : UTC_DISPLAY_TIME_ZONE
}

export function detectBrowserDisplayTimeZone(): string {
  if (typeof window === 'undefined') return UTC_DISPLAY_TIME_ZONE
  try {
    return resolveDisplayTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return UTC_DISPLAY_TIME_ZONE
  }
}

export function getDisplayTimeZone(): string {
  if (activeDisplayTimeZone === null) {
    activeDisplayTimeZone = detectBrowserDisplayTimeZone()
  }
  return activeDisplayTimeZone
}

export function getServerDisplayTimeZone(): string {
  return UTC_DISPLAY_TIME_ZONE
}

export function setDisplayTimeZone(value: unknown): string {
  const next = resolveDisplayTimeZone(value)
  if (next === activeDisplayTimeZone) return next
  activeDisplayTimeZone = next
  listeners.forEach((listener) => listener())
  return next
}

export function subscribeDisplayTimeZone(listener: DisplayTimeZoneListener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function parseApiDateTime(value: DateTimeValue): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  }
  if (typeof value === 'number') {
    const millis = Math.abs(value) < 1e12 ? value * 1000 : value
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const hasExplicitTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  const isIsoDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)
  const normalized = isIsoDateTime && !hasExplicitTimeZone
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function getFormatter(
  locale: string | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  const key = JSON.stringify([locale || '', timeZone, options])
  const cached = formatterCache.get(key)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone })
  if (formatterCache.size >= 64) formatterCache.clear()
  formatterCache.set(key, formatter)
  return formatter
}

export function formatDisplayDateTime(
  value: DateTimeValue,
  timeZone = getDisplayTimeZone(),
  locale?: string,
) {
  const date = parseApiDateTime(value)
  if (!date) return '--'
  return getFormatter(locale, resolveDisplayTimeZone(timeZone), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

export function formatDisplayTime(
  value: DateTimeValue,
  timeZone = getDisplayTimeZone(),
  locale?: string,
) {
  const date = parseApiDateTime(value)
  if (!date) return '--:--:--'
  return getFormatter(locale, resolveDisplayTimeZone(timeZone), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}
