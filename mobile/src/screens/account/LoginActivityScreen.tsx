import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CircleAlert, Laptop, MapPin, ShieldCheck } from 'lucide-react-native';
import { fetchMyLoginLogs, type LoginLogItem } from '../../api';
import {
  ActionCard,
  ActionHeader,
  InlineNotice,
  RefreshButton,
  StateCard,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

export function formatLoginTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDeviceName(value: string, t?: Translator) {
  const normalized = value.trim();
  if (
    !normalized ||
    /^unknown(?: browser)?(?:\s*\/\s*unknown os)?$/i.test(normalized) ||
    /^unknown device$/i.test(normalized)
  ) {
    return t?.('loginActivity.unknownDevice') || '未知设备';
  }
  return normalized;
}

export function formatLoginFailureReason(value: string | null, t?: Translator) {
  const message = (value || '').trim();
  if (!message) return t?.('loginActivity.defaultFailure') || '登录验证未通过';
  const normalized = message.toLowerCase();
  if (normalized.includes('credential') || normalized.includes('password')) {
    return t?.('loginActivity.credentialsFailure') || '账号或密码验证失败';
  }
  if (normalized.includes('captcha'))
    return t?.('loginActivity.captchaFailure') || '图形验证码验证失败';
  if (normalized.includes('locked') || normalized.includes('too many')) {
    return (
      t?.('loginActivity.lockedFailure') || '登录失败次数过多，账户已临时保护'
    );
  }
  return /[\u3400-\u9fff]/.test(message) && message.length <= 80
    ? message
    : t?.('loginActivity.defaultFailure') || '登录验证未通过';
}

function recentDevices(items: LoginLogItem[]) {
  const seen = new Set<string>();
  return items
    .filter(item => {
      if (item.status !== 'SUCCESS') return false;
      const key = `${item.deviceName}|${item.userAgent}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function LogRow({ item }: { item: LoginLogItem }) {
  const { t } = useLanguage();
  const success = item.status === 'SUCCESS';
  return (
    <View style={styles.logRow}>
      <View
        style={[
          styles.statusIcon,
          success ? styles.successIcon : styles.failedIcon,
        ]}
      >
        {success ? (
          <ShieldCheck color={colors.green} size={17} />
        ) : (
          <CircleAlert color={colors.red} size={17} />
        )}
      </View>
      <View style={styles.logText}>
        <View style={styles.logTitleRow}>
          <Text numberOfLines={1} style={styles.deviceName}>
            {formatDeviceName(item.deviceName, t)}
          </Text>
          <Text style={success ? styles.success : styles.failed}>
            {success ? t('loginActivity.success') : t('loginActivity.failure')}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.logMeta}>
          {item.ipAddress} ·{' '}
          {item.countryCode === 'UNKNOWN'
            ? t('loginActivity.regionUnknown')
            : item.countryCode}
        </Text>
        <Text style={styles.logTime}>{formatLoginTime(item.createdAt)}</Text>
        {!success && item.failureReason ? (
          <Text numberOfLines={2} style={styles.failureReason}>
            {formatLoginFailureReason(item.failureReason, t)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default function LoginActivityScreen({
  navigation,
}: {
  navigation: any;
}) {
  const { t } = useLanguage();
  const mountedRef = useRef(true);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const loadLockRef = useRef(false);
  const [items, setItems] = useState<LoginLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const devices = useMemo(() => recentDevices(items), [items]);

  const load = useCallback(async () => {
    if (loadLockRef.current) return;
    loadLockRef.current = true;
    const generation = ++loadGenerationRef.current;
    const controller = new AbortController();
    loadControllerRef.current?.abort();
    loadControllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchMyLoginLogs(30, controller.signal);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      ) {
        return;
      }
      setItems(result);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      ) {
        return;
      }
      setError(toChineseError(requestError, t('loginActivity.loadError')));
    } finally {
      if (generation === loadGenerationRef.current) {
        loadLockRef.current = false;
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null;
        }
        if (mountedRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    load().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      loadLockRef.current = false;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
    };
  }, [load]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('loginActivity.title')}
        subtitle={t('loginActivity.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading}
            onPress={() => load()}
          />
        }
      />
      {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
      {loading && items.length === 0 ? (
        <StateCard
          title={t('loginActivity.loading')}
          description={t('common.pleaseWait')}
        />
      ) : items.length === 0 ? (
        <StateCard
          title={t('loginActivity.empty')}
          description={t('loginActivity.emptyDescription')}
        />
      ) : (
        <>
          <ActionCard>
            <Text style={styles.sectionTitle}>
              {t('loginActivity.recentDevices')}
            </Text>
            <Text style={styles.sectionHint}>
              {t('loginActivity.deviceHint')}
            </Text>
            {devices.map(item => (
              <View key={`device-${item.id}`} style={styles.deviceRow}>
                <View style={styles.deviceIcon}>
                  <Laptop color={colors.gold} size={18} />
                </View>
                <View style={styles.deviceText}>
                  <Text numberOfLines={1} style={styles.deviceName}>
                    {formatDeviceName(item.deviceName, t)}
                  </Text>
                  <View style={styles.locationRow}>
                    <MapPin color={colors.textSubtle} size={12} />
                    <Text style={styles.deviceMeta}>
                      {item.ipAddress} · {formatLoginTime(item.createdAt)}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </ActionCard>
          <ActionCard>
            <Text style={styles.sectionTitle}>
              {t('loginActivity.allRecords')}
            </Text>
            {items.map(item => (
              <LogRow item={item} key={item.id} />
            ))}
          </ActionCard>
        </>
      )}
      <InlineNotice>{t('loginActivity.warning')}</InlineNotice>
    </AppScreen>
  );
}

export { recentDevices };

const styles = StyleSheet.create({
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  sectionHint: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  deviceRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  deviceIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.goldSoft,
  },
  deviceText: { flex: 1, minWidth: 0 },
  deviceName: { ...typography.bold, flex: 1, color: colors.text, fontSize: 13 },
  locationRow: {
    marginTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  deviceMeta: { color: colors.textMuted, fontSize: 10 },
  logRow: {
    minHeight: 80,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  statusIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
  },
  successIcon: { backgroundColor: 'rgba(25,195,125,0.1)' },
  failedIcon: { backgroundColor: 'rgba(240,90,90,0.1)' },
  logText: { flex: 1, minWidth: 0 },
  logTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  success: { ...typography.bold, color: colors.green, fontSize: 10 },
  failed: { ...typography.bold, color: colors.red, fontSize: 10 },
  logMeta: { marginTop: 5, color: colors.textMuted, fontSize: 10 },
  logTime: { marginTop: 4, color: colors.textSubtle, fontSize: 10 },
  failureReason: {
    marginTop: 5,
    color: colors.red,
    fontSize: 10,
    lineHeight: 15,
  },
});
