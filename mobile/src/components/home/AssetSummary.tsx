import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {formatAssetNumber} from '../../api/assets';
import {useAssetSnapshot} from '../../hooks/useAssetSnapshot';
import type {RootStackParamList} from '../../navigation/types';
import {useLanguage, type Translator} from '../../i18n';
import PrimaryButton from '../common/PrimaryButton';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export default function AssetSummary() {
  const navigation = useNavigation<RootNavigation>();
  const {t} = useLanguage();
  const assetState = useAssetSnapshot();
  const {loading, snapshot} = assetState;
  const totalUsdt =
    snapshot?.valuationComplete && snapshot.totalUsdt !== null
      ? snapshot.totalUsdt
      : null;
  const amountText =
    !loading && totalUsdt !== null
      ? `${formatAssetNumber(totalUsdt, 2)} USDT`
      : '-- USDT';
  const statusText = getAssetSummaryStatus(assetState, t);

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t('home.assetTotal')}</Text>
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.amount}>{amountText}</Text>
          <Text style={styles.status}>{statusText}</Text>
        </View>
        <View style={styles.button}>
          <PrimaryButton
            title={t('home.deposit')}
            onPress={() => navigation.navigate('AssetDeposit')}
          />
        </View>
      </View>
    </View>
  );
}

function getAssetSummaryStatus(
  state: ReturnType<typeof useAssetSnapshot>,
  t: Translator,
) {
  if (state.stale) return t('home.assetStale');
  if (state.error) return state.error;
  if (!state.userId) return t('home.assetLogin');
  if (state.loading) return t('home.assetLoading');
  if (!state.snapshot) return t('home.assetMissing');
  if (!state.snapshot.valuationComplete) {
    return t('home.assetIncomplete');
  }
  return t('home.assetUpdated');
}

const styles = StyleSheet.create({
  card: {
    marginTop: 18,
    borderRadius: 8,
    padding: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
  },
  row: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  copy: {
    flex: 1,
  },
  amount: {
    ...typography.cardNumber,
    color: colors.text,
    fontSize: 26,
  },
  status: {
    marginTop: 5,
    color: colors.textSubtle,
    fontSize: 10,
    lineHeight: 14,
  },
  button: {
    width: 88,
  },
});
