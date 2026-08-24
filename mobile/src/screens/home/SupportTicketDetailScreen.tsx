import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  addSupportTicketMessage,
  closeSupportTicket,
  fetchSupportTicketDetail,
  markSupportTicketRead,
  type SupportTicket,
  type SupportTicketStatus,
} from '../../api/support';
import { ApiClientError } from '../../api/client';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  InlineNotice,
  RefreshButton,
  StateCard,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type Navigation = NativeStackNavigationProp<
  RootStackParamList,
  'SupportTicketDetail'
>;
type DetailRoute = RouteProp<RootStackParamList, 'SupportTicketDetail'>;

export function formatSupportTime(value: string | null) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusTone(status: SupportTicketStatus) {
  if (status === 'REPLIED') return colors.green;
  if (status === 'CLOSED') return colors.textMuted;
  if (status === 'IN_PROGRESS') return colors.blue;
  return colors.gold;
}

export default function SupportTicketDetailScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DetailRoute>();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [readSyncError, setReadSyncError] = useState(false);
  const mountedRef = useRef(true);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadLockRef = useRef(false);
  const submitLockRef = useRef(false);
  const confirmationOpenRef = useRef(false);

  const syncRead = useCallback(
    async (nextTicket: SupportTicket, signal?: AbortSignal) => {
      const lastMessage = nextTicket.messages[nextTicket.messages.length - 1];
      if (!lastMessage) return;
      try {
        await markSupportTicketRead(nextTicket.id, lastMessage.id, { signal });
        if (mountedRef.current && !signal?.aborted) setReadSyncError(false);
      } catch {
        if (mountedRef.current && !signal?.aborted) setReadSyncError(true);
      }
    },
    [],
  );

  const load = useCallback(async () => {
    if (loadLockRef.current) return;
    loadLockRef.current = true;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    setError('');
    setReadSyncError(false);
    try {
      const result = await fetchSupportTicketDetail(route.params.ticketId, {
        signal: controller.signal,
      });
      if (mountedRef.current && !controller.signal.aborted) {
        setTicket(result);
        syncRead(result, controller.signal).catch(() => undefined);
      }
    } catch (requestError) {
      if (mountedRef.current && !controller.signal.aborted) {
        setError(
          localizeSupportTicketError(
            requestError,
            tRef.current,
            tRef.current('supportTicket.detail.loadFailed'),
          ),
        );
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        loadLockRef.current = false;
      }
    }
  }, [route.params.ticketId, syncRead]);

  useEffect(() => {
    mountedRef.current = true;
    load().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      confirmationOpenRef.current = false;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadLockRef.current = false;
    };
  }, [load]);

  const submitReply = useCallback(async () => {
    const cleanMessage = message.trim();
    if (
      submitLockRef.current ||
      submitting ||
      ticket?.status === 'CLOSED' ||
      !cleanMessage
    ) {
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const updated = await addSupportTicketMessage(ticket!.id, cleanMessage);
      if (mountedRef.current) {
        setTicket(updated);
        syncRead(updated).catch(() => undefined);
        setMessage('');
        setNotice(tRef.current('supportTicket.detail.replySuccess'));
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          localizeSupportTicketError(
            requestError,
            tRef.current,
            tRef.current('supportTicket.detail.replyFailed'),
          ),
        );
      }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [message, submitting, syncRead, ticket]);

  const executeClose = useCallback(async () => {
    if (!ticket || closing || submitLockRef.current) return;
    submitLockRef.current = true;
    setClosing(true);
    setError('');
    setNotice('');
    try {
      const updated = await closeSupportTicket(ticket.id);
      if (mountedRef.current) {
        setTicket(updated);
        setMessage('');
        setNotice(tRef.current('supportTicket.detail.closedSuccess'));
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          localizeSupportTicketError(
            requestError,
            tRef.current,
            tRef.current('supportTicket.detail.closeFailed'),
          ),
        );
      }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setClosing(false);
    }
  }, [closing, ticket]);

  const confirmClose = useCallback(() => {
    if (
      !ticket ||
      ticket.status === 'CLOSED' ||
      closing ||
      confirmationOpenRef.current ||
      submitLockRef.current
    )
      return;
    confirmationOpenRef.current = true;
    Alert.alert(
      tRef.current('supportTicket.detail.closeTitle'),
      tRef.current('supportTicket.detail.closeDescription'),
      [
        {
          text: tRef.current('supportTicket.detail.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: tRef.current('supportTicket.detail.confirmClose'),
          style: 'destructive',
          onPress: () => {
            confirmationOpenRef.current = false;
            executeClose().catch(() => undefined);
          },
        },
      ],
      {
        onDismiss: () => {
          confirmationOpenRef.current = false;
        },
      },
    );
  }, [closing, executeClose, ticket]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('supportTicket.detail.title')}
        subtitle={ticket?.ticketNo || t('supportTicket.detail.subtitle')}
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={() => load()} />}
      />
      {loading && !ticket ? (
        <StateCard
          title={t('supportTicket.detail.loading')}
          description={t('supportTicket.detail.pleaseWait')}
        />
      ) : !ticket ? (
        <StateCard
          title={t('supportTicket.detail.unavailable')}
          description={error || t('supportTicket.detail.tryAgain')}
          actionTitle={t('supportTicket.reload')}
          onActionPress={() => load()}
        />
      ) : (
        <>
          <ActionCard>
            <View style={styles.titleRow}>
              <View style={styles.titleCopy}>
                <Text style={styles.subject}>{ticket.subject}</Text>
                <Text style={styles.meta}>
                  {t('supportTicket.detail.updatedAt', {
                    category: ticket.categoryLabel,
                    time: formatSupportTime(ticket.updatedAt),
                  })}
                </Text>
              </View>
              <Text
                style={[styles.status, { color: statusTone(ticket.status) }]}
              >
                {ticket.statusLabel}
              </Text>
            </View>
          </ActionCard>

          <ActionCard>
            <Text style={styles.sectionTitle}>
              {t('supportTicket.detail.conversation')}
            </Text>
            {ticket.messages.length === 0 ? (
              <View style={styles.bubble}>
                <Text style={styles.sender}>
                  {t('supportTicket.detail.me')}
                </Text>
                <Text style={styles.message}>{ticket.content}</Text>
                <Text style={styles.time}>
                  {formatSupportTime(ticket.createdAt)}
                </Text>
              </View>
            ) : (
              ticket.messages.map(item => {
                const isAdmin = item.senderType === 'ADMIN';
                return (
                  <View
                    key={item.id}
                    style={[
                      styles.bubble,
                      isAdmin ? styles.adminBubble : styles.userBubble,
                    ]}
                  >
                    <Text
                      style={[
                        styles.sender,
                        isAdmin ? styles.adminSender : null,
                      ]}
                    >
                      {isAdmin
                        ? t('supportTicket.detail.support')
                        : t('supportTicket.detail.me')}
                    </Text>
                    <Text style={styles.message}>{item.message}</Text>
                    <Text style={styles.time}>
                      {formatSupportTime(item.createdAt)}
                    </Text>
                  </View>
                );
              })
            )}
          </ActionCard>

          {ticket.status === 'CLOSED' ? (
            <InlineNotice>{t('supportTicket.detail.closed')}</InlineNotice>
          ) : (
            <ActionCard>
              <Text style={styles.sectionTitle}>
                {t('supportTicket.detail.addDetails')}
              </Text>
              <ActionTextField
                label={t('supportTicket.detail.message')}
                value={message}
                onChangeText={setMessage}
                placeholder={t('supportTicket.detail.messagePlaceholder')}
                multiline
                maxLength={5000}
              />
              <Text style={styles.counter}>{message.length}/5000</Text>
              <View style={styles.actionRow}>
                <View style={styles.actionButton}>
                  <PrimaryButton
                    title={
                      submitting
                        ? t('supportTicket.detail.sending')
                        : t('supportTicket.detail.send')
                    }
                    disabled={submitting || closing || !message.trim()}
                    onPress={submitReply}
                  />
                </View>
                <View style={styles.closeButton}>
                  <PrimaryButton
                    title={
                      closing
                        ? t('supportTicket.detail.closing')
                        : t('supportTicket.detail.close')
                    }
                    variant="secondary"
                    disabled={submitting || closing}
                    onPress={confirmClose}
                  />
                </View>
              </View>
            </ActionCard>
          )}
          {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
          {readSyncError ? (
            <InlineNotice>
              {t('supportTicket.detail.readSyncWarning')}
            </InlineNotice>
          ) : null}
          {notice ? <InlineNotice tone="green">{notice}</InlineNotice> : null}
        </>
      )}
    </AppScreen>
  );
}

