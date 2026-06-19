import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import SectionTitle from '../../components/common/SectionTitle';
import type {RootStackParamList} from '../../navigation/types';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

const accounts = ['资金账户', '现货账户', '合约账户'];
const actions = ['充值', '提现', '划转', '资金流水'];

export default function AssetsScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn, user, logout} = useAuth();

  if (!isLoggedIn) {
    return (
      <AppScreen>
        <SectionTitle title="资产" />
        <View style={styles.guestCard}>
          <Text style={styles.guestTitle}>登录后查看资产</Text>
          <Text style={styles.guestDesc}>
            查看总资产、账户划分、充值提现与资金流水入口。
          </Text>
          <View style={styles.guestActions}>
            <View style={styles.guestButton}>
              <PrimaryButton
                title="登录"
                onPress={() => navigation.navigate('Auth', {screen: 'Login'})}
              />
            </View>
            <View style={styles.guestButton}>
              <PrimaryButton
                title="注册"
                variant="secondary"
                onPress={() =>
                  navigation.navigate('Auth', {screen: 'Register'})
                }
              />
            </View>
          </View>
        </View>
      </AppScreen>
    );
  }

  return (
    <AppScreen>
      <SectionTitle title="资产" />
      <View style={styles.totalCard}>
        <Text style={styles.label}>当前用户</Text>
        <Text style={styles.userName}>{getUserLabel(user)}</Text>
        <Text style={styles.userMeta}>用户 ID：{user?.id || '-'}</Text>
      </View>
      <View style={styles.totalCard}>
        <Text style={styles.label}>总资产</Text>
        <Text style={styles.total}>-- USDT</Text>
        <Text style={styles.placeholder}>余额接口暂未接入，本页仅展示账户入口。</Text>
      </View>
      <View style={styles.actionRow}>
        {actions.map(item => (
          <Pressable key={item} style={styles.action}>
            <Text style={styles.actionText}>{item}</Text>
          </Pressable>
        ))}
      </View>
      <SectionTitle title="账户" />
      <View style={styles.accountList}>
        {accounts.map(item => (
          <View key={item} style={styles.accountRow}>
            <Text style={styles.accountName}>{item}</Text>
            <Text style={styles.accountAmount}>-- USDT</Text>
          </View>
        ))}
      </View>
      <View style={styles.logoutButton}>
        <PrimaryButton title="退出登录" variant="secondary" onPress={logout} />
      </View>
    </AppScreen>
  );
}

function getUserLabel(user: ReturnType<typeof useAuth>['user']) {
  return (
    user?.profile?.nickname ||
    user?.profile?.username ||
    user?.email ||
    user?.phone ||
    '已登录用户'
  );
}

const styles = StyleSheet.create({
  guestCard: {
    marginTop: 8,
    padding: 18,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  guestTitle: {
    ...typography.heavy,
    color: colors.text,
    fontSize: 20,
  },
  guestDesc: {
    ...typography.body,
    marginTop: 10,
    color: colors.textMuted,
  },
  guestActions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 12,
  },
  guestButton: {
    flex: 1,
  },
  totalCard: {
    marginBottom: 12,
    padding: 18,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: {
    ...typography.regular,
    color: colors.textMuted,
    fontSize: 12,
  },
  userName: {
    ...typography.heavy,
    marginTop: 10,
    color: colors.text,
    fontSize: 20,
  },
  userMeta: {
    ...typography.regular,
    ...typography.number,
    marginTop: 8,
    color: colors.textSubtle,
    fontSize: 12,
  },
  total: {
    ...typography.heavy,
    ...typography.number,
    marginTop: 10,
    color: colors.text,
    fontSize: 30,
  },
  placeholder: {
    ...typography.regular,
    marginTop: 8,
    color: colors.textSubtle,
    fontSize: 12,
  },
  actionRow: {
    marginTop: 2,
    flexDirection: 'row',
    gap: 10,
  },
  action: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.primarySoft,
  },
  actionText: {
    ...typography.bold,
    color: colors.primary,
    fontSize: 12,
  },
  accountList: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  accountRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  accountName: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
  },
  accountAmount: {
    ...typography.medium,
    ...typography.number,
    color: colors.textMuted,
    fontSize: 14,
  },
  logoutButton: {
    marginTop: 18,
  },
});
