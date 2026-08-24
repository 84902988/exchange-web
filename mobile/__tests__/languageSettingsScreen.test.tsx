import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
} from '../src/i18n';
import type {RootStackParamList} from '../src/navigation/types';
import LanguageSettingsScreen from '../src/screens/settings/LanguageSettingsScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'LanguageSettings'>;

function textValues(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node =>
      typeof node.props.children === 'string' ? [node.props.children] : [],
    );
}

describe('LanguageSettingsScreen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('exposes all four choices and updates the screen language immediately', async () => {
    const navigation = {goBack: jest.fn()} as unknown as Props['navigation'];
    const route = {
      key: 'language-settings',
      name: 'LanguageSettings',
    } as Props['route'];
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <LanguageSettingsScreen navigation={navigation} route={route} />
        </LanguageProvider>,
      );
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining(['语言设置', '简体中文', '繁體中文', 'English', '日本語']),
    );
    expect(
      renderer.root.findByProps({accessibilityLabel: '简体中文, 当前使用'})
        .props.accessibilityState,
    ).toEqual({checked: true});

    await act(async () => {
      await renderer.root.findByProps({accessibilityLabel: 'English'}).props
        .onPress();
    });

    expect(textValues(renderer)).toEqual(
      expect.arrayContaining(['Language', 'Choose a language', 'Platform content']),
    );
    expect(
      renderer.root.findByProps({accessibilityLabel: 'English, Current'}).props
        .accessibilityState,
    ).toEqual({checked: true});
    expect(
      renderer.root.findByProps({accessibilityLabel: 'Back'}),
    ).toBeTruthy();
    await expect(AsyncStorage.getItem(MOBILE_LOCALE_STORAGE_KEY)).resolves.toBe(
      'en',
    );

    act(() => renderer.unmount());
  });
});
