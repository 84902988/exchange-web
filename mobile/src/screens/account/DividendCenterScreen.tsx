import React, {useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {
  fetchMyDividendRecords,
  fetchMyDividendSummary,
  type DividendRecord,
  type DividendSummary,
} from '../../api/dividend';
import {
  ActionCard,
  ActionHeader,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SmallTextButton,
  StateCard,
  formatAmount,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import {useLanguage, type Translator} from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {colors, typography} from '../../theme';

const PAGE_SIZE = 20;

type Navigation = NativeStackNavigationProp<
  RootStackParamList,
  'DividendCenter'
>;

export default function DividendCenterScreen() {
  const navigation = useNavigation<Navigation>();
  const {t} = useLanguage();
  const tRef = useRef(t);
  const [summary, setSummary] = useState<DividendSummary | null>(null);
  const [records, setRecords] = useState<DividendRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      fetchMyDividendSummary({signal: controller.signal}),
      fetchMyDividendRecords(page, PAGE_SIZE, {signal: controller.signal}),
    ])
      .then(([nextSummary, nextRecords]) => {
        setSummary(nextSummary);
        setRecords(nextRecords.items);
        setTotal(nextRecords.total);
      })
      .catch(requestError => {
        if (controller.signal.aborted) return;
        setSummary(null);
        setRecords([]);
        setTotal(0);
        const translate = tRef.current;
        setError(
          getDividendRequestError(
            requestError,
            translate,
            translate('dividend.loadFailed'),
          ),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, reloadKey]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total],
  );

  const retry = () => setReloadKey(value => value + 1);

  return (
    <AppScreen>
      <ActionHeader
        backAccessibilityLabel={t('common.back')}
        title={t('dividend.title')}
        subtitle={t('dividend.subtitle')}
        onBack={() => navigation.goBack()}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading}
            onPress={retry}
          />
        }
      />

      {loading && !summary ? (
        <StateCard
          title={t('dividend.loading')}
          description={t('common.pleaseWait')}
        />
      ) : error ? (
        <StateCard
          title={t('dividend.unavailable')}
          description={error}
          actionTitle={t('common.reload')}
          onActionPress={retry}
        />
      ) : summary ? (
        <>
          <View
            accessibilityLabel={
              summary.eligible
                ? t('dividend.eligible')
                : t('dividend.ineligible')
            }
            style={[
              styles.eligibility,
              summary.eligible ? styles.eligibilityActive : null,
            ]}>
            <Text
              style={[
                styles.eligibilityText,
                summary.eligible ? styles.eligibilityTextActive : null,
              ]}>
              {summary.eligible
                ? t('dividend.eligible')
                : t('dividend.ineligible')}
            </Text>
          </View>

          <ActionCard>
            <Text style={styles.cardTitle}>{t('dividend.summary')}</Text>
            <InfoRow
              label={t('dividend.total')}
              value={`${formatAmount(summary.totalRcb, 8)} RCB`}
              tone="gold"
            />
            <InfoRow
              label={t('dividend.month')}
              value={`${formatAmount(summary.monthRcb, 8)} RCB`}
              tone="gold"
            />
            <InfoRow
              label={t('dividend.latestAmount')}
              value={formatNullableAmount(summary.latestAmountRcb, 'RCB')}
            />
            <InfoRow
              label={t('dividend.latestDate')}
              value={summary.latestDividendDate || '--'}
            />
            <InfoRow
              label={t('dividend.currentSvip')}
              value={summary.currentSvipLevel || '--'}
            />
            <InfoRow
              label={t('dividend.latestStatus')}
              value={formatDividendStatus(summary.latestStatus, t)}
              tone={dividendStatusTone(summary.latestStatus)}
            />
          </ActionCard>

          <View style={styles.recordsHeader}>
            <Text style={styles.sectionTitle}>{t('dividend.details')}</Text>
            <Text style={styles.totalText}>
              {t('dividend.count', {count: total})}
            </Text>
          </View>

          {loading ? (
            <StateCard
              title={t('dividend.loadingPage', {page})}
              description={t('common.pleaseWait')}
            />
          ) : records.length === 0 ? (
            <StateCard
              title={t('dividend.empty')}
              description={t('dividend.emptyDescription')}
            />
          ) : (
            records.map(record => (
              <DividendRecordCard key={record.id} record={record} t={t} />
            ))
          )}

          {totalPages > 1 ? (
            <View style={styles.pagination}>
              <SmallTextButton
                disabled={loading || page <= 1}
                title={t('dividend.previous')}
                onPress={() => setPage(value => Math.max(1, value - 1))}
              />
              <Text style={styles.pageText}>
                {page} / {totalPages}
              </Text>
              <SmallTextButton
                disabled={loading || page >= totalPages}
                title={t('dividend.next')}
                onPress={() =>
                  setPage(value => Math.min(totalPages, value + 1))
                }
              />
            </View>
          ) : null}

          <InlineNotice>
            {t('dividend.notice')}
          </InlineNotice>
        </>
      ) : null}
    </AppScreen>
  );
}

