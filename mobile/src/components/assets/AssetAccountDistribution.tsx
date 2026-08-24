import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {formatAssetNumber} from '../../api/assets';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';

export type AssetDistributionItem = {
  key: string;
  label: string;
  value: number | null;
  color: string;
};

type Props = {
  items: AssetDistributionItem[];
  hidden?: boolean;
  valuationComplete?: boolean;
};

function AssetAccountDistribution({
  items,
  hidden = false,
  valuationComplete = true,
}: Props) {
  const {t} = useLanguage();
  const segments = getAssetDistributionSegments(
    items,
    valuationComplete,
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('assets.distribution')}</Text>
        <Text style={styles.meta}>
          {valuationComplete
            ? t('assets.usdtValuation')
            : t('assets.incompleteValuation')}
        </Text>
      </View>
      <View style={styles.bar}>
        {segments.length > 0 ? (
          segments.map(item => (
            <View
              key={item.key}
              style={[
                styles.segment,
                {backgroundColor: item.color, flex: item.value},
              ]}
            />
          ))
        ) : (
          <View style={[styles.segment, styles.incompleteSegment]} />
        )}
      </View>
      <View style={styles.list}>
        {items.map(item => (
          <View key={item.key} style={styles.row}>
            <View style={styles.nameWrap}>
              <View style={[styles.dot, {backgroundColor: item.color}]} />
              <Text style={styles.name}>{item.label}</Text>
            </View>
            <Text style={styles.value}>
              {hidden
                ? '******'
                : item.value === null
                  ? '-- USDT'
                  : `${formatAssetNumber(item.value, 2)} USDT`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export default React.memo(AssetAccountDistribution);

export function getAssetDistributionSegments(
  items: AssetDistributionItem[],
  valuationComplete: boolean,
) {
  if (!valuationComplete) return [];
  return items.filter(
    item =>
      typeof item.value === 'number' &&
      Number.isFinite(item.value) &&
      item.value > 0,
  ) as Array<AssetDistributionItem & {value: number}>;
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  meta: {
    color: colors.textSubtle,
    fontSize: 11,
  },
  bar: {
    height: 9,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 5,
    backgroundColor: colors.bgElevated,
    marginTop: 12,
  },
  segment: {
    height: 9,
  },
  incompleteSegment: {
    flex: 1,
    backgroundColor: colors.line,
  },
  list: {
    marginTop: 10,
    gap: 9,
  },
  row: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nameWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  name: {
    ...typography.bold,
    color: colors.text,
    fontSize: 12,
  },
  value: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
  },
});
