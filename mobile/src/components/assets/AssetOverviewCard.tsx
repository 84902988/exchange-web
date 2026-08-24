import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  CircleCheck,
  Eye,
  EyeOff,
  LogIn,
  TriangleAlert,
} from 'lucide-react-native';
import { formatAssetNumber } from '../../api/assets';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = {
  isLoggedIn: boolean;
  totalUsdt: number | null;
  valuationComplete: boolean;
  snapshotAvailable: boolean;
  hidden: boolean;
  loading?: boolean;
  stale?: boolean;
  fetchedAt?: number | null;
  onToggleHidden: () => void;
};

function AssetOverviewCard({
  isLoggedIn,
  totalUsdt,
  valuationComplete,
  snapshotAvailable,
  hidden,
  loading = false,
  stale = false,
  fetchedAt = null,
  onToggleHidden,
}: Props) {
  const { t } = useLanguage();
  const { width, fontScale } = useWindowDimensions();
  const compact = width <= 360 || fontScale >= 1.2;
  const canDisplayTotal = !loading && valuationComplete && totalUsdt !== null;
  const displayAmount = hidden
    ? '******'
    : canDisplayTotal
    ? formatAssetNumber(totalUsdt, 2)
    : '--';
  const Icon = hidden ? EyeOff : Eye;
  const StatusIcon = !isLoggedIn
    ? LogIn
    : canDisplayTotal && !stale
    ? CircleCheck
    : TriangleAlert;
  const status = getSnapshotStatus(
    {
      canDisplayTotal,
      isLoggedIn,
      loading,
      snapshotAvailable,
      stale,
      valuationComplete,
    },
    t,
  );

  return (
    <View style={styles.card}>
      <View style={[styles.topRow, compact ? styles.topRowCompact : null]}>
        <View style={styles.amountWrap}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>{t('assets.totalValuation')}</Text>
            {isLoggedIn ? (
              <Pressable
                accessibilityLabel={
                  hidden ? t('assets.show') : t('assets.hide')
                }
                accessibilityRole="button"
                android_ripple={{
                  color: 'rgba(212, 175, 55, 0.12)',
                  borderless: true,
                }}
                style={({ pressed }) => [
                  styles.eyeButton,
                  pressed ? styles.pressed : null,
                ]}
                onPress={onToggleHidden}
              >
                <Icon color={colors.textMuted} size={14} strokeWidth={2.2} />
              </Pressable>
            ) : null}
          </View>
          <Text maxFontSizeMultiplier={1.2} style={styles.amount}>
            {displayAmount} USDT
          </Text>
        </View>
        <View
          style={[styles.statusWrap, compact ? styles.statusWrapCompact : null]}
        >
          <StatusIcon
            color={
              !isLoggedIn
                ? colors.textMuted
                : canDisplayTotal && !stale
                ? colors.green
                : colors.gold
            }
            size={22}
            strokeWidth={2}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.statusTitle,
              compact ? styles.statusTextCompact : null,
            ]}
          >
            {status}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.statusTime,
              compact ? styles.statusTextCompact : null,
            ]}
          >
            {!isLoggedIn
              ? t('assets.notLoggedIn')
              : fetchedAt
              ? t('assets.updatedAt', { time: formatSnapshotTime(fetchedAt) })
              : t('assets.noUpdateTime')}
          </Text>
        </View>
      </View>
      <View style={styles.footerRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{t('assets.pricingUnit')}</Text>
          <Text style={styles.metricValue}>USDT</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{t('assets.assetView')}</Text>
          <Text style={styles.metricValue}>
            {!isLoggedIn
              ? t('assets.loginToDisplay')
              : !snapshotAvailable
              ? t('assets.dataPending')
              : valuationComplete
              ? t('assets.completeValuation')
              : t('assets.incompleteValuation')}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default React.memo(AssetOverviewCard);

function getSnapshotStatus(
  {
    canDisplayTotal,
    isLoggedIn,
    loading,
    snapshotAvailable,
    stale,
    valuationComplete,
  }: {
    canDisplayTotal: boolean;
    isLoggedIn: boolean;
    loading: boolean;
    snapshotAvailable: boolean;
    stale: boolean;
    valuationComplete: boolean;
  },
  t: Translator,
) {
  if (!isLoggedIn) return t('assets.loginToDisplay');
  if (loading) return t('assets.reading');
  if (stale) return t('assets.dataPending');
  if (!snapshotAvailable) return t('assets.noData');
  if (!valuationComplete) return t('assets.missingMarket');
  if (!canDisplayTotal) return t('assets.noData');
  return t('assets.completeValuation');
}

function formatSnapshotTime(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.68, transform: [{ scale: 0.94 }] },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.34)',
    backgroundColor: colors.card,
    padding: 18,
  },
  topRow: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  topRowCompact: {
    minHeight: 0,
    flexDirection: 'column',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
  },
  amountWrap: {
    minWidth: 0,
    flexShrink: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
  },
  eyeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amount: {
    ...typography.cardNumber,
    marginTop: 8,
    color: colors.text,
    fontSize: 28,
  },
  statusWrap: {
    width: 104,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  statusWrapCompact: {
    width: '100%',
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
  },
  statusTitle: {
    ...typography.bold,
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
  },
  statusTime: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 9,
  },
  statusTextCompact: {
    marginTop: 0,
  },
  footerRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 10,
  },
  metricLabel: {
    color: colors.textSubtle,
    fontSize: 10,
  },
  metricValue: {
    ...typography.bold,
    marginTop: 4,
    color: colors.gold,
    fontSize: 12,
  },
});
