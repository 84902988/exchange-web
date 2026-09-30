export type CfdGroup = 'metals' | 'commodities' | 'forex' | 'indices' | 'other';
export type CfdFilter = 'all' | CfdGroup;

export function resolveCfdGroup(category: unknown): CfdGroup {
  switch (String(category || '').trim().toUpperCase()) {
    case 'GOLD':
    case 'METAL':
      return 'metals';
    case 'FUTURES':
    case 'COMMODITY':
      return 'commodities';
    case 'FOREX':
      return 'forex';
    case 'INDEX':
      return 'indices';
    default:
      return 'other';
  }
}
