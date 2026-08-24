import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Laptop,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react-native';
import {
  fetchMyActiveSessions,
  revokeMyOtherSessions,
  revokeMySession,
  type ActiveSessionItem,
} from '../../api';
import {
  ActionCard,
  ActionHeader,
  InlineNotice,
  StateCard,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

export function formatSessionTime(value: string | null) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isMobileSession(
  item: Pick<ActiveSessionItem, 'deviceName' | 'userAgent'>,
) {
  return /android|ios|iphone|ipad/i.test(
    `${item.deviceName} ${item.userAgent}`,
  );
}

function SessionRow({
  item,
  disabled,
  onRevoke,
}: {
  item: ActiveSessionItem;
  disabled: boolean;
  onRevoke: (item: ActiveSessionItem) => void;
}) {
  const { t } = useLanguage();
  const DeviceIcon = isMobileSession(item) ? Smartphone : Laptop;
  return (
    <View style={styles.sessionRow}>
      <View
        style={[styles.deviceIcon, item.isCurrent ? styles.currentIcon : null]}
      >
        <DeviceIcon
          color={item.isCurrent ? colors.green : colors.gold}
          size={19}
        />
      </View>
      <View style={styles.sessionBody}>
        <View style={styles.sessionTitleRow}>
          <Text numberOfLines={1} style={styles.sessionTitle}>
            {item.deviceName}
          </Text>
          {item.isCurrent ? (
            <View style={styles.currentBadge}>
              <ShieldCheck color={colors.green} size={12} />
              <Text style={styles.currentBadgeText}>
                {t('sessions.currentDevice')}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.sessionMeta}>{item.ipAddress}</Text>
        <Text style={styles.sessionTime}>
          {t('sessions.lastUsed', {
            time: formatSessionTime(item.lastUsedAt || item.createdAt),
          })}
        </Text>
        <Text style={styles.sessionExpiry}>
          {t('sessions.expires', { time: formatSessionTime(item.expiresAt) })}
        </Text>
      </View>
      {!item.isCurrent ? (
        <Pressable
          accessibilityLabel={t('sessions.revokeA11y', {
            device: item.deviceName,
          })}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(240, 90, 90, 0.14)' }}
          disabled={disabled}
          onPress={() => onRevoke(item)}
          style={({ pressed }) => [
            styles.revokeButton,
            disabled ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <LogOut color={colors.red} size={15} />
          <Text style={styles.revokeText}>{t('sessions.revoke')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function SessionManagementScreen({
  navigation,
}: {
  navigation: any;
}) {
  const { t } = useLanguage();
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadLockRef = useRef(false);
  const submitLockRef = useRef(false);
  const confirmationOpenRef = useRef(false);
  const [items, setItems] = useState<ActiveSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const otherCount = useMemo(
    () => items.filter(item => !item.isCurrent).length,
    [items],
  );

  const load = useCallback(async () => {
    if (loadLockRef.current) return;
    loadLockRef.current = true;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await fetchMyActiveSessions(controller.signal);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      )
        return;
      setItems(result.items);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      )
        return;
      setError(toChineseError(requestError, t('sessions.loadError')));
    } finally {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        generation === loadGenerationRef.current
      ) {
        setLoading(false);
      }
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        loadLockRef.current = false;
      }
    }
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    load().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      confirmationOpenRef.current = false;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadLockRef.current = false;
    };
  }, [load]);

  const revokeOne = useCallback(
    (item: ActiveSessionItem) => {
      if (confirmationOpenRef.current || submitLockRef.current) return;
      confirmationOpenRef.current = true;
      Alert.alert(
        t('sessions.revokeTitle'),
        t('sessions.revokeDescription', {
          device: item.deviceName,
          ip: item.ipAddress,
        }),
        [
          {
            text: t('common.cancel'),
            style: 'cancel',
            onPress: () => {
              confirmationOpenRef.current = false;
            },
          },
          {
            text: t('sessions.revokeConfirm'),
            style: 'destructive',
            onPress: async () => {
              confirmationOpenRef.current = false;
              if (submitLockRef.current) return;
              submitLockRef.current = true;
              setSubmitting(true);
              setError('');
              try {
                await revokeMySession(item.id);
                if (mountedRef.current) {
                  setItems(current =>
                    current.filter(session => session.id !== item.id),
                  );
                }
              } catch (requestError) {
                if (mountedRef.current) {
                  setError(
                    toChineseError(requestError, t('sessions.revokeFailed')),
                  );
                }
              } finally {
                submitLockRef.current = false;
                if (mountedRef.current) setSubmitting(false);
              }
            },
          },
        ],
        {
          onDismiss: () => {
            confirmationOpenRef.current = false;
          },
        },
      );
    },
    [t],
  );

  const revokeOthers = useCallback(() => {
    if (
      otherCount === 0 ||
      submitting ||
      loading ||
      confirmationOpenRef.current ||
      submitLockRef.current
    ) {
      return;
    }
    confirmationOpenRef.current = true;
    Alert.alert(
      t('sessions.revokeOthersTitle'),
      t('sessions.revokeOthersDescription', { count: otherCount }),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: t('sessions.revokeConfirm'),
          style: 'destructive',
          onPress: async () => {
            confirmationOpenRef.current = false;
            if (submitLockRef.current) return;
            submitLockRef.current = true;
            setSubmitting(true);
            setError('');
            try {
              await revokeMyOtherSessions();
              if (mountedRef.current) {
                setItems(current => current.filter(item => item.isCurrent));
              }
            } catch (requestError) {
              if (mountedRef.current) {
                setError(
                  toChineseError(
                    requestError,
                    t('sessions.revokeOthersFailed'),
                  ),
                );
              }
            } finally {
              submitLockRef.current = false;
              if (mountedRef.current) setSubmitting(false);
            }
          },
        },
      ],
      {
        onDismiss: () => {
          confirmationOpenRef.current = false;
        },
      },
    );
  }, [loading, otherCount, submitting, t]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
        right={
          <Pressable
            accessibilityLabel={t('sessions.refreshA11y')}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
            disabled={loading || submitting}
            onPress={() => load()}
            testID="sessions-refresh"
            style={({ pressed }) => [
              styles.refreshButton,
              pressed ? styles.pressed : null,
            ]}
          >
            <RefreshCw color={colors.textMuted} size={17} />
          </Pressable>
        }
      />
      {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
      {loading && items.length === 0 ? (
        <StateCard
          title={t('sessions.loading')}
          description={t('sessions.loadingDescription')}
        />
      ) : items.length === 0 ? (
        <StateCard
          title={t('sessions.empty')}
          description={t('sessions.emptyDescription')}
          actionTitle={t('common.reload')}
          onActionPress={() => load()}
        />
      ) : (
        <ActionCard>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>
                {t('sessions.activeDevices')}
              </Text>
              <Text style={styles.sectionHint}>{t('sessions.activeHint')}</Text>
            </View>
            <Text style={styles.countText}>
              {t('sessions.count', { count: items.length })}
            </Text>
          </View>
          {items.map(item => (
            <SessionRow
              disabled={submitting || loading}
              item={item}
              key={item.id}
              onRevoke={revokeOne}
            />
          ))}
        </ActionCard>
      )}
      <ActionCard>
        <Text style={styles.sectionTitle}>{t('sessions.quickProtection')}</Text>
        <Text style={styles.sectionHint}>{t('sessions.quickDescription')}</Text>
        <Pressable
          accessibilityLabel={t('sessions.revokeOthersA11y')}
          accessibilityRole="button"
          accessibilityState={{
            disabled: otherCount === 0 || submitting || loading,
          }}
          android_ripple={{ color: 'rgba(240, 90, 90, 0.14)' }}
          disabled={otherCount === 0 || submitting || loading}
          onPress={revokeOthers}
          style={({ pressed }) => [
            styles.revokeOthersButton,
            otherCount === 0 || submitting || loading ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <LogOut color={colors.red} size={17} />
          <Text style={styles.revokeOthersText}>
            {submitting
              ? t('common.processing')
              : t('sessions.revokeOthersButton', { count: otherCount })}
          </Text>
        </Pressable>
      </ActionCard>
      <InlineNotice>{t('sessions.currentDeviceNotice')}</InlineNotice>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  refreshButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  sectionHint: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  countText: { ...typography.bold, color: colors.gold, fontSize: 12 },
  sessionRow: {
    minHeight: 98,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  deviceIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.goldSoft,
  },
  currentIcon: { backgroundColor: 'rgba(25,195,125,0.1)' },
  sessionBody: { flex: 1, minWidth: 0 },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sessionTitle: {
    ...typography.bold,
    flexShrink: 1,
    color: colors.text,
    fontSize: 13,
  },
  currentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(25,195,125,0.1)',
  },
  currentBadgeText: { ...typography.bold, color: colors.green, fontSize: 9 },
  sessionMeta: { marginTop: 5, color: colors.textMuted, fontSize: 11 },
  sessionTime: { marginTop: 4, color: colors.textMuted, fontSize: 10 },
  sessionExpiry: { marginTop: 3, color: colors.textSubtle, fontSize: 10 },
  revokeButton: {
    minWidth: 68,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(240,90,90,0.22)',
    backgroundColor: 'rgba(240,90,90,0.08)',
  },
  revokeText: { ...typography.bold, color: colors.red, fontSize: 11 },
  revokeOthersButton: {
    marginTop: 15,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(240,90,90,0.24)',
    backgroundColor: 'rgba(240,90,90,0.08)',
  },
  revokeOthersText: { ...typography.bold, color: colors.red, fontSize: 13 },
  disabled: { opacity: 0.45 },
});
