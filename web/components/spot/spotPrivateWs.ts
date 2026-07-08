type SpotPrivateWsParseOptions = {
  sendPong?: () => void
  onIgnoredText?: (message: string) => void
}

export function parseSpotPrivateWsMessage(
  rawData: unknown,
  options: SpotPrivateWsParseOptions = {},
): unknown | null {
  const rawMessage = typeof rawData === 'string' ? rawData.trim() : rawData

  if (rawMessage === '' || rawMessage === 'pong') {
    return null
  }

  if (rawMessage === 'ping') {
    options.sendPong?.()
    return null
  }

  if (
    typeof rawMessage === 'string' &&
    !rawMessage.startsWith('{') &&
    !rawMessage.startsWith('[')
  ) {
    options.onIgnoredText?.(rawMessage)
    return null
  }

  return JSON.parse(String(rawMessage))
}
