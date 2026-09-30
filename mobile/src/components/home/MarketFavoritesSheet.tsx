import React, {useMemo, useState} from 'react';
import {FlatList, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {MarketInstrument} from '../../api/market';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';
import MarketRow from '../common/MarketRow';
import MarketSearchBar from '../markets/MarketSearchBar';

type Props = {
  items: readonly MarketInstrument[];
  symbols: readonly string[];
  loading: boolean;
  error: boolean;
  onToggle: (symbol: string) => Promise<void>;
  onClose: () => void;
};

export default function MarketFavoritesSheet({
  items, symbols, loading, error, onToggle, onClose,
}: Props) {
  const {t} = useLanguage();
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const favorites = useMemo(() => new Set(symbols), [symbols]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase().replace(/\//g, '');
    return items.filter(item =>
      `${item.symbol} ${item.displaySymbol} ${item.name}`
        .toLowerCase().replace(/\//g, '').includes(search),
    );
  }, [items, query]);
  const toggle = async (item: MarketInstrument) => {
    if (loading || saving) return;
    setSaving(true);
    try {
      await onToggle(item.symbol);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('home.marketManageFavorites')}</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.done}>
            <Text style={styles.doneText}>{t('home.marketFavoritesDone')}</Text>
          </Pressable>
        </View>
        <MarketSearchBar value={query} onChangeText={setQuery} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{t('home.marketFavoritesSaveFailed')}</Text> : null}
        {loading ? <Text style={styles.empty}>{t('common.loading')}</Text> : null}
        <FlatList
          data={filtered}
          extraData={{symbols, loading, saving}}
          keyExtractor={item => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={({item}) => (
            <MarketRow
              item={item}
              favorite={favorites.has(item.symbol)}
              favoriteDisabled={loading || saving}
              favoriteAccessibilityLabel={t(favorites.has(item.symbol)
                ? 'home.marketRemoveFavoriteA11y' : 'home.marketAddFavoriteA11y',
                {symbol: item.displaySymbol})}
              onToggleFavorite={toggle}
            />
          )}
          ListEmptyComponent={<Text style={styles.empty}>{t('markets.searchEmpty')}</Text>}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {...typography.semibold, color: colors.text, fontSize: 18},
  done: {minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center'},
  doneText: {color: colors.gold},
  error: {color: colors.red, paddingVertical: 12},
  empty: {color: colors.textSubtle, textAlign: 'center', paddingVertical: 24},
});
