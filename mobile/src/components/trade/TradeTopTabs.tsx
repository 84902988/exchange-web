import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';

export type TradeBusinessTab = {
  key: string;
  label: string;
  disabled?: boolean;
};

type Props = {
  tabs: TradeBusinessTab[];
  activeKey: string;
  onChange: (key: string) => void;
};

export default function TradeTopTabs({tabs, activeKey, onChange}: Props) {
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
            disabled={tab.disabled}
            style={styles.tab}
            onPress={() => onChange(tab.key)}>
            <Text
              style={[
                styles.label,
                active ? styles.activeLabel : null,
                tab.disabled ? styles.disabledLabel : null,
              ]}>
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
    height: 38,
    alignItems: 'center',
    gap: 18,
    paddingRight: 10,
  },
  tab: {
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 17,
  },
  activeLabel: {
    color: colors.gold,
    fontWeight: '900',
  },
  disabledLabel: {
    color: colors.textSubtle,
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
