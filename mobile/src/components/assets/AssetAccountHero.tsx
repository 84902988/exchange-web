import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, typography } from '../../theme';
import { shouldUseCompactAssetLayout } from './assetLayout';

type Props = {
  Icon: LucideIcon;
  accentColor: string;
  eyebrow: string;
  title: string;
  value: string;
  valueLabel: string;
  meta: string;
};

function AssetAccountHero({
  Icon,
  accentColor,
  eyebrow,
  title,
  value,
  valueLabel,
  meta,
}: Props) {
  const { width, fontScale } = useWindowDimensions();
  const compact = shouldUseCompactAssetLayout(width, fontScale);

  return (
    <View
      style={[
        styles.card,
        compact ? styles.cardCompact : null,
        { borderColor: `${accentColor}66` },
      ]}
    >
      <View
        pointerEvents="none"
        style={[styles.decorativeOrb, { backgroundColor: `${accentColor}18` }]}
      />
      <View style={styles.header}>
        <View
          style={[styles.iconWrap, { backgroundColor: `${accentColor}20` }]}
        >
          <Icon color={accentColor} size={21} strokeWidth={2.1} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={[styles.eyebrow, { color: accentColor }]}>
            {eyebrow}
          </Text>
          <Text numberOfLines={2} style={styles.title}>{title}</Text>
        </View>
      </View>
      <Text style={styles.valueLabel}>{valueLabel}</Text>
      <Text
        numberOfLines={2}
        style={[styles.value, compact ? styles.valueCompact : null]}
      >
        {value}
      </Text>
      <View style={styles.metaRow}>
        <View style={[styles.metaDot, { backgroundColor: accentColor }]} />
        <Text numberOfLines={2} style={styles.meta}>{meta}</Text>
      </View>
    </View>
  );
}

export default React.memo(AssetAccountHero);

const styles = StyleSheet.create({
  card: {
    minHeight: 164,
    marginTop: 12,
    overflow: 'hidden',
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: colors.card,
    padding: 16,
  },
  cardCompact: {
    minHeight: 180,
  },
  decorativeOrb: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 75,
    top: -72,
    right: -48,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconWrap: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
  },
  headerCopy: {
    flex: 1,
    marginLeft: 11,
  },
  eyebrow: {
    ...typography.bold,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  title: {
    ...typography.bold,
    marginTop: 2,
    color: colors.text,
    fontSize: 15,
  },
  valueLabel: {
    marginTop: 17,
    color: colors.textSubtle,
    fontSize: 10,
  },
  value: {
    ...typography.number,
    marginTop: 5,
    color: colors.text,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  valueCompact: {
    fontSize: 20,
    lineHeight: 27,
  },
  metaRow: {
    marginTop: 13,
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  meta: {
    flex: 1,
    marginLeft: 7,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
});
