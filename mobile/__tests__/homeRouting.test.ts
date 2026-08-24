import type { MobileContentAction } from '../src/api/mobileContent';
import type { MarketInstrument } from '../src/api/market';
import {
  createLoggedInServiceEntries,
  navigateHomeMarket,
  navigateMobileContentAction,
  type HomeNavigation,
} from '../src/screens/home/HomeScreen';

function navigation() {
  return { navigate: jest.fn() } as unknown as HomeNavigation;
}

function market(category: MarketInstrument['category']): MarketInstrument {
  return {
    id: `market-${category}`,
    symbol: 'TESTUSDT',
    displaySymbol: 'TEST/USDT',
    name: 'Test',
    category,
    price: 1,
    changePercent: 0,
    pricePrecision: 2,
    source: 'api',
  };
}

describe('Home navigation mapping', () => {
  it.each([
    ['LOGIN', ['Auth', { screen: 'Login' }]],
    ['REGISTER', ['Auth', { screen: 'Register' }]],
    ['MARKETS', ['Markets']],
    ['SPOT', ['Trade']],
    ['CONTRACT', ['Contract']],
    ['ASSETS', ['Assets']],
  ] as const)(
    'maps the Mobile %s action to a real route',
    (route, expected) => {
      const target = navigation();
      navigateMobileContentAction(target, {
        type: 'ROUTE',
        route,
      } as MobileContentAction);

      expect(target.navigate).toHaveBeenCalledWith(...expected);
    },
  );

  it('maps the logged-in service shortcuts to implemented routes', () => {
    const target = navigation();
    const entries = createLoggedInServiceEntries(target);

    expect(entries.map(item => item.id)).toEqual([
      'invite',
      'agent',
      'vip',
      'blackCard',
      'rewards',
    ]);
    entries.forEach(item => item.onPress());
    expect(target.navigate).toHaveBeenNthCalledWith(1, 'Assets', {
      section: 'invite',
    });
    expect(target.navigate).toHaveBeenNthCalledWith(2, 'Assets', {
      section: 'bd',
    });
    expect(target.navigate).toHaveBeenNthCalledWith(3, 'VipCenter');
    expect(target.navigate).toHaveBeenNthCalledWith(4, 'BlackCard');
    expect(target.navigate).toHaveBeenNthCalledWith(5, 'AssetHistory', {
      initialFilter: 'inviteReward',
    });
  });

  it('fails closed for a forged non-route or unknown Mobile action', () => {
    const target = navigation();
    navigateMobileContentAction(target, {
      type: 'URL',
      route: 'MARKETS',
    } as unknown as MobileContentAction);
    navigateMobileContentAction(target, {
      type: 'ROUTE',
      route: 'ONCHAIN',
    } as unknown as MobileContentAction);
    expect(target.navigate).not.toHaveBeenCalled();
  });

  it.each(['crypto', 'stock', 'cfd'] as const)(
    'routes a %s market card to its Markets category',
    category => {
      const target = navigation();
      navigateHomeMarket(target, market(category));
      expect(target.navigate).toHaveBeenCalledWith('Markets', { category });
    },
  );

  it('does not create a misleading destination for onchain instruments', () => {
    const target = navigation();
    navigateHomeMarket(target, market('onchain'));
    expect(target.navigate).not.toHaveBeenCalled();
  });
});
