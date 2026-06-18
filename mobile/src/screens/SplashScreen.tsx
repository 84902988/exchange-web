import React, {useEffect} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation/types';
import {colors, typography} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'>;

export default function SplashScreen({navigation}: Props) {
  useEffect(() => {
    const timer = setTimeout(() => navigation.replace('Main'), 450);
    return () => clearTimeout(timer);
  }, [navigation]);

  return (
    <View style={styles.container}>
      <View style={styles.logo}>
        <Text style={styles.logoText}>EX</Text>
      </View>
      <Text style={styles.title}>Exchange Mobile</Text>
      <Text style={styles.subtitle}>全球多资产交易平台</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  logo: {
    width: 76,
    height: 76,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  logoText: {
    ...typography.number,
    color: colors.primary,
    fontSize: 28,
    fontWeight: '900',
  },
  title: {
    marginTop: 18,
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
  },
});
