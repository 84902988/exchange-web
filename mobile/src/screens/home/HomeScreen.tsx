import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import SectionTitle from '../../components/common/SectionTitle';
import HomeTopBar from '../../components/home/HomeTopBar';
import HeroBanner from '../../components/home/HeroBanner';
import MarketShortcutGrid from '../../components/home/MarketShortcutGrid';
import PromoStrip from '../../components/home/PromoStrip';
import ServiceLinks from '../../components/home/ServiceLinks';
import AssetSummary from '../../components/home/AssetSummary';
import QuickEntryRow from '../../components/home/QuickEntryRow';
import TabbedMarketList from '../../components/home/TabbedMarketList';
import InfoFeed from '../../components/home/InfoFeed';
import type {RootStackParamList} from '../../navigation/types';
import {isMockLoggedIn} from '../../store/mockAuth';
import {colors} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export default function HomeScreen() {
  const navigation = useNavigation<RootNavigation>();
  const openLogin = () => navigation.navigate('Auth', {screen: 'Login'});
  const openRegister = () => navigation.navigate('Auth', {screen: 'Register'});

  return (
    <AppScreen>
      <HomeTopBar loggedIn={isMockLoggedIn} navigation={navigation} />
      {isMockLoggedIn ? (
        <LoggedInHome />
      ) : (
        <GuestHome onLogin={openLogin} onRegister={openRegister} />
      )}
    </AppScreen>
  );
}

function GuestHome({
  onLogin,
  onRegister,
}: {
  onLogin: () => void;
  onRegister: () => void;
}) {
  return (
    <View>
      <Text style={styles.status}>未登录 · 浏览行情和活动，登录后查看资产与快捷入口</Text>
      <HeroBanner onLogin={onLogin} onRegister={onRegister} />
      <SectionTitle title="市场入口" action="占位跳转" />
      <MarketShortcutGrid />
      <SectionTitle title="活动广告" />
      <PromoStrip />
      <SectionTitle title="公告与服务" />
      <ServiceLinks />
    </View>
  );
}

function LoggedInHome() {
  return (
    <View>
      <AssetSummary />
      <QuickEntryRow />
      <SectionTitle title="市场入口" action="占位跳转" />
      <MarketShortcutGrid />
      <SectionTitle title="活动广告" />
      <PromoStrip />
      <SectionTitle title="行情榜单" action="更多" />
      <TabbedMarketList />
      <SectionTitle title="公告与活动" />
      <InfoFeed />
    </View>
  );
}

const styles = StyleSheet.create({
  status: {
    marginTop: 12,
    color: colors.textSubtle,
    fontSize: 12,
    lineHeight: 18,
  },
});
