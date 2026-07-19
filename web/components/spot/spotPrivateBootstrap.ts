import {
  getSpotAccountBalances,
  type SpotAccountBalanceItem,
} from '@/lib/api/modules/spot';
import {
  getVipFeePreference,
  getVipOverview,
  type VipFeePreferenceResponse,
} from '@/lib/api/modules/vip';
import type { VipOverviewResponse } from '@/components/vip/vip.types';

export type SpotVipBootstrapResult = {
  overview: VipOverviewResponse;
  preference: VipFeePreferenceResponse;
};

const accountBalanceFlights = new Map<string, Promise<SpotAccountBalanceItem[]>>();
const vipBootstrapFlights = new Map<string, Promise<SpotVipBootstrapResult>>();

function runIdentitySingleFlight<T>(
  flights: Map<string, Promise<T>>,
  identityKey: string,
  loader: () => Promise<T>,
): Promise<T> {
  const key = identityKey.trim();
  if (!key) {
    return Promise.reject(new Error('Authenticated identity is required'));
  }

  const existing = flights.get(key);
  if (existing) {
    return existing;
  }

  const flight = Promise.resolve()
    .then(loader)
    .finally(() => {
      if (flights.get(key) === flight) {
        flights.delete(key);
      }
    });

  flights.set(key, flight);
  return flight;
}

export function loadSpotAccountBalancesSingleFlight(
  identityKey: string,
): Promise<SpotAccountBalanceItem[]> {
  return runIdentitySingleFlight(accountBalanceFlights, identityKey, getSpotAccountBalances);
}

export function loadSpotVipBootstrapSingleFlight(
  identityKey: string,
): Promise<SpotVipBootstrapResult> {
  return runIdentitySingleFlight(vipBootstrapFlights, identityKey, async () => {
    const [overview, preference] = await Promise.all([
      getVipOverview(),
      getVipFeePreference(),
    ]);
    return { overview, preference };
  });
}

export function resetSpotPrivateBootstrapFlightsForTests(): void {
  accountBalanceFlights.clear();
  vipBootstrapFlights.clear();
}
