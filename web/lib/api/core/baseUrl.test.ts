import { describe, expect, test } from '@jest/globals';
import { resolveRuntimeHttpApiBaseUrl } from './baseUrl';

describe('runtime HTTP API routing', () => {
  test('reuses the frontend cpolar connection through the existing API rewrite', () => {
    expect(resolveRuntimeHttpApiBaseUrl({
      host: 'sample-hook.cpolar.io',
      origin: 'https://sample-hook.cpolar.io',
      apiBaseUrl: 'https://sample-api.cpolar.io',
    })).toBe('https://sample-hook.cpolar.io/api');
  });

  test('keeps direct API routing outside the cpolar frontend tunnel', () => {
    expect(resolveRuntimeHttpApiBaseUrl({
      host: 'exchange.example.com',
      origin: 'https://exchange.example.com',
      apiBaseUrl: 'https://api.example.com',
    })).toBe('https://api.example.com');
  });
});
