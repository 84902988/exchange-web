import { describe, expect, test } from '@jest/globals';
import { resolveRuntimeHttpApiBaseUrl } from './baseUrl';

describe('runtime HTTP API routing', () => {
  test('reuses the frontend cpolar connection through the existing API rewrite', () => {
    expect(resolveRuntimeHttpApiBaseUrl({
      host: 'moralis-hook.cpolar.io',
      origin: 'https://moralis-hook.cpolar.io',
      apiBaseUrl: 'https://moralis-api.cpolar.io',
    })).toBe('https://moralis-hook.cpolar.io/api');
  });

  test('keeps direct API routing outside the cpolar frontend tunnel', () => {
    expect(resolveRuntimeHttpApiBaseUrl({
      host: 'exchange.example.com',
      origin: 'https://exchange.example.com',
      apiBaseUrl: 'https://api.example.com',
    })).toBe('https://api.example.com');
  });
});
