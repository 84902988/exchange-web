import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getSpotAccountBalances } from '@/lib/api/modules/spot';
import { getVipFeePreference, getVipOverview } from '@/lib/api/modules/vip';
import {
  loadSpotAccountBalancesSingleFlight,
  loadSpotVipBootstrapSingleFlight,
  resetSpotPrivateBootstrapFlightsForTests,
} from './spotPrivateBootstrap';

jest.mock('@/lib/api/modules/spot', () => ({
  getSpotAccountBalances: jest.fn(),
}));

jest.mock('@/lib/api/modules/vip', () => ({
  getVipFeePreference: jest.fn(),
  getVipOverview: jest.fn(),
}));

const accountBalancesMock = jest.mocked(getSpotAccountBalances);
const vipOverviewMock = jest.mocked(getVipOverview);
const vipPreferenceMock = jest.mocked(getVipFeePreference);

describe('Spot private bootstrap single-flight', () => {
  beforeEach(() => {
    resetSpotPrivateBootstrapFlightsForTests();
    jest.clearAllMocks();
  });

  it('shares an account balance request for the same authenticated identity', async () => {
    let resolveRequest!: (value: []) => void;
    accountBalancesMock.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    const first = loadSpotAccountBalancesSingleFlight('user:1');
    const second = loadSpotAccountBalancesSingleFlight('user:1');
    await Promise.resolve();

    expect(accountBalancesMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    resolveRequest([]);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it('keeps private account requests isolated between identities', async () => {
    accountBalancesMock.mockResolvedValue([]);

    await Promise.all([
      loadSpotAccountBalancesSingleFlight('user:1'),
      loadSpotAccountBalancesSingleFlight('user:2'),
    ]);

    expect(accountBalancesMock).toHaveBeenCalledTimes(2);
  });

  it('clears a failed flight so the next request can retry', async () => {
    accountBalancesMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([]);

    await expect(loadSpotAccountBalancesSingleFlight('user:1')).rejects.toThrow('temporary failure');
    await expect(loadSpotAccountBalancesSingleFlight('user:1')).resolves.toEqual([]);

    expect(accountBalancesMock).toHaveBeenCalledTimes(2);
  });

  it('shares the paired VIP bootstrap for the same authenticated identity', async () => {
    vipOverviewMock.mockResolvedValue({ user_summary: null } as never);
    vipPreferenceMock.mockResolvedValue({ use_rcb_fee: true });

    const [first, second] = await Promise.all([
      loadSpotVipBootstrapSingleFlight('user:1'),
      loadSpotVipBootstrapSingleFlight('user:1'),
    ]);

    expect(first).toEqual(second);
    expect(vipOverviewMock).toHaveBeenCalledTimes(1);
    expect(vipPreferenceMock).toHaveBeenCalledTimes(1);
  });
});
