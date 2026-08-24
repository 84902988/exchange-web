import {BoundedStoreCache} from '../src/realtime/boundedStoreCache';

function entry(retained = false) {
  return {
    destroy: jest.fn(),
    isRetained: jest.fn(() => retained),
  };
}

describe('BoundedStoreCache', () => {
  it('evicts the least recently used inactive entry', () => {
    const cache = new BoundedStoreCache<string, ReturnType<typeof entry>>(2);
    const first = entry();
    const second = entry();
    const third = entry();

    cache.getOrCreate('first', () => first);
    cache.getOrCreate('second', () => second);
    cache.getOrCreate('first', () => entry());
    cache.getOrCreate('third', () => third);

    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(third.destroy).not.toHaveBeenCalled();
    expect(cache.sizeForTests()).toBe(2);
  });

  it('never evicts retained entries and permits a temporary soft overflow', () => {
    const cache = new BoundedStoreCache<string, ReturnType<typeof entry>>(1);
    const active = entry(true);
    const current = entry();

    cache.getOrCreate('active', () => active);
    cache.getOrCreate('current', () => current);

    expect(active.destroy).not.toHaveBeenCalled();
    expect(current.destroy).not.toHaveBeenCalled();
    expect(cache.sizeForTests()).toBe(2);
  });

  it('destroys every entry when cleared', () => {
    const cache = new BoundedStoreCache<string, ReturnType<typeof entry>>(2);
    const first = entry(true);
    const second = entry();

    cache.getOrCreate('first', () => first);
    cache.getOrCreate('second', () => second);
    cache.clear();

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(cache.sizeForTests()).toBe(0);
  });
});
