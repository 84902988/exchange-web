import React, { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  useNavigation,
  type CompositeNavigationProp,
} from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CreditCard, Crown, Gift, Handshake, UserPlus } from 'lucide-react-native';
import type {
  MobileAnnouncementSummary,
  MobileContentAction,
  MobileContentSnapshot,
} from '../../api/mobileContent';
import { getOverviewMarkets, type MarketInstrument } from '../../api/market';
import AppScreen from '../../components/common/AppScreen';
import SectionTitle from '../../components/common/SectionTitle';
import AssetSummary from '../../components/home/AssetSummary';
import HomeAboutEntry from '../../components/home/HomeAboutEntry';
import HomeActivityEntry from '../../components/home/HomeActivityEntry';
import HeroBanner from '../../components/home/HeroBanner';
import HomeNewsFeed from '../../components/home/HomeNewsFeed';
import HomeNoticeService from '../../components/home/HomeNoticeService';
import HomePromoCarousel from '../../components/home/HomePromoCarousel';
import HomeTopBar from '../../components/home/HomeTopBar';
import MarketShortcutGrid from '../../components/home/MarketShortcutGrid';
import QuickEntryRow, {
  type QuickEntryItem,
} from '../../components/home/QuickEntryRow';
import TabbedMarketList from '../../components/home/TabbedMarketList';
import { useAssetSnapshot } from '../../hooks/useAssetSnapshot';
import { useMobileHomeData } from '../../hooks/useMobileHomeData';
import { useMobileMessageUnreadCounts } from '../../hooks/useMobileMessageUnreadCounts';
import {
  type PreloadableMainTab,
  usePreloadMainTabs,
} from '../../hooks/usePreloadMainTabs';
import { reportAppFullyDrawn } from '../../config/env';
import {
  createTranslator,
  defaultLocale,
  useLanguage,
  type Translator,
} from '../../i18n';
import type {
  MainTabParamList,
  RootStackParamList,
} from '../../navigation/types';
import { useAuth } from '../../store/authStore';
import type { AssetSnapshot } from '../../services/assetSnapshot';
import { colors, typography } from '../../theme';

export type HomeNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Home'>,
  NativeStackNavigationProp<RootStackParamList>
>;

