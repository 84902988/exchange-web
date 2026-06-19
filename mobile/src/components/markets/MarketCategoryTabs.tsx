import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MarketCategoryKey} from '../../api/market';
import {colors, typography} from '../../theme';

export type MarketCategoryTab = {
  key: MarketCategoryKey;
  label: string;
};

type Props = {
  tabs: MarketCategoryTab[];
  activeKey: MarketCategoryKey;
  onChange: (key: MarketCategoryKey) => void;
};

export default function MarketCategoryTabs({tabs, activeKey, onChange}: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}>
      {tabs.map(tab => {
        const active = tab.key === activeKey;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="button"
            style={styles.tab}
            onPress={() => onChange(tab.key)}>
            <Text style={[styles.label, active ? styles.activeLabel : null]}>
              {tab.label}
            </Text>
            <View style={[styles.indicator, active ? styles.activeIndicator : null]} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    height: 44,
    alignItems: 'center',
    paddingRight: 8,
  },
  tab: {
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 1,
  },
  label: {
    ...typography.medium,
    color: colors.marketMuted,
    fontSize: 13,
    lineHeight: 17,
  },
  activeLabel: {
    color: colors.gold,
    fontWeight: '800',
  },
  indicator: {
    position: 'absolute',
    bottom: 3,
    width: 18,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'transparent',
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
});
