import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { sendOtp, type OtpScene } from '../../api/auth';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type FeedbackKind = 'error' | 'success';

type Props = {
  email: string;
  value: string;
  scene?: Extract<OtpScene, 'register' | 'reset'>;
  onRequestCode?: (normalizedEmail: string) => Promise<unknown>;
  onChangeText: (value: string) => void;
  onFeedback: (message: string, kind: FeedbackKind) => void;
};

export function normalizeEmailInput(value: string) {
  return value.trim().toLowerCase();
}

export function isValidEmailInput(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmailInput(value));
}

export default function EmailOtpField({
  email,
  value,
  scene,
  onRequestCode,
  onChangeText,
  onFeedback,
}: Props) {
  const { t } = useLanguage();
  const [sending, setSending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const sendLockRef = useRef(false);
  const sentEmailRef = useRef('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendLockRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setTimeout(() => {
      setCooldownSeconds(current => Math.max(0, current - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  useEffect(() => {
    if (
      cooldownSeconds > 0 &&
      sentEmailRef.current &&
      normalizeEmailInput(email) !== sentEmailRef.current
    ) {
      sentEmailRef.current = '';
      setCooldownSeconds(0);
    }
  }, [cooldownSeconds, email]);

  const requestCode = async () => {
    if (sendLockRef.current || cooldownSeconds > 0) return;

    const normalizedEmail = normalizeEmailInput(email);
    if (!isValidEmailInput(normalizedEmail)) {
      onFeedback(t('auth.invalidEmail'), 'error');
      return;
    }

    sendLockRef.current = true;
    setSending(true);
    try {
      if (onRequestCode) {
        await onRequestCode(normalizedEmail);
      } else if (scene) {
        await sendOtp({ email: normalizedEmail, scene });
      } else {
        throw new Error(t('auth.otpSendNotConfigured'));
      }
      if (!mountedRef.current) return;
      sentEmailRef.current = normalizedEmail;
      setCooldownSeconds(60);
      onFeedback(t('auth.otpSent'), 'success');
    } catch (error) {
      if (!mountedRef.current) return;
      onFeedback(
        error instanceof Error ? error.message : t('auth.otpSendFailed'),
        'error',
      );
    } finally {
      sendLockRef.current = false;
      if (mountedRef.current) {
        setSending(false);
      }
    }
  };

  const disabled = sending || cooldownSeconds > 0;
  const buttonText = sending
    ? t('auth.sending')
    : cooldownSeconds > 0
    ? t('auth.otpRetrySeconds', { seconds: cooldownSeconds })
    : t('auth.sendOtp');

  return (
    <View style={styles.row}>
      <TextInput
        accessibilityLabel={t('auth.emailOtp')}
        autoCapitalize="none"
        keyboardType="number-pad"
        maxLength={8}
        style={styles.input}
        placeholder={t('auth.emailOtp')}
        placeholderTextColor={colors.textSubtle}
        value={value}
        onChangeText={onChangeText}
      />
      <Pressable
        accessibilityLabel={buttonText}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
        disabled={disabled}
        onPress={requestCode}
        style={({ pressed }) => [
          styles.sendButton,
          disabled ? styles.disabled : null,
          pressed ? styles.pressed : null,
        ]}
      >
        <Text style={styles.sendText}>{buttonText}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    ...typography.regular,
    height: 50,
    flex: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    color: colors.text,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  sendButton: {
    minWidth: 112,
    height: 50,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  disabled: {
    opacity: 0.55,
  },
  sendText: {
    ...typography.medium,
    color: colors.primary,
    fontSize: 12,
  },
});
