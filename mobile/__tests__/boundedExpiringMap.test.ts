import {
  getFreshExpiringEntry,
  getOrCreateInFlightRequest,
  setBoundedExpiringEntry,
} from '../src/utils/boundedExpiringMap';

describe('bounded expiring map', () => {
  it('removes expired entries and never grows past its capacity', () => {
    const cache = new Map<string, { expiresAt: number; value: string }>();
    setBoundedExpiringEntry(
      cache,
      'expired',
      { expiresAt: 9, value: 'x' },
      2,
      0,
    );
    setBoundedExpiringEntry(cache, 'a', { expiresAt: 100, value: 'a' }, 2, 10);
    setBoundedExpiringEntry(cache, 'b', { expiresAt: 100, value: 'b' }, 2, 10);

    expect([...cache.keys()]).toEqual(['a', 'b']);
    expect(cache.size).toBe(2);
  });

  it('touches fresh entries so capacity eviction follows recent use', () => {
    const cache = new Map<string, { expiresAt: number; value: string }>();
    setBoundedExpiringEntry(cache, 'a', { expiresAt: 100, value: 'a' }, 2, 0);
    setBoundedExpiringEntry(cache, 'b', { expiresAt: 100, value: 'b' }, 2, 0);

    expect(getFreshExpiringEntry(cache, 'a', 10)?.value).toBe('a');
    setBoundedExpiringEntry(cache, 'c', { expiresAt: 100, value: 'c' }, 2, 10);

    expect([...cache.keys()]).toEqual(['a', 'c']);
    expect(getFreshExpiringEntry(cache, 'missing', 10)).toBeUndefined();
  });

  it('deletes a requested entry once it expires', () => {
    const cache = new Map([['a', { expiresAt: 10, value: 'a' }]]);

    expect(getFreshExpiringEntry(cache, 'a', 10)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('coalesces concurrent loads and releases the request after settlement', async () => {
    const requests = new Map<string, Promise<string>>();
    const load = jest.fn().mockResolvedValue('ok');

    const first = getOrCreateInFlightRequest(requests, 'quote', load);
    const second = getOrCreateInFlightRequest(requests, 'quote', load);

    expect(first).toBe(second);
    await expect(first).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
    expect(requests.size).toBe(0);
  });
});
