import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import type {LucideIcon} from 'lucide-react-native';
import {colors} from '../../theme';

type Props = {
  icon: LucideIcon;
  accessibilityLabel: string;
  onPress?: () => void;
  badge?: boolean;
};

export default function IconButton({
  icon: Icon,
  accessibilityLabel,
  onPress,
  badge,
}: Props) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={styles.button}
      onPress={onPress}>
      <Icon color={colors.text} size={21} strokeWidth={2.2} />
      {badge ? <View style={styles.badge} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 7,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: colors.card,
  },
});