function localizeSupportTicketError(
  error: unknown,
  t: Translator,
  fallback: string,
) {
  if (
    error instanceof ApiClientError &&
    error.code === 'INVALID_SUPPORT_RESPONSE'
  ) {
    return t('supportTicket.contractInvalid');
  }
  return toChineseError(error, fallback, t);
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  titleCopy: { flex: 1, minWidth: 0 },
  subject: {
    ...typography.bold,
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
  },
  meta: { marginTop: 5, color: colors.textMuted, fontSize: 10, lineHeight: 15 },
  status: { ...typography.bold, fontSize: 11 },
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  bubble: {
    marginTop: 12,
    borderRadius: 10,
    padding: 12,
    backgroundColor: colors.cardAlt,
  },
  adminBubble: { marginRight: 28, backgroundColor: 'rgba(214,168,50,0.11)' },
  userBubble: { marginLeft: 28, backgroundColor: colors.cardAlt },
  sender: { ...typography.bold, color: colors.textMuted, fontSize: 11 },
  adminSender: { color: colors.gold },
  message: { marginTop: 6, color: colors.text, fontSize: 13, lineHeight: 20 },
  time: { marginTop: 7, color: colors.textSubtle, fontSize: 9 },
  counter: {
    marginTop: 5,
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'right',
  },
  actionRow: { marginTop: 14, flexDirection: 'row', gap: 10 },
  actionButton: { flex: 1.25 },
  closeButton: { flex: 1 },
});
