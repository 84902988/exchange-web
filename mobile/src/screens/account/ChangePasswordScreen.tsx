import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Check, Circle } from 'lucide-react-native';
import { changeMyPassword } from '../../api';
import {
  ActionCard,
  ActionHeader,
  InlineNotice,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import PasswordField, {
  isStrongPassword,
} from '../../components/auth/PasswordField';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import { useLanguage, type Translator } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

export function getPasswordChecks(value: string, t?: Translator) {
  return [
    {
      label: t?.('password.ruleLength') || '8-64 个字符',
      passed: value.length >= 8 && value.length <= 64,
    },
    {
      label: t?.('password.ruleCase') || '包含大写和小写字母',
      passed: /[A-Z]/.test(value) && /[a-z]/.test(value),
    },
    {
      label: t?.('password.ruleNumber') || '包含数字',
      passed: /\d/.test(value),
    },
    {
      label: t?.('password.ruleSpecial') || '包含特殊字符',
      passed: /[^A-Za-z0-9]/.test(value),
    },
  ];
}

export default function ChangePasswordScreen({
  navigation,
}: {
  navigation: any;
}) {
  const { t } = useLanguage();
  const { logout } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);
  const submitLockRef = useRef(false);
  const confirmationOpenRef = useRef(false);
  const checks = useMemo(
    () => getPasswordChecks(newPassword, t),
    [newPassword, t],
  );
  const valid =
    oldPassword.length > 0 &&
    isStrongPassword(newPassword) &&
    confirmPassword === newPassword &&
    newPassword !== oldPassword;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      confirmationOpenRef.current = false;
    };
  }, []);

  const executeChange = useCallback(async () => {
    if (submitLockRef.current || submitting || !valid) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await changeMyPassword({
        old_password: oldPassword,
        new_password: newPassword,
      });
      await logout();
      if (!mountedRef.current) return;
      Alert.alert(
        t('password.changedTitle'),
        t('password.changedDescription'),
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
    } catch (requestError) {
      if (mountedRef.current) {
        setError(toChineseError(requestError, t('password.changeFailed')));
      }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [logout, navigation, newPassword, oldPassword, submitting, t, valid]);

  const confirmChange = useCallback(() => {
    if (
      !valid ||
      submitting ||
      confirmationOpenRef.current ||
      submitLockRef.current
    )
      return;
    confirmationOpenRef.current = true;
    Alert.alert(
      t('password.confirmTitle'),
      t('password.confirmDescription'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: t('password.confirmChange'),
          style: 'destructive',
          onPress: () => {
            confirmationOpenRef.current = false;
            executeChange().catch(() => undefined);
          },
        },
      ],
      {
        onDismiss: () => {
          confirmationOpenRef.current = false;
        },
      },
    );
  }, [executeChange, submitting, t, valid]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('password.title')}
        subtitle={t('password.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
      />
      <ActionCard>
        <Text style={styles.fieldLabel}>{t('password.current')}</Text>
        <PasswordField
          accessibilityLabel={t('password.current')}
          autoComplete="current-password"
          placeholder={t('password.currentPlaceholder')}
          value={oldPassword}
          onChangeText={setOldPassword}
        />
        <Text style={styles.fieldLabel}>{t('password.new')}</Text>
        <PasswordField
          accessibilityLabel={t('password.new')}
          autoComplete="new-password"
          placeholder={t('password.newPlaceholder')}
          value={newPassword}
          onChangeText={setNewPassword}
        />
        <View style={styles.checks}>
          {checks.map(item => (
            <View key={item.label} style={styles.checkRow}>
              {item.passed ? (
                <Check color={colors.green} size={15} strokeWidth={2.5} />
              ) : (
                <Circle color={colors.textSubtle} size={12} />
              )}
              <Text style={item.passed ? styles.checkPassed : styles.checkText}>
                {item.label}
              </Text>
            </View>
          ))}
        </View>
        <Text style={styles.fieldLabel}>{t('password.confirmNew')}</Text>
        <PasswordField
          accessibilityLabel={t('password.confirmNew')}
          autoComplete="new-password"
          placeholder={t('password.confirmPlaceholder')}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />
        {confirmPassword && confirmPassword !== newPassword ? (
          <Text style={styles.inlineError}>{t('password.mismatch')}</Text>
        ) : null}
        {newPassword && oldPassword === newPassword ? (
          <Text style={styles.inlineError}>{t('password.sameAsCurrent')}</Text>
        ) : null}
      </ActionCard>
      {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
      <InlineNotice>{t('password.warning')}</InlineNotice>
      <View style={styles.submitWrap}>
        <PrimaryButton
          title={submitting ? t('password.changing') : t('password.change')}
          disabled={!valid || submitting}
          onPress={confirmChange}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  fieldLabel: {
    ...typography.bold,
    marginTop: 14,
    marginBottom: 8,
    color: colors.text,
    fontSize: 13,
  },
  checks: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', rowGap: 7 },
  checkRow: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  checkText: { color: colors.textSubtle, fontSize: 10 },
  checkPassed: { color: colors.green, fontSize: 10 },
  inlineError: { marginTop: 8, color: colors.red, fontSize: 11 },
  submitWrap: { marginTop: 16 },
});
