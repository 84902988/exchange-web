import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SITE_LOGO_URL, resolveSiteLogoUrl } from './siteLogo';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

test('legacy and empty site logo values use the optimized PNG asset', () => {
  assert.equal(resolveSiteLogoUrl(null), DEFAULT_SITE_LOGO_URL);
  assert.equal(resolveSiteLogoUrl(''), DEFAULT_SITE_LOGO_URL);
  assert.equal(resolveSiteLogoUrl('/icons/logo-1.svg'), DEFAULT_SITE_LOGO_URL);
  assert.equal(resolveSiteLogoUrl(' https://cdn.example.com/custom-logo.webp '), 'https://cdn.example.com/custom-logo.webp');
});

test('browser icon assets use compatible formats and bounded payloads', () => {
  const favicon32 = statSync(`${webRoot}public/icons/royal-exchange-favicon-32.png`);
  const appleTouch = statSync(`${webRoot}public/icons/royal-exchange-apple-touch-icon.png`);
  const headerLogo = statSync(`${webRoot}public/icons/royal-exchange-logo-256.png`);
  const favicon = readFileSync(`${webRoot}public/favicon.ico`);

  assert.ok(favicon32.size < 10_000);
  assert.ok(appleTouch.size < 100_000);
  assert.ok(headerLogo.size < 200_000);
  assert.equal(favicon.readUInt16LE(0), 0);
  assert.equal(favicon.readUInt16LE(2), 1);
  assert.ok(favicon.length < 20_000);
  assert.ok(favicon.readUInt16LE(4) >= 1);
});
