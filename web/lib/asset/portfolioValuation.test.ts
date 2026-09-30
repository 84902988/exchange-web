import {describe, expect, it} from '@jest/globals';
import {buildPortfolioValuation} from './portfolioValuation';
import type {AccountBalanceItem} from '../api/modules/assets';

const balances: AccountBalanceItem[] = [
  {account_key: 'funding', symbol: 'USDT', available: '1.92', frozen: '0'},
  {account_key: 'funding', symbol: 'TOKEN', available: '2', frozen: '0'},
  {account_key: 'spot', symbol: 'USDT', available: '0.2', frozen: '0'},
  {account_key: 'spot', symbol: 'TOKEN', available: '90', frozen: '2'},
  {account_key: 'contract', symbol: 'USDT', available: '8.82', frozen: '0'},
];
const tickers = [{symbol: 'TOKENUSDT', last_price: '2', stale: false}];

describe('full portfolio valuation', () => {
  it('includes every currency in all account totals and values frozen quantities', () => {
    const result = buildPortfolioValuation(balances, tickers);
    expect(result.total).toBeCloseTo(198.94);
    expect(result.accounts.get('funding')).toBeCloseTo(5.92);
    expect(result.accounts.get('spot')).toBeCloseTo(184.2);
    expect(result.accounts.get('contract')).toBeCloseTo(8.82);
    expect(result.available).toBeCloseTo(194.94);
    expect(result.frozen).toBeCloseTo(4);
    expect(result.available! + result.frozen!).toBeCloseTo(result.total!);
  });

  it.each([
    [],
    [{...tickers[0], stale: true}],
    [{...tickers[0], stale: undefined}],
    [tickers[0], tickers[0]],
    [{...tickers[0], last_price: 'Infinity'}],
    [{...tickers[0], symbol: 'TOKENBTC'}],
  ].map(quotes => ({quotes})))('does not present partial values as a complete total for invalid quotes %#', ({quotes}) => {
    const result = buildPortfolioValuation(balances, quotes);
    expect(result.total).toBeNull();
    expect(result.accounts.get('funding')).toBeNull();
    expect(result.accounts.get('contract')).toBeCloseTo(8.82);
  });

  it('aggregates duplicate balances and preserves unknown balances', () => {
    expect(buildPortfolioValuation([...balances, balances[1]], tickers).total).toBeCloseTo(202.94);
    expect(buildPortfolioValuation([...balances, {...balances[1], available: ''}], tickers).total).toBeNull();
  });

  it('needs no quote for zero holdings or the USDT anchor', () => {
    const result = buildPortfolioValuation([balances[0], {...balances[1], available: '0'}], []);
    expect(result.total).toBeCloseTo(1.92);
  });
});
