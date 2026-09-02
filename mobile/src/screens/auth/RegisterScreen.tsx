import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import EmailOtpField, {
  isValidEmailInput,
  normalizeEmailInput,
} from '../../components/auth/EmailOtpField';
import PasswordField, {
  isStrongPassword,
} from '../../components/auth/PasswordField';
import type {
  AuthStackParamList,
  RootStackParamList,
} from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';
import { inferInviteRegistrationType } from '../../utils/inviteLink';

type Props = NativeStackScreenProps<AuthStackParamList, 'Register'>;

export default function RegisterScreen({ navigation }: Props) {
  const { register, loading } = useAuth();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    kind: 'error' | 'success';
  } | null>(null);
  const mountedRef = useRef(true);
  const submitLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submitLockRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (submitLockRef.current || loading) return;
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
    if (!isStrongPassword(password)) {
      setFeedback({
        message: t('auth.strongPasswordError'),
        kind: 'error',
      });
      return;
    }
    if (!acceptedLegal) {
      setFeedback({
        message: t('auth.acceptLegalError'),
        kind: 'error',
      });
      return;
    }
    const normalizedInviteCode = inviteCode.trim();
    if (
      normalizedInviteCode &&
      !/^[A-Za-z0-9_-]{1,64}$/.test(normalizedInviteCode)
    ) {
      setFeedback({ message: t('auth.invalidInvite'), kind: 'error' });
      return;
    }

    submitLockRef.current = true;
    try {
      await register({
        email: normalizeEmailInput(email),
        otp: normalizedOtp,
        password,
        ...(normalizedInviteCode
          ? {
              invite_code: normalizedInviteCode,
              invite_type: inferInviteRegistrationType(normalizedInviteCode),
            }
          : {}),
      });
      if (mountedRef.current) navigation.getParent()?.goBack();
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({
          message:
            error instanceof Error ? error.message : t('auth.registerFailed'),
          kind: 'error',
        });
      }
    } finally {
      submitLockRef.current = false;
    }
  };

  const openLegalPage = (pageKey: 'terms' | 'privacy') => {
    navigation
      .getParent<NativeStackNavigationProp<RootStackParamList>>()
      ?.navigate('LegalPage', { pageKey });
  };

  return (
    <AppScreen>
      <Text style={styles.title}>{t('auth.registerTitle')}</Text>
      <Text style={styles.subtitle}>{t('auth.registerSubtitle')}</Text>
      <View style={styles.form}>
        {feedback ? (
          <Text
            style={feedback.kind === 'success' ? styles.success : styles.error}
          >
            {feedback.message}
          </Text>
        ) : null}
        <TextInput
          accessibilityLabel={t('auth.email')}
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          importantForAutofill="yes"
          keyboardType="email-address"
          maxLength={254}
          style={styles.input}
          placeholder={t('auth.email')}
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
          onChangeText={setOtp}
          scene="register"
          onFeedback={(message, kind) => setFeedback({ message, kind })}
        />
        <PasswordField
          accessibilityLabel={t('auth.password')}
          autoComplete="new-password"
          placeholder={t('auth.password')}
          value={password}
          onChangeText={setPassword}
        />
        <Text style={styles.passwordHint}>{t('auth.passwordHint')}</Text>
        <TextInput
          accessibilityLabel={t('auth.inviteOptional')}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={64}
          style={styles.input}
          placeholder={t('auth.inviteOptional')}
          placeholderTextColor={colors.textSubtle}
          value={inviteCode}
          onChangeText={value => {
            setInviteCode(value.replace(/[^A-Za-z0-9_-]/g, ''));
            setFeedback(null);
          }}
        />
        <View style={styles.legalRow}>
          <Pressable
            accessibilityLabel={t('auth.acceptLegalA11y')}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: acceptedLegal }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.14)' }}
            hitSlop={10}
            onPress={() => {
              setAcceptedLegal(value => !value);
              setFeedback(null);
            }}
            style={({ pressed }) => [
              styles.checkbox,
              acceptedLegal ? styles.checkboxActive : null,
              pressed ? styles.pressed : null,
            ]}
          >
            {acceptedLegal ? <Text style={styles.checkmark}>✓</Text> : null}
          </Pressable>
          <Text maxFontSizeMultiplier={1.3} style={styles.legalText}>
            {t('auth.legalPrefix')}
            <Text
              accessibilityRole="link"
              onPress={() => openLegalPage('terms')}
              style={styles.legalLink}
            >
              {t('auth.terms')}
            </Text>
            {t('auth.legalJoin')}
            <Text
              accessibilityRole="link"
              onPress={() => openLegalPage('privacy')}
              style={styles.legalLink}
            >
              {t('auth.privacy')}
            </Text>
          </Text>
        </View>
        <PrimaryButton
          title={loading ? t('auth.registering') : t('auth.register')}
          disabled={loading}
          onPress={submit}
        />
      </View>
      <View style={styles.links}>
        <Pressable
          accessibilityLabel={t('auth.haveAccount')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          style={({ pressed }) => [
            styles.linkButton,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => navigation.navigate('Login')}
        >
          <Text style={styles.link}>{t('auth.haveAccount')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('auth.forgotPassword')}
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          style={({ pressed }) => [
            styles.linkButton,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => navigation.navigate('ResetPassword')}
        >
          <Text style={styles.link}>{t('auth.forgotPassword')}</Text>
        </Pressable>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
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
    ...typography.regular,
    borderRadius: 8,
    padding: 12,
    color: colors.red,
    backgroundColor: 'rgba(240, 90, 90, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(240, 90, 90, 0.24)',
    fontSize: 13,
    lineHeight: 19,
  },
  success: {
    ...typography.regular,
    borderRadius: 8,
    padding: 12,
    color: colors.green,
    backgroundColor: 'rgba(38, 187, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(38, 187, 118, 0.24)',
    fontSize: 13,
    lineHeight: 19,
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
  legalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  passwordHint: {
    ...typography.regular,
    marginTop: -8,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  checkbox: {
    width: 24,
    height: 24,
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  checkboxActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  checkmark: {
    ...typography.bold,
    color: colors.black,
    fontSize: 13,
    lineHeight: 16,
  },
  legalText: {
    ...typography.regular,
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 20,
  },
  legalLink: {
    ...typography.medium,
    color: colors.primary,
  },
  links: {
    marginTop: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  linkButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  link: {
    ...typography.medium,
    color: colors.primary,
    fontSize: 13,
  },
});
