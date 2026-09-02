import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

export type QuickEntryItem = {
  id: string;
  title: string;
  description?: string;
  Icon: LucideIcon;
  onPress: () => void;
};

type Props = {
  entries?: readonly QuickEntryItem[];
};

export default function QuickEntryRow({ entries = [] }: Props) {
  const { t } = useLanguage();
  if (entries.length === 0) {
    return null;
  }

  return (
    <View style={styles.row}>
      {entries.map(item => {
        const Icon = item.Icon;

        return (
          <Pressable
            accessibilityLabel={
              item.description
                ? `${item.title}${t('common.a11ySeparator')}${item.description}`
                : item.title
            }
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            key={item.id}
            onPress={item.onPress}
            style={({ pressed }) => [
              styles.item,
              pressed ? styles.pressed : null,
            ]}
          >
            <View style={styles.icon}>
              <Icon color={colors.gold} size={20} strokeWidth={2.2} />
            </View>
            <Text style={styles.label} numberOfLines={1}>
              {item.title}
            </Text>
            {item.description ? (
              <Text style={styles.desc} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  row: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 9,
  },
  item: {
    flex: 1,
    alignItems: 'center',
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.16)',
  },
  label: {
    ...typography.bold,
    marginTop: 7,
    color: colors.text,
    fontSize: 11,
  },
  desc: {
    ...typography.medium,
    marginTop: 3,
    minHeight: 26,
    color: colors.textSubtle,
    fontSize: 10,
    lineHeight: 13,
    textAlign: 'center',
  },
});
