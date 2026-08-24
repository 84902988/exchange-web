import {resolveMarketLogoUrl} from '../src/components/markets/MarketLogo';

describe('market logo URL resolution', () => {
  const apiBaseUrl = 'http://10.0.2.2:8000';

  it('resolves a backend-relative product logo against the mobile API origin', () => {
    expect(
      resolveMarketLogoUrl('/static/uploads/assets/mfc.svg', apiBaseUrl),
    ).toBe('http://10.0.2.2:8000/static/uploads/assets/mfc.svg');
  });

  it.each([
    'file:///data/private/logo.svg',
    ['java', 'script:alert(1)'].join(''),
    'http://user:password@example.com/logo.svg',
    'not a url',
  ])('rejects an unsafe product logo URL: %s', value => {
    expect(resolveMarketLogoUrl(value, apiBaseUrl)).toBeNull();
  });
});
