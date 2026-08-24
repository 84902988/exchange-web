import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  fetchUserTransferRecords,
  type UserTransferDirection,
  type UserTransferRecord,
} from '../../api/userTransfer';
import {
  ActionCard,
  ActionHeader,
  AuthRequiredCard,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SelectChips,
  StateCard,
  formatAmount,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import type { RootStackParamList } from '../../navigation/types';
import { useAuth } from '../../store/authStore';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type Navigation = NativeStackNavigationProp<
  RootStackParamList,
  'UserTransferRecords'
>;

const PAGE_SIZE = 20;
export default function UserTransferRecordsScreen() {
  const navigation = useNavigation<Navigation>();
  const { isLoggedIn } = useAuth();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const filters = useMemo<
    Array<{ value: UserTransferDirection; label: string }>
  >(
    () => [
      { value: 'all', label: t('userTransferRecords.all') },
      { value: 'out', label: t('userTransferRecords.out') },
      { value: 'in', label: t('userTransferRecords.in') },
    ],
    [t],
  );
  const [direction, setDirection] = useState<UserTransferDirection>('all');
  const [records, setRecords] = useState<UserTransferRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadMoreControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!isLoggedIn) {
      setLoading(false);
      setRecords([]);
      setTotal(0);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetchUserTransferRecords(
      { direction, page: 1, pageSize: PAGE_SIZE },
      { signal: controller.signal },
    )
      .then(response => {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) {
          return;
        }
        setRecords(response.items);
        setTotal(response.total);
        setPage(response.page);
      })
      .catch(requestError => {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) {
          return;
        }
        setRecords([]);
        setTotal(0);
        setError(
          toChineseError(
            requestError,
            tRef.current('userTransferRecords.loadFailed'),
            tRef.current,
          ),
        );
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          generation === requestGenerationRef.current
        ) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
      requestGenerationRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, [direction, isLoggedIn, reloadKey]);

  const loadMore = async () => {
    if (loadingMoreRef.current || records.length >= total) return;
    loadingMoreRef.current = true;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    setError('');
    try {
      const response = await fetchUserTransferRecords(
        {
          direction,
          page: page + 1,
          pageSize: PAGE_SIZE,
        },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) {
        return;
      }
      setRecords(current => mergeUserTransferRecords(current, response.items));
      setPage(response.page);
      setTotal(response.total);
    } catch (requestError) {
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) {
        return;
      }
      setError(
        toChineseError(
          requestError,
          tRef.current('userTransferRecords.loadMoreFailed'),
          tRef.current,
        ),
      );
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        loadingMoreRef.current = false;
      }
      if (
        !controller.signal.aborted &&
        generation === requestGenerationRef.current
      ) {
        setLoadingMore(false);
      }
    }
  };

  const retry = () => setReloadKey(value => value + 1);

  return (
    <AppScreen scroll={false} contentStyle={styles.screen}>
      <FlatList
        contentContainerStyle={styles.listContent}
        data={isLoggedIn ? records : []}
        initialNumToRender={8}
        keyExtractor={record => String(record.id)}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        maxToRenderPerBatch={8}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item }) => <TransferRecordCard record={item} />}
        showsVerticalScrollIndicator={false}
        updateCellsBatchingPeriod={40}
        windowSize={7}
        ListHeaderComponent={
          <>
            <ActionHeader
              title={t('userTransferRecords.title')}
              subtitle={t('userTransferRecords.subtitle')}
              onBack={() => navigation.goBack()}
              right={<RefreshButton disabled={loading} onPress={retry} />}
            />
            {!isLoggedIn ? (
              <AuthRequiredCard
                onLoginPress={() =>
                  navigation.navigate('Auth', { screen: 'Login' })
                }
              />
            ) : (
              <>
                <ActionCard>
                  <SelectChips
                    label={t('userTransferRecords.filter')}
                    value={direction}
                    options={filters}
                    onChange={value =>
                      setDirection(value as UserTransferDirection)
                    }
                  />
                </ActionCard>

                {loading && records.length === 0 ? (
                  <StateCard
                    title={t('userTransferRecords.loading')}
                    description={t('assetAction.loading')}
                  />
                ) : error && records.length === 0 ? (
                  <StateCard
                    title={t('userTransferRecords.unavailable')}
                    description={error}
                    actionTitle={t('userTransferRecords.reload')}
                    onActionPress={retry}
                  />
                ) : records.length === 0 ? (
                  <StateCard
                    title={t('userTransferRecords.empty')}
                    description={t('userTransferRecords.emptyDescription')}
                  />
                ) : (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryTitle}>
                      {t('userTransferRecords.details')}
                    </Text>
                    <Text style={styles.summaryCount}>
                      {t('userTransferRecords.count', { count: total })}
                    </Text>
                  </View>
                )}
              </>
            )}
          </>
        }
        ListFooterComponent={
          isLoggedIn ? (
            <>
              {records.length > 0 && records.length < total ? (
                <Pressable
                  accessibilityLabel={t('userTransferRecords.loadMoreA11y')}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: loadingMore }}
                  android_ripple={{ color: 'rgba(216, 176, 74, 0.14)' }}
                  disabled={loadingMore}
                  style={({ pressed }) => [
                    styles.loadMore,
                    pressed && !loadingMore ? styles.loadMorePressed : null,
                  ]}
                  testID="user-transfer-records-load-more"
                  onPress={loadMore}
                >
                  <Text style={styles.loadMoreText}>
                    {loadingMore
                      ? t('userTransferRecords.loadingMore')
                      : t('userTransferRecords.loadMore')}
                  </Text>
                </Pressable>
              ) : null}
              {error && records.length > 0 ? (
                <InlineNotice tone="red">{error}</InlineNotice>
              ) : null}
              <InlineNotice>{t('userTransferRecords.notice')}</InlineNotice>
            </>
          ) : null
        }
      />
    </AppScreen>
  );
}

