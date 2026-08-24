import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import LoginScreen from '../screens/auth/LoginScreen';
import RegisterScreen from '../screens/auth/RegisterScreen';
import ResetPasswordScreen from '../screens/auth/ResetPasswordScreen';
import type {AuthStackParamList} from './types';
import {useLanguage} from '../i18n';
import {colors} from '../theme';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthStack() {
  const {t} = useLanguage();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: {backgroundColor: colors.bg},
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: {backgroundColor: colors.bg},
      }}>
      <Stack.Screen
        name="Login"
        component={LoginScreen}
        options={{title: t('auth.login')}}
      />
      <Stack.Screen
        name="Register"
        component={RegisterScreen}
        options={{title: t('auth.register')}}
      />
      <Stack.Screen
        name="ResetPassword"
        component={ResetPasswordScreen}
        options={{title: t('auth.resetPassword')}}
      />
    </Stack.Navigator>
  );
}
