import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  BadgeCheck,
  BriefcaseBusiness,
  CircleCheck,
  Clock3,
  Share2,
  ShieldCheck,
  UsersRound,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import type {
  AssetBdApplication,
  AssetBdOverview,
  CreateAssetBdApplicationInput,
} from '../../api/assets';
import { CHART_WEB_BASE_URL } from '../../config/env';
import { useLanguage, type TranslationKey } from '../../i18n';
import { colors, typography } from '../../theme';
import { normalizeNonNegativeDecimalText } from '../../utils/decimalText';
import {
  buildInviteRegistrationLink,
  buildInviteShareMessage,
} from '../../utils/inviteLink';
import { CopyIconButton } from './action/ActionPrimitives';
import AssetAccountHero from './AssetAccountHero';
import AssetEmptyState from './AssetEmptyState';
import { shouldUseCompactAssetLayout } from './assetLayout';

type Props = {
  overview: AssetBdOverview | null;
  application?: AssetBdApplication | null;
  isLoggedIn: boolean;
  loading?: boolean;
  applicationLoading?: boolean;
  submitting?: boolean;
  error?: string | null;
  applicationError?: string | null;
  submitError?: string | null;
  submitSuccess?: string | null;
  onLoginPress: () => void;
  onRetryPress?: () => void;
  onRetryApplicationPress?: () => void;
  onApply?: (input: CreateAssetBdApplicationInput) => void;
};

const levelOptions: Array<{
  value: CreateAssetBdApplicationInput['applyLevel'];
  descriptionKey: TranslationKey;
}> = [
  { value: 'BD1', descriptionKey: 'bd.level.bd1Description' },
  { value: 'BD2', descriptionKey: 'bd.level.bd2Description' },
  { value: 'BD3', descriptionKey: 'bd.level.bd3Description' },
];

const applicationStatusLabelKeys: Record<string, TranslationKey> = {
  PENDING: 'bd.status.pending',
  APPROVED: 'bd.status.approved',
  REJECTED: 'bd.status.rejected',
  CANCELED: 'bd.status.canceled',
};

const applicationStatusHintKeys: Record<string, TranslationKey> = {
  PENDING: 'bd.status.pendingHint',
  APPROVED: 'bd.status.approvedHint',
  REJECTED: 'bd.status.rejectedHint',
  CANCELED: 'bd.status.canceledHint',
};

function AssetBdSummary({
  overview,
  application = null,
  isLoggedIn,
  loading = false,
  applicationLoading = false,
  submitting = false,
  error,
  applicationError,
  submitError,
  submitSuccess,
  onLoginPress,
  onRetryPress,
  onRetryApplicationPress,
  onApply,
}: Props) {
  const { t } = useLanguage();
  const { width, fontScale } = useWindowDimensions();
  const compact = shouldUseCompactAssetLayout(width, fontScale);

  if (!isLoggedIn) {
    return (
      <AssetEmptyState
        actionLabel={t('auth.login')}
        title={t('bd.loginTitle')}
        description={t('bd.loginDescription')}
        onActionPress={onLoginPress}
      />
    );
  }

  if (error) {
    return (
      <AssetEmptyState
        actionLabel={onRetryPress ? t('common.reload') : undefined}
        title={t('bd.unavailable')}
        description={error}
        onActionPress={onRetryPress}
      />
    );
  }

  if (!overview && loading) {
    return (
      <AssetEmptyState
        title={t('bd.loading')}
        description={t('common.pleaseWait')}
      />
    );
  }

  if (!overview) {
    return (
      <AssetEmptyState
        title={t('bd.unavailable')}
        description={t('bd.unavailableDescription')}
        actionLabel={onRetryPress ? t('common.reload') : undefined}
        onActionPress={onRetryPress}
      />
    );
  }

  if (!overview.isBd) {
    const disabled = Boolean(
      overview.accountStatus && overview.accountStatus !== 'ACTIVE',
    );
    return (
      <AssetBdApplicationCenter
        application={application}
        applicationError={applicationError}
        applicationLoading={applicationLoading}
        disabled={disabled}
        submitError={submitError}
        submitSuccess={submitSuccess}
        submitting={submitting}
        onApply={onApply}
        onRetryApplicationPress={onRetryApplicationPress}
      />
    );
  }

  return (
    <>
      <AssetAccountHero
        Icon={BriefcaseBusiness}
        accentColor="#9B7CFF"
        eyebrow={t('bd.earningsEyebrow')}
        meta={t('bd.meta', {
          count: overview.teamCount,
          level: overview.bdLevel,
        })}
        title={t('bd.earnings')}
        value={overview.totalCommission}
        valueLabel={t('bd.totalCommission')}
      />
      <BdInviteCard inviteCode={overview.inviteCode} />
      <View style={styles.card}>
        <View style={styles.sectionHeader}>
          <Text style={styles.title}>{t('bd.overview')}</Text>
          <View style={styles.levelChip}>
            <BadgeCheck color="#B7A2FF" size={14} strokeWidth={2} />
            <Text style={styles.levelText}>{overview.bdLevel}</Text>
          </View>
        </View>
        <View style={styles.grid}>
          <Metric
            Icon={UsersRound}
            compact={compact}
            label={t('bd.teamCount')}
            value={t('invite.countPeople', { count: overview.teamCount })}
          />
          <Metric
            Icon={Clock3}
            compact={compact}
            label={t('bd.pendingCommission')}
            value={overview.pendingCommission}
          />
          <Metric
            Icon={CircleCheck}
            compact={compact}
            label={t('bd.paidCommission')}
            value={overview.paidCommission}
          />
        </View>
      </View>
    </>
  );
}

