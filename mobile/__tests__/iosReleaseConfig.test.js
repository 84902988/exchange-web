'use strict';

const {
  validateIosReleaseConfig,
} = require('../scripts/validateIosReleaseConfig');

const validConfig = {
  MOBILE_API_BASE_URL: 'https://api.example.com/mobile',
  MOBILE_CHART_WEB_BASE_URL: 'https://charts.example.com',
  PRODUCT_BUNDLE_IDENTIFIER: 'com.example.exchange.mobile',
};

describe('validateIosReleaseConfig', () => {
  it('accepts explicit public HTTPS release configuration', () => {
    expect(() => validateIosReleaseConfig(validConfig)).not.toThrow();
  });

  it.each([
    ['MOBILE_API_BASE_URL', ''],
    ['MOBILE_API_BASE_URL', 'http://api.example.com'],
    ['MOBILE_API_BASE_URL', 'https://127.0.0.1'],
    ['MOBILE_CHART_WEB_BASE_URL', 'https://charts.example.com/mobile'],
    ['PRODUCT_BUNDLE_IDENTIFIER', 'org.reactjs.native.example.ExchangeMobile'],
  ])('fails closed for unsafe %s=%s', (key, value) => {
    expect(() =>
      validateIosReleaseConfig({...validConfig, [key]: value}),
    ).toThrow();
  });
});
