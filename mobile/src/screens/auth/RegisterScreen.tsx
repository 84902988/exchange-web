import React, {useState} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import type {AuthStackParamList} from '../../navigation/types';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'Register'>;

export default function RegisterScreen({navigation}: Props) {
  const {register, loading} = useAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    setMessage(null);
    if (!email.trim()) {
      setMessage('请输入邮箱');
      return;
    }
    if (!otp.trim()) {
      setMessage('请输入邮箱验证码');
      return;
    }
    if (!password) {
      setMessage('请输入密码');
      return;
    }

    try {
      const loggedInAfterRegister = await register({
        email: email.trim(),
        otp: otp.trim(),
        password,
      });
      if (loggedInAfterRegister) {
        navigation.getParent()?.goBack();
      } else {
        navigation.navigate('Login');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '注册失败，请稍后重试');
    }
  };

  return (
    <AppScreen>
      <Text style={styles.title}>创建账户</Text>
      <Text style={styles.subtitle}>复用 Web 注册接口，需填写邮箱验证码</Text>
      <View style={styles.form}>
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <TextInput
          autoCapitalize="none"
          keyboardType="email-address"
          style={styles.input}
          placeholder="邮箱"
          placeholderTextColor={colors.textSubtle}
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          autoCapitalize="none"
          keyboardType="number-pad"
          style={styles.input}
          placeholder="邮箱验证码"
          placeholderTextColor={colors.textSubtle}
          value={otp}
          onChangeText={setOtp}
        />
        <TextInput
          autoCapitalize="none"
          style={styles.input}
          placeholder="密码"
          placeholderTextColor={colors.textSubtle}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <PrimaryButton
          title={loading ? '注册中...' : '注册'}
          disabled={loading}
          onPress={submit}
        />
      </View>
      <View style={styles.links}>
        <Pressable onPress={() => navigation.navigate('Login')}>
          <Text style={styles.link}>已有账户，去登录</Text>
        </Pressable>
        <Text style={styles.link}>忘记密码</Text>
      </View>
    </AppScreen>
  );
}

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
  links: {
    marginTop: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  link: {
    ...typography.medium,
    color: colors.primary,
    fontSize: 13,
  },
});
