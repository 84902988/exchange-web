import type {AccountBalanceItem} from '../api/modules/assets';
import type {SpotMarketTickerItem} from '../api/modules/spot';

// Match mobile assetSnapshot: USDT-quoted, fresh last prices; missing values
// remain unknown rather than silently reducing the portfolio total.
export function assetPrices(tickers: SpotMarketTickerItem[]) {
  const grouped = new Map<string, SpotMarketTickerItem[]>();
  for (const ticker of tickers) {
    const symbol = ticker.symbol.trim().toUpperCase();
    grouped.set(symbol, [...(grouped.get(symbol) || []), ticker]);
  }
  const prices = new Map<string, number>([['USDT', 1]]);
  for (const [symbol, rows] of grouped) {
    if (!symbol.endsWith('USDT') || rows.length !== 1 || rows[0].stale !== false) continue;
    const raw = rows[0].last_price;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()))) continue;
    const price = Number(raw);
    if (Number.isFinite(price) && price > 0 && symbol !== 'USDTUSDT') prices.set(symbol.slice(0, -4), price);
  }
  return prices;
}

function amount(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(values: Array<number | null>): number | null {
  if (values.some(value => value === null)) return null;
  const total = values.reduce<number>((value, item) => value + (item ?? 0), 0);
  return Number.isFinite(total) ? total : null;
}

function valueOf(quantity: number | null, price: number | undefined) {
  if (quantity === 0) return 0;
  if (quantity === null || price === undefined) return null;
  const value = quantity * price;
  return Number.isFinite(value) ? value : null;
}

export function buildPortfolioValuation(balances: AccountBalanceItem[], tickers: SpotMarketTickerItem[]) {
  const prices = assetPrices(tickers);
  const grouped = new Map<string, {account: string; symbol: string; available: number | null; frozen: number | null}>();
  for (const balance of balances) {
    const account = balance.account_key.trim().toLowerCase();
    const symbol = balance.symbol.trim().toUpperCase();
    const key = `${account}:${symbol}`;
    const previous = grouped.get(key);
    grouped.set(key, {account, symbol,
      available: sum([previous?.available ?? (previous ? null : 0), amount(balance.available)]),
      frozen: sum([previous?.frozen ?? (previous ? null : 0), amount(balance.frozen)]),
    });
  }
  const rows = [...grouped.values()].map(row => ({...row,
    total: valueOf(sum([row.available, row.frozen]), prices.get(row.symbol)),
    available: valueOf(row.available, prices.get(row.symbol)),
    frozen: valueOf(row.frozen, prices.get(row.symbol)),
  }));
  const accounts = new Map<string, number | null>();
  for (const account of new Set(rows.map(row => row.account))) {
    accounts.set(account, sum(rows.filter(row => row.account === account).map(row => row.total)));
  }
  return {accounts, total: sum(rows.map(row => row.total)),
    available: sum(rows.map(row => row.available)), frozen: sum(rows.map(row => row.frozen))};
}
