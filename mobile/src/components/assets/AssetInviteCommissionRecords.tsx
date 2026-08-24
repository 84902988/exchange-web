import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type {
  AssetInviteCommissionRecord,
  AssetInviteCommissionStatus,
} from '../../api/assets';
import { createTranslator, useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = {
  items: AssetInviteCommissionRecord[];
};

function AssetInviteCommissionRecords({ items }: Props) {
  const { t } = useLanguage();
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('invite.recentRecords')}</Text>
      <Text style={styles.subtitle}>{t('invite.recordSource')}</Text>
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{t('invite.noRecords')}</Text>
          <Text style={styles.emptyDescription}>
            {t('invite.noRecordsDescription')}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {items.map(item => (
            <View key={item.id} style={styles.record}>
              <View style={styles.recordHeader}>
                <View style={styles.recordIdentity}>
                  <Text style={styles.recordUser}>
                    {t('invite.inviteeUid', { uid: item.inviteeUserId })}
                  </Text>
                  <Text style={styles.recordTime}>
                    {formatInviteCommissionTime(item.createdAt)}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusChip,
                    statusTone(item.status) === 'green'
                      ? styles.statusGreen
                      : statusTone(item.status) === 'red'
                      ? styles.statusRed
                      : styles.statusGold,
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      statusTone(item.status) === 'green'
                        ? styles.statusTextGreen
                        : statusTone(item.status) === 'red'
                        ? styles.statusTextRed
                        : styles.statusTextGold,
                    ]}
                  >
                    {inviteCommissionStatusLabel(item.status, t)}
                  </Text>
                </View>
              </View>
              <View style={styles.metrics}>
                <RecordMetric
                  label={t('invite.fee')}
                  value={`${item.feeAmount} ${item.feeCoinSymbol}`}
                />
                <RecordMetric
                  accent
                  label={t('invite.rcbReward')}
                  value={`${item.commissionRcbAmount} RCB`}
                />
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default React.memo(AssetInviteCommissionRecords);

function RecordMetric({
  accent = false,
  label,
  value,
}: {
  accent?: boolean;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, accent ? styles.metricAccent : null]}>
        {value}
      </Text>
    </View>
  );
}

export function inviteCommissionStatusLabel(
  status: AssetInviteCommissionStatus,
  t: Translator = createTranslator('zh-CN'),
) {
  if (status === 'PAID') return t('invite.statusPaid');
  if (status === 'FAILED') return t('invite.statusFailed');
  return t('invite.statusPending');
}

export function formatInviteCommissionTime(value: string) {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(
    parsed.getDate(),
  )} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function statusTone(status: AssetInviteCommissionStatus) {
  if (status === 'PAID') return 'green';
  if (status === 'FAILED') return 'red';
  return 'gold';
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
  empty: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 14,
    paddingVertical: 18,
  },
  emptyTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 12,
    textAlign: 'center',
  },
  emptyDescription: {
    marginTop: 6,
    color: colors.textSubtle,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  list: {
    marginTop: 12,
    gap: 10,
  },
  record: {
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    padding: 12,
  },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  recordIdentity: {
    flex: 1,
  },
  recordUser: {
    ...typography.bold,
    color: colors.text,
    fontSize: 11,
  },
  recordTime: {
    marginTop: 4,
    color: colors.textSubtle,
    fontSize: 9,
  },
  statusChip: {
    borderRadius: 99,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusGreen: {
    borderColor: 'rgba(20, 207, 148, 0.28)',
    backgroundColor: 'rgba(20, 207, 148, 0.10)',
  },
  statusGold: {
    borderColor: 'rgba(229, 179, 45, 0.28)',
    backgroundColor: colors.goldSoft,
  },
  statusRed: {
    borderColor: 'rgba(255, 84, 112, 0.28)',
    backgroundColor: 'rgba(255, 84, 112, 0.10)',
  },
  statusText: {
    ...typography.bold,
    fontSize: 9,
  },
  statusTextGreen: {
    color: colors.green,
  },
  statusTextGold: {
    color: colors.gold,
  },
  statusTextRed: {
    color: colors.red,
  },
  metrics: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: colors.textSubtle,
    fontSize: 9,
  },
  metricValue: {
    ...typography.number,
    marginTop: 4,
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  metricAccent: {
    color: colors.gold,
  },
});
