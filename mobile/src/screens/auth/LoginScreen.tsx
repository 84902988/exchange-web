import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import type {AuthStackParamList} from '../../navigation/types';
import {colors} from '../../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export default function LoginScreen({navigation}: Props) {
  return (
    <AppScreen>
      <Text style={styles.title}>欢迎回来</Text>
      <Text style={styles.subtitle}>使用手机号或邮箱登录</Text>
      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="手机号 / 邮箱"
          placeholderTextColor={colors.textSubtle}
        />
        <TextInput
          style={styles.input}
          placeholder="密码"
          placeholderTextColor={colors.textSubtle}
          secureTextEntry
        />
        <PrimaryButton title="登录" />
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
