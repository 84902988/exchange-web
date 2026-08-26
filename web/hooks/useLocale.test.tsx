import { act, renderHook, waitFor } from '@testing-library/react';

import useLocale from './useLocale';

describe('useLocale', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('initializes with the synchronous English fallback', async () => {
    const { result } = renderHook(() => useLocale());

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    expect(result.current.locale).toBe('en');
    expect(result.current.t('login')).toBe('Login');
    expect(result.current.isLoading).toBe(false);
  });

  it('loads only the stored locale without rewriting initialization storage', async () => {
    window.localStorage.setItem('language', 'zh');
    const { result } = renderHook(() => useLocale());

    await waitFor(() => expect(result.current.locale).toBe('zh'));

    expect(result.current.isInitialized).toBe(true);
    expect(result.current.t('login')).toBe('登录');
    expect(window.localStorage.getItem('language')).toBe('zh');
    expect(window.localStorage.getItem('locale')).toBeNull();
  });

  it('dynamically switches locale through the legacy language event', async () => {
    const { result } = renderHook(() => useLocale());
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      window.dispatchEvent(new CustomEvent('languageChanged', { detail: 'ja' }));
    });
    await waitFor(() => expect(result.current.locale).toBe('ja'));

    expect(result.current.t('trade')).toBe('取引');
    expect(window.localStorage.getItem('language')).toBe('ja');
    expect(window.localStorage.getItem('locale')).toBe('ja');
  });

  it('normalizes unsupported stored locale values back to English', async () => {
    window.localStorage.setItem('language', 'fr');
    const { result } = renderHook(() => useLocale());

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    expect(result.current.locale).toBe('en');
    expect(result.current.t('trade')).toBe('Trade');
    expect(window.localStorage.getItem('language')).toBe('fr');
    expect(window.localStorage.getItem('locale')).toBeNull();
  });

  it('initializes the mobile chart locale without waiting for a full locale bundle', async () => {
    window.localStorage.setItem('language', 'ja');
    window.history.replaceState(
      {},
      '',
      '/mobile/advanced-chart?market=spot&symbol=BTCUSDT&lang=zh-CN',
    );
    const { result } = renderHook(() => useLocale());

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    expect(result.current.locale).toBe('zh');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.t('spotChartLoadFailed', 'asset')).toBe('K线加载失败');
    expect(window.localStorage.getItem('language')).toBe('ja');
    expect(window.localStorage.getItem('locale')).toBeNull();
  });
});
