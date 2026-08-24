import React from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
} from 'react-native';
import type {
  MobileContentAction,
  MobileHeroContent,
  MobileRasterImage,
} from '../../api/mobileContent';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import PrimaryButton from '../common/PrimaryButton';

type Props = {
  allowBundledLogo?: boolean;
  hero?: MobileHeroContent | null;
  isLoggedIn?: boolean;
  siteLogo?: MobileRasterImage | null;
  siteName?: string;
  onAction?: (action: MobileContentAction, hero: MobileHeroContent) => void;
  onLogin?: () => void;
  onRegister?: () => void;
};

const brandLogo = require('../../assets/brand/app-logo.png');

export default function HeroBanner({
  allowBundledLogo = true,
  hero = null,
  isLoggedIn = false,
  siteLogo = null,
  siteName,
  onAction,
  onLogin,
  onRegister,
}: Props) {
  const { t } = useLanguage();
  if (hero) {
    const content = (
      <>
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: hero.image.url }}
          style={styles.heroImage}
          resizeMode="cover"
        />
        <View style={styles.heroCopy}>
          {siteLogo ? (
            <Image
              accessibilityIgnoresInvertColors
              source={{ uri: siteLogo.url }}
              style={styles.remoteLogo as ImageStyle}
              resizeMode="contain"
            />
          ) : null}
          {siteName ? (
            <Text style={styles.brandName} numberOfLines={1}>
              {siteName}
            </Text>
          ) : null}
          <Text style={styles.title}>{hero.title}</Text>
          {hero.subtitle ? (
            <Text style={styles.subtitle}>{hero.subtitle}</Text>
          ) : null}
          {hero.action && onAction ? (
            <Text style={styles.detailLabel}>{t('common.viewDetails')}</Text>
          ) : null}
        </View>
      </>
    );

    if (hero.action && onAction) {
      return (
        <Pressable
          accessibilityLabel={`${hero.title}${t('common.a11ySeparator')}${t(
            'common.viewDetails',
          )}`}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          onPress={() => onAction(hero.action!, hero)}
          style={({ pressed }) => [
            styles.hero,
            pressed ? styles.pressed : null,
          ]}
        >
          {content}
        </Pressable>
      );
    }

    return <View style={styles.hero}>{content}</View>;
  }

  return (
    <View
      style={[
        styles.hero,
        styles.neutralHero,
        isLoggedIn ? styles.signedInHero : null,
      ]}
    >
      {siteLogo || allowBundledLogo ? (
        <Image
          accessibilityIgnoresInvertColors
          source={siteLogo ? { uri: siteLogo.url } : brandLogo}
          style={styles.logo as ImageStyle}
          resizeMode="contain"
        />
      ) : null}
      {!isLoggedIn && siteName ? (
        <Text style={styles.brandName} numberOfLines={1}>
          {siteName}
        </Text>
      ) : null}
      <Text style={styles.title}>
        {isLoggedIn
          ? siteName || t('home.accountHome')
          : t('home.loginOrCreate')}
      </Text>
      <Text style={styles.subtitle}>
        {isLoggedIn ? t('home.memberDescription') : t('home.guestDescription')}
      </Text>
      {!isLoggedIn && (onLogin || onRegister) ? (
        <View style={styles.actions}>
          {onLogin ? (
            <View style={styles.actionButton}>
              <PrimaryButton
                title={t('auth.login')}
                variant="secondary"
                onPress={onLogin}
              />
            </View>
          ) : null}
          {onRegister ? (
            <View style={styles.actionButton}>
              <PrimaryButton title={t('auth.register')} onPress={onRegister} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
  hero: {
    marginTop: 16,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.22)',
  },
  neutralHero: {
    minHeight: 238,
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 18,
  },
  signedInHero: {
    minHeight: 0,
    paddingTop: 18,
  },
  heroImage: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: colors.card,
  },
  heroCopy: {
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  logo: {
    width: 68,
    height: 58,
    marginLeft: 4,
    marginBottom: 18,
  },
  remoteLogo: {
    width: 38,
    height: 38,
    marginBottom: 10,
  },
  brandName: {
    ...typography.semibold,
    marginBottom: 8,
    color: colors.primary,
    fontSize: 12,
  },
  title: {
    ...typography.screenTitle,
    color: colors.text,
  },
  subtitle: {
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  detailLabel: {
    ...typography.semibold,
    marginTop: 12,
    color: colors.primary,
    fontSize: 12,
  },
  actions: {
    marginTop: 22,
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
});
