import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Pressable, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
  normalizeMobileLocale,
  supportedLocales,
  useLanguage,
} from '../src/i18n';

function Probe() {
  const {locale, ready, setLocale, t} = useLanguage();
  return (
    <>
      <Text testID="locale">{locale}</Text>
      <Text testID="ready">{String(ready)}</Text>
      <Text testID="home-label">{t('nav.home')}</Text>
      <Pressable
        accessibilityLabel="switch-to-english"
        onPress={() => setLocale('en')}
      />
    </>
  );
}

function textByTestId(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findByProps({testID}).props.children;
}

describe('mobile i18n foundation', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('normalizes the supported server, PC and device locale variants', () => {
    expect(supportedLocales.map(item => item.locale)).toEqual([
      'zh-CN',
      'zh-TW',
      'en',
      'ja',
    ]);
    expect(normalizeMobileLocale('zh')).toBe('zh-CN');
    expect(normalizeMobileLocale('zh_Hant')).toBe('zh-TW');
    expect(normalizeMobileLocale('en-US')).toBe('en');
    expect(normalizeMobileLocale('ja-JP')).toBe('ja');
    expect(normalizeMobileLocale('unsupported')).toBe('zh-CN');

    expect(createTranslator('zh-CN')('nav.home')).toBe('首页');
    expect(createTranslator('zh-TW')('nav.home')).toBe('首頁');
    expect(createTranslator('en')('nav.home')).toBe('Home');
    expect(createTranslator('ja')('nav.home')).toBe('ホーム');
    expect(createTranslator('en')('auth.welcomeBack')).toBe('Welcome back');
    expect(createTranslator('ja')('announcement.title')).toBe(
      '運営からのお知らせ',
    );
    expect(
      createTranslator('zh-TW')('activity.countSummary', {count: 3}),
    ).toBe('共 3 項活動，進入詳情查看完整規則');
    expect(createTranslator('en')('security.sessions')).toBe(
      'Devices and sessions',
    );
    expect(createTranslator('ja')('password.change')).toBe(
      'パスワードを変更',
    );
    expect(createTranslator('zh-CN')('assets.distribution')).toBe('账户分布');
    expect(createTranslator('zh-TW')('assets.quick.history')).toBe('資金流水');
    expect(createTranslator('en')('history.title')).toBe('Asset history');
    expect(createTranslator('ja')('invite.statusPaid')).toBe('支払済み');
    expect(
      createTranslator('en')('assets.missingPrices', { symbols: 'BTC' }),
    ).toBe(
      'Valid USDT prices are missing for BTC, so the complete total is hidden.',
    );
  });

  it('switches immediately, persists the choice and restores it on remount', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <Probe />
        </LanguageProvider>,
      );
    });

    expect(textByTestId(renderer, 'ready')).toBe('true');
    expect(textByTestId(renderer, 'locale')).toBe('zh-CN');
    expect(textByTestId(renderer, 'home-label')).toBe('首页');

    await act(async () => {
      await renderer.root
        .findByProps({accessibilityLabel: 'switch-to-english'})
        .props.onPress();
    });

    expect(textByTestId(renderer, 'locale')).toBe('en');
    expect(textByTestId(renderer, 'home-label')).toBe('Home');
    await expect(AsyncStorage.getItem(MOBILE_LOCALE_STORAGE_KEY)).resolves.toBe(
      'en',
    );

    act(() => renderer.unmount());
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <Probe />
        </LanguageProvider>,
      );
    });
    expect(textByTestId(renderer, 'locale')).toBe('en');
    expect(textByTestId(renderer, 'home-label')).toBe('Home');
    act(() => renderer.unmount());
  });
});
