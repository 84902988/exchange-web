import React, {useEffect} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation/types';
import {colors, typography} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'>;
const splashLogo = require('../assets/brand/royal-exchange-logo.png');

export default function SplashScreen({navigation}: Props) {
  useEffect(() => {
    const timer = setTimeout(() => navigation.replace('Main'), 450);
    return () => clearTimeout(timer);
  }, [navigation]);

  return (
    <View style={styles.container}>
      <Image source={splashLogo} style={styles.logoImage} resizeMode="contain" />
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
  logoImage: {
    width: 188,
    height: 188,
  },
  title: {
    ...typography.heavy,
    marginTop: 18,
    color: colors.text,
    fontSize: 20,
  },
  subtitle: {
    ...typography.regular,
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
  },
});