function BdInviteCard({ inviteCode }: { inviteCode: string }) {
  const { t } = useLanguage();
  const [sharing, setSharing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const inviteLink = buildInviteRegistrationLink(
    CHART_WEB_BASE_URL,
    inviteCode,
    'bd',
  );

  const shareInviteLink = async () => {
    if (!inviteLink || sharing) return;
    setSharing(true);
    setFeedback(null);
    try {
      const result = await Share.share({
        title: t('invite.shareTitle'),
        message: buildInviteShareMessage(inviteCode, inviteLink, t),
      });
      if (result.action === Share.sharedAction) {
        setFeedback(t('invite.shareOpened'));
      }
    } catch {
      setFeedback(t('invite.shareUnavailable'));
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('bd.inviteTitle')}</Text>
      <Text style={styles.inviteDescription}>{t('bd.inviteDescription')}</Text>
      <View style={styles.inviteCodeRow}>
        <Text style={styles.inviteCode}>{inviteCode}</Text>
        <CopyIconButton
          text={inviteCode}
          accessibilityLabel={t('invite.copyCodeA11y')}
          onCopied={() => setFeedback(t('invite.codeCopied'))}
        />
      </View>
      {inviteLink ? (
        <View style={styles.inviteLinkRow}>
          <Text numberOfLines={2} selectable style={styles.inviteLink}>
            {inviteLink}
          </Text>
          <CopyIconButton
            text={inviteLink}
            accessibilityLabel={t('invite.copyLinkA11y')}
            onCopied={() => setFeedback(t('invite.linkCopied'))}
          />
        </View>
      ) : null}
      {inviteLink ? (
        <Pressable
          accessibilityLabel={t('invite.shareA11y')}
          accessibilityRole="button"
          accessibilityState={{ disabled: sharing }}
          disabled={sharing}
          onPress={shareInviteLink}
          style={({ pressed }) => [
            styles.shareButton,
            sharing ? styles.shareButtonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <Share2 color={colors.bg} size={16} strokeWidth={2.4} />
          <Text style={styles.shareButtonText}>
            {sharing ? t('invite.sharing') : t('invite.share')}
          </Text>
        </Pressable>
      ) : null}
      {feedback ? (
        <Text accessibilityLiveRegion="polite" style={styles.shareFeedback}>
          {feedback}
        </Text>
      ) : null}
    </View>
  );
}

function AssetBdApplicationCenter({
  application,
  applicationError,
  applicationLoading,
  disabled,
  submitting,
  submitError,
  submitSuccess,
  onRetryApplicationPress,
  onApply,
}: {
  application: AssetBdApplication | null;
  applicationError?: string | null;
  applicationLoading: boolean;
  disabled: boolean;
  submitting: boolean;
  submitError?: string | null;
  submitSuccess?: string | null;
  onRetryApplicationPress?: () => void;
  onApply?: (input: CreateAssetBdApplicationInput) => void;
}) {
  const { t } = useLanguage();
  const [formVisible, setFormVisible] = useState(false);
  const [applyLevel, setApplyLevel] =
    useState<CreateAssetBdApplicationInput['applyLevel']>('BD1');
  const [depositCoinSymbol, setDepositCoinSymbol] =
    useState<CreateAssetBdApplicationInput['depositCoinSymbol']>('USDT');
  const [depositAmount, setDepositAmount] = useState('1000');
  const [remark, setRemark] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const confirmationOpenRef = useRef(false);
  const normalizedStatus = String(application?.status || '').toUpperCase();
  const canApply =
    !disabled &&
    !applicationError &&
    !applicationLoading &&
    Boolean(onApply) &&
    (!application || ['REJECTED', 'CANCELED'].includes(normalizedStatus));

  useEffect(() => {
    if (application && !['REJECTED', 'CANCELED'].includes(normalizedStatus)) {
      setFormVisible(false);
    }
  }, [application, normalizedStatus]);

  useEffect(
    () => () => {
      confirmationOpenRef.current = false;
    },
    [],
  );

  const statusLabel = application
    ? applicationStatusLabelKeys[normalizedStatus]
      ? t(applicationStatusLabelKeys[normalizedStatus])
      : normalizedStatus
    : null;
  const statusHint = application
    ? applicationStatusHintKeys[normalizedStatus]
      ? t(applicationStatusHintKeys[normalizedStatus])
      : t('bd.status.unknownHint')
    : null;
  const actionLabel = application ? t('bd.applyAgain') : t('bd.applyNow');

  const confirmApplication = () => {
    if (submitting || confirmationOpenRef.current) return;
    const normalizedAmount = normalizeNonNegativeDecimalText(depositAmount);
    if (normalizedAmount === null) {
      setValidationError(t('bd.invalidDepositAmount'));
      return;
    }
    if (remark.trim().length > 255) {
      setValidationError(t('bd.remarkTooLong'));
      return;
    }
    setValidationError(null);
    confirmationOpenRef.current = true;
    Alert.alert(
      t('bd.confirmTitle'),
      t('bd.confirmDescription', {
        amount: normalizedAmount,
        coin: depositCoinSymbol,
        level: applyLevel,
      }),
      [
        {
          text: t('bd.confirmCancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: t('bd.confirmSubmit'),
          onPress: () => {
            confirmationOpenRef.current = false;
            onApply?.({
              applyLevel,
              depositCoinSymbol,
              depositAmount: normalizedAmount,
              remark: remark.trim(),
            });
          },
        },
      ],
      {
        onDismiss: () => {
          confirmationOpenRef.current = false;
        },
      },
    );
  };

  return (
    <>
      <View style={styles.accessCard}>
        <View style={styles.accessIcon}>
          <BriefcaseBusiness color={colors.gold} size={25} strokeWidth={1.9} />
        </View>
        <Text style={styles.accessEyebrow}>{t('bd.programEyebrow')}</Text>
        <Text style={styles.accessTitle}>
          {disabled ? t('bd.qualificationDisabled') : t('bd.notEnabled')}
        </Text>
        <Text style={styles.accessDescription}>
          {disabled
            ? t('bd.qualificationDisabledDescription')
            : t('bd.notEnabledDescription')}
        </Text>
        <View style={styles.accessNotice}>
          <ShieldCheck color={colors.green} size={15} strokeWidth={2} />
          <Text style={styles.accessNoticeText}>{t('bd.realDataNotice')}</Text>
        </View>
        {!disabled && canApply && !formVisible ? (
          <Pressable
            accessibilityLabel={actionLabel}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
            style={({ pressed }) => [
              styles.applyCta,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => setFormVisible(true)}
          >
            <Text style={styles.applyCtaText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>

      {applicationLoading ? (
        <View style={styles.applicationStateCard}>
          <Text style={styles.applicationStateText}>
            {t('bd.applicationLoading')}
          </Text>
        </View>
      ) : null}

      {applicationError ? (
        <View style={styles.applicationErrorCard}>
          <Text style={styles.applicationErrorTitle}>
            {t('bd.applicationUnavailable')}
          </Text>
          <Text style={styles.applicationErrorText}>{applicationError}</Text>
          {onRetryApplicationPress ? (
            <Pressable
              accessibilityLabel={t('common.reload')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              style={({ pressed }) => [
                styles.inlineRetry,
                pressed ? styles.pressed : null,
              ]}
              onPress={onRetryApplicationPress}
            >
              <Text style={styles.inlineRetryText}>{t('common.reload')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {application ? (
        <View style={styles.applicationStatusCard}>
          <View style={styles.statusHeader}>
            <Text style={styles.statusTitle}>{t('bd.recentStatus')}</Text>
            <View
              style={[
                styles.statusChip,
                normalizedStatus === 'PENDING' ? styles.statusPending : null,
                normalizedStatus === 'APPROVED' ? styles.statusApproved : null,
                normalizedStatus === 'REJECTED' ? styles.statusRejected : null,
              ]}
            >
              <Text style={styles.statusChipText}>{statusLabel}</Text>
            </View>
          </View>
          <Text style={styles.applicationValue}>
            {application.applyLevel} / {application.depositAmount}{' '}
            {application.depositCoinSymbol}
          </Text>
          <Text style={styles.statusHint}>{statusHint}</Text>
          {application.adminRemark ? (
            <View style={styles.adminRemark}>
              <Text style={styles.adminRemarkLabel}>
                {t('bd.reviewRemark')}
              </Text>
              <Text style={styles.adminRemarkText}>
                {application.adminRemark}
              </Text>
            </View>
          ) : null}
          {canApply && !formVisible ? (
            <Pressable
              accessibilityLabel={actionLabel}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              style={({ pressed }) => [
                styles.secondaryApplyCta,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => setFormVisible(true)}
            >
              <Text style={styles.secondaryApplyCtaText}>{actionLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {formVisible && canApply ? (
        <View style={styles.formCard}>
          <Text style={styles.formEyebrow}>{t('bd.applyEyebrow')}</Text>
          <Text style={styles.formTitle}>{t('bd.applyTitle')}</Text>
          <Text style={styles.formDescription}>{t('bd.applyDescription')}</Text>

          <View style={styles.steps}>
            {[
              'bd.step.submit',
              'bd.step.review',
              'bd.step.deposit',
              'bd.step.activate',
            ].map((key, index) => (
              <View key={key} style={styles.stepRow}>
                <View style={styles.stepNumber}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <Text style={styles.stepText}>{t(key as TranslationKey)}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.fieldLabel}>{t('bd.selectLevel')}</Text>
          <View style={styles.levelOptions}>
            {levelOptions.map(option => {
              const active = option.value === applyLevel;
              return (
                <Pressable
                  key={option.value}
                  accessibilityLabel={`${option.value}${t(
                    'common.a11ySeparator',
                  )}${t(option.descriptionKey)}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                  style={({ pressed }) => [
                    styles.levelOption,
                    active ? styles.levelOptionActive : null,
                    pressed ? styles.pressed : null,
                  ]}
                  onPress={() => setApplyLevel(option.value)}
                >
                  <Text style={styles.levelOptionTitle}>{option.value}</Text>
                  <Text style={styles.levelOptionDescription}>
                    {t(option.descriptionKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.fieldLabel}>{t('bd.depositCoin')}</Text>
          <View style={styles.coinOptions}>
            {(['USDT', 'RCB'] as const).map(coin => {
              const active = coin === depositCoinSymbol;
              return (
                <Pressable
                  key={coin}
                  accessibilityLabel={coin}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                  style={({ pressed }) => [
                    styles.coinOption,
                    active ? styles.coinOptionActive : null,
                    pressed ? styles.pressed : null,
                  ]}
                  onPress={() => setDepositCoinSymbol(coin)}
                >
                  <Text
                    style={[
                      styles.coinOptionText,
                      active ? styles.coinOptionTextActive : null,
                    ]}
                  >
                    {coin}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.fieldLabel}>{t('bd.estimatedDeposit')}</Text>
          <TextInput
            accessibilityLabel={t('bd.estimatedDeposit')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="decimal-pad"
            placeholder={t('bd.depositAmountPlaceholder')}
            placeholderTextColor={colors.textSubtle}
            style={styles.input}
            value={depositAmount}
            onChangeText={setDepositAmount}
          />

          <View style={styles.depositNotice}>
            <Text style={styles.depositNoticeText}>
              {t('bd.depositNotice')}
            </Text>
          </View>

          <Text style={styles.fieldLabel}>{t('bd.remark')}</Text>
          <TextInput
            accessibilityLabel={t('bd.remark')}
            autoCorrect={false}
            maxLength={255}
            multiline
            placeholder={t('bd.remarkPlaceholder')}
            placeholderTextColor={colors.textSubtle}
            style={[styles.input, styles.remarkInput]}
            textAlignVertical="top"
            value={remark}
            onChangeText={setRemark}
          />

          {validationError || submitError ? (
            <Text style={styles.formError}>
              {validationError || submitError}
            </Text>
          ) : null}
          {submitSuccess ? (
            <Text style={styles.formSuccess}>{submitSuccess}</Text>
          ) : null}

          <Pressable
            accessibilityLabel={t('bd.submit')}
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting }}
            android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
            disabled={submitting}
            style={({ pressed }) => [
              styles.submitButton,
              submitting ? styles.submitButtonDisabled : null,
              pressed ? styles.submitPressed : null,
            ]}
            onPress={confirmApplication}
          >
            <Text style={styles.submitButtonText}>
              {submitting ? t('bd.submitting') : t('bd.submit')}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

export default React.memo(AssetBdSummary);

function Metric({
  Icon,
  label,
  value,
  compact,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  compact: boolean;
}) {
  return (
    <View style={[styles.metric, compact ? styles.metricCompact : null]}>
      <View style={styles.metricHeader}>
        <Icon color="#B7A2FF" size={15} strokeWidth={2} />
        <Text style={styles.metricLabel}>{label}</Text>
      </View>
      <Text numberOfLines={2} style={styles.metricValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  submitPressed: { opacity: 0.86, transform: [{ scale: 0.992 }] },
  card: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  inviteDescription: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 16,
  },
  inviteCodeRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 11,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  inviteCode: {
    ...typography.number,
    color: '#B7A2FF',
    fontSize: 13,
    fontWeight: '900',
  },
  inviteLinkRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 11,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  inviteLink: {
    flex: 1,
    color: colors.text,
    fontSize: 10,
    lineHeight: 15,
  },
  shareButton: {
    minHeight: 42,
    marginTop: 12,
    borderRadius: 11,
    backgroundColor: '#B7A2FF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  shareButtonDisabled: {
    opacity: 0.55,
  },
  shareButtonText: {
    ...typography.bold,
    color: colors.bg,
    fontSize: 12,
  },
  shareFeedback: {
    marginTop: 8,
    color: colors.green,
    fontSize: 10,
    textAlign: 'center',
  },
  levelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 99,
    backgroundColor: 'rgba(155,124,255,0.14)',
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  levelText: {
    ...typography.bold,
    marginLeft: 5,
    color: '#B7A2FF',
    fontSize: 9,
  },
  grid: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    flex: 1,
    minWidth: 96,
    minHeight: 82,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  metricCompact: {
    flexBasis: '100%',
    flexGrow: 0,
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metricLabel: {
    marginLeft: 6,
    color: colors.textSubtle,
    fontSize: 10,
  },
  metricValue: {
    ...typography.number,
    marginTop: 6,
    color: colors.text,
    fontSize: 13,
    fontWeight: '900',
  },
  accessCard: {
    minHeight: 248,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.34)',
    backgroundColor: colors.card,
    padding: 24,
  },
  accessIcon: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.goldSoft,
  },
  accessEyebrow: {
    ...typography.bold,
    marginTop: 16,
    color: colors.gold,
    fontSize: 9,
    letterSpacing: 0.8,
  },
  accessTitle: {
    ...typography.bold,
    marginTop: 7,
    color: colors.text,
    fontSize: 17,
    textAlign: 'center',
  },
  accessDescription: {
    maxWidth: 280,
    marginTop: 9,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  accessNotice: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 99,
    backgroundColor: 'rgba(25,195,125,0.10)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  accessNoticeText: {
    marginLeft: 7,
    color: colors.green,
    fontSize: 9,
  },
  applyCta: {
    minHeight: 44,
    marginTop: 18,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.gold,
    paddingHorizontal: 18,
  },
  applyCtaText: {
    ...typography.bold,
    color: '#08090C',
    fontSize: 14,
  },
  applicationStateCard: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: 14,
  },
  applicationStateText: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
  applicationErrorCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,91,111,0.28)',
    backgroundColor: 'rgba(255,91,111,0.08)',
    padding: 14,
  },
  applicationErrorTitle: {
    ...typography.bold,
    color: colors.red,
    fontSize: 13,
  },
  applicationErrorText: {
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  inlineRetry: {
    minHeight: 36,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginTop: 5,
  },
  inlineRetryText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  applicationStatusCard: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 15,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  statusTitle: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 13,
  },
  statusChip: {
    borderRadius: 99,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusPending: {
    backgroundColor: colors.goldSoft,
  },
  statusApproved: {
    backgroundColor: 'rgba(25,195,125,0.12)',
  },
  statusRejected: {
    backgroundColor: 'rgba(255,91,111,0.12)',
  },
  statusChipText: {
    ...typography.bold,
    color: colors.text,
    fontSize: 10,
  },
  applicationValue: {
    ...typography.number,
    marginTop: 14,
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  statusHint: {
    marginTop: 9,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  adminRemark: {
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    padding: 10,
  },
  adminRemarkLabel: {
    color: colors.textSubtle,
    fontSize: 10,
  },
  adminRemarkText: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  secondaryApplyCta: {
    minHeight: 42,
    marginTop: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.42)',
    backgroundColor: colors.goldSoft,
  },
  secondaryApplyCtaText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 13,
  },
  formCard: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.25)',
    backgroundColor: colors.card,
    padding: 15,
  },
  formEyebrow: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 9,
    letterSpacing: 0.8,
  },
  formTitle: {
    ...typography.bold,
    marginTop: 6,
    color: colors.text,
    fontSize: 18,
  },
  formDescription: {
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  steps: {
    marginTop: 13,
    gap: 7,
  },
  stepRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  stepNumber: {
    width: 23,
    height: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.goldSoft,
  },
  stepNumberText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 10,
  },
  stepText: {
    marginLeft: 9,
    color: colors.textMuted,
    fontSize: 11,
  },
  fieldLabel: {
    ...typography.bold,
    marginTop: 16,
    marginBottom: 8,
    color: colors.text,
    fontSize: 12,
  },
  levelOptions: {
    gap: 8,
  },
  levelOption: {
    minHeight: 66,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  levelOptionActive: {
    borderColor: 'rgba(214,168,50,0.68)',
    backgroundColor: colors.goldSoft,
  },
  levelOptionTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  levelOptionDescription: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 15,
  },
  coinOptions: {
    flexDirection: 'row',
    gap: 8,
  },
  coinOption: {
    minHeight: 40,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  coinOptionActive: {
    borderColor: 'rgba(214,168,50,0.68)',
    backgroundColor: colors.goldSoft,
  },
  coinOptionText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 12,
  },
  coinOptionTextActive: {
    color: colors.gold,
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    color: colors.text,
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  remarkInput: {
    minHeight: 92,
  },
  depositNotice: {
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: colors.goldSoft,
    padding: 11,
  },
  depositNoticeText: {
    color: colors.gold,
    fontSize: 10,
    lineHeight: 16,
  },
  formError: {
    marginTop: 10,
    color: colors.red,
    fontSize: 11,
    lineHeight: 17,
  },
  formSuccess: {
    marginTop: 10,
    color: colors.green,
    fontSize: 11,
    lineHeight: 17,
  },
  submitButton: {
    minHeight: 46,
    marginTop: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.gold,
  },
  submitButtonDisabled: {
    opacity: 0.55,
  },
  submitButtonText: {
    ...typography.bold,
    color: '#08090C',
    fontSize: 14,
  },
});
