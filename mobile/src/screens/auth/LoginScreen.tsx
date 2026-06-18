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
import {colors} from '../../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export default function LoginScreen({navigation}: Props) {
  const {login, loading} = useAuth();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    setMessage(null);
    if (!account.trim()) {
      setMessage('请输入手机号或邮箱');
      return;
    }
    if (!password) {
      setMessage('请输入密码');
      return;
    }

    try {
      await login(account, password);
      navigation.getParent()?.goBack();
    } catch (error) {
      const fallbackMessage =
        error instanceof Error &&
        (error.message.includes('网络') || error.message.includes('超时'))
          ? error.message
          : '登录失败，请检查账号或密码';
      setMessage(fallbackMessage);
    }
  };

  return (
    <AppScreen>
      <Text style={styles.title}>欢迎回来</Text>
      <Text style={styles.subtitle}>使用手机号或邮箱登录</Text>
      <View style={styles.form}>
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <TextInput
          autoCapitalize="none"
          keyboardType="email-address"
          style={styles.input}
          placeholder="手机号 / 邮箱"
          placeholderTextColor={colors.textSubtle}
          value={account}
          onChangeText={setAccount}
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
          title={loading ? '登录中...' : '登录'}
          disabled={loading}
          onPress={submit}
        />
      </View>
      <View style={styles.links}>
        <Pressable onPress={() => navigation.navigate('Register')}>
          <Text style={styles.link}>注册账户</Text>
        </Pressable>
        <Text style={styles.link}>忘记密码</Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: {
    marginTop: 24,
    color: colors.text,
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
  },
  form: {
    marginTop: 28,
    gap: 14,
  },
  error: {
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
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
});
