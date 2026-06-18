import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import SectionTitle from '../../components/common/SectionTitle';
import type {RootStackParamList} from '../../navigation/types';
import {isMockLoggedIn} from '../../store/mockAuth';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

const accounts = ['资金账户', '现货账户', '合约账户'];
const actions = ['充值', '提现', '划转', '资金流水'];

export default function AssetsScreen() {
  const navigation = useNavigation<RootNavigation>();

  if (!isMockLoggedIn) {
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
        <Text style={styles.label}>总资产</Text>
        <Text style={styles.total}>5.22 USDT</Text>
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
        {accounts.map((item, index) => (
          <View key={item} style={styles.accountRow}>
            <Text style={styles.accountName}>{item}</Text>
            <Text style={styles.accountAmount}>{index === 0 ? '5.22' : '0.00'} USDT</Text>
          </View>
        ))}
      </View>
    </AppScreen>
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
    color: colors.text,
    fontSize: 20,
    fontWeight: '900',
  },
  guestDesc: {
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
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
    padding: 18,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
  },
  total: {
    ...typography.number,
    marginTop: 10,
    color: colors.text,
    fontSize: 30,
    fontWeight: '900',
  },
  actionRow: {
    marginTop: 14,
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
    color: colors.primary,
    fontSize: 12,
    fontWeight: '800',
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
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  accountAmount: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
});
