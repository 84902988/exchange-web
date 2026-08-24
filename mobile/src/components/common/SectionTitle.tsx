import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

type Props = {
  title: string;
  action?: string;
  onActionPress?: () => void;
};

export default function SectionTitle({ title, action, onActionPress }: Props) {
  const { t } = useLanguage();
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {action && onActionPress ? (
        <Pressable
          accessibilityLabel={`${title}${t('common.a11ySeparator')}${action}`}
          accessibilityRole="button"
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          hitSlop={6}
          onPress={onActionPress}
          style={({ pressed }) => [
            styles.actionButton,
            pressed ? styles.pressed : null,
          ]}
        >
          <Text style={styles.action}>{action}</Text>
        </Pressable>
      ) : action ? (
        <Text style={styles.action}>{action}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: { minHeight: 44, justifyContent: 'center' },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  row: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text,
  },
  action: {
    ...typography.action,
    color: colors.textMuted,
  },
});
