import React, {useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {
  fetchStockTokenConverts,
  fetchStockTokenLocks,
  type StockTokenConvertRecord,
  type StockTokenLock,
} from '../../api/stockToken';
import {
  ActionCard,
  ActionHeader,
  InfoRow,
  InlineNotice,
  RefreshButton,
  StateCard,
  formatAmount,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import {
  createTranslator,
  useLanguage,
  type Translator,
} from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {isPositiveDecimalText} from '../../utils/decimalText';
import {colors, typography} from '../../theme';

type Navigation = NativeStackNavigationProp<
  RootStackParamList,
  'StockTokenCenter'
>;

export default function StockTokenCenterScreen() {
  const navigation = useNavigation<Navigation>();
  const {t} = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [locks, setLocks] = useState<StockTokenLock[]>([]);
  const [converts, setConverts] = useState<StockTokenConvertRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      fetchStockTokenLocks({signal: controller.signal}),
      fetchStockTokenConverts({signal: controller.signal}),
    ])
      .then(([lockResponse, convertResponse]) => {
        setLocks(lockResponse.items);
        setConverts(convertResponse.items);
      })
      .catch(requestError => {
        if (controller.signal.aborted) return;
        setLocks([]);
        setConverts([]);
        setError(
          requestError instanceof Error &&
            requestError.name === 'StockTokenContractError'
            ? tRef.current('stockToken.contractInvalid')
            : toChineseError(
                requestError,
                tRef.current('stockToken.loadFailed'),
                tRef.current,
              ),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const availableBatchCount = useMemo(
    () => locks.filter(item => isPositiveDecimalText(item.availableAmount)).length,
    [locks],
  );
  const retry = () => setReloadKey(value => value + 1);

  return (
    <AppScreen>
      <ActionHeader
        title={t('stockToken.title')}
        subtitle={t('stockToken.subtitle')}
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={retry} />}
      />

      {loading && locks.length === 0 && converts.length === 0 ? (
        <StateCard
          title={t('stockToken.loading')}
          description={t('stockToken.loadingDescription')}
        />
      ) : error ? (
        <StateCard
          title={t('stockToken.unavailable')}
          description={error}
          actionTitle={t('stockToken.reload')}
          onActionPress={retry}
        />
      ) : (
        <>
          <ActionCard>
            <Text style={styles.cardTitle}>{t('stockToken.overview')}</Text>
            <InfoRow
              label={t('stockToken.lockBatches')}
              value={t('stockToken.batchCount', {count: locks.length})}
            />
            <InfoRow
              label={t('stockToken.availableBatches')}
              value={t('stockToken.batchCount', {count: availableBatchCount})}
              tone={availableBatchCount > 0 ? 'gold' : undefined}
            />
            <InfoRow
              label={t('stockToken.conversionRecords')}
              value={t('stockToken.recordCount', {count: converts.length})}
            />
          </ActionCard>

          <SectionHeader
            title={t('stockToken.lockRelease')}
            count={locks.length}
            t={t}
          />
          {locks.length === 0 ? (
            <StateCard
              title={t('stockToken.noLocks')}
              description={t('stockToken.noLocksDescription')}
            />
          ) : (
            locks.map(item => <LockCard key={item.id} item={item} t={t} />)
          )}

          <SectionHeader
            title={t('stockToken.conversionHistory')}
            count={converts.length}
            t={t}
          />
          {converts.length === 0 ? (
            <StateCard
              title={t('stockToken.noConversions')}
              description={t('stockToken.noConversionsDescription')}
            />
          ) : (
            converts.map(record => (
              <ConvertCard key={record.id} record={record} t={t} />
            ))
          )}

          <InlineNotice>{t('stockToken.readOnlyNotice')}</InlineNotice>
        </>
      )}
    </AppScreen>
  );
}

function SectionHeader({
  title,
  count,
  t,
}: {
  title: string;
  count: number;
  t: Translator;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.countText}>
        {t('stockToken.sectionCount', {count})}
      </Text>
    </View>
  );
}

function LockCard({item, t}: {item: StockTokenLock; t: Translator}) {
  const statusTone = item.status === 'RELEASED' ? 'green' : 'gold';
  return (
    <ActionCard>
      <View style={styles.titleRow}>
        <View>
          <Text style={styles.symbol}>
            {item.lockSymbol} → {item.tradeSymbol || '--'}
          </Text>
          <Text style={styles.batch}>
            {t('stockToken.lockBatch', {id: item.id})}
          </Text>
        </View>
        <Text
          style={[
            styles.status,
            statusTone === 'green' ? styles.statusGreen : null,
          ]}>
          {formatLockStatus(item.status, t)}
        </Text>
      </View>
      <InfoRow
        label={t('stockToken.releaseProgress')}
        value={`${formatAmount(item.progressPercent, 2)}%`}
        tone="gold"
      />
      <InfoRow
        label={t('stockToken.totalAmount')}
        value={`${formatAmount(item.totalAmount, 8)} ${item.lockSymbol}`}
      />
      <InfoRow
        label={t('stockToken.remainingAmount')}
        value={`${formatAmount(item.lockedAmount, 8)} ${item.lockSymbol}`}
      />
      <InfoRow
        label={t('stockToken.availableAmount')}
        value={`${formatAmount(item.availableAmount, 8)} ${item.lockSymbol}`}
        tone={isPositiveDecimalText(item.availableAmount) ? 'gold' : undefined}
      />
      <InfoRow
        label={t('stockToken.convertedAmount')}
        value={`${formatAmount(item.convertedAmount, 8)} ${item.lockSymbol}`}
      />
      <InfoRow
        label={t('stockToken.conversionRate')}
        value={`1 ${item.lockSymbol} = ${formatAmount(
          item.conversionRateSnapshot,
          8,
        )} ${item.tradeSymbol || '--'}`}
      />
      <InfoRow
        label={t('stockToken.dailyRelease')}
        value={`${formatDecimalAsPercent(item.dailyReleaseRate)}%`}
      />
      <InfoRow
        label={t('stockToken.lockPeriod')}
        value={t('stockToken.days', {count: item.lockDays})}
      />
      <InfoRow
        label={t('stockToken.releasePeriod')}
        value={t('stockToken.days', {count: item.releaseDays})}
      />
      <InfoRow
        label={t('stockToken.lockStart')}
        value={formatBackendUtcAt(item.lockStartAt)}
      />
      <InfoRow
        label={t('stockToken.releaseStart')}
        value={formatBackendUtcAt(item.releaseStartAt)}
      />
      <InfoRow
        label={t('stockToken.releaseFinish')}
        value={formatBackendUtcAt(item.releaseFinishAt)}
      />
    </ActionCard>
  );
}

function ConvertCard({
  record,
  t,
}: {
  record: StockTokenConvertRecord;
  t: Translator;
}) {
  const failed = record.status === 'FAILED';
  return (
    <ActionCard>
      <View style={styles.titleRow}>
        <View>
          <Text style={styles.symbol}>
            {record.fromSymbol} → {record.toSymbol}
          </Text>
          <Text style={styles.batch}>
            {t('stockToken.conversionRecord', {id: record.id})}
          </Text>
        </View>
        <Text style={[styles.status, failed ? styles.statusRed : styles.statusGreen]}>
          {failed
            ? t('stockToken.conversionFailed')
            : t('stockToken.conversionSuccess')}
        </Text>
      </View>
      <InfoRow
        label={t('stockToken.conversionAmount')}
        value={`${formatAmount(record.fromAmount, 8)} ${record.fromSymbol}`}
      />
      <InfoRow
        label={t('stockToken.receivedAmount')}
        value={`${formatAmount(record.toAmount, 8)} ${record.toSymbol}`}
        tone={failed ? 'red' : 'green'}
      />
      <InfoRow
        label={t('stockToken.conversionRate')}
        value={`1 ${record.fromSymbol} = ${formatAmount(
          record.conversionRate,
          8,
        )} ${record.toSymbol}`}
      />
      <InfoRow
        label={t('stockToken.conversionTime')}
        value={formatBackendUtcAt(record.createdAt)}
      />
    </ActionCard>
  );
}

const defaultTranslator = createTranslator('zh-CN');

export function formatLockStatus(
  status: StockTokenLock['status'],
  t: Translator = defaultTranslator,
) {
  if (status === 'LOCKED') return t('stockToken.statusLocked');
  if (status === 'ACTIVE') return t('stockToken.statusActive');
  return t('stockToken.statusReleased');
}

export function formatBackendUtcAt(value: string | null | undefined) {
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

export function formatDecimalAsPercent(value: string) {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  const adjustedScale = fraction.length - 2;
  if (adjustedScale < 0) return `${digits}${'0'.repeat(-adjustedScale)}`;
  const scale = adjustedScale;
  const raw = digits.padStart(scale + 1, '0');
  if (scale === 0) return raw;
  const resultWhole = raw.slice(0, -scale) || '0';
  const resultFraction = raw.slice(-scale).replace(/0+$/, '');
  return resultFraction ? `${resultWhole}.${resultFraction}` : resultWhole;
}

const styles = StyleSheet.create({
  cardTitle: {...typography.bold, marginBottom: 6, color: colors.text, fontSize: 15},
  sectionHeader: {
    marginTop: 22,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {...typography.sectionTitle, color: colors.text},
  countText: {color: colors.textMuted, fontSize: 11},
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  symbol: {...typography.bold, color: colors.text, fontSize: 14},
  batch: {marginTop: 3, color: colors.textMuted, fontSize: 10},
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
});
