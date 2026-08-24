import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Search, X } from 'lucide-react-native';
import {
  fetchContractTradingCatalog,
  getCachedContractTradingCatalog,
  type ContractCatalogInstrument,
  type ContractMarketCategory,
} from '../../api/tradingCatalog';
import { useLanguage, type TranslationKey } from '../../i18n';
import { colors, typography } from '../../theme';
import MarketLogo from '../markets/MarketLogo';

type Props = {
  initialCategory: ContractMarketCategory;
  visible: boolean;
  onClose: () => void;
  onSelect: (item: ContractCatalogInstrument) => void;
};

const CATEGORY_KEYS: Array<{
  key: ContractMarketCategory;
  labelKey: TranslationKey;
}> = [
  { key: 'crypto', labelKey: 'markets.category.crypto' },
  { key: 'stock', labelKey: 'markets.category.stock' },
  { key: 'cfd', labelKey: 'markets.category.cfd' },
];

function ContractMarketSelectorSheet({
  initialCategory,
  visible,
  onClose,
  onSelect,
}: Props) {
  const { t } = useLanguage();
  const [category, setCategory] =
    useState<ContractMarketCategory>(initialCategory);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<ContractCatalogInstrument[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestGenerationRef = useRef(0);

  const loadCatalog = useCallback(() => {
    const generation = ++requestGenerationRef.current;
    const cached = getCachedContractTradingCatalog();
    setCatalog(cached);
    setLoading(cached.length === 0);
    setFailed(false);

    fetchContractTradingCatalog()
      .then(items => {
        if (requestGenerationRef.current !== generation) return;
        setCatalog(items);
        setFailed(false);
      })
      .catch(() => {
        if (requestGenerationRef.current !== generation) return;
        setCatalog([]);
        setFailed(true);
      })
      .finally(() => {
        if (requestGenerationRef.current === generation) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!visible) {
      requestGenerationRef.current += 1;
      return;
    }
    setCategory(initialCategory);
    setQuery('');
    loadCatalog();
  }, [initialCategory, loadCatalog, visible]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ContractMarketCategory, number> = {
      crypto: 0,
      stock: 0,
      cfd: 0,
    };
    catalog.forEach(item => {
      counts[item.marketCategory] += 1;
    });
    return counts;
  }, [catalog]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return catalog.filter(item => {
      if (item.marketCategory !== category) return false;
      if (!normalizedQuery) return true;
      return [
        item.symbol,
        item.displaySymbol,
        item.displayName,
        item.providerSymbol,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [catalog, category, query]);

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('contractSelector.title')}</Text>
            <Pressable
              accessibilityLabel={t('contractSelector.closeA11y')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              onPress={onClose}
              style={({ pressed }) => [
                styles.closeButton,
                pressed ? styles.pressed : null,
              ]}
            >
              <X color={colors.textMuted} size={20} />
            </Pressable>
          </View>

          <View style={styles.searchWrap}>
            <Search color={colors.textSubtle} size={16} />
            <TextInput
              accessibilityLabel={t('contractSelector.searchA11y')}
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={setQuery}
              placeholder={t('contractSelector.searchPlaceholder')}
              placeholderTextColor={colors.textSubtle}
              style={styles.searchInput}
              value={query}
            />
          </View>

          <View style={styles.tabs}>
            {CATEGORY_KEYS.map(item => {
              const active = category === item.key;
              return (
                <Pressable
                  key={item.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                  onPress={() => setCategory(item.key)}
                  style={({ pressed }) => [
                    styles.tab,
                    active && styles.tabActive,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text
                    style={[styles.tabText, active && styles.tabTextActive]}
                  >
                    {t(item.labelKey)} {categoryCounts[item.key]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={colors.gold} />
              <Text style={styles.stateText}>
                {t('contractSelector.loading')}
              </Text>
            </View>
          ) : failed ? (
            <View style={styles.centerState}>
              <Text style={styles.errorText}>
                {t('contractSelector.loadFailed')}
              </Text>
              <Pressable
                accessibilityRole="button"
                android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
                onPress={loadCatalog}
                testID="contract-market-retry"
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed ? styles.retryPressed : null,
                ]}
              >
                <Text style={styles.retryText}>{t('common.retry')}</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={item => item.symbol}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={styles.centerState}>
                  <Text style={styles.stateText}>
                    {t('contractSelector.empty')}
                  </Text>
                </View>
              }
              renderItem={({ item }) => {
                const marketStatus = item.marketStatus;
                const statusLabel =
                  marketStatus === 'CLOSED'
                    ? t('contract.marketClosed')
                    : marketStatus === 'OPEN'
                    ? t('contract.tradable')
                    : marketStatus || t('trading.contractMarket');
                return (
                  <Pressable
                    accessibilityLabel={`${item.displaySymbol} ${item.displayName}`}
                    accessibilityRole="button"
                    android_ripple={{ color: 'rgba(212, 175, 55, 0.08)' }}
                    onPress={() => onSelect(item)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <MarketLogo
                      label={item.baseAsset}
                      logoUrl={item.logoUrl}
                      size={34}
                    />
                    <View style={styles.rowText}>
                      <Text numberOfLines={1} style={styles.symbol}>
                        {item.displaySymbol}
                      </Text>
                      <Text numberOfLines={1} style={styles.name}>
                        {item.displayName}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.status,
                        marketStatus === 'CLOSED' && styles.statusClosed,
                      ]}
                    >
                      {statusLabel}
                    </Text>
                  </Pressable>
                );
              }}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

export default React.memo(ContractMarketSelectorSheet);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.64)',
  },
  sheet: {
    height: '88%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
  },
  header: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 17,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: colors.cardAlt,
  },
  searchWrap: {
    height: 42,
    marginTop: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 0,
  },
  tabs: {
    marginTop: 12,
    marginBottom: 4,
    flexDirection: 'row',
    gap: 8,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  tabActive: {
    borderColor: colors.deepGold,
    backgroundColor: colors.goldSoft,
  },
  tabText: {
    ...typography.semibold,
    color: colors.textMuted,
    fontSize: 11,
  },
  tabTextActive: {
    color: colors.gold,
  },
  row: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  symbol: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 13,
  },
  name: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 10,
  },
  status: {
    color: colors.green,
    fontSize: 10,
  },
  statusClosed: {
    color: colors.textSubtle,
  },
  centerState: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  stateText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  errorText: {
    color: colors.red,
    fontSize: 12,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 104,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  retryText: {
    ...typography.bold,
    color: colors.black,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.76,
  },
  retryPressed: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
});
