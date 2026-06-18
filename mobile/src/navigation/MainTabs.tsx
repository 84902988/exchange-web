import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {
  createBottomTabNavigator,
  type BottomTabNavigationOptions,
} from '@react-navigation/bottom-tabs';
import HomeScreen from '../screens/home/HomeScreen';
import MarketsScreen from '../screens/markets/MarketsScreen';
import TradeScreen from '../screens/trade/TradeScreen';
import ContractScreen from '../screens/contract/ContractScreen';
import AssetsScreen from '../screens/assets/AssetsScreen';
import type {MainTabParamList} from './types';
import {colors, typography} from '../theme';

const Tab = createBottomTabNavigator<MainTabParamList>();

function TabIcon({mark, focused}: {mark: string; focused: boolean}) {
  return (
    <View style={[styles.icon, focused ? styles.iconFocused : null]}>
      <Text style={[styles.iconText, focused ? styles.iconTextFocused : null]}>
        {mark}
      </Text>
    </View>
  );
}

const homeOptions: BottomTabNavigationOptions = {
  tabBarLabel: '首页',
  tabBarIcon: ({focused}) => <TabIcon mark="H" focused={focused} />,
};
const marketsOptions: BottomTabNavigationOptions = {
  tabBarLabel: '行情',
  tabBarIcon: ({focused}) => <TabIcon mark="M" focused={focused} />,
};
const tradeOptions: BottomTabNavigationOptions = {
  tabBarLabel: '交易',
  tabBarIcon: ({focused}) => <TabIcon mark="T" focused={focused} />,
};
const contractOptions: BottomTabNavigationOptions = {
  tabBarLabel: '合约',
  tabBarIcon: ({focused}) => <TabIcon mark="C" focused={focused} />,
};
const assetsOptions: BottomTabNavigationOptions = {
  tabBarLabel: '资产',
  tabBarIcon: ({focused}) => <TabIcon mark="A" focused={focused} />,
};

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSubtle,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabBarLabel,
      }}>
      <Tab.Screen name="Home" component={HomeScreen} options={homeOptions} />
      <Tab.Screen
        name="Markets"
        component={MarketsScreen}
        options={marketsOptions}
      />
      <Tab.Screen name="Trade" component={TradeScreen} options={tradeOptions} />
      <Tab.Screen
        name="Contract"
        component={ContractScreen}
        options={contractOptions}
      />
      <Tab.Screen name="Assets" component={AssetsScreen} options={assetsOptions} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.bgElevated,
    borderTopColor: colors.line,
    height: 68,
    paddingTop: 6,
    paddingBottom: 10,
  },
  tabBarLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  icon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconFocused: {
    backgroundColor: colors.primarySoft,
  },
  iconText: {
    ...typography.number,
    color: colors.textSubtle,
    fontSize: 12,
    fontWeight: '800',
  },
  iconTextFocused: {
    color: colors.primary,
  },
});
