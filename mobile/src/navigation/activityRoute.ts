export type ActivityCtaTarget =
  | { type: 'auth'; screen: 'Login' | 'Register' }
  | {
      type: 'main';
      screen: 'Trade' | 'Contract' | 'Assets';
      params?: { section: 'invite' };
    }
  | { type: 'root'; screen: 'AssetDeposit' };

export function resolveActivityCtaTarget(
  ctaUrl: string,
): ActivityCtaTarget | null {
  switch (ctaUrl.trim().replace(/\/+$/, '') || '/') {
    case '/register':
      return { type: 'auth', screen: 'Register' };
    case '/login':
      return { type: 'auth', screen: 'Login' };
    case '/invite':
      return { type: 'main', screen: 'Assets', params: { section: 'invite' } };
    case '/trade/spot':
      return { type: 'main', screen: 'Trade' };
    case '/trade/futures':
    case '/contract':
      return { type: 'main', screen: 'Contract' };
    case '/asset/deposit':
      return { type: 'root', screen: 'AssetDeposit' };
    default:
      return null;
  }
}
