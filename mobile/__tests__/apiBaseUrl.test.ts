import {resolveApiBaseUrl} from '../src/config/apiBaseUrl';

describe('resolveApiBaseUrl', () => {
  it('uses and normalizes the variant-provided public endpoint', () => {
    expect(
      resolveApiBaseUrl({
        platform: 'android',
        nativeApiBaseUrl: ' HTTPS://api.example.com/mobile/// ',
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toBe('https://api.example.com/mobile');
  });

  it('keeps local development fallbacks platform-specific', () => {
    expect(
      resolveApiBaseUrl({
        platform: 'android',
        allowLocalFallback: true,
        requireHttps: false,
      }),
    ).toBe('http://10.0.2.2:8000');
    expect(
      resolveApiBaseUrl({
        platform: 'ios',
        allowLocalFallback: true,
        requireHttps: false,
      }),
    ).toBe('http://127.0.0.1:8000');
  });

  it('fails closed when a non-development build has no endpoint', () => {
    expect(() =>
      resolveApiBaseUrl({
        platform: 'android',
        nativeApiBaseUrl: '',
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow('Mobile API base URL is missing for this build');
  });

  it('rejects non-HTTP endpoint schemes', () => {
    expect(() =>
      resolveApiBaseUrl({
        platform: 'android',
        nativeApiBaseUrl: 'ws://api.example.com',
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow('Mobile API base URL must use HTTP or HTTPS');
  });

  it('preserves the iOS local fallback only for development builds', () => {
    expect(
      resolveApiBaseUrl({
        platform: 'ios',
        nativeApiBaseUrl: '',
        allowLocalFallback: true,
        requireHttps: false,
      }),
    ).toBe('http://127.0.0.1:8000');
  });

  it.each([
    'http://api.example.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://api.example.local',
  ])('rejects an unsafe production API endpoint: %s', value => {
    expect(() =>
      resolveApiBaseUrl({
        platform: 'ios',
        nativeApiBaseUrl: value,
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow();
  });

  it.each([
    'https://user:secret@api.example.com',
    'https://api.example.com?tenant=a',
    'https://api.example.com#mobile',
  ])('rejects credential-bearing or ambiguous API configuration: %s', value => {
    expect(() =>
      resolveApiBaseUrl({
        platform: 'ios',
        nativeApiBaseUrl: value,
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow(
      'Mobile API base URL must not contain credentials, query, or fragment',
    );
  });
});
