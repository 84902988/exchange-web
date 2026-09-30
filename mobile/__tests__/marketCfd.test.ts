import {resolveCfdGroup} from '../src/utils/marketCfd';

test.each([
  ['GOLD', 'metals'], ['METAL', 'metals'], ['COMMODITY', 'commodities'],
  ['FUTURES', 'commodities'], ['FOREX', 'forex'], ['INDEX', 'indices'],
  [' forex ', 'forex'], ['UNKNOWN', 'other'], [undefined, 'other'],
])('maps server category %s to %s', (category, expected) => {
  expect(resolveCfdGroup(category)).toBe(expected);
});
