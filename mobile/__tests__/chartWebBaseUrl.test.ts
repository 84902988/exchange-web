import {resolveChartWebBaseUrl} from '../src/config/chartWebBaseUrl';

describe('resolveChartWebBaseUrl', () => {
  it('uses the independent development chart origin', () => {
    expect(
      resolveChartWebBaseUrl({
        allowLocalFallback: true,
        requireHttps: false,
      }),
    ).toBe('http://127.0.0.1:3000');
  });

  it('normalizes a configured public HTTPS origin', () => {
    expect(
      resolveChartWebBaseUrl({
        nativeChartWebBaseUrl: ' HTTPS://charts.example.com/ ',
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toBe('https://charts.example.com');
  });

  it('fails closed when a release-like build has no explicit origin', () => {
    expect(() =>
      resolveChartWebBaseUrl({
        nativeChartWebBaseUrl: '',
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow('Mobile chart URL is missing for this build');
  });

  it.each([
    'http://charts.example.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://charts.example.local',
  ])('rejects an unsafe production chart origin: %s', value => {
    expect(() =>
      resolveChartWebBaseUrl({
        nativeChartWebBaseUrl: value,
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow();
  });

  it.each([
    'https://user:secret@charts.example.com',
    'https://charts.example.com/mobile',
    'https://charts.example.com?tenant=a',
    'https://charts.example.com#chart',
  ])('rejects a non-origin chart configuration: %s', value => {
    expect(() =>
      resolveChartWebBaseUrl({
        nativeChartWebBaseUrl: value,
        allowLocalFallback: false,
        requireHttps: true,
      }),
    ).toThrow(
      'Mobile chart URL must be an origin without credentials, path, query, or fragment',
    );
  });
});
