import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Coins,
  FileCheck2,
  History,
  ShieldCheck,
  UserRoundPen,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import UserAvatar, {
  getUserAvatarLabel,
} from '../../components/common/UserAvatar';
import {
  ActionCard,
  ActionHeader,
  AuthRequiredCard,
  CopyIconButton,
  InfoRow,
  InlineNotice,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage, type Translator } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList, 'Account'>;

export default function AccountScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { t } = useLanguage();
  const { error: authError, isLoggedIn, loading, logout, user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const mountedRef = useRef(true);
  const logoutLockRef = useRef(false);
  const logoutConfirmationOpenRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      logoutConfirmationOpenRef.current = false;
    };
  }, []);

  const openLogin = useCallback(
    () => navigation.navigate('Auth', { screen: 'Login' }),
    [navigation],
  );

  const openLegalPage = useCallback(
    (pageKey: 'terms' | 'privacy') =>
      navigation.navigate('LegalPage', { pageKey }),
    [navigation],
  );

  const confirmLogout = useCallback(() => {
    if (
      loggingOut ||
      loading ||
      logoutLockRef.current ||
      logoutConfirmationOpenRef.current
    ) {
      return;
    }
    logoutConfirmationOpenRef.current = true;
    Alert.alert(
      t('account.logoutTitle'),
      t('account.logoutDescription'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => {
            logoutConfirmationOpenRef.current = false;
          },
        },
        {
          text: t('account.logoutConfirm'),
          style: 'destructive',
          onPress: async () => {
            logoutConfirmationOpenRef.current = false;
            if (logoutLockRef.current) return;
            logoutLockRef.current = true;
            setLoggingOut(true);
            try {
              await logout();
              if (mountedRef.current && navigation.canGoBack()) {
                navigation.goBack();
              }
            } finally {
              logoutLockRef.current = false;
              if (mountedRef.current) setLoggingOut(false);
            }
          },
        },
      ],
      {
        onDismiss: () => {
          logoutConfirmationOpenRef.current = false;
        },
      },
    );
  }, [loading, loggingOut, logout, navigation, t]);

  const displayName =
    user?.profile?.nickname?.trim() ||
    user?.profile?.username?.trim() ||
    user?.email?.trim() ||
    user?.phone?.trim() ||
    t('account.loggedInAccount');

  return (
    <AppScreen>
      <ActionHeader
        title={t('account.title')}
        subtitle={t('account.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
      />

      {!isLoggedIn || !user ? (
        <AuthRequiredCard
          actionTitle={t('auth.goLogin')}
          description={t('auth.requiredAccountDescription')}
          onLoginPress={openLogin}
          title={t('auth.requiredTitle')}
        />
      ) : (
        <>
          <ActionCard>
            <View style={styles.identityRow}>
              <UserAvatar displayName={displayName} size={48} user={user} />
              <View style={styles.identityText}>
                <Text maxFontSizeMultiplier={1.3} style={styles.name}>
                  {displayName}
                </Text>
                <Text maxFontSizeMultiplier={1.3} style={styles.status}>
                  UID {String(user.id)} ·{' '}
                  {formatAccountKycStatus(user.kyc_status, user.kyc_level, t)}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={t('account.editProfile')}
                accessibilityRole="button"
                android_ripple={{ color: 'rgba(212, 175, 55, 0.14)' }}
                onPress={() => navigation.navigate('ProfileEdit')}
                style={({ pressed }) => [
                  styles.editButton,
                  pressed ? styles.pressed : null,
                ]}
              >
                <UserRoundPen color={colors.gold} size={17} />
                <Text style={styles.editButtonText}>{t('account.edit')}</Text>
              </Pressable>
            </View>
            <View style={styles.infoBlock}>
              {user.email ? (
                <InfoRow label={t('account.email')} value={user.email} />
              ) : null}
              {user.phone ? (
                <InfoRow label={t('account.phone')} value={user.phone} />
              ) : null}
              <InfoRow label={t('account.id')} value={String(user.id)} />
              {user.created_at ? (
                <InfoRow
                  label={t('account.registeredAt')}
                  value={formatAccountDate(user.created_at)}
                />
              ) : null}
            </View>
          </ActionCard>

          {user.invite_code ? (
            <ActionCard>
              <Text style={styles.sectionTitle}>{t('account.inviteCode')}</Text>
              <View style={styles.inviteRow}>
                <Text style={styles.inviteCode}>{user.invite_code}</Text>
                <CopyIconButton
                  accessibilityLabel={t('common.copy')}
                  text={user.invite_code}
                  onCopied={() => setCopied(true)}
                />
              </View>
              {copied ? (
                <InlineNotice tone="green">
                  {t('account.inviteCopied')}
                </InlineNotice>
              ) : null}
            </ActionCard>
          ) : null}

          <ActionCard>
            <Text style={styles.sectionTitle}>
              {t('account.identitySecurity')}
            </Text>
            <Pressable
              accessibilityLabel={t('account.openSecurity')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              onPress={() => navigation.navigate('AccountSecurity')}
              style={({ pressed }) => [
                styles.serviceRow,
                pressed ? styles.pressed : null,
              ]}
            >
              <View style={styles.serviceIcon}>
                <ShieldCheck color={colors.green} size={19} />
              </View>
              <View style={styles.serviceText}>
                <Text style={styles.serviceTitle}>{t('account.security')}</Text>
                <Text style={styles.serviceDescription}>
                  {t('account.securityDescription')}
                </Text>
              </View>
              <Text style={styles.legalArrow}>›</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={t('account.openKyc')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              onPress={() => navigation.navigate('Kyc')}
              style={({ pressed }) => [
                styles.serviceRow,
                pressed ? styles.pressed : null,
              ]}
            >
              <View style={styles.serviceIcon}>
                <FileCheck2 color={colors.gold} size={19} />
              </View>
              <View style={styles.serviceText}>
                <Text style={styles.serviceTitle}>{t('account.kyc')}</Text>
                <Text style={styles.serviceDescription}>
                  {t('account.kycDescription')}
                </Text>
              </View>
              <View style={styles.serviceRight}>
                <Text style={styles.kycStatus}>
                  {formatAccountKycStatus(user.kyc_status, user.kyc_level, t)}
                </Text>
                <Text style={styles.legalArrow}>›</Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityLabel={t('account.openLoginActivity')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              onPress={() => navigation.navigate('LoginActivity')}
              style={({ pressed }) => [
                styles.serviceRow,
                pressed ? styles.pressed : null,
              ]}
            >
              <View style={styles.serviceIcon}>
                <History color={colors.blue} size={19} />
              </View>
              <View style={styles.serviceText}>
                <Text style={styles.serviceTitle}>
                  {t('account.loginActivity')}
                </Text>
                <Text style={styles.serviceDescription}>
                  {t('account.loginActivityDescription')}
                </Text>
              </View>
              <Text style={styles.legalArrow}>›</Text>
            </Pressable>
          </ActionCard>

          <ActionCard>
            <Text style={styles.sectionTitle}>
              {t('account.benefitsRecords')}
            </Text>
            <Pressable
              accessibilityLabel={t('account.openDividends')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              onPress={() => navigation.navigate('DividendCenter')}
              style={({ pressed }) => [
                styles.serviceRow,
                pressed ? styles.pressed : null,
              ]}
            >
              <View style={styles.serviceIcon}>
                <Coins color={colors.gold} size={19} />
              </View>
              <View style={styles.serviceText}>
                <Text style={styles.serviceTitle}>
                  {t('account.dividends')}
                </Text>
                <Text style={styles.serviceDescription}>
                  {t('account.dividendsDescription')}
                </Text>
              </View>
              <Text style={styles.legalArrow}>›</Text>
            </Pressable>
          </ActionCard>

          {authError ? (
            <InlineNotice tone="red">
              {t('account.statusUnavailable')}
            </InlineNotice>
          ) : null}

          <Pressable
            accessibilityLabel={t('account.logout')}
            accessibilityRole="button"
            accessibilityState={{ disabled: loggingOut || loading }}
            android_ripple={{ color: 'rgba(240, 90, 90, 0.14)' }}
            disabled={loggingOut || loading}
            onPress={confirmLogout}
            style={({ pressed }) => [
              styles.logoutButton,
              loggingOut || loading ? styles.disabled : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text maxFontSizeMultiplier={1.3} style={styles.logoutText}>
              {loggingOut ? t('account.loggingOut') : t('account.logout')}
            </Text>
          </Pressable>
        </>
      )}

      <ActionCard>
        <Text maxFontSizeMultiplier={1.3} style={styles.sectionTitle}>
          {t('account.legalPrivacy')}
        </Text>
        <View style={styles.legalLinks}>
          <Pressable
            accessibilityLabel={t('account.viewTerms')}
            accessibilityRole="link"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            onPress={() => openLegalPage('terms')}
            style={({ pressed }) => [
              styles.legalButton,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.legalButtonText}>{t('account.terms')}</Text>
            <Text style={styles.legalArrow}>›</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={t('account.viewPrivacy')}
            accessibilityRole="link"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            onPress={() => openLegalPage('privacy')}
            style={({ pressed }) => [
              styles.legalButton,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.legalButtonText}>{t('account.privacy')}</Text>
            <Text style={styles.legalArrow}>›</Text>
          </Pressable>
        </View>
      </ActionCard>
    </AppScreen>
  );
}

export function getAvatarLabel(value: string) {
  return getUserAvatarLabel(value);
}

export function formatAccountDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatAccountKycStatus(
  status: string | null | undefined,
  level: number | undefined,
  t?: Translator,
) {
  const normalized = String(status || '')
    .trim()
    .toUpperCase();
  if (normalized === 'PENDING') return t?.('account.kycPending') || '审核中';
  if (normalized === 'REJECTED') return t?.('account.kycRejected') || '需重提';
  if (normalized === 'APPROVED' || (level || 0) > 0)
    return t?.('account.kycApproved') || '已认证';
  return t?.('account.kycUnverified') || '未认证';
}

const styles = StyleSheet.create({
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  identityText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...typography.bold,
    color: colors.text,
    fontSize: 17,
  },
  status: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 12,
  },
  editButton: {
    minWidth: 68,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.32)',
    backgroundColor: colors.goldSoft,
  },
  editButtonText: { ...typography.bold, color: colors.gold, fontSize: 11 },
  infoBlock: {
    marginTop: 14,
  },
  sectionTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
  },
  serviceRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  serviceIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
  },
  serviceText: {
    flex: 1,
    minWidth: 0,
  },
  serviceTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  serviceDescription: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  serviceRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  kycStatus: {
    ...typography.medium,
    color: colors.gold,
    fontSize: 12,
  },
  legalLinks: {
    marginTop: 8,
  },
  legalButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  legalButtonText: {
    ...typography.medium,
    color: colors.text,
    fontSize: 14,
  },
  legalArrow: {
    color: colors.textSubtle,
    fontSize: 24,
  },
  inviteRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 10,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
  },
  inviteCode: {
    ...typography.identifier,
    flex: 1,
    color: colors.gold,
    fontSize: 15,
  },
  logoutButton: {
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(240,90,90,0.42)',
    backgroundColor: 'rgba(240,90,90,0.1)',
  },
  logoutText: {
    ...typography.bold,
    color: colors.red,
    fontSize: 14,
  },
  disabled: {
    opacity: 0.55,
  },
  pressed: {
    opacity: 0.78,
    transform: [{ scale: 0.99 }],
  },
});