export function mergeUserTransferRecords(
  current: UserTransferRecord[],
  incoming: UserTransferRecord[],
) {
  const knownIds = new Set(current.map(record => record.id));
  return [...current, ...incoming.filter(record => !knownIds.has(record.id))];
}

function TransferRecordCard({ record }: { record: UserTransferRecord }) {
  const { t } = useLanguage();
  const outbound = record.direction === 'out';
  const counterparty = outbound
    ? record.recipientNickname ||
      record.counterpartyNickname ||
      record.recipientEmailMask
    : record.counterpartyNickname ||
      t('userTransferRecords.userFallback', {
        id: record.counterpartyUserId,
      });
  return (
    <ActionCard>
      <View style={styles.recordTitleRow}>
        <View>
          <Text style={styles.recordDirection}>
            {outbound
              ? t('userTransferRecords.out')
              : t('userTransferRecords.in')}{' '}
            {record.symbol}
          </Text>
          <Text style={styles.recordNo}>{record.transferNo}</Text>
        </View>
        <Text
          style={[styles.amount, outbound ? styles.amountOut : styles.amountIn]}
        >
          {outbound ? '-' : '+'}
          {formatAmount(record.netAmount, 8)} {record.symbol}
        </Text>
      </View>
      <InfoRow
        label={
          outbound
            ? t('userTransferRecords.recipient')
            : t('userTransferRecords.sender')
        }
        value={counterparty}
      />
      <InfoRow
        label={t('userTransferRecords.status')}
        value={formatStatus(record.status, t)}
        tone="green"
      />
      <InfoRow
        label={t('userTransferRecords.fee')}
        value={`${formatAmount(record.feeAmount, 8)} ${record.symbol}`}
      />
      <InfoRow
        label={t('userTransferRecords.time')}
        value={formatBackendUtcAt(record.createdAt)}
      />
      {record.remark ? (
        <InfoRow
          label={t('userTransferRecords.remark')}
          value={record.remark}
        />
      ) : null}
    </ActionCard>
  );
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

function formatStatus(status: string, t: Translator) {
  return status === 'SUCCESS' ? t('userTransferRecords.completed') : status;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { paddingBottom: 16 },
  summaryRow: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryTitle: { ...typography.sectionTitle, color: colors.text },
  summaryCount: { color: colors.textMuted, fontSize: 11 },
  recordTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  recordDirection: { ...typography.bold, color: colors.text, fontSize: 14 },
  recordNo: {
    ...typography.identifier,
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 9,
  },
  amount: {
    ...typography.bold,
    flexShrink: 1,
    textAlign: 'right',
    fontSize: 14,
  },
  amountOut: { color: colors.red },
  amountIn: { color: colors.green },
  loadMore: {
    minHeight: 42,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  loadMoreText: { ...typography.bold, color: colors.gold, fontSize: 12 },
  loadMorePressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
});