export default function HomeScreen() {
  const navigation = useNavigation<HomeNavigation>();
  const {locale, t} = useLanguage();
  const { isLoggedIn, loading: authLoading, user } = useAuth();
  const {
    content,
    markets,
    contentLoading,
    marketsLoading,
    contentError,
    marketsError,
  } = useMobileHomeData(locale);
  const { hasUnread: hasUnreadMessages } =
    useMobileMessageUnreadCounts(isLoggedIn);
  const visibleMarkets = useMemo(
    () => markets.filter(item => item.category !== 'onchain'),
    [markets],
  );
  const marketShortcuts = useMemo(
    () =>
      getOverviewMarkets(
        visibleMarkets,
        content?.homeConfig.marketShortcutSymbols,
      ),
    [content?.homeConfig.marketShortcutSymbols, visibleMarkets],
  );
  const memberEntries = useMemo(
    () => createLoggedInServiceEntries(navigation, t),
    [navigation, t],
  );
  const preloadMainTab = useCallback(
    (route: PreloadableMainTab) => {
      if (typeof navigation.preload === 'function') {
        navigation.preload(route);
      }
    },
    [navigation],
  );
  usePreloadMainTabs(preloadMainTab);

  useEffect(() => {
    if (!authLoading && !contentLoading && !marketsLoading) {
      reportAppFullyDrawn();
    }
  }, [authLoading, contentLoading, marketsLoading]);

  const openLogin = useCallback(
    () => navigation.navigate('Auth', { screen: 'Login' }),
    [navigation],
  );
  const openRegister = useCallback(
    () => navigation.navigate('Auth', { screen: 'Register' }),
    [navigation],
  );
  const openProfile = useCallback(() => {
    if (isLoggedIn) {
      navigation.navigate('Account');
      return;
    }
    openLogin();
  }, [isLoggedIn, navigation, openLogin]);
  const openSearch = useCallback(
    () => navigation.navigate('Markets'),
    [navigation],
  );
  const openContentAction = useCallback(
    (action: MobileContentAction) =>
      navigateMobileContentAction(navigation, action),
    [navigation],
  );
  const openMarket = useCallback(
    (item: MarketInstrument) => navigateHomeMarket(navigation, item),
    [navigation],
  );
  const openAnnouncement = useCallback(
    (announcement: MobileAnnouncementSummary) => {
      navigation.navigate('MobileAnnouncementDetail', {
        announcementId: announcement.id,
        title: announcement.title,
      });
    },
    [navigation],
  );
  const openAnnouncementCenter = useCallback(() => {
    navigation.navigate('AnnouncementCenter');
  }, [navigation]);
  const openSupport = useCallback(() => {
    navigation.navigate('HelpCenter');
  }, [navigation]);
  const openNotifications = useCallback(() => {
    navigation.navigate('HomeMessageCenter', {
      initialTab: 'announcements',
    });
  }, [navigation]);
  const openActivityCenter = useCallback(() => {
    navigation.navigate('ActivityCenter');
  }, [navigation]);
  const openAboutPage = useCallback(() => {
    navigation.navigate('AboutPage');
  }, [navigation]);
  const openLanguageSettings = useCallback(() => {
    navigation.navigate('LanguageSettings');
  }, [navigation]);

  return (
    <AppScreen contentWidth="dashboard">
      <HomeTopBar
        isLoggedIn={isLoggedIn}
        user={user}
        userLabel={getUserLabel(user)}
        onPressProfile={openProfile}
        onPressSearch={openSearch}
        onPressLanguage={openLanguageSettings}
        onPressSupport={openSupport}
        onPressNotifications={openNotifications}
        hasUnreadNotifications={hasUnreadMessages}
      />
      {authLoading ? (
        <Text style={styles.status}>{t('home.restoringSession')}</Text>
      ) : null}
      {contentLoading && !content ? (
        <Text style={styles.status}>{t('home.loadingContent')}</Text>
      ) : null}
      {marketsLoading && markets.length === 0 ? (
        <Text style={styles.status}>{t('home.loadingMarkets')}</Text>
      ) : null}
      {contentError && !content ? (
        <Text style={styles.error}>{t('home.contentUnavailable')}</Text>
      ) : null}
      {marketsError && markets.length === 0 ? (
        <Text style={styles.error}>{t('home.marketsUnavailable')}</Text>
      ) : null}

      {isLoggedIn ? (
        <LoggedInHome
          content={content}
          marketShortcuts={marketShortcuts}
          markets={visibleMarkets}
          onAbout={openAboutPage}
          onAction={openContentAction}
          onActivityCenter={openActivityCenter}
          onAnnouncement={openAnnouncement}
          onAnnouncementCenter={openAnnouncementCenter}
          onMarket={openMarket}
          memberEntries={memberEntries}
        />
      ) : (
        <GuestHome
          content={content}
          markets={marketShortcuts}
          onAbout={openAboutPage}
          onAction={openContentAction}
          onActivityCenter={openActivityCenter}
          onAnnouncement={openAnnouncement}
          onAnnouncementCenter={openAnnouncementCenter}
          onLogin={openLogin}
          onMarket={openMarket}
          onRegister={openRegister}
        />
      )}
    </AppScreen>
  );
}

export function navigateMobileContentAction(
  navigation: HomeNavigation,
  action: MobileContentAction | { type?: unknown; route?: unknown },
) {
  if (action.type !== 'ROUTE') {
    return;
  }
  switch (action.route) {
    case 'LOGIN':
      navigation.navigate('Auth', { screen: 'Login' });
      return;
    case 'REGISTER':
      navigation.navigate('Auth', { screen: 'Register' });
      return;
    case 'MARKETS':
      navigation.navigate('Markets');
      return;
    case 'SPOT':
      navigation.navigate('Trade');
      return;
    case 'CONTRACT':
      navigation.navigate('Contract');
      return;
    case 'ASSETS':
      navigation.navigate('Assets');
      return;
  }
}

