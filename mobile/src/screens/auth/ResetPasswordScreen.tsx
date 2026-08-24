import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import EmailOtpField, {
  isValidEmailInput,
  normalizeEmailInput,
} from '../../components/auth/EmailOtpField';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import PasswordField, {
  isStrongPassword,
} from '../../components/auth/PasswordField';
import { resetPassword } from '../../api/auth';
import { useLanguage } from '../../i18n';
import type { AuthStackParamList } from '../../navigation/types';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'ResetPassword'>;

export default function ResetPasswordScreen({ navigation }: Props) {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    kind: 'error' | 'success';
  } | null>(null);
  const submitLockRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submitLockRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (submitLockRef.current) return;
    setFeedback(null);

    if (!isValidEmailInput(email)) {
      setFeedback({ message: t('auth.invalidEmail'), kind: 'error' });
      return;
    }
    const normalizedOtp = otp.trim();
    if (normalizedOtp.length < 4 || normalizedOtp.length > 8) {
      setFeedback({ message: t('auth.invalidOtp'), kind: 'error' });
      return;
    }
    if (!isStrongPassword(newPassword)) {
      setFeedback({
        message: t('auth.strongNewPasswordError'),
        kind: 'error',
      });
      return;
    }
    if (confirmPassword !== newPassword) {
      setFeedback({ message: t('auth.passwordMismatch'), kind: 'error' });
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);
    try {
      await resetPassword({
        email: normalizeEmailInput(email),
        otp: normalizedOtp,
        new_password: newPassword,
        confirm_password: confirmPassword,
      });
      if (!mountedRef.current) return;
      navigation.replace('Login');
    } catch (error) {
      if (!mountedRef.current) return;
      setFeedback({
        message:
          error instanceof Error ? error.message : t('auth.resetFailed'),
        kind: 'error',
      });
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  return (
    <AppScreen>
      <Text style={styles.title}>{t('auth.resetPassword')}</Text>
      <Text style={styles.subtitle}>{t('auth.resetSubtitle')}</Text>
      <View style={styles.form}>
        {feedback ? (
          <Text
            style={feedback.kind === 'success' ? styles.success : styles.error}
          >
            {feedback.message}
          </Text>
        ) : null}
        <TextInput
          accessibilityLabel={t('auth.registeredEmail')}
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          importantForAutofill="yes"
          keyboardType="email-address"
          maxLength={254}
          style={styles.input}
          placeholder={t('auth.registeredEmail')}
          placeholderTextColor={colors.textSubtle}
          value={email}
          textContentType="emailAddress"
          onChangeText={value => {
            setEmail(value);
            setOtp('');
            setFeedback(null);
          }}
        />
        <EmailOtpField
          email={email}
          value={otp}
          scene="reset"
          onChangeText={setOtp}
          onFeedback={(message, kind) => setFeedback({ message, kind })}
        />
        <PasswordField
          accessibilityLabel={t('auth.newPassword')}
          autoComplete="new-password"
          placeholder={t('auth.newPassword')}
          value={newPassword}
          onChangeText={setNewPassword}
        />
        <Text style={styles.passwordHint}>{t('auth.passwordHint')}</Text>
        <PasswordField
          accessibilityLabel={t('auth.confirmNewPassword')}
          autoComplete="new-password"
          placeholder={t('auth.confirmNewPassword')}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />
        <PrimaryButton
          title={submitting ? t('auth.submitting') : t('auth.confirmReset')}
          disabled={submitting}
          onPress={submit}
        />
      </View>
    </AppScreen>
  );
}

const feedbackBase = {
  ...typography.regular,
  borderRadius: 8,
  padding: 12,
  borderWidth: 1,
  fontSize: 13,
  lineHeight: 19,
};

const styles = StyleSheet.create({
  title: {
    ...typography.screenTitle,
    marginTop: 24,
    color: colors.text,
  },
  subtitle: {
    ...typography.regular,
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
  },
  form: {
    marginTop: 28,
    gap: 14,
  },
  error: {
    ...feedbackBase,
    color: colors.red,
    backgroundColor: 'rgba(240, 90, 90, 0.12)',
    borderColor: 'rgba(240, 90, 90, 0.24)',
  },
  success: {
    ...feedbackBase,
    color: colors.green,
    backgroundColor: 'rgba(38, 187, 118, 0.12)',
    borderColor: 'rgba(38, 187, 118, 0.24)',
  },
  input: {
    ...typography.regular,
    height: 50,
    borderRadius: 8,
    paddingHorizontal: 14,
    color: colors.text,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  passwordHint: {
    ...typography.regular,
    marginTop: -8,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
});
