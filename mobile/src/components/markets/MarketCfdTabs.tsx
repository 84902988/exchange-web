import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text} from 'react-native';
import {useLanguage, type TranslationKey} from '../../i18n';
import {colors} from '../../theme';
import type {CfdFilter} from '../../utils/marketCfd';

const tabs: Array<{key: CfdFilter; label: TranslationKey}> = [
  {key: 'all', label: 'markets.cfd.all'},
  {key: 'metals', label: 'markets.cfd.metals'},
  {key: 'commodities', label: 'markets.cfd.commodities'},
  {key: 'forex', label: 'markets.cfd.forex'},
  {key: 'indices', label: 'markets.cfd.indices'},
  {key: 'other', label: 'markets.cfd.other'},
];

export default function MarketCfdTabs({active, onChange, showOther}: {
  active: CfdFilter;
  onChange: (key: CfdFilter) => void;
  showOther: boolean;
}) {
  const {t} = useLanguage();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
      {tabs.filter(tab => tab.key !== 'other' || showOther).map(tab => (
        <Pressable
          key={tab.key}
          accessibilityRole="tab"
          accessibilityState={{selected: active === tab.key}}
          onPress={() => onChange(tab.key)}
          style={[styles.tab, active === tab.key && styles.active]}>
          <Text style={[styles.label, active === tab.key && styles.activeLabel]}>{t(tab.label)}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {gap: 8, paddingVertical: 8, paddingRight: 8},
  tab: {paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: 18, backgroundColor: colors.marketLine},
  active: {backgroundColor: colors.gold},
  label: {color: colors.marketMuted, fontSize: 12},
  activeLabel: {color: '#101010', fontWeight: '700'},
});
