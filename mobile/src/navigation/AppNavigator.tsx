import React from 'react';
import {Dimensions, Platform, useWindowDimensions} from 'react-native';
import {
  DarkTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import SplashScreen from '../screens/SplashScreen';
import AuthStack from './AuthStack';
import MainTabs from './MainTabs';
import AssetHistoryScreen from '../screens/assets/AssetHistoryScreen';
import DepositScreen from '../screens/assets/DepositScreen';
import TransferScreen from '../screens/assets/TransferScreen';
import WithdrawScreen from '../screens/assets/WithdrawScreen';
import UserTransferScreen from '../screens/assets/UserTransferScreen';
import StockTokenCenterScreen from '../screens/assets/StockTokenCenterScreen';
import UserTransferRecordsScreen from '../screens/assets/UserTransferRecordsScreen';
import MobileAnnouncementDetailScreen from '../screens/home/MobileAnnouncementDetailScreen';
import AnnouncementCenterScreen from '../screens/home/AnnouncementCenterScreen';
import HomeMessageCenterScreen from '../screens/home/HomeMessageCenterScreen';
import SupportTicketCreateScreen from '../screens/home/SupportTicketCreateScreen';
import SupportTicketDetailScreen from '../screens/home/SupportTicketDetailScreen';
import VipCenterScreen from '../screens/home/VipCenterScreen';
import BlackCardScreen from '../screens/home/BlackCardScreen';
import RcbLockScreen from '../screens/home/RcbLockScreen';
import MarketDetailScreen from '../screens/market/MarketDetailScreen';
import AccountScreen from '../screens/account/AccountScreen';
import AccountSecurityScreen from '../screens/account/AccountSecurityScreen';
import EmailSecurityScreen from '../screens/account/EmailSecurityScreen';
import ChangePasswordScreen from '../screens/account/ChangePasswordScreen';
import LoginActivityScreen from '../screens/account/LoginActivityScreen';
import SessionManagementScreen from '../screens/account/SessionManagementScreen';
import SecurityEventsScreen from '../screens/account/SecurityEventsScreen';
import ProfileEditScreen from '../screens/account/ProfileEditScreen';
import KycScreen from '../screens/account/KycScreen';
import DividendCenterScreen from '../screens/account/DividendCenterScreen';
import LegalPageScreen from '../screens/legal/LegalPageScreen';
import ActivityCenterScreen from '../screens/home/ActivityCenterScreen';
import ActivityDetailScreen from '../screens/home/ActivityDetailScreen';
import HelpCenterScreen from '../screens/home/HelpCenterScreen';
import HelpArticleScreen from '../screens/home/HelpArticleScreen';
import AboutPageScreen from '../screens/home/AboutPageScreen';
import LanguageSettingsScreen from '../screens/settings/LanguageSettingsScreen';
import type { RootStackParamList } from './types';
import {resolveAppOrientation} from '../constants/responsiveLayout';
import { colors } from '../theme';

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
  useWindowDimensions();
  const screen = Dimensions.get('screen');
  const appOrientation = resolveAppOrientation({
    isPad: Platform.OS === 'ios' && Platform.isPad,
    screenHeight: screen.height,
    screenWidth: screen.width,
  });

  return (
    <NavigationContainer theme={appTheme}>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerShown: false,
          orientation: appOrientation,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="Splash" component={SplashScreen} />
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="AssetDeposit" component={DepositScreen} />
        <Stack.Screen name="AssetWithdraw" component={WithdrawScreen} />
        <Stack.Screen name="AssetUserTransfer" component={UserTransferScreen} />
        <Stack.Screen name="AssetTransfer" component={TransferScreen} />
        <Stack.Screen
          name="UserTransferRecords"
          component={UserTransferRecordsScreen}
        />
        <Stack.Screen name="AssetHistory" component={AssetHistoryScreen} />
        <Stack.Screen
          name="StockTokenCenter"
          component={StockTokenCenterScreen}
        />
        <Stack.Screen name="Account" component={AccountScreen} />
        <Stack.Screen name="ProfileEdit" component={ProfileEditScreen} />
        <Stack.Screen
          name="AccountSecurity"
          component={AccountSecurityScreen}
        />
        <Stack.Screen name="EmailSecurity" component={EmailSecurityScreen} />
        <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} />
        <Stack.Screen name="LoginActivity" component={LoginActivityScreen} />
        <Stack.Screen name="SecurityEvents" component={SecurityEventsScreen} />
        <Stack.Screen
          name="SessionManagement"
          component={SessionManagementScreen}
        />
        <Stack.Screen name="Kyc" component={KycScreen} />
        <Stack.Screen name="DividendCenter" component={DividendCenterScreen} />
        <Stack.Screen name="LegalPage" component={LegalPageScreen} />
        <Stack.Screen
          name="MarketDetail"
          component={MarketDetailScreen}
          options={{
            animation: 'slide_from_right',
            gestureEnabled: true,
            orientation: 'portrait_up',
          }}
        />
        <Stack.Screen
          name="MobileAnnouncementDetail"
          component={MobileAnnouncementDetailScreen}
        />
        <Stack.Screen
          name="AnnouncementCenter"
          component={AnnouncementCenterScreen}
        />
        <Stack.Screen name="ActivityCenter" component={ActivityCenterScreen} />
        <Stack.Screen name="ActivityDetail" component={ActivityDetailScreen} />
        <Stack.Screen name="HelpCenter" component={HelpCenterScreen} />
        <Stack.Screen name="HelpArticle" component={HelpArticleScreen} />
        <Stack.Screen name="AboutPage" component={AboutPageScreen} />
        <Stack.Screen
          name="LanguageSettings"
          component={LanguageSettingsScreen}
        />
        <Stack.Screen
          name="HomeMessageCenter"
          component={HomeMessageCenterScreen}
        />
        <Stack.Screen
          name="SupportTicketCreate"
          component={SupportTicketCreateScreen}
        />
        <Stack.Screen
          name="SupportTicketDetail"
          component={SupportTicketDetailScreen}
        />
        <Stack.Screen name="VipCenter" component={VipCenterScreen} />
        <Stack.Screen name="BlackCard" component={BlackCardScreen} />
        <Stack.Screen name="RcbLock" component={RcbLockScreen} />
        <Stack.Screen
          name="Auth"
          component={AuthStack}
          options={{ presentation: 'modal' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
