import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Network, UserRound} from 'lucide-react-native';
import type {InvitedFriend} from '../../api/invite';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';
import AssetEmptyState from './AssetEmptyState';
import {
  formatInviteUtcTime,
  maskInvitedEmail,
} from './AssetInvitedFriends';

type Props = {
  items: InvitedFriend[];
  totalCount: number;
  loading?: boolean;
  error?: string | null;
  onRetryPress?: () => void;
};

function AssetBdTeamMembers({
  items,
  totalCount,
  loading = false,
  error,
  onRetryPress,
}: Props) {
  const {t} = useLanguage();
  const teamMembers = items.filter(item => item.sourceType === 'BD');

  if (error) {
    return (
      <AssetEmptyState
        actionLabel={onRetryPress ? t('common.reload') : undefined}
        title={t('bd.teamUnavailable')}
        description={error}
        onActionPress={onRetryPress}
      />
    );
  }

  if (loading && teamMembers.length === 0) {
    return (
      <AssetEmptyState
        title={t('bd.loadingTeam')}
        description={t('common.pleaseWait')}
      />
    );
  }

  if (teamMembers.length === 0) {
    return (
      <AssetEmptyState
        title={t('bd.noTeamMembers')}
        description={t('bd.noTeamMembersDescription')}
      />
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{t('bd.teamMembers')}</Text>
          <Text style={styles.subtitle}>{t('bd.teamMembersPrivacy')}</Text>
        </View>
        <View style={styles.countChip}>
          <Text style={styles.countText}>
            {t('invite.countFriends', {count: totalCount})}
          </Text>
        </View>
      </View>

      {teamMembers.map(item => (
        <View key={`${item.sourceType}:${item.userId}`} style={styles.row}>
          <View style={styles.avatar}>
            <UserRound color="#B7A2FF" size={17} strokeWidth={2.1} />
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
            <Network color={colors.green} size={12} strokeWidth={2.2} />
            <Text style={styles.sourceText}>{t('invite.bdBinding')}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export default React.memo(AssetBdTeamMembers);

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(155,124,255,0.28)',
    backgroundColor: colors.card,
    padding: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 5,
    gap: 10,
  },
  headerCopy: {flex: 1},
  title: {...typography.bold, color: colors.text, fontSize: 14},
  subtitle: {marginTop: 3, color: colors.textSubtle, fontSize: 9},
  countChip: {
    borderRadius: 99,
    backgroundColor: 'rgba(155,124,255,0.14)',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  countText: {...typography.bold, color: '#B7A2FF', fontSize: 9},
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
    backgroundColor: 'rgba(155,124,255,0.14)',
  },
  main: {flex: 1, marginHorizontal: 9},
  email: {...typography.bold, color: colors.text, fontSize: 11},
  meta: {marginTop: 4, color: colors.textMuted, fontSize: 9},
  code: {marginTop: 3, color: colors.textSubtle, fontSize: 9},
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 99,
    backgroundColor: 'rgba(25,195,125,0.1)',
    paddingHorizontal: 7,
    paddingVertical: 5,
    gap: 4,
  },
  sourceText: {...typography.bold, color: colors.green, fontSize: 8},
});
