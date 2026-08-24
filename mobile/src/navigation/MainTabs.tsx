import React from 'react';
import {StyleSheet, useWindowDimensions, View} from 'react-native';
import {
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import HomeScreen from '../screens/home/HomeScreen';
import MarketsScreen from '../screens/markets/MarketsScreen';
import TradeScreen from '../screens/trade/TradeScreen';
import ContractScreen from '../screens/contract/ContractScreen';
import AssetsScreen from '../screens/assets/AssetsScreen';
import ResponsiveTabBarButton from '../components/navigation/ResponsiveTabBarButton';
import {resolveResponsiveLayout} from '../constants/responsiveLayout';
import type { MainTabParamList } from './types';
import {useLanguage} from '../i18n';
import { colors, layout, typography } from '../theme';

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

const homeOptions = (label: string): BottomTabNavigationOptions => ({
  tabBarLabel: label,
  tabBarIcon: ({ color, focused }) => (
    <TabIcon Icon={Home} color={color} focused={focused} />
  ),
});
const marketsOptions = (label: string): BottomTabNavigationOptions => ({
  tabBarLabel: label,
  tabBarIcon: ({ color, focused }) => (
    <TabIcon Icon={ChartLine} color={color} focused={focused} />
  ),
});
const tradeOptions = (label: string): BottomTabNavigationOptions => ({
  tabBarLabel: label,
  tabBarIcon: ({ color, focused }) => (
    <TabIcon Icon={ArrowLeftRight} color={color} focused={focused} />
  ),
});
const contractOptions = (label: string): BottomTabNavigationOptions => ({
  tabBarLabel: label,
  tabBarIcon: ({ color, focused }) => (
    <TabIcon Icon={ChartCandlestick} color={color} focused={focused} />
  ),
});
const assetsOptions = (label: string): BottomTabNavigationOptions => ({
  tabBarLabel: label,
  tabBarIcon: ({ color, focused }) => (
    <TabIcon Icon={Wallet} color={color} focused={focused} />
  ),
});

export default function MainTabs() {
  const insets = useSafeAreaInsets();
  const {fontScale, height, width} = useWindowDimensions();
  const {t} = useLanguage();
  const bottomPadding = Math.max(insets.bottom, layout.tabBarMinBottomInset);
  const responsive = resolveResponsiveLayout(width, height, fontScale);

  return (
    <Tab.Navigator
      detachInactiveScreens
      screenOptions={{
        animation: 'none',
        freezeOnBlur: false,
        headerShown: false,
        lazy: true,
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarActiveBackgroundColor: 'transparent',
        tabBarInactiveBackgroundColor: 'transparent',
        tabBarButton: ResponsiveTabBarButton,
        tabBarStyle: [
          styles.tabBar,
          {
            height: layout.tabBarBaseHeight + bottomPadding,
            paddingBottom: bottomPadding,
            paddingHorizontal: responsive.tabBarHorizontalInset,
          },
        ],
        tabBarItemStyle: styles.tabBarItem,
        tabBarIconStyle: styles.tabBarIcon,
        tabBarLabelStyle: styles.tabBarLabel,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={homeOptions(t('nav.home'))}
      />
      <Tab.Screen
        name="Markets"
        component={MarketsScreen}
        options={marketsOptions(t('nav.markets'))}
      />
      <Tab.Screen
        name="Trade"
        component={TradeScreen}
        options={tradeOptions(t('nav.trade'))}
      />
      <Tab.Screen
        name="Contract"
        component={ContractScreen}
        options={contractOptions(t('nav.contract'))}
      />
      <Tab.Screen
        name="Assets"
        component={AssetsScreen}
        options={assetsOptions(t('nav.assets'))}
      />
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
