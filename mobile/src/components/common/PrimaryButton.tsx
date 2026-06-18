import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {colors} from '../../theme';

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
      disabled={disabled}
      style={[
        styles.button,
        isPrimary ? styles.primary : styles.secondary,
        disabled ? styles.disabled : null,
      ]}
      onPress={onPress}>
      <Text style={[styles.label, isPrimary ? styles.primaryText : styles.text]}>
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
    fontSize: 15,
    fontWeight: '800',
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
});
