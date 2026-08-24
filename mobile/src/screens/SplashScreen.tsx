import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { loadMobileContentBootstrap } from '../api/mobileContent';
import {useLanguage} from '../i18n';
import type { RootStackParamList } from '../navigation/types';
import { useAuth } from '../store/authStore';
import { colors, typography } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'>;
const splashLogo = require('../assets/brand/app-logo.png');
export const SPLASH_MIN_VISIBLE_MS = 120;
export const SPLASH_MAX_WAIT_MS = 700;

export default function SplashScreen({ navigation }: Props) {
  const {t} = useLanguage();
  const { isLoggedIn, loading: authLoading } = useAuth();
  const [contentSettled, setContentSettled] = useState(false);
  const startedAtRef = useRef(Date.now());
  const navigatedRef = useRef(false);

  useEffect(() => {
    let active = true;
    loadMobileContentBootstrap()
      .catch(() => undefined)
      .finally(() => {
        if (active) setContentSettled(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const startupReady = (!authLoading || isLoggedIn) && contentSettled;
    const elapsed = Date.now() - startedAtRef.current;
    const target = startupReady ? SPLASH_MIN_VISIBLE_MS : SPLASH_MAX_WAIT_MS;
    const delay = Math.max(0, target - elapsed);
    const timer = setTimeout(() => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      navigation.replace('Main');
    }, delay);
    return () => clearTimeout(timer);
  }, [authLoading, contentSettled, isLoggedIn, navigation]);

  return (
    <View style={styles.container}>
      <Image
        source={splashLogo}
        style={styles.logoImage}
        resizeMode="contain"
      />
      <Text style={styles.title}>{t('appShell.starting')}</Text>
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
});
