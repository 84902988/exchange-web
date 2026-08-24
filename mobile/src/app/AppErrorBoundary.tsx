import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
  defaultLocale,
  isMobileLocale,
  type MobileLocale,
} from '../i18n';

type Props = { children: ReactNode };
type State = { failed: boolean; retryKey: number; locale: MobileLocale };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, retryKey: 0, locale: defaultLocale };
  private mounted = true;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Keep credentials, request payloads, and component state out of local
    // production logs. A future crash reporter can receive a scrubbed event.
    AsyncStorage.getItem(MOBILE_LOCALE_STORAGE_KEY)
      .then(locale => {
        if (
          this.mounted &&
          isMobileLocale(locale) &&
          locale !== this.state.locale
        ) {
          this.setState({ locale });
        }
      })
      .catch(() => undefined);
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  private retry = () => {
    this.setState(previous => ({
      failed: false,
      retryKey: previous.retryKey + 1,
    }));
  };

  render() {
    if (!this.state.failed) {
      return (
        <React.Fragment key={this.state.retryKey}>
          {this.props.children}
        </React.Fragment>
      );
    }

    const t = createTranslator(this.state.locale);

    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.screen} testID="app-error-fallback">
          <StatusBar barStyle="light-content" backgroundColor="#050608" />
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {t('appShell.errorTitle')}
            </Text>
            <Text style={styles.body}>{t('appShell.errorBody')}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('appShell.retryA11y')}
              android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
              onPress={this.retry}
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
              ]}
              testID="app-error-retry"
            >
              <Text style={styles.buttonText}>{t('appShell.retry')}</Text>
            </Pressable>
            <Text style={styles.hint}>{t('appShell.errorHint')}</Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#050608',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#30343B',
    borderRadius: 18,
    backgroundColor: '#13161B',
    paddingHorizontal: 22,
    paddingVertical: 24,
  },
  title: {
    color: '#F4F6F8',
    fontSize: 22,
    fontWeight: '700',
  },
  body: {
    color: '#AAB2BD',
    fontSize: 15,
    lineHeight: 23,
    marginTop: 12,
  },
  button: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#E1B12C',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
  },
  buttonPressed: { opacity: 0.82 },
  buttonText: {
    color: '#080A0D',
    fontSize: 16,
    fontWeight: '700',
  },
  hint: {
    color: '#747E8A',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 14,
  },
});
