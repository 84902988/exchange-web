import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  fetchDepositRecords,
  type DepositAddress,
  type DepositRecord,
} from '../../../api/assets';
import { useApplicationActive } from '../../../hooks/useApplicationState';
import { useLanguage } from '../../../i18n';
import { depositStage } from '../../../utils/depositStatus';
import { colors, typography } from '../../../theme';
import {
  ActionCard,
  InfoRow,
  InlineNotice,
  SmallTextButton,
  CopyIconButton,
} from './ActionPrimitives';

export default function DepositProgress({
  address,
}: {
  address: DepositAddress;
}) {
  const { t } = useLanguage();
  const active = useApplicationActive();
  const [rows, setRows] = useState<DepositRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<number | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++generation.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const result = await fetchDepositRecords(
        {
          symbol: address.symbol,
          network: address.network,
          address: address.address,
          page,
        },
        { signal: controller.signal },
      );
      if (current !== generation.current || controller.signal.aborted) return;
      setRows(result.items);
      setTotal(result.total);
      setError(false);
      setUpdated(Date.now());
    } catch {
      if (current === generation.current && !controller.signal.aborted)
        setError(true);
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, [address.symbol, address.network, address.address, page]);

  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      load().catch(() => undefined);
      const timer = setInterval(() => {
        load().catch(() => undefined);
      }, 5000);
      return () => {
        clearInterval(timer);
        generation.current += 1;
        inFlight.current = false;
        controllerRef.current?.abort();
      };
    }, [active, load]),
  );

  return (
    <View>
      <ActionCard>
        <Text style={styles.title}>{t('deposit.progress.title')}</Text>
        <InlineNotice tone={error ? 'red' : 'gold'}>
          {t(
            error
              ? 'deposit.progress.error'
              : updated
              ? 'deposit.progress.monitoring'
              : 'deposit.progress.loading',
          )}
        </InlineNotice>
        <Text style={styles.hint}>{t('deposit.progress.explanation')}</Text>
        {updated ? (
          <Text style={styles.hint}>
            {t('deposit.progress.updated', {
              time: new Date(updated).toLocaleTimeString(),
            })}
          </Text>
        ) : null}
        <SmallTextButton
          title={t('deposit.progress.transferred')}
          disabled={loading || !active}
          onPress={() => {
            load().catch(() => undefined);
          }}
        />
        {!rows.length && updated && !error ? (
          <Text style={styles.hint}>{t('deposit.progress.waiting')}</Text>
        ) : null}
      </ActionCard>
      {rows.length ? (
        <Text style={styles.title}>{t('deposit.progress.recent')}</Text>
      ) : null}
      {rows.map(row => {
        const stage = depositStage(row);
        const steps = ['detected', 'confirmed', 'credited'] as const;
        const reached =
          stage === 'credited'
            ? 2
            : stage === 'confirmed'
            ? 1
            : stage === 'detected' || stage === 'processing'
            ? 0
            : -1;
        return (
          <ActionCard key={row.id}>
            <InfoRow
              label={t('assetAction.amount')}
              value={`${row.amount} ${row.symbol}`}
            />
            <InfoRow
              label={t('assetAction.status')}
              value={t(`deposit.progress.${stage}`)}
              tone={stage === 'credited' ? 'gold' : undefined}
            />
            <View style={styles.steps}>
              {steps.map((step, index) => (
                <View key={step} style={styles.step}>
                  <View
                    style={[styles.line, index <= reached && styles.complete]}
                  />
                  <Text style={styles.hint}>
                    {t(`deposit.progress.${step}`)}
                  </Text>
                </View>
              ))}
            </View>
            <InfoRow
              label={t('deposit.confirmations')}
              value={`${row.confirmations} / ${row.confirmRequired || '--'}`}
            />
            {row.createdAt ? (
              <InfoRow
                label={t('deposit.progress.time')}
                value={`${row.createdAt.replace('T', ' ')} UTC`}
              />
            ) : null}
            {row.creditDestination === 'stock_token_lock' && row.credited ? (
              <InlineNotice>{t('deposit.progress.locked')}</InlineNotice>
            ) : null}
            {row.txid ? (
              <>
                <InfoRow label="TxID" value={row.txid} mono />
                <CopyIconButton text={row.txid} />
              </>
            ) : null}
          </ActionCard>
        );
      })}
      {page > 1 || total > 20 ? (
        <ActionCard>
          <SmallTextButton
            title={t('withdraw.previousPage')}
            disabled={page <= 1 || loading}
            onPress={() => {
              setRows([]);
              setPage(value => value - 1);
            }}
          />
          <SmallTextButton
            title={t('withdraw.nextPage')}
            disabled={page * 20 >= total || loading}
            onPress={() => {
              setRows([]);
              setPage(value => value + 1);
            }}
          />
        </ActionCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 16,
    marginBottom: 8,
  },
  hint: { color: colors.textMuted, fontSize: 12, marginVertical: 5 },
  steps: { flexDirection: 'row', gap: 8, marginVertical: 12 },
  step: { flex: 1 },
  line: { height: 4, borderRadius: 2, backgroundColor: colors.marketLine },
  complete: { backgroundColor: colors.primary },
});
