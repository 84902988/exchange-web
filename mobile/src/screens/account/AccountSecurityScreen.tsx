import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  FileCheck2,
  History,
  KeyRound,
  MailCheck,
  MonitorSmartphone,
  ScrollText,
  ShieldCheck,
} from 'lucide-react-native';
import {
  ActionCard,
  ActionHeader,
  InfoRow,
  InlineNotice,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

type EntryProps = {
  label: string;
  description: string;
  icon: React.ReactNode;
  status?: string;
  onPress: () => void;
};

function SecurityEntry({
  label,
  description,
  icon,
  status,
  onPress,
}: EntryProps) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('security.openA11y', { label })}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.entry, pressed ? styles.pressed : null]}
    >
      <View style={styles.entryIcon}>{icon}</View>
      <View style={styles.entryText}>
        <Text style={styles.entryTitle}>{label}</Text>
        <Text style={styles.entryDescription}>{description}</Text>
      </View>
      {status ? <Text style={styles.entryStatus}>{status}</Text> : null}
      <Text style={styles.arrow}>›</Text>
    </Pressable>
  );
}

export function getAccountSecurityProgress(
  emailVerified: boolean,
  kycVerified: boolean,
) {
  const total = 3;
  const completed = 1 + Number(emailVerified) + Number(kycVerified);
  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
  };
}

export default function AccountSecurityScreen({
  navigation,
}: {
  navigation: any;
}) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const emailVerified = Boolean(user?.email_verified_at);
  const kycVerified =
    String(user?.kyc_status || '').toUpperCase() === 'APPROVED' ||
    (user?.kyc_level || 0) > 0;
  const { completed, total, percent } = getAccountSecurityProgress(
    emailVerified,
    kycVerified,
  );

  return (
    <AppScreen>
      <ActionHeader
        title={t('security.title')}
        subtitle={t('security.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
      />
      <ActionCard style={styles.scoreCard}>
        <View style={styles.scoreTop}>
          <View>
            <Text style={styles.scoreLabel}>{t('security.basicItems')}</Text>
            <Text style={styles.scoreValue}>
              {t('security.completed', { completed, total })}
            </Text>
          </View>
          <View style={styles.scoreBadge}>
            <ShieldCheck color={colors.green} size={22} />
            <Text style={styles.scorePercent}>{percent}%</Text>
          </View>
        </View>
        <View style={styles.track}>
          <View style={[styles.progress, { width: `${percent}%` }]} />
        </View>
        <View style={styles.summaryRows}>
          <InfoRow
            label={t('security.passwordProtection')}
            value={t('security.set')}
            tone="green"
          />
          <InfoRow
            label={t('security.emailVerification')}
            value={
              emailVerified ? t('security.verified') : t('security.notVerified')
            }
            tone={emailVerified ? 'green' : 'gold'}
          />
          <InfoRow
            label={t('security.identityVerification')}
            value={
              kycVerified ? t('security.certified') : t('security.notCertified')
            }
            tone={kycVerified ? 'green' : 'gold'}
          />
        </View>
      </ActionCard>

      <ActionCard>
        <Text style={styles.sectionTitle}>{t('security.actions')}</Text>
        <SecurityEntry
          label={t('security.changePassword')}
          description={t('security.changePasswordDescription')}
          icon={<KeyRound color={colors.gold} size={19} />}
          onPress={() => navigation.navigate('ChangePassword')}
        />
        <SecurityEntry
          label={t('account.loginActivity')}
          description={t('security.loginActivityDescription')}
          icon={<History color={colors.blue} size={19} />}
          onPress={() => navigation.navigate('LoginActivity')}
        />
        <SecurityEntry
          label={t('security.events')}
          description={t('security.eventsDescription')}
          icon={<ScrollText color={colors.blue} size={19} />}
          onPress={() => navigation.navigate('SecurityEvents')}
        />
        <SecurityEntry
          label={t('security.sessions')}
          description={t('security.sessionsDescription')}
          icon={<MonitorSmartphone color={colors.gold} size={19} />}
          onPress={() => navigation.navigate('SessionManagement')}
        />
        <SecurityEntry
          label={t('security.loginEmail')}
          description={t('security.loginEmailDescription')}
          icon={
            <MailCheck
              color={emailVerified ? colors.green : colors.gold}
              size={19}
            />
          }
          status={
            emailVerified ? t('security.verified') : t('security.verifyNow')
          }
          onPress={() => navigation.navigate('EmailSecurity')}
        />
        <SecurityEntry
          label={t('security.identityVerification')}
          description={t('security.kycDescription')}
          icon={<FileCheck2 color={colors.green} size={19} />}
          status={
            kycVerified ? t('security.certified') : t('security.certifyNow')
          }
          onPress={() => navigation.navigate('Kyc')}
        />
      </ActionCard>

      <ActionCard>
        <Text style={styles.sectionTitle}>
          {t('security.accountVerification')}
        </Text>
        <View style={styles.verifyRow}>
          <MailCheck
            color={emailVerified ? colors.green : colors.textMuted}
            size={19}
          />
          <View style={styles.verifyText}>
            <Text style={styles.verifyTitle}>{t('security.loginEmail')}</Text>
            <Text style={styles.verifyValue}>
              {user?.email || t('common.notBound')}
            </Text>
          </View>
          <Text style={emailVerified ? styles.verified : styles.unverified}>
            {emailVerified ? t('security.verified') : t('security.notVerified')}
          </Text>
        </View>
      </ActionCard>
      <InlineNotice>{t('security.emailChangeNotice')}</InlineNotice>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  scoreCard: { padding: 16 },
  scoreTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scoreLabel: { color: colors.textMuted, fontSize: 12 },
  scoreValue: {
    ...typography.bold,
    marginTop: 5,
    color: colors.text,
    fontSize: 20,
  },
  scoreBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(25,195,125,0.1)',
  },
  scorePercent: { ...typography.bold, color: colors.green, fontSize: 13 },
  track: {
    height: 6,
    marginTop: 16,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.cardAlt,
  },
  progress: { height: 6, borderRadius: 3, backgroundColor: colors.green },
  summaryRows: { marginTop: 12 },
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  entry: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  entryIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
  },
  entryText: { flex: 1, minWidth: 0 },
  entryTitle: { ...typography.bold, color: colors.text, fontSize: 14 },
  entryDescription: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  entryStatus: { ...typography.medium, color: colors.gold, fontSize: 11 },
  arrow: { color: colors.textSubtle, fontSize: 23 },
  verifyRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  verifyText: { flex: 1, minWidth: 0 },
  verifyTitle: { ...typography.medium, color: colors.text, fontSize: 13 },
  verifyValue: { marginTop: 3, color: colors.textMuted, fontSize: 11 },
  verified: { ...typography.bold, color: colors.green, fontSize: 11 },
  unverified: { ...typography.bold, color: colors.gold, fontSize: 11 },
});
