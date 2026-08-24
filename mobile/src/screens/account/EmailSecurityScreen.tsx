import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  confirmCurrentEmailVerification,
  confirmEmailChange,
  sendCurrentEmailVerification,
  sendEmailChangeVerification,
} from '../../api';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  InfoRow,
  InlineNotice,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import EmailOtpField, {
  isValidEmailInput,
  normalizeEmailInput,
} from '../../components/auth/EmailOtpField';
import PasswordField from '../../components/auth/PasswordField';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

type Feedback = { message: string; kind: 'error' | 'success' } | null;

export default function EmailSecurityScreen({
  navigation,
}: {
  navigation: any;
}) {
  const { t } = useLanguage();
  const { user, refreshUser, logout } = useAuth();
  const currentEmail = normalizeEmailInput(user?.email || '');
  const verified = Boolean(user?.email_verified_at);
  const [verifyCode, setVerifyCode] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [changeCode, setChangeCode] = useState('');
  const [changeCodeEmail, setChangeCodeEmail] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  const submitLockRef = useRef(false);
  const confirmationOpenRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      confirmationOpenRef.current = false;
    };
  }, []);

  const showFeedback = useCallback(
    (message: string, kind: 'error' | 'success') => {
      if (mountedRef.current) setFeedback({ message, kind });
    },
    [],
  );

  const verifyCurrent = useCallback(async () => {
    const code = verifyCode.trim();
    if (submitLockRef.current || submitting || !/^\d{4,8}$/.test(code)) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    try {
      await confirmCurrentEmailVerification(code);
      await refreshUser();
      if (!mountedRef.current) return;
      setVerifyCode('');
      showFeedback(t('emailSecurity.verifiedSuccess'), 'success');
    } catch (error) {
      showFeedback(
        toChineseError(error, t('emailSecurity.verifyFailed')),
        'error',
      );
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }, [refreshUser, showFeedback, submitting, t, verifyCode]);

  const requestChangeCode = useCallback(
    async (normalizedEmail: string) => {
      if (!currentPassword)
        throw new Error(t('emailSecurity.currentPasswordRequired'));
      if (normalizedEmail === currentEmail)
        throw new Error(t('emailSecurity.sameEmail'));
      await sendEmailChangeVerification({
        new_email: normalizedEmail,
        current_password: currentPassword,
      });
      if (!mountedRef.current) return;
      setChangeCodeEmail(normalizedEmail);
      setChangeCode('');
    },
    [currentEmail, currentPassword, t],
  );

  const executeEmailChange = useCallback(async () => {
    const normalizedEmail = normalizeEmailInput(newEmail);
    const code = changeCode.trim();
    if (
      submitLockRef.current ||
      submitting ||
      !currentPassword ||
      !isValidEmailInput(normalizedEmail) ||
      normalizedEmail !== changeCodeEmail ||
      !/^\d{4,8}$/.test(code)
    )
      return;
    submitLockRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    try {
      await confirmEmailChange({
        new_email: normalizedEmail,
        current_password: currentPassword,
        code,
      });
      await logout();
      if (!mountedRef.current) return;
      Alert.alert(
        t('emailSecurity.changedTitle'),
        t('emailSecurity.changedDescription'),
        [
          {
            text: t('password.relogin'),
            onPress: () =>
              navigation.reset({
                index: 0,
                routes: [{ name: 'Auth', params: { screen: 'Login' } }],
              }),
          },
        ],
      );
    } catch (error) {
      showFeedback(
        toChineseError(error, t('emailSecurity.updateFailed')),
        'error',
      );
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    changeCode,
    changeCodeEmail,
    currentPassword,
    logout,
    navigation,
    newEmail,
    showFeedback,
    submitting,
    t,
  ]);

  const confirmChange = useCallback(() => {
    const normalizedEmail = normalizeEmailInput(newEmail);
    if (
      submitting ||
      confirmationOpenRef.current ||
      submitLockRef.current ||
      !currentPassword ||
      normalizedEmail !== changeCodeEmail ||
      !/^\d{4,8}$/.test(changeCode.trim())
    )
      return;
    confirmationOpenRef.current = true;
    Alert.alert(
      t('emailSecurity.confirmTitle'),
      t('emailSecurity.confirmDescription', { email: normalizedEmail }),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: t('emailSecurity.confirmChange'),
          style: 'destructive',
          onPress: () => {
            confirmationOpenRef.current = false;
            executeEmailChange().catch(() => undefined);
          },
        },
      ],
      {
        onDismiss: () => {
          confirmationOpenRef.current = false;
        },
      },
    );
  }, [
    changeCode,
    changeCodeEmail,
    currentPassword,
    executeEmailChange,
    newEmail,
    submitting,
    t,
  ]);

  const normalizedNewEmail = normalizeEmailInput(newEmail);
  const changeReady =
    Boolean(currentPassword) &&
    isValidEmailInput(normalizedNewEmail) &&
    normalizedNewEmail !== currentEmail &&
    normalizedNewEmail === changeCodeEmail &&
    /^\d{4,8}$/.test(changeCode.trim());

  return (
    <AppScreen>
      <ActionHeader
        title={t('emailSecurity.title')}
        subtitle={t('emailSecurity.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
      />

      <ActionCard>
        <Text style={styles.sectionTitle}>
          {t('emailSecurity.currentEmail')}
        </Text>
        <InfoRow
          label={t('emailSecurity.address')}
          value={currentEmail || t('common.notBound')}
        />
        <InfoRow
          label={t('emailSecurity.status')}
          value={verified ? t('security.verified') : t('security.notVerified')}
          tone={verified ? 'green' : 'gold'}
        />
      </ActionCard>

      {!verified && currentEmail ? (
        <ActionCard>
          <Text style={styles.sectionTitle}>
            {t('emailSecurity.verifyCurrent')}
          </Text>
          <Text style={styles.description}>
            {t('emailSecurity.verifyDescription')}
          </Text>
          <View style={styles.fieldGap}>
            <EmailOtpField
              email={currentEmail}
              value={verifyCode}
              onChangeText={setVerifyCode}
              onFeedback={showFeedback}
              onRequestCode={() => sendCurrentEmailVerification()}
            />
          </View>
          <View style={styles.buttonGap}>
            <PrimaryButton
              title={
                submitting
                  ? t('emailSecurity.verifying')
                  : t('emailSecurity.verify')
              }
              disabled={submitting || !/^\d{4,8}$/.test(verifyCode.trim())}
              onPress={verifyCurrent}
            />
          </View>
        </ActionCard>
      ) : null}

      <ActionCard>
        <Text style={styles.sectionTitle}>
          {t('emailSecurity.changeEmail')}
        </Text>
        <Text style={styles.description}>
          {t('emailSecurity.changeDescription')}
        </Text>
        <ActionTextField
          label={t('emailSecurity.newEmail')}
          value={newEmail}
          onChangeText={value => {
            setNewEmail(value);
            if (normalizeEmailInput(value) !== changeCodeEmail)
              setChangeCode('');
          }}
          placeholder={t('emailSecurity.newEmailPlaceholder')}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={191}
        />
        <Text style={styles.fieldLabel}>
          {t('emailSecurity.currentPassword')}
        </Text>
        <PasswordField
          accessibilityLabel={t('emailSecurity.currentPassword')}
          autoComplete="current-password"
          placeholder={t('emailSecurity.currentPasswordPlaceholder')}
          value={currentPassword}
          onChangeText={setCurrentPassword}
        />
        <View style={styles.fieldGap}>
          <EmailOtpField
            email={newEmail}
            value={changeCode}
            onChangeText={setChangeCode}
            onFeedback={showFeedback}
            onRequestCode={requestChangeCode}
          />
        </View>
        {normalizedNewEmail &&
        changeCodeEmail &&
        normalizedNewEmail !== changeCodeEmail ? (
          <Text style={styles.inlineError}>
            {t('emailSecurity.emailChangedResend')}
          </Text>
        ) : null}
        <View style={styles.buttonGap}>
          <PrimaryButton
            title={
              submitting
                ? t('emailSecurity.updating')
                : t('emailSecurity.changeButton')
            }
            disabled={!changeReady || submitting}
            onPress={confirmChange}
          />
        </View>
      </ActionCard>

      {feedback ? (
        <InlineNotice tone={feedback.kind === 'error' ? 'red' : 'green'}>
          {feedback.message}
        </InlineNotice>
      ) : null}
      <InlineNotice>{t('emailSecurity.warning')}</InlineNotice>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  description: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  fieldLabel: {
    ...typography.bold,
    marginTop: 14,
    marginBottom: 8,
    color: colors.text,
    fontSize: 13,
  },
  fieldGap: { marginTop: 14 },
  buttonGap: { marginTop: 14 },
  inlineError: { marginTop: 8, color: colors.red, fontSize: 11 },
});
