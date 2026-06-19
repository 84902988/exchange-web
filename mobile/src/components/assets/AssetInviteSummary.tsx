import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {AssetInviteOverview} from '../../api/assets';
import {colors, typography} from '../../theme';
import AssetEmptyState from './AssetEmptyState';

type Props = {
  overview: AssetInviteOverview | null;
  isLoggedIn: boolean;
  loading?: boolean;
  error?: string | null;
  onLoginPress: () => void;
};

function AssetInviteSummary({
  overview,
  isLoggedIn,
  loading = false,
  error,
  onLoginPress,
}: Props) {
  if (!isLoggedIn) {
    return (
      <AssetEmptyState
        actionLabel="登录"
        title="登录后查看邀请奖励"
        description="邀请好友完成交易后，可在这里查看奖励进度。"
        onActionPress={onLoginPress}
      />
    );
  }

  if (error) {
    return <AssetEmptyState title="邀请数据暂不可用" description={error} />;
  }

  if (!overview && !loading) {
    return (
      <AssetEmptyState
        title="暂无邀请收益"
        description="邀请概览接口已预留，暂无可展示奖励。"
      />
    );
  }

  const asset = overview?.rewardAsset || 'RCB';
  return (
    <View style={styles.card}>
      <Text style={styles.title}>邀请收益</Text>
      <View style={styles.grid}>
        <Metric label="累计奖励" value={`${overview?.totalReward ?? '--'} ${asset}`} />
        <Metric label="待发奖励" value={`${overview?.pendingReward ?? '--'} ${asset}`} />
        <Metric label="已发奖励" value={`${overview?.paidReward ?? '--'} ${asset}`} />
        <Metric label="邀请人数" value={`${overview?.invitedCount ?? '--'}`} />
      </View>
      <Text style={styles.note}>
        {overview?.inviteCode
          ? `邀请码 ${overview.inviteCode}`
          : '暂无邀请码或奖励记录，后续按邀请规则自动汇总。'}
      </Text>
    </View>
  );
}

export default React.memo(AssetInviteSummary);

function Metric({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  grid: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    width: '48%',
    minHeight: 58,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  metricLabel: {
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
  note: {
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
});
