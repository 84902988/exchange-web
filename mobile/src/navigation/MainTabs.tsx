import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import {
  type BottomTabBarButtonProps,
  createBottomTabNavigator,
  type BottomTabNavigationOptions,
} from '@react-navigation/bottom-tabs';
import {
  ArrowLeftRight,
  ChartCandlestick,
  ChartLine,
  Home,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import HomeScreen from '../screens/home/HomeScreen';
import MarketsScreen from '../screens/markets/MarketsScreen';
import TradeScreen from '../screens/trade/TradeScreen';
import ContractScreen from '../screens/contract/ContractScreen';
import AssetsScreen from '../screens/assets/AssetsScreen';
import type {MainTabParamList} from './types';
import {colors, layout, typography} from '../theme';

const Tab = createBottomTabNavigator<MainTabParamList>();
const TAB_ICON_SIZE = 22;

function TabIcon({
  Icon,
  color,
  focused,
}: {
  Icon: LucideIcon;
  color: string;
  focused: boolean;
}) {
  return (
    <View style={styles.icon}>
      <Icon
        color={color}
        size={TAB_ICON_SIZE}
        strokeWidth={focused ? 2.4 : 2}
      />
    </View>
  );
}

function TabBarButton({
  accessibilityLabel,
  accessibilityState,
  children,
  onLongPress,
  onPress,
  style,
  testID,
}: BottomTabBarButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      android_ripple={{color: 'transparent'}}
      onLongPress={onLongPress}
      onPress={onPress}
      style={style}
      testID={testID}>
      {children}
    </Pressable>
  );
}

const homeOptions: BottomTabNavigationOptions = {
  tabBarLabel: '首页',
  tabBarIcon: ({color, focused}) => (
    <TabIcon Icon={Home} color={color} focused={focused} />
  ),
};
const marketsOptions: BottomTabNavigationOptions = {
  tabBarLabel: '行情',
  tabBarIcon: ({color, focused}) => (
    <TabIcon Icon={ChartLine} color={color} focused={focused} />
  ),
};
const tradeOptions: BottomTabNavigationOptions = {
  tabBarLabel: '交易',
  tabBarIcon: ({color, focused}) => (
    <TabIcon Icon={ArrowLeftRight} color={color} focused={focused} />
  ),
};
const contractOptions: BottomTabNavigationOptions = {
  tabBarLabel: '合约',
  tabBarIcon: ({color, focused}) => (
    <TabIcon Icon={ChartCandlestick} color={color} focused={focused} />
  ),
};
const assetsOptions: BottomTabNavigationOptions = {
  tabBarLabel: '资产',
  tabBarIcon: ({color, focused}) => (
    <TabIcon Icon={Wallet} color={color} focused={focused} />
  ),
};

export default function MainTabs() {
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom, layout.tabBarMinBottomInset);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarActiveBackgroundColor: 'transparent',
        tabBarInactiveBackgroundColor: 'transparent',
        tabBarButton: TabBarButton,
        tabBarStyle: [
          styles.tabBar,
          {
            height: layout.tabBarBaseHeight + bottomPadding,
            paddingBottom: bottomPadding,
          },
        ],
        tabBarItemStyle: styles.tabBarItem,
        tabBarIconStyle: styles.tabBarIcon,
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
    backgroundColor: colors.tabBarBackground,
    borderTopColor: colors.tabBarBorder,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 7,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabBarItem: {
    height: 52,
    paddingVertical: 3,
    backgroundColor: 'transparent',
  },
  tabBarIcon: {
    marginTop: 1,
  },
  tabBarLabel: {
    ...typography.medium,
    fontSize: 11,
    marginTop: 1,
    marginBottom: 0,
  },
  icon: {
    width: 26,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
