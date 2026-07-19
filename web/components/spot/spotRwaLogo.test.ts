import { describe, expect, it } from '@jest/globals';
import { renderSpotTradingViewLogo, resolveSpotRwaLogo } from './spotRwaLogo';

describe('resolveSpotRwaLogo', () => {
  const candidate = {
    symbol: 'MFCUSDT',
    showSpotLogo: true,
    spotLogoUrl: ' /uploads/mfc.webp ',
    spotLogoAlt: ' MFC ',
    marketCategory: 'RWA',
  };

  it('returns configured logo metadata for the active RWA symbol', () => {
    expect(resolveSpotRwaLogo(candidate, 'mfc-usdt')).toEqual({
      url: '/uploads/mfc.webp',
      alt: 'MFC',
    });
  });

  it.each([
    [{ ...candidate, showSpotLogo: false }, 'MFCUSDT'],
    [{ ...candidate, spotLogoUrl: '' }, 'MFCUSDT'],
    [{ ...candidate, marketCategory: 'CRYPTO' }, 'MFCUSDT'],
    [candidate, 'BTCUSDT'],
  ])('fails closed when the pair is not eligible', (value, symbol) => {
    expect(resolveSpotRwaLogo(value, symbol)).toBeNull();
  });

  it('accepts RWA ownership from any supported category field', () => {
    expect(resolveSpotRwaLogo({
      ...candidate,
      marketCategory: null,
      displayCategory: 'rwa',
    }, 'MFCUSDT')).toEqual({ url: '/uploads/mfc.webp', alt: 'MFC' });
  });
});

describe('renderSpotTradingViewLogo', () => {
  it('renders the current logo and uses a deterministic fallback alt', () => {
    const slot = document.createElement('div');
    let currentUrl = '/uploads/mfc.webp';
    const image = renderSpotTradingViewLogo(slot, {
      url: currentUrl,
      displayName: 'MFC/USDT',
      getCurrentUrl: () => currentUrl,
    });

    expect(slot.style.display).toBe('inline-flex');
    expect(image?.getAttribute('src')).toBe('/uploads/mfc.webp');
    expect(image?.alt).toBe('MFC/USDT logo');
    currentUrl = '';
  });

  it('does not let a detached stale image hide the replacement logo', () => {
    const slot = document.createElement('div');
    let currentUrl = '/uploads/old.webp';
    const oldImage = renderSpotTradingViewLogo(slot, {
      url: currentUrl,
      displayName: 'MFC/USDT',
      getCurrentUrl: () => currentUrl,
    });

    currentUrl = '/uploads/new.webp';
    const newImage = renderSpotTradingViewLogo(slot, {
      url: currentUrl,
      displayName: 'MFC/USDT',
      getCurrentUrl: () => currentUrl,
    });
    oldImage?.dispatchEvent(new Event('error'));

    expect(slot.style.display).toBe('inline-flex');
    expect(slot.firstChild).toBe(newImage);

    newImage?.dispatchEvent(new Event('error'));
    expect(slot.style.display).toBe('none');
  });

  it('clears the slot when no logo is available', () => {
    const slot = document.createElement('div');
    slot.appendChild(document.createElement('img'));

    expect(renderSpotTradingViewLogo(slot, {
      url: null,
      displayName: 'MFC/USDT',
      getCurrentUrl: () => '',
    })).toBeNull();
    expect(slot.childElementCount).toBe(0);
    expect(slot.style.display).toBe('none');
  });
});