function DividendRecordCard({
  record,
  t,
}: {
  record: DividendRecord;
  t: Translator;
}) {
  const tone = dividendStatusTone(record.status);
  return (
    <ActionCard>
      <View style={styles.recordTitleRow}>
        <View>
          <Text style={styles.recordDate}>{record.dividendDate || '--'}</Text>
          <Text style={styles.recordLevel}>{record.svipLevelCode}</Text>
        </View>
        <Text
          style={[
            styles.status,
            tone === 'green' ? styles.statusGreen : null,
            tone === 'red' ? styles.statusRed : null,
          ]}>
          {formatDividendStatus(record.status, t)}
        </Text>
      </View>
      <InfoRow
        label={t('dividend.amount')}
        value={`${formatAmount(record.amountRcb, 8)} RCB`}
        tone="gold"
      />
      <InfoRow
        label={t('dividend.usdtEquivalent')}
        value={`${formatAmount(record.amountUsdt, 8)} USDT`}
      />
      <InfoRow
        label={t('dividend.paidAt')}
        value={formatDividendPaidAt(record.paidAt)}
      />
    </ActionCard>
  );
}

export function formatDividendStatus(
  value: string | null | undefined,
  t?: Translator,
) {
  switch (String(value || '').trim().toUpperCase()) {
    case 'PAID':
      return t?.('dividend.statusPaid') || '已发放';
    case 'FAILED':
      return t?.('dividend.statusFailed') || '发放失败';
    case 'PENDING':
    case 'CALCULATED':
      return t?.('dividend.statusPending') || '待发放';
    default:
      return value?.trim() || '--';
  }
}

export function formatDividendPaidAt(value: string | null | undefined) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatNullableAmount(value: string | null, unit: string) {
  return value === null ? '--' : `${formatAmount(value, 8)} ${unit}`;
}

function dividendStatusTone(value: string | null | undefined) {
  const status = String(value || '').trim().toUpperCase();
  if (status === 'PAID') return 'green' as const;
  if (status === 'FAILED') return 'red' as const;
  return 'gold' as const;
}

function getDividendRequestError(
  error: unknown,
  t: Translator,
  fallback: string,
) {
  const message = error instanceof Error ? error.message : '';
  if (/[\u3400-\u9fff]/.test(message)) return message;
  const normalized = message.toLowerCase();
  if (normalized.includes('network') || normalized.includes('timeout')) {
    return t('common.networkError');
  }
  return fallback;
}

const styles = StyleSheet.create({
  eligibility: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  eligibilityActive: {
    borderColor: 'rgba(25,195,125,0.32)',
    backgroundColor: 'rgba(25,195,125,0.1)',
  },
  eligibilityText: {...typography.bold, color: colors.textMuted, fontSize: 12},
  eligibilityTextActive: {color: colors.green},
  cardTitle: {
    ...typography.bold,
    marginBottom: 6,
    color: colors.text,
    fontSize: 15,
  },
  recordsHeader: {
    marginTop: 22,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {...typography.sectionTitle, color: colors.text},
  totalText: {color: colors.textMuted, fontSize: 11},
  recordTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  recordDate: {...typography.bold, color: colors.text, fontSize: 14},
  recordLevel: {marginTop: 3, color: colors.textMuted, fontSize: 10},
  status: {
    ...typography.bold,
    color: colors.gold,
    borderRadius: 10,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 9,
    paddingVertical: 4,
    fontSize: 10,
  },
  statusGreen: {color: colors.green, backgroundColor: 'rgba(25,195,125,0.1)'},
  statusRed: {color: colors.red, backgroundColor: 'rgba(240,90,90,0.1)'},
  pagination: {
    minHeight: 46,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pageText: {color: colors.textMuted, fontSize: 12},
});
