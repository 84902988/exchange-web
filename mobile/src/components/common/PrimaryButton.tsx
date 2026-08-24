import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, typography } from '../../theme';

type Props = {
  title: string;
  variant?: 'primary' | 'secondary';
  onPress?: () => void;
  disabled?: boolean;
};

export default function PrimaryButton({
  title,
  variant = 'primary',
  onPress,
  disabled = false,
}: Props) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{
        color: isPrimary ? 'rgba(0,0,0,0.14)' : 'rgba(214,168,50,0.12)',
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        isPrimary ? styles.primary : styles.secondary,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
      onPress={onPress}
    >
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[styles.label, isPrimary ? styles.primaryText : styles.text]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: colors.primary,
  },
  secondary: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: {
    ...typography.button,
  },
  primaryText: {
    color: colors.black,
  },
  text: {
    color: colors.text,
  },
  disabled: {
    opacity: 0.55,
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.985 }],
  },
});
