import React from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {enableFreeze, enableScreens} from 'react-native-screens';
import AppNavigator from '../navigation/AppNavigator';
import {LanguageProvider} from '../i18n';
import {AuthProvider} from '../store/authStore';
import {colors} from '../theme';

enableScreens(true);
enableFreeze(true);

export default function AppRoot() {
  return (
    <SafeAreaProvider>
      <LanguageProvider>
        <AuthProvider>
          <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
          <AppNavigator />
        </AuthProvider>
      </LanguageProvider>
    </SafeAreaProvider>
  );
}