export function navigateHomeMarket(
  navigation: HomeNavigation,
  item: MarketInstrument,
) {
  if (item.category === 'onchain') {
    return;
  }
  navigation.navigate('Markets', { category: item.category });
}

export function createLoggedInServiceEntries(
  navigation: HomeNavigation,
  t: Translator = createTranslator(defaultLocale),
): QuickEntryItem[] {
  return [
    {
      id: 'invite',
      title: t('home.invite'),
      description: t('home.inviteDescription'),
      Icon: UserPlus,
      onPress: () => navigation.navigate('Assets', { section: 'invite' }),
    },
    {
      id: 'agent',
      title: t('home.agent'),
      description: t('home.agentDescription'),
      Icon: Handshake,
      onPress: () => navigation.navigate('Assets', { section: 'bd' }),
    },
    {
      id: 'vip',
      title: t('home.vip'),
      description: t('home.vipDescription'),
      Icon: Crown,
      onPress: () => navigation.navigate('VipCenter'),
    },
    {
      id: 'blackCard',
      title: t('home.blackCard'),
      description: t('home.blackCardDescription'),
      Icon: CreditCard,
      onPress: () => navigation.navigate('BlackCard'),
    },
    {
      id: 'rewards',
      title: t('home.rewards'),
      description: t('home.rewardsDescription'),
      Icon: Gift,
      onPress: () =>
        navigation.navigate('AssetHistory', { initialFilter: 'inviteReward' }),
    },
  ];
}

function getUserLabel(user: ReturnType<typeof useAuth>['user']) {
  const label = [
    user?.profile?.nickname,
    user?.profile?.username,
    user?.email,
    user?.phone,
  ].find(value => typeof value === 'string' && value.trim());
  return label?.trim() || '';
}

type HomeContentProps = {
  content: MobileContentSnapshot | null;
  markets: MarketInstrument[];
  onAbout: () => void;
  onAction: (action: MobileContentAction) => void;
  onActivityCenter: () => void;
  onAnnouncement: (announcement: MobileAnnouncementSummary) => void;
  onAnnouncementCenter: () => void;
  onMarket: (item: MarketInstrument) => void;
};

function GuestHome({
  content,
  markets,
  onAbout,
  onAction,
  onActivityCenter,
  onAnnouncement,
  onAnnouncementCenter,
  onLogin,
  onMarket,
  onRegister,
}: HomeContentProps & {
  onLogin: () => void;
  onRegister: () => void;
}) {
  const {t} = useLanguage();
  return (
    <View>
      <HeroBanner
        allowBundledLogo={!content}
        hero={content?.hero}
        onAction={onAction}
        onLogin={onLogin}
        onRegister={onRegister}
        siteLogo={content?.site.logo}
        siteName={content?.site.displayName}
      />
      <HomeActivityEntry onPress={onActivityCenter} />
      {content?.homeConfig.sections.marketShortcuts !== false ? (
        <MarketContent
          limit={content?.homeConfig.marketShortcutLimit ?? 4}
          markets={markets}
          onMarket={onMarket}
          shortcutOnly
        />
      ) : null}
      {content?.homeConfig.sections.promos && content.promos.length > 0 ? (
        <>
          <SectionTitle title={t('home.activity')} />
          <HomePromoCarousel promos={content.promos} onAction={onAction} />
        </>
      ) : null}
      {content?.homeConfig.sections.announcements &&
      content.announcements.length > 0 ? (
        <>
          <SectionTitle
            title={t('home.announcements')}
            action={t('common.viewAll')}
            onActionPress={onAnnouncementCenter}
          />
          <HomeNoticeService
            announcements={content.announcements}
            onPressAnnouncement={onAnnouncement}
          />
        </>
      ) : null}
      <HomeAboutEntry onPress={onAbout} />
    </View>
  );
}

