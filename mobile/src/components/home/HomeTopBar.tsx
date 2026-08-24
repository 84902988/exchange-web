import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Bell, CircleUserRound, Headphones } from 'lucide-react-native';
import type { MeOut } from '../../api/auth';
import { useLanguage } from '../../i18n';
import { colors } from '../../theme';
import IconButton from '../common/IconButton';
import SearchBar from '../common/SearchBar';
import UserAvatar from '../common/UserAvatar';
import HeaderLanguageIcon from './HeaderLanguageIcon';

type Props = {
  isLoggedIn: boolean;
  user?: MeOut | null;
  userLabel?: string;
  onPressProfile?: () => void;
  onPressSearch?: () => void;
  onPressSupport?: () => void;
  onPressNotifications?: () => void;
  onPressLanguage?: () => void;
  hasUnreadNotifications?: boolean;
};

export default function HomeTopBar({
  isLoggedIn,
  user,
  userLabel,
  onPressProfile,
  onPressSearch,
  onPressSupport,
  onPressNotifications,
  onPressLanguage,
  hasUnreadNotifications = false,
}: Props) {
  const { t } = useLanguage();
  return (
    <View style={styles.row}>
      {onPressProfile && isLoggedIn ? (
        <Pressable
          accessibilityLabel={t('home.userEntry')}
          accessibilityRole="button"
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          hitSlop={6}
          onPress={onPressProfile}
          style={({ pressed }) => [
            styles.profileButton,
            pressed ? styles.pressed : null,
          ]}
        >
          <UserAvatar displayName={userLabel} user={user} />
        </Pressable>
      ) : onPressProfile ? (
        <IconButton
          accessibilityLabel={t('home.userEntry')}
          icon={CircleUserRound}
          onPress={onPressProfile}
        />
      ) : (
        <View style={styles.passiveIcon}>
          <CircleUserRound color={colors.text} size={21} strokeWidth={2.2} />
        </View>
      )}
      <SearchBar placeholder={t('home.searchMarket')} onPress={onPressSearch} />
      {onPressLanguage ? (
        <IconButton
          accessibilityLabel={t('home.languageSettings')}
          icon={HeaderLanguageIcon}
          onPress={onPressLanguage}
        />
      ) : null}
      {onPressSupport ? (
        <IconButton
          accessibilityLabel={t('home.supportCenter')}
          icon={Headphones}
          onPress={onPressSupport}
        />
      ) : null}
      {isLoggedIn && onPressNotifications ? (
        <IconButton
          accessibilityLabel={t('home.notifications')}
          badge={hasUnreadNotifications}
          icon={Bell}
          onPress={onPressNotifications}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 4,
  },
  passiveIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
});
