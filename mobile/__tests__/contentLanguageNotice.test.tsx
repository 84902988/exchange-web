import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import ContentLanguageNotice from '../src/components/common/ContentLanguageNotice';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
} from '../src/i18n';

function visibleText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}

describe('ContentLanguageNotice', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
  });

  it('only reports a fallback when the server confirms a different locale', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <ContentLanguageNotice responseLocale="zh-CN" />
        </LanguageProvider>,
      );
    });
    expect(visibleText(renderer)).toContain(
      'No content is available in your selected language.',
    );
    expect(visibleText(renderer)).toContain('简体中文');

    await act(async () => {
      renderer.update(
        <LanguageProvider>
          <ContentLanguageNotice responseLocale="en-US" />
        </LanguageProvider>,
      );
    });
    expect(visibleText(renderer)).toBe('');
    act(() => renderer.unmount());
  });

  it('stays silent when an endpoint does not expose a supported response locale', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <ContentLanguageNotice responseLocale={null} />
        </LanguageProvider>,
      );
    });
    expect(visibleText(renderer)).toBe('');
    act(() => renderer.unmount());
  });
});