function LoggedInHome({
  content,
  marketShortcuts,
  markets,
  onAbout,
  onAction,
  onActivityCenter,
  onAnnouncement,
  onAnnouncementCenter,
  onMarket,
  memberEntries,
}: HomeContentProps & {
  marketShortcuts: MarketInstrument[];
  memberEntries: QuickEntryItem[];
}) {
  const {t} = useLanguage();
  const {
    snapshot: assetSnapshot,
    loading: holdingsLoading,
    error: holdingsError,
  } = useAssetSnapshot();
  const holdingSymbols = useMemo(
    () => getHomeHoldingSymbols(assetSnapshot),
    [assetSnapshot],
  );
  return (
    <View>
      {content?.homeConfig.sections.assetSummary !== false ? (
        <AssetSummary />
      ) : null}
      {content?.homeConfig.sections.quickEntries !== false ? (
        <QuickEntryRow entries={memberEntries} />
      ) : null}
      <HomeActivityEntry onPress={onActivityCenter} />
      {content?.homeConfig.sections.marketShortcuts !== false &&
      marketShortcuts.length > 0 ? (
        <>
          <SectionTitle title={t('home.marketOverview')} />
          <MarketShortcutGrid
            items={marketShortcuts.slice(
              0,
              content?.homeConfig.marketShortcutLimit ?? 4,
            )}
            onPress={onMarket}
          />
        </>
      ) : null}
      {content?.homeConfig.sections.promos && content.promos.length > 0 ? (
        <>
          <SectionTitle title={t('home.activity')} />
          <HomePromoCarousel promos={content.promos} onAction={onAction} />
        </>
      ) : null}
      {content?.homeConfig.sections.marketShortcuts !== false &&
      markets.length > 0 ? (
        <>
          <SectionTitle title={t('home.marketRankings')} />
          <TabbedMarketList
            holdingSymbols={holdingSymbols}
            holdingsLoading={holdingsLoading && !assetSnapshot}
            holdingsUnavailable={Boolean(holdingsError && !assetSnapshot)}
            items={markets}
            onPress={onMarket}
          />
        </>
      ) : null}
      {content?.homeConfig.sections.announcements &&
      content.announcements.length > 0 ? (
        <>
          <SectionTitle
            title={t('home.announcements')}
            action={t('common.viewAll')}
            onActionPress={onAnnouncementCenter}
          />
          <HomeNewsFeed
            announcements={content.announcements}
            onPressAnnouncement={onAnnouncement}
          />
        </>
      ) : null}
      <HomeAboutEntry onPress={onAbout} />
    </View>
  );
}

export function getHomeHoldingSymbols(snapshot: AssetSnapshot | null) {
  if (!snapshot) return [];
  const values = new Map<string, number | null>();
  snapshot.rows.forEach(row => {
    if (row.totalAmount === null || row.totalAmount <= 0) return;
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) return;
    const current = values.get(symbol);
    if (row.valueUsdt === null) {
      if (!values.has(symbol)) values.set(symbol, null);
      return;
    }
    values.set(symbol, (current ?? 0) + row.valueUsdt);
  });
  return Array.from(values.entries())
    .sort(([leftSymbol, leftValue], [rightSymbol, rightValue]) => {
      if (leftValue !== null && rightValue !== null) {
        const valueOrder = rightValue - leftValue;
        if (valueOrder !== 0) return valueOrder;
      } else if (leftValue !== null) {
        return -1;
      } else if (rightValue !== null) {
        return 1;
      }
      return leftSymbol.localeCompare(rightSymbol);
    })
    .map(([symbol]) => symbol);
}

function MarketContent({
  limit,
  markets,
  onMarket,
  shortcutOnly = false,
}: {
  limit: number;
  markets: MarketInstrument[];
  onMarket: (item: MarketInstrument) => void;
  shortcutOnly?: boolean;
}) {
  const {t} = useLanguage();
  if (markets.length === 0) {
    return null;
  }

  return (
    <>
      <SectionTitle title={t('home.marketQuotes')} />
      <MarketShortcutGrid items={markets.slice(0, limit)} onPress={onMarket} />
      {!shortcutOnly ? (
        <>
          <SectionTitle title={t('home.marketRankings')} />
          <TabbedMarketList items={markets} onPress={onMarket} />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  status: {
    ...typography.regular,
    marginTop: 12,
    color: colors.textSubtle,
    fontSize: 12,
    lineHeight: 18,
  },
  error: {
    ...typography.regular,
    marginTop: 10,
    color: colors.red,
    fontSize: 12,
    lineHeight: 18,
  },
});
