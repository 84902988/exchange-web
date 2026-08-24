import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = {
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
};

export function isStrongPassword(value: string) {
  return (
    value.length >= 8 &&
    value.length <= 64 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

export default function PasswordField({
  accessibilityLabel,
  placeholder,
  value,
  onChangeText,
  autoComplete,
}: Props) {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);

  return (
    <View style={styles.container}>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoCapitalize="none"
        autoComplete={autoComplete}
        autoCorrect={false}
        importantForAutofill="yes"
        maxLength={64}
        placeholder={placeholder}
        placeholderTextColor={colors.textSubtle}
        secureTextEntry={!visible}
        style={styles.input}
        textContentType={
          autoComplete === 'current-password' ? 'password' : 'newPassword'
        }
        value={value}
        onChangeText={onChangeText}
      />
      <Pressable
        accessibilityLabel={
          visible ? t('auth.hidePassword') : t('auth.showPassword')
        }
        accessibilityRole="button"
        accessibilityState={{ expanded: visible }}
        android_ripple={{ color: 'rgba(212, 175, 55, 0.12)', borderless: true }}
        hitSlop={4}
        style={({ pressed }) => [
          styles.visibilityButton,
          pressed ? styles.pressed : null,
        ]}
        onPress={() => setVisible(current => !current)}
      >
        {visible ? (
          <EyeOff color={colors.textMuted} size={20} />
        ) : (
          <Eye color={colors.textMuted} size={20} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.68, transform: [{ scale: 0.94 }] },
  container: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  input: {
    ...typography.regular,
    minWidth: 0,
    flex: 1,
    height: 48,
    paddingLeft: 14,
    paddingRight: 4,
    color: colors.text,
  },
  visibilityButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
