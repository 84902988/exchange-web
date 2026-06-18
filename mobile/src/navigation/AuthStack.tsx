import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import LoginScreen from '../screens/auth/LoginScreen';
import RegisterScreen from '../screens/auth/RegisterScreen';
import type {AuthStackParamList} from './types';
import {colors} from '../theme';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: {backgroundColor: colors.bg},
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: {backgroundColor: colors.bg},
      }}>
      <Stack.Screen name="Login" component={LoginScreen} options={{title: '登录'}} />
      <Stack.Screen
        name="Register"
        component={RegisterScreen}
        options={{title: '注册'}}
      />
    </Stack.Navigator>
  );
}
