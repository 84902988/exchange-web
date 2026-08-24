import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {BadgeCheck, Network, UserRound} from 'lucide-react-native';
import type {InvitedFriend} from '../../api/invite';
import {createTranslator, useLanguage, type Translator} from '../../i18n';
import {colors, typography} from '../../theme';
import AssetEmptyState from './AssetEmptyState';

type Props = {
  items: InvitedFriend[];
  loading?: boolean;
  error?: string | null;
  onRetryPress?: () => void;
};

function AssetInvitedFriends({
  items,
  loading = false,
  error,
  onRetryPress,
}: Props) {
  const {t} = useLanguage();
  const invitedFriends = items.filter(item => item.sourceType === 'USER_INVITE');
  if (error) {
    return (
      <AssetEmptyState
        actionLabel={onRetryPress ? t('common.reload') : undefined}
        title={t('invite.friendsUnavailable')}
        description={error}
        onActionPress={onRetryPress}
      />
    );
  }

  if (loading && invitedFriends.length === 0) {
    return (
      <AssetEmptyState
        title={t('invite.loadingFriends')}
        description={t('common.pleaseWait')}
      />
    );
  }

  if (invitedFriends.length === 0) {
    return (
      <AssetEmptyState
        title={t('invite.noFriends')}
        description={t('invite.noFriendsDescription')}
      />
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{t('invite.recentFriends')}</Text>
          <Text style={styles.subtitle}>{t('invite.friendsPrivacy')}</Text>
        </View>
        <View style={styles.countChip}>
          <Text style={styles.countText}>
            {t('invite.countFriends', {count: invitedFriends.length})}
          </Text>
        </View>
      </View>

      {invitedFriends.map(item => (
        <View key={`${item.sourceType}:${item.userId}`} style={styles.row}>
          <View style={styles.avatar}>
            <UserRound color={colors.gold} size={17} strokeWidth={2.1} />
          </View>
          <View style={styles.main}>
            <Text style={styles.email}>{maskInvitedEmail(item.email, t)}</Text>
            <Text style={styles.meta}>
              {t('invite.boundAt', {
                time: formatInviteUtcTime(item.boundAt || item.registeredAt),
              })}
            </Text>
            {item.inviteCode ? (
              <Text style={styles.code}>
                {t('invite.codeValue', {code: item.inviteCode})}
              </Text>
            ) : null}
          </View>
          <View style={styles.sourceChip}>
            {item.sourceType === 'BD' ? (
              <Network color={colors.green} size={12} strokeWidth={2.2} />
            ) : (
              <BadgeCheck color={colors.gold} size={12} strokeWidth={2.2} />
            )}
            <Text
              style={[
                styles.sourceText,
                item.sourceType === 'BD' ? styles.sourceTextBd : null,
              ]}>
              {item.sourceType === 'BD'
                ? t('invite.bdBinding')
                : t('invite.friendBinding')}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export default React.memo(AssetInvitedFriends);

export function maskInvitedEmail(
  value: string | null | undefined,
  t: Translator = createTranslator('zh-CN'),
) {
  if (!value) return t('invite.emailMissing');
  const [local, domain] = value.split('@');
  if (!local || !domain) return t('invite.emailHidden');
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function formatInviteUtcTime(value: string | null | undefined) {
  if (!value) return '--';
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  title: {...typography.bold, color: colors.text, fontSize: 14},
  subtitle: {marginTop: 3, color: colors.textSubtle, fontSize: 9},
  countChip: {
    borderRadius: 99,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  countText: {...typography.bold, color: colors.gold, fontSize: 9},
  row: {
    minHeight: 78,
    marginTop: 9,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  avatar: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.goldSoft,
  },
  main: {flex: 1, marginHorizontal: 9},
  email: {...typography.bold, color: colors.text, fontSize: 11},
  meta: {marginTop: 4, color: colors.textMuted, fontSize: 9},
  code: {marginTop: 3, color: colors.textSubtle, fontSize: 9},
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 99,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 7,
    paddingVertical: 5,
    gap: 4,
  },
  sourceText: {...typography.bold, color: colors.gold, fontSize: 8},
  sourceTextBd: {color: colors.green},
});
