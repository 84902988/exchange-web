import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SvgXml } from 'react-native-svg';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import PasswordField from '../../components/auth/PasswordField';
import {
  isValidEmailInput,
  normalizeEmailInput,
} from '../../components/auth/EmailOtpField';
import {
  fetchLoginCaptcha,
  readLoginFailureState,
  type LoginCaptchaChallenge,
} from '../../api/auth';
import type { AuthStackParamList } from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export default function LoginScreen({ navigation }: Props) {
  const { login, loading } = useAuth();
  const { t } = useLanguage();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [captchaRequired, setCaptchaRequired] = useState(false);
  const [captchaChallenge, setCaptchaChallenge] =
    useState<LoginCaptchaChallenge | null>(null);
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [captchaExpiresAt, setCaptchaExpiresAt] = useState<number | null>(null);
  const [loginLocked, setLoginLocked] = useState(false);
  const [lockSecondsRemaining, setLockSecondsRemaining] = useState<
    number | null
  >(0);
  const mountedRef = useRef(true);
  const captchaRequestRef = useRef(0);
  const submitLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      captchaRequestRef.current += 1;
      submitLockRef.current = false;
    };
  }, []);

  const refreshCaptcha = useCallback(async () => {
    const requestId = captchaRequestRef.current + 1;
    captchaRequestRef.current = requestId;
    setCaptchaLoading(true);
    setCaptchaError(null);
    setCaptchaChallenge(null);
    setCaptchaCode('');
    setCaptchaExpiresAt(null);
    try {
      const challenge = await fetchLoginCaptcha();
      if (!mountedRef.current || captchaRequestRef.current !== requestId)
        return;
      setCaptchaChallenge(challenge);
      setCaptchaExpiresAt(Date.now() + challenge.expiresIn * 1000);
    } catch (error) {
      if (!mountedRef.current || captchaRequestRef.current !== requestId)
        return;
      setCaptchaError(
        error instanceof Error ? error.message : t('auth.captchaLoadFailed'),
      );
    } finally {
      if (mountedRef.current && captchaRequestRef.current === requestId) {
        setCaptchaLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    if (!captchaChallenge || captchaExpiresAt === null) return;
    const expiresInMs = Math.max(0, captchaExpiresAt - Date.now());
    const timer = setTimeout(() => {
      setCaptchaChallenge(null);
      setCaptchaCode('');
      setCaptchaError(t('auth.captchaExpired'));
      setCaptchaExpiresAt(null);
    }, expiresInMs);
    return () => clearTimeout(timer);
  }, [captchaChallenge, captchaExpiresAt, t]);

  useEffect(() => {
    if (
      !loginLocked ||
      lockSecondsRemaining === null ||
      lockSecondsRemaining <= 0
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (lockSecondsRemaining <= 1) {
        setLockSecondsRemaining(0);
        setLoginLocked(false);
        refreshCaptcha().catch(() => undefined);
      } else {
        setLockSecondsRemaining(lockSecondsRemaining - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [lockSecondsRemaining, loginLocked, refreshCaptcha]);

  const submit = async () => {
    if (submitLockRef.current || loading) return;
    setMessage(null);
    if (!isValidEmailInput(account)) {
      setMessage(t('auth.invalidEmail'));
      return;
    }
    if (password.length < 6 || password.length > 64) {
      setMessage(t('auth.passwordLength'));
      return;
    }

    let challenge: { captchaId: string; captchaCode: string } | undefined;
    if (captchaRequired) {
      if (loginLocked) {
        setMessage(
          lockSecondsRemaining === null
            ? t('auth.loginLockedLater')
            : t('auth.loginLockedSeconds', {
                seconds: lockSecondsRemaining,
              }),
        );
        return;
      }
      if (
        !captchaChallenge ||
        captchaExpiresAt === null ||
        Date.now() >= captchaExpiresAt
      ) {
        setMessage(t('auth.captchaRefreshFirst'));
        return;
      }
      const normalizedCaptchaCode = captchaCode.trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{5}$/.test(normalizedCaptchaCode)) {
        setMessage(t('auth.captchaFiveChars'));
        return;
      }
      challenge = {
        captchaId: captchaChallenge.captchaId,
        captchaCode: normalizedCaptchaCode,
      };
    }

    submitLockRef.current = true;
    try {
      await login(normalizeEmailInput(account), password, challenge);
      if (mountedRef.current) {
        const parentNavigation = navigation.getParent();
        if (parentNavigation?.canGoBack()) {
          parentNavigation.goBack();
        } else {
          parentNavigation?.reset({
            index: 0,
            routes: [{ name: 'Main' }],
          });
        }
      }
    } catch (error) {
      if (!mountedRef.current) return;
      const failureState = readLoginFailureState(error);
      const fallbackMessage =
        failureState && error instanceof Error
          ? error.message
          : error instanceof Error &&
            (error.message.includes('网络') || error.message.includes('超时'))
          ? error.message
          : t('auth.loginFailed');
      setMessage(fallbackMessage);
      if (failureState || captchaRequired) {
        setCaptchaRequired(true);
        setCaptchaCode('');
        if (failureState?.locked) {
          setLoginLocked(true);
          setLockSecondsRemaining(failureState.lockSeconds);
        } else {
          setLoginLocked(false);
          setLockSecondsRemaining(0);
        }
        await refreshCaptcha();
      }
    } finally {
      submitLockRef.current = false;
    }
  };

  return (
    <AppScreen>
      <Text style={styles.title}>{t('auth.welcomeBack')}</Text>
      <Text style={styles.subtitle}>{t('auth.loginSubtitle')}</Text>
      <View style={styles.form}>
        {message ? <Text style={styles.error}>{message}</Text> : null}
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
          value={account}
          textContentType="emailAddress"
          onChangeText={setAccount}
        />
        <PasswordField
          accessibilityLabel={t('auth.password')}
          autoComplete="current-password"
          placeholder={t('auth.password')}
          value={password}
          onChangeText={setPassword}
        />
        {captchaRequired ? (
          <View style={styles.captchaPanel}>
            <View style={styles.captchaHeader}>
              <Text style={styles.captchaTitle}>{t('auth.securityCheck')}</Text>
              <Pressable
                accessibilityLabel={t('auth.refreshCaptcha')}
                accessibilityRole="button"
                accessibilityState={{ disabled: captchaLoading }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                disabled={captchaLoading}
                style={({ pressed }) => [
                  styles.captchaRefreshButton,
                  pressed ? styles.pressed : null,
                ]}
                onPress={refreshCaptcha}
              >
                <Text style={styles.captchaRefresh}>
                  {captchaLoading
                    ? t('common.loading')
                    : t('auth.refreshImage')}
                </Text>
              </Pressable>
            </View>
            {captchaChallenge ? (
              <View
                accessibilityLabel={t('auth.captchaImage')}
                style={styles.captchaImage}
              >
                <SvgXml
                  height={44}
                  width={132}
                  xml={captchaChallenge.svgXml}
                  onError={() => {
                    setCaptchaChallenge(null);
                    setCaptchaCode('');
                    setCaptchaError(t('auth.captchaImageFailed'));
                  }}
                />
              </View>
            ) : (
              <View style={styles.captchaPlaceholder}>
                <Text style={styles.captchaHint}>
                  {captchaLoading
                    ? t('auth.captchaLoading')
                    : t('auth.captchaUnavailable')}
                </Text>
              </View>
            )}
            {captchaError ? (
              <Text style={styles.captchaError}>{captchaError}</Text>
            ) : null}
            {loginLocked ? (
              <Text style={styles.captchaError}>
                {lockSecondsRemaining === null
                  ? t('auth.loginLockedShort')
                  : t('auth.loginLockedCountdown', {
                      seconds: lockSecondsRemaining,
                    })}
              </Text>
            ) : null}
            <TextInput
              accessibilityLabel={t('auth.captcha')}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={Boolean(captchaChallenge) && !loginLocked}
              maxLength={5}
              style={styles.input}
              placeholder={t('auth.captcha')}
              placeholderTextColor={colors.textSubtle}
              value={captchaCode}
              onChangeText={value => setCaptchaCode(value.toUpperCase())}
            />
          </View>
        ) : null}
        <PrimaryButton
          title={loading ? t('auth.loggingIn') : t('auth.login')}
          disabled={
            loading ||
            captchaLoading ||
            loginLocked ||
            (captchaRequired && !captchaChallenge)
          }
          onPress={submit}
        />
      </View>
      <View style={styles.links}>
        <Pressable
          accessibilityLabel={t('auth.createAccount')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          style={({ pressed }) => [
            styles.linkButton,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => navigation.navigate('Register')}
        >
          <Text style={styles.link}>{t('auth.createAccount')}</Text>
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
  captchaPanel: {
    gap: 10,
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  captchaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  captchaTitle: {
    ...typography.medium,
    color: colors.text,
    fontSize: 13,
  },
  captchaRefresh: {
    ...typography.medium,
    color: colors.primary,
    fontSize: 12,
  },
  captchaRefreshButton: {
    minWidth: 72,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  captchaImage: {
    width: 132,
    height: 44,
    overflow: 'hidden',
    borderRadius: 6,
  },
  captchaPlaceholder: {
    width: 132,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.bg,
  },
  captchaHint: {
    ...typography.regular,
    color: colors.textMuted,
    fontSize: 11,
  },
  captchaError: {
    ...typography.regular,
    color: colors.red,
    fontSize: 12,
    lineHeight: 18,
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
