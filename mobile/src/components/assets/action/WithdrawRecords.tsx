import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  cancelWithdraw,
  fetchWithdrawRecords,
  sendWithdrawTx,
  type WithdrawRecord,
} from '../../../api/assets';
import { useLanguage } from '../../../i18n';
import { useApplicationActive } from '../../../hooks/useApplicationState';
import {
  canCancelWithdraw,
  canSendWithdraw,
  mapWithdrawStatus,
} from '../../../utils/withdrawStatus';
import {
  ActionCard,
  InfoRow,
  InlineNotice,
  SmallTextButton,
  maskMiddle,
} from './ActionPrimitives';
import { colors } from '../../../theme';

export default function WithdrawRecords({
  revision,
  disabled,
  onChange,
  onMutation,
}: {
  revision: number;
  disabled: boolean;
  onChange: (rows: WithdrawRecord[]) => void;
  onMutation?: () => void;
}) {
  const { t } = useLanguage();
  const active = useApplicationActive();
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<WithdrawRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const readPending = useRef(false);
  const focused = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const load = useCallback(async () => {
    readPending.current = true;
    const current = ++generation.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const result = await fetchWithdrawRecords(page * 20, {
        signal: controller.signal,
      });
      if (generation.current !== current || controller.signal.aborted) return;
      setRows(result);
      setError(false);
      changeRef.current(result);
    } catch {
      if (generation.current === current && !controller.signal.aborted)
        setError(true);
    } finally {
      if (generation.current === current) readPending.current = false;
      if (generation.current === current && !controller.signal.aborted)
        setLoading(false);
    }
  }, [page]);

  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      focused.current = true;
      setBusy(lock.current);
      load().catch(() => undefined);
      const timer = setInterval(() => {
        if (!lock.current && !readPending.current) load().catch(() => undefined);
      }, 5000);
      return () => {
        clearInterval(timer);
        focused.current = false;
        readPending.current = false;
        generation.current += 1;
        controllerRef.current?.abort();
      };
    }, [active, load]),
  );

  useEffect(() => {
    if (revision > 0 && focused.current && !lock.current) load().catch(() => undefined);
  }, [load, revision]);

  const run = async (row: WithdrawRecord, action: 'send' | 'cancel') => {
    if (lock.current || disabled || !focused.current) return;
    lock.current = true;
    readPending.current = false;
    setBusy(true);
    generation.current += 1;
    controllerRef.current?.abort();
    const current = generation.current;
    try {
      const result =
        action === 'send'
          ? await sendWithdrawTx(row.withdrawId)
          : await cancelWithdraw(row.withdrawId);
      if (current !== generation.current) return;
      setRows(items =>
        items.map(item =>
          item.withdrawId === row.withdrawId
            ? { ...item, status: result.status }
            : item,
        ),
      );
      changeRef.current([{ ...row, status: result.status }]);
      setError(false);
    } catch {
      if (current === generation.current) {
        setError(true);
        // The server may have accepted the action before the connection failed.
        await load();
      }
    } finally {
      lock.current = false;
      if (focused.current) {
        setBusy(false);
        onMutation?.();
      }
    }
  };

  const confirmAction = (row: WithdrawRecord, action: 'send' | 'cancel') => {
    if (busy || loading || disabled) return;
    Alert.alert(
      t(action === 'send' ? 'withdraw.sendNow' : 'withdraw.cancelRequest'),
      t(action === 'send' ? 'withdraw.sendConfirm' : 'withdraw.cancelConfirm', {
        id: row.withdrawId,
        amount: row.amount,
        symbol: row.symbol,
        network: row.chainKey.toUpperCase(),
        address: row.toAddress,
      }),
      [
        { text: t('withdraw.keepRequest'), style: 'cancel' },
        {
          text: t('withdraw.confirmAction'),
          onPress: () => {
            run(row, action).catch(() => undefined);
          },
        },
      ],
    );
  };

  return (
    <View>
      <ActionCard>
        <Text style={{ color: colors.text }}>{t('withdraw.records')}</Text>
        <SmallTextButton
          title={t('withdraw.refreshRecords')}
          disabled={busy || loading || disabled}
          onPress={() => {
            load().catch(() => undefined);
          }}
        />
        {error ? (
          <InlineNotice>{t('withdraw.recordsError')}</InlineNotice>
        ) : null}
        {!loading && !rows.length && !error ? (
          <InlineNotice>{t('withdraw.noRecords')}</InlineNotice>
        ) : null}
      </ActionCard>
      {rows.map(row => (
        <ActionCard key={row.withdrawId}>
          <InfoRow
            label={t('withdraw.orderNo')}
            value={String(row.withdrawId)}
          />
          <InfoRow
            label={t('assetAction.status')}
            value={mapWithdrawStatus(row.status, t)}
          />
          <InfoRow
            label={t('assetAction.amount')}
            value={`${row.amount} ${row.symbol}`}
          />
          <InfoRow
            label={t('assetAction.network')}
            value={row.chainKey.toUpperCase()}
          />
          <InfoRow
            label={t('assetAction.address')}
            value={maskMiddle(row.toAddress)}
          />
          <InfoRow
            label={t('assetAction.fee')}
            value={`${row.fee} ${row.feeCoin}`}
          />
          {row.txHash ? <InfoRow label="TxID" value={row.txHash} mono /> : null}
          {canSendWithdraw(row.status, row.txHash) ? (
            <SmallTextButton
              title={t('withdraw.sendNow')}
              disabled={busy || loading || error || disabled}
              onPress={() => confirmAction(row, 'send')}
            />
          ) : null}
          {canCancelWithdraw(row.status, row.txHash) ? (
            <SmallTextButton
              title={t('withdraw.cancelRequest')}
              disabled={busy || loading || error || disabled}
              onPress={() => confirmAction(row, 'cancel')}
            />
          ) : null}
        </ActionCard>
      ))}
      <SmallTextButton
        title={t('withdraw.previousPage')}
        disabled={page === 0 || busy || loading}
        onPress={() => {
          setRows([]);
          setPage(value => value - 1);
        }}
      />
      <SmallTextButton
        title={t('withdraw.nextPage')}
        disabled={rows.length < 20 || busy || loading}
        onPress={() => {
          setRows([]);
          setPage(value => value + 1);
        }}
      />
    </View>
  );
}
