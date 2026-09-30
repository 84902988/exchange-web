import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Landmark} from 'lucide-react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import {ActionHeader} from '../../components/assets/action/ActionPrimitives';
import {useLanguage} from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {colors, typography} from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Bank'>;

export default function BankScreen({navigation}: Props) {
  const {t} = useLanguage();
  return (
    <AppScreen>
      <ActionHeader title={t('home.bankPortal')} onBack={() => navigation.goBack()} />
      <View style={styles.card}>
        <Landmark color={colors.gold} size={56} strokeWidth={1.5} />
        <Text accessibilityRole="header" style={styles.title}>{t('bank.comingSoon')}</Text>
        <Text style={styles.description}>{t('bank.stayTuned')}</Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    marginTop: 40,
    paddingHorizontal: 20,
    paddingVertical: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.25)',
    backgroundColor: colors.bgElevated,
  },
  title: {...typography.bold, marginTop: 24, fontSize: 22, color: colors.text, textAlign: 'center'},
  description: {...typography.regular, marginTop: 12, fontSize: 14, color: colors.textMuted, textAlign: 'center'},
});
