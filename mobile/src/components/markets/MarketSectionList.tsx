import React, {type ReactElement, useCallback, useMemo} from 'react';
import {
  Platform,
  type RefreshControlProps,
  SectionList,
  StyleSheet,
  Text,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
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
  header?: ReactElement | null;
  footer?: ReactElement | null;
  refreshControl?: ReactElement<RefreshControlProps>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  scrollIndicatorInsets?: {top?: number; left?: number; bottom?: number; right?: number};
  style?: StyleProp<ViewStyle>;
};

type VirtualMarketSection = {
  key: string;
  title: string;
  data: MarketInstrument[];
};

export default function MarketSectionList({
  sections,
  onRowPress,
  header,
  footer,
  refreshControl,
  contentContainerStyle,
  scrollIndicatorInsets,
  style,
}: Props) {
  const virtualSections = useMemo<VirtualMarketSection[]>(
    () =>
      sections.map(section => ({
        key: section.key,
        title: section.title,
        data: section.items,
      })),
    [sections],
  );
  const renderItem = useCallback(
    ({
      item,
      index,
      section,
    }: {
      item: MarketInstrument;
      index: number;
      section: VirtualMarketSection;
    }) => (
      <View
        style={[
          styles.rowFrame,
          index === section.data.length - 1 ? styles.lastRowFrame : null,
        ]}>
        <MarketRow item={item} onPress={onRowPress} />
      </View>
    ),
    [onRowPress],
  );
  const renderSectionHeader = useCallback(
    ({section}: {section: VirtualMarketSection}) => (
      <View style={styles.header}>
        <Text style={styles.title}>{section.title}</Text>
      </View>
    ),
    [],
  );

  return (
    <SectionList<MarketInstrument, VirtualMarketSection>
      contentContainerStyle={contentContainerStyle}
      initialNumToRender={12}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      keyExtractor={item => item.id}
      ListFooterComponent={footer}
      ListHeaderComponent={header}
      maxToRenderPerBatch={12}
      refreshControl={refreshControl}
      removeClippedSubviews={Platform.OS === 'android'}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      scrollIndicatorInsets={scrollIndicatorInsets}
      sections={virtualSections}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      style={style}
      updateCellsBatchingPeriod={40}
      windowSize={7}
    />
  );
}

const styles = StyleSheet.create({
  header: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    backgroundColor: colors.marketCard,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.marketLine,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    paddingHorizontal: 10,
  },
  rowFrame: {
    backgroundColor: colors.marketCard,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.marketLine,
    paddingHorizontal: 10,
  },
  lastRowFrame: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    marginBottom: 0,
    overflow: 'hidden',
  },
  title: {
    ...typography.medium,
    color: colors.marketText,
    fontSize: 14,
    fontWeight: '900',
  },
});
