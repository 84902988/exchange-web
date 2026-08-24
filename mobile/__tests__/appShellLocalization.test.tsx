import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {type ReactNode} from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import UserAvatar, {
  getUserAvatarLabel,
} from '../src/components/common/UserAvatar';
import SearchBar from '../src/components/common/SearchBar';
import {
  appShellEn,
  appShellJa,
  appShellZhCN,
  appShellZhTW,
} from '../src/i18n/appShellCatalog';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  useLanguage,
} from '../src/i18n';

describe('app shell localization', () => {
  it('keeps every app-shell key explicit in all four languages', () => {
    const expectedKeys = Object.keys(appShellZhCN).sort();
    expect(expectedKeys).toHaveLength(8);
    expect(Object.keys(appShellZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(appShellEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(appShellJa).sort()).toEqual(expectedKeys);
    expect(getUserAvatarLabel('')).toBe('账');
  });

  it('renders the English avatar fallback and accessibility label', async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <Ready>
            <>
              <UserAvatar />
              <SearchBar />
            </>
          </Ready>
        </LanguageProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({accessibilityLabel: 'User avatar'}),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({accessibilityLabel: 'Search markets'}),
    ).toBeTruthy();
    expect(
      renderer.root
        .findAllByType(Text)
        .some(node => node.props.children === 'AC'),
    ).toBe(true);
    act(() => renderer.unmount());
  });
});

function Ready({children}: {children: ReactNode}) {
  const {ready} = useLanguage();
  return ready ? <>{children}</> : null;
}
