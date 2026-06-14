type PriceListener = (price: number) => void;

class PriceSimulator {
  private timers: Map<string, any> = new Map();
  private prices: Map<string, number> = new Map();
  private listeners: Map<string, Set<PriceListener>> = new Map();

  start(symbol: string, basePrice = 3000) {
    if (this.timers.has(symbol)) return;

    this.prices.set(symbol, basePrice);
    this.listeners.set(symbol, new Set());

    const timer = setInterval(() => {
      const last = this.prices.get(symbol)!;
      const delta = (Math.random() - 0.5) * 5; // 1 秒跳价
      const next = Math.max(0.1, +(last + delta).toFixed(2));

      this.prices.set(symbol, next);
      this.listeners.get(symbol)!.forEach(cb => cb(next));
    }, 1000);

    this.timers.set(symbol, timer);
  }

  stop(symbol: string) {
    if (this.timers.has(symbol)) {
      clearInterval(this.timers.get(symbol));
      this.timers.delete(symbol);
    }
  }

  subscribe(symbol: string, cb: PriceListener) {
    if (!this.listeners.has(symbol)) {
      this.start(symbol);
    }
    this.listeners.get(symbol)!.add(cb);

    return () => {
      this.listeners.get(symbol)?.delete(cb);
    };
  }

  getPrice(symbol: string) {
    return this.prices.get(symbol);
  }
}

export const priceSimulator = new PriceSimulator();
