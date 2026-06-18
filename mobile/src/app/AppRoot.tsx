import React from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AppNavigator from '../navigation/AppNavigator';
import {AuthProvider} from '../store/authStore';
import {colors} from '../theme';

export default function AppRoot() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <AppNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
