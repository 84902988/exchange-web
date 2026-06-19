import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {ChevronRight} from 'lucide-react-native';
import type {MarketInstrument} from '../../api/market';
import {colors, typography} from '../../theme';
import MarketRow from './MarketRow';

export type MarketSection = {
  key: string;
  title: string;
  items: MarketInstrument[];
};

type Props = {
  sections: MarketSection[];
  onRowPress?: (item: MarketInstrument) => void;
};

export default function MarketSectionList({sections, onRowPress}: Props) {
  return (
    <View style={styles.wrap}>
      {sections.map(section => (
        <View key={section.key} style={styles.section}>
          <View style={styles.header}>
            <Text style={styles.title}>{section.title}</Text>
            <ChevronRight color={colors.marketMuted} size={16} strokeWidth={2.2} />
          </View>
          {section.items.map(item => (
            <MarketRow key={item.id} item={item} onPress={onRowPress} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 12,
  },
  section: {
    borderRadius: 8,
    backgroundColor: colors.marketCard,
    borderWidth: 1,
    borderColor: colors.marketLine,
    paddingHorizontal: 10,
    paddingTop: 10,
    overflow: 'hidden',
  },
  header: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  title: {
    ...typography.medium,
    color: colors.marketText,
    fontSize: 14,
    fontWeight: '900',
  },
});
