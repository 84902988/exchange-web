import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  type ContractPositionItem,
  type ContractTpSlTriggerPriceType,
} from '../../api/contract';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import { formatFixedPrice } from '../../utils/format';

type Props = {
  position: ContractPositionItem | null;
  referencePrice: number | null;
  referencePriceType: ContractTpSlTriggerPriceType;
  pricePrecision: number;
  visible: boolean;
  takeProfitPrice: string;
  stopLossPrice: string;
  saving: boolean;
  error: string | null;
  onTakeProfitPriceChange: (value: string) => void;
  onStopLossPriceChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

function ContractPositionTpSlSheet({
  position,
  referencePrice,
  referencePriceType,
  pricePrecision,
  visible,
  takeProfitPrice,
  stopLossPrice,
  saving,
  error,
  onTakeProfitPriceChange,
  onStopLossPriceChange,
  onClose,
  onSave,
}: Props) {
  const { t } = useLanguage();
  const sideLabel = position
    ? t(
        position.side === 'SHORT'
          ? 'trading.position.short'
          : 'trading.position.long',
      )
    : '';
  const visibleReferencePrice = resolveReferencePrice(
    referencePrice,
    position?.markPrice,
  );
  const close = () => {
    if (!saving) onClose();
  };

  return (
    <Modal
      transparent
      animationType="slide"
      statusBarTranslucent
      visible={visible}
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        <View style={styles.sheet}>
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.handle} />
            <Text style={styles.title}>
              {t('contract.tpSlTitle', { side: sideLabel })}
            </Text>
            <Text style={styles.reference}>
              {t(
                referencePriceType === 'LAST_PRICE'
                  ? 'contract.tpSlLastPriceReference'
                  : 'contract.tpSlReference',
                {
                  price: formatFixedPrice(
                    visibleReferencePrice,
                    pricePrecision,
                  ),
                },
              )}
            </Text>
            <Text style={styles.hint}>
              {t(
                position?.side === 'SHORT'
                  ? 'contract.tpSlShortHint'
                  : 'contract.tpSlLongHint',
              )}
            </Text>

            <PriceField
              label={t('contract.takeProfit')}
              pricePrecision={pricePrecision}
              referencePrice={visibleReferencePrice}
              testID="contract-tp-price-input"
              value={takeProfitPrice}
              onChangeText={onTakeProfitPriceChange}
            />
            <PriceField
              label={t('contract.stopLoss')}
              pricePrecision={pricePrecision}
              referencePrice={visibleReferencePrice}
              testID="contract-sl-price-input"
              value={stopLossPrice}
              onChangeText={onStopLossPriceChange}
            />
            <Text style={styles.clearHint}>{t('contract.tpSlEmptyClears')}</Text>
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: saving }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                disabled={saving}
                style={({ pressed }) => [
                  styles.button,
                  styles.cancelButton,
                  saving ? styles.buttonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={close}
              >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: saving, disabled: saving }}
                android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
                disabled={saving}
                testID="contract-tp-sl-save"
                style={({ pressed }) => [
                  styles.button,
                  styles.saveButton,
                  saving ? styles.buttonDisabled : null,
                  pressed ? styles.savePressed : null,
                ]}
                onPress={onSave}
              >
                <Text style={styles.saveText}>
                  {saving ? t('contract.tpSlSaving') : t('contract.tpSlSave')}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PriceField({
  label,
  pricePrecision,
  referencePrice,
  testID,
  value,
  onChangeText,
}: {
  label: string;
  pricePrecision: number;
  referencePrice: number | null;
  testID: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  const step = (direction: -1 | 1) => {
    const nextValue = stepContractTpSlPrice({
      direction,
      pricePrecision,
      referencePrice,
      value,
    });
    if (nextValue !== null) onChangeText(nextValue);
  };
  const decrementDisabled =
    stepContractTpSlPrice({
      direction: -1,
      pricePrecision,
      referencePrice,
      value,
    }) === null;
  const incrementDisabled =
    stepContractTpSlPrice({
      direction: 1,
      pricePrecision,
      referencePrice,
      value,
    }) === null;

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <PriceStepButton
          accessibilityLabel={`${label} -1`}
          disabled={decrementDisabled}
          symbol="−"
          testID={`${testID}-decrement`}
          onPress={() => step(-1)}
        />
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="decimal-pad"
          testID={testID}
          value={value}
          style={styles.input}
          onChangeText={onChangeText}
        />
        <PriceStepButton
          accessibilityLabel={`${label} +1`}
          disabled={incrementDisabled}
          symbol="+"
          testID={`${testID}-increment`}
          onPress={() => step(1)}
        />
      </View>
    </View>
  );
}

function PriceStepButton({
  accessibilityLabel,
  disabled,
  symbol,
  testID,
  onPress,
}: {
  accessibilityLabel: string;
  disabled: boolean;
  symbol: string;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [
        styles.stepButton,
        disabled ? styles.buttonDisabled : null,
        pressed ? styles.pressed : null,
      ]}
      onPress={onPress}
    >
      <Text style={styles.stepButtonText}>{symbol}</Text>
    </Pressable>
  );
}

function resolveReferencePrice(
  referencePrice: number | null,
  positionMarkPrice: string | null | undefined,
) {
  if (
    referencePrice !== null &&
    Number.isFinite(referencePrice) &&
    referencePrice > 0
  ) {
    return referencePrice;
  }
  const parsed = Number(String(positionMarkPrice || '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function stepContractTpSlPrice({
  direction,
  pricePrecision,
  referencePrice,
  value,
}: {
  direction: -1 | 1;
  pricePrecision: number;
  referencePrice: number | null;
  value: string;
}) {
  const normalizedValue = value.replace(/,/g, '').trim();
  const base = normalizedValue
    ? Number(normalizedValue)
    : referencePrice ?? Number.NaN;
  if (!Number.isFinite(base) || base < 0) return null;

  const precision = Math.max(0, Math.min(8, Math.trunc(pricePrecision)));
  const scale = 10 ** precision;
  const nextScaled = Math.round(base * scale) + direction * scale;
  if (!Number.isSafeInteger(nextScaled) || nextScaled <= 0) return null;
  return (nextScaled / scale).toFixed(precision);
}

export default React.memo(ContractPositionTpSlSheet);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  sheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  sheetContent: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginBottom: 14,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 18,
  },
  reference: {
    marginTop: 8,
    color: colors.gold,
    fontSize: 13,
  },
  hint: {
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  field: {
    marginTop: 16,
  },
  label: {
    marginBottom: 7,
    color: colors.textMuted,
    fontSize: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  stepButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  stepButtonText: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 22,
    lineHeight: 26,
  },
  clearHint: {
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 11,
  },
  error: {
    marginTop: 10,
    color: colors.red,
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    overflow: 'hidden',
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  saveButton: {
    backgroundColor: colors.primary,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  saveText: {
    ...typography.bold,
    color: '#101116',
    fontSize: 14,
  },
  pressed: {
    opacity: 0.76,
  },
  savePressed: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
});
