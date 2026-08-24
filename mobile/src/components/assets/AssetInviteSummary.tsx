import React, { useState } from 'react';
import {
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  CircleCheck,
  Clock3,
  Gift,
  Share2,
  Ticket,
  UsersRound,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import type { AssetInviteOverview } from '../../api/assets';
import { CHART_WEB_BASE_URL } from '../../config/env';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import {
  buildInviteRegistrationLink,
  buildInviteShareMessage,
} from '../../utils/inviteLink';
import { CopyIconButton } from './action/ActionPrimitives';
import AssetAccountHero from './AssetAccountHero';
import AssetEmptyState from './AssetEmptyState';
import { shouldUseCompactAssetLayout } from './assetLayout';

type Props = {
  overview: AssetInviteOverview | null;
  isLoggedIn: boolean;
  loading?: boolean;
  error?: string | null;
  onLoginPress: () => void;
  onRetryPress?: () => void;
};

function AssetInviteSummary({
  overview,
  isLoggedIn,
  loading = false,
  error,
  onLoginPress,
  onRetryPress,
}: Props) {
  const { t } = useLanguage();
  const { width, fontScale } = useWindowDimensions();
  const compact = shouldUseCompactAssetLayout(width, fontScale);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  if (!isLoggedIn) {
    return (
      <AssetEmptyState
        actionLabel={t('auth.login')}
        title={t('invite.loginTitle')}
        description={t('invite.loginDescription')}
        onActionPress={onLoginPress}
      />
    );
  }

  if (error) {
    return (
      <AssetEmptyState
        actionLabel={onRetryPress ? t('common.reload') : undefined}
        title={t('invite.unavailable')}
        description={error}
        onActionPress={onRetryPress}
      />
    );
  }

  if (!overview && loading) {
    return (
      <AssetEmptyState
        title={t('invite.loading')}
        description={t('common.pleaseWait')}
      />
    );
  }

  if (!overview) {
    return (
      <AssetEmptyState
        title={t('invite.unavailable')}
        description={t('invite.unavailableDescription')}
        actionLabel={onRetryPress ? t('common.reload') : undefined}
        onActionPress={onRetryPress}
      />
    );
  }

  const asset = overview.rewardAsset;
  const inviteCode = overview.inviteCode?.trim() || '';
  const inviteLink =
    overview.inviteLink?.trim() ||
    buildInviteRegistrationLink(CHART_WEB_BASE_URL, inviteCode, 'user');
  const shareInviteLink = async () => {
    if (!inviteCode || !inviteLink || sharing) return;
    setSharing(true);
    setShareFeedback(null);
    try {
      const result = await Share.share({
        title: t('invite.shareTitle'),
        message: buildInviteShareMessage(inviteCode, inviteLink, t),
      });
      if (result.action === Share.sharedAction) {
        setShareFeedback(t('invite.shareOpened'));
      }
    } catch {
      setShareFeedback(t('invite.shareUnavailable'));
    } finally {
      setSharing(false);
    }
  };
  return (
    <>
      <AssetAccountHero
        Icon={Gift}
        accentColor={colors.gold}
        eyebrow={t('invite.eyebrow')}
        meta={t('invite.meta', {
          percent: overview.commissionPercent,
          count: overview.invitedCount,
        })}
        title={t('invite.earnings')}
        value={`${overview.totalReward} ${asset}`}
        valueLabel={t('invite.totalReward')}
      />
      <View style={styles.card}>
        <View style={styles.inviteHeader}>
          <View style={styles.inviteText}>
            <Text style={styles.title}>{t('invite.friends')}</Text>
            <Text style={styles.subtitle}>{t('invite.bindDescription')}</Text>
          </View>
          <View style={styles.inviteCodeRow}>
            <Text style={styles.inviteCode}>
              {inviteCode || t('invite.notGenerated')}
            </Text>
            {inviteCode ? (
              <CopyIconButton
                text={inviteCode}
                accessibilityLabel={t('invite.copyCodeA11y')}
                onCopied={() => setShareFeedback(t('invite.codeCopied'))}
              />
            ) : null}
          </View>
        </View>
        {inviteLink ? (
          <View style={styles.inviteLinkBlock}>
            <Text style={styles.inviteLinkLabel}>{t('invite.link')}</Text>
            <View style={styles.inviteLinkRow}>
              <Text numberOfLines={2} selectable style={styles.inviteLink}>
                {inviteLink}
              </Text>
              <CopyIconButton
                text={inviteLink}
                accessibilityLabel={t('invite.copyLinkA11y')}
                onCopied={() => setShareFeedback(t('invite.linkCopied'))}
              />
            </View>
          </View>
        ) : null}
        {inviteLink ? (
          <Pressable
            accessibilityLabel={t('invite.shareA11y')}
            accessibilityRole="button"
            accessibilityState={{ disabled: sharing }}
            android_ripple={{ color: 'rgba(0, 0, 0, 0.12)' }}
            disabled={sharing}
            onPress={shareInviteLink}
            style={({ pressed }) => [
              styles.shareButton,
              sharing ? styles.shareDisabled : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <Share2 color={colors.bg} size={16} strokeWidth={2.4} />
            <Text style={styles.shareButtonText}>
              {sharing ? t('invite.sharing') : t('invite.share')}
            </Text>
          </Pressable>
        ) : null}
        {shareFeedback ? (
          <Text accessibilityLiveRegion="polite" style={styles.shareFeedback}>
            {shareFeedback}
          </Text>
        ) : null}
      </View>
      <View style={styles.card}>
        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.title}>{t('invite.progress')}</Text>
            <Text style={styles.subtitle}>{t('invite.realStatus')}</Text>
          </View>
          <View style={styles.assetChip}>
            <Text style={styles.assetChipText}>{asset}</Text>
          </View>
        </View>
        <View style={styles.grid}>
          <Metric
            Icon={Clock3}
            compact={compact}
            label={t('invite.pendingReward')}
            value={`${overview.pendingReward} ${asset}`}
          />
          <Metric
            Icon={CircleCheck}
            compact={compact}
            label={t('invite.paidReward')}
            value={`${overview.paidReward} ${asset}`}
          />
          <Metric
            Icon={UsersRound}
            compact={compact}
            label={t('invite.people')}
            value={t('invite.countPeople', { count: overview.invitedCount })}
          />
          <Metric
            Icon={Ticket}
            compact={compact}
            label={t('invite.code')}
            value={overview.inviteCode || t('invite.notGenerated')}
          />
        </View>
      </View>
    </>
  );
}

export default React.memo(AssetInviteSummary);

export { buildInviteShareMessage } from '../../utils/inviteLink';

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
        <Icon color={colors.gold} size={15} strokeWidth={2} />
        <Text style={styles.metricLabel}>{label}</Text>
      </View>
      <Text numberOfLines={compact ? 2 : 1} style={styles.metricValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
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
  inviteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  inviteText: {
    flex: 1,
  },
  inviteCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inviteCode: {
    ...typography.number,
    color: colors.gold,
    fontSize: 13,
    fontWeight: '900',
  },
  inviteLinkBlock: {
    marginTop: 14,
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  inviteLinkLabel: {
    ...typography.bold,
    color: colors.textSubtle,
    fontSize: 9,
  },
  inviteLinkRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inviteLink: {
    flex: 1,
    color: colors.text,
    fontSize: 10,
    lineHeight: 15,
  },
  shareButton: {
    minHeight: 42,
    marginTop: 14,
    borderRadius: 12,
    backgroundColor: colors.gold,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  shareDisabled: {
    opacity: 0.55,
  },
  shareButtonText: {
    ...typography.bold,
    color: colors.bg,
    fontSize: 12,
  },
  shareFeedback: {
    marginTop: 9,
    color: colors.green,
    fontSize: 10,
    textAlign: 'center',
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  subtitle: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 9,
  },
  assetChip: {
    borderRadius: 99,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  assetChipText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 9,
  },
  grid: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    width: '48%',
    minHeight: 76,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  metricCompact: {
    width: '100%',
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
});
