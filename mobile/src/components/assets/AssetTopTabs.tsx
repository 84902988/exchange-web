import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';

export type AssetTabKey = 'overview' | 'spot' | 'contract' | 'invite' | 'bd';

type Props = {
  activeKey: AssetTabKey;
  onChange: (key: AssetTabKey) => void;
};

const tabs: Array<{key: AssetTabKey; label: string}> = [
  {key: 'overview', label: '总览'},
  {key: 'spot', label: '现货'},
  {key: 'contract', label: '合约'},
  {key: 'invite', label: '邀请'},
  {key: 'bd', label: '代理'},
];

function AssetTopTabs({activeKey, onChange}: Props) {
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

export default React.memo(AssetTopTabs);

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
