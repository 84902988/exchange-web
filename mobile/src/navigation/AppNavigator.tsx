import React from 'react';
import {
  DarkTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import SplashScreen from '../screens/SplashScreen';
import AuthStack from './AuthStack';
import MainTabs from './MainTabs';
import type {RootStackParamList} from './types';
import {colors} from '../theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

const appTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bgElevated,
    primary: colors.primary,
    text: colors.text,
    border: colors.line,
    notification: colors.red,
  },
};

export default function AppNavigator() {
  return (
    <NavigationContainer theme={appTheme}>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerShown: false,
          contentStyle: {backgroundColor: colors.bg},
        }}>
        <Stack.Screen name="Splash" component={SplashScreen} />
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen
          name="Auth"
          component={AuthStack}
          options={{presentation: 'modal'}}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
