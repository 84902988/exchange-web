import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Check, X } from 'lucide-react-native';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = {
  leverage: number;
  maxLeverage: number | null;
  visible: boolean;
  onClose: () => void;
  onSelect: (leverage: number) => void;
};

function ContractLeverageSelectorSheet({
  leverage,
  maxLeverage,
  visible,
  onClose,
  onSelect,
}: Props) {
  const { t } = useLanguage();
  const options = useMemo(
    () =>
      maxLeverage === null
        ? []
        : Array.from(
            { length: Math.max(0, maxLeverage) },
            (_, index) => index + 1,
          ),
    [maxLeverage],
  );

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        style={styles.overlay}
        onPress={onClose}
      >
        <Pressable style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.titleWrap}>
              <Text style={styles.title}>{t('contract.leverage')}</Text>
              <Text style={styles.subtitle}>
                {maxLeverage === null
                  ? t('contract.rulesBeforeAdjust')
                  : t('contract.leverageRange', { max: maxLeverage })}
              </Text>
            </View>
            <Pressable
              accessibilityLabel={t('common.cancel')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              style={({ pressed }) => [
                styles.closeButton,
                pressed ? styles.pressed : null,
              ]}
              onPress={onClose}
            >
              <X color={colors.textMuted} size={20} />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.options}
            showsVerticalScrollIndicator={false}
          >
            {options.map(option => {
              const selected = option === leverage;
              return (
                <Pressable
                  accessibilityLabel={t('contract.selectLeverageA11y', {
                    leverage: option,
                  })}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                  key={option}
                  style={({ pressed }) => [
                    styles.option,
                    selected ? styles.optionSelected : null,
                    pressed ? styles.pressed : null,
                  ]}
                  onPress={() => onSelect(option)}
                >
                  <Text
                    style={[
                      styles.optionText,
                      selected ? styles.optionTextSelected : null,
                    ]}
                  >
                    {option}x
                  </Text>
                  {selected ? (
                    <Check color={colors.gold} size={15} strokeWidth={2.4} />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default React.memo(ContractLeverageSelectorSheet);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.64)',
  },
  sheet: {
    maxHeight: '72%',
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
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 17,
  },
  subtitle: {
    marginTop: 4,
    color: colors.textSubtle,
    fontSize: 11,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: colors.cardAlt,
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 14,
    paddingBottom: 8,
  },
  option: {
    width: '23%',
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  optionSelected: {
    borderColor: colors.deepGold,
    backgroundColor: colors.goldSoft,
  },
  optionText: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  optionTextSelected: {
    color: colors.gold,
  },
  pressed: {
    opacity: 0.76,
  },
});
