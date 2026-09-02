import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import {X} from 'lucide-react-native';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';

type Props = {
  leverage: number;
  maxLeverage: number | null;
  symbol: string;
  visible: boolean;
  onClose: () => void;
  onConfirm: (leverage: number) => void;
};

export function clampLeverage(value: number, maxLeverage: number) {
  const safeMax =
    Number.isSafeInteger(maxLeverage) && maxLeverage >= 1 ? maxLeverage : 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(safeMax, Math.floor(value)));
}

export function getLeverageMarks(maxLeverage: number) {
  const safeMax = clampLeverage(maxLeverage, maxLeverage);
  return Array.from(
    new Set(
      [1, 30, 60, 90, 120, 150, safeMax].filter(
        mark => mark >= 1 && mark <= safeMax,
      ),
    ),
  ).sort((left, right) => left - right);
}

function ContractLeverageSelectorSheet({
  leverage,
  maxLeverage,
  symbol,
  visible,
  onClose,
  onConfirm,
}: Props) {
  const {t} = useLanguage();
  const safeMax =
    maxLeverage !== null &&
    Number.isSafeInteger(maxLeverage) &&
    maxLeverage >= 1
      ? maxLeverage
      : 1;
  const [draft, setDraft] = useState(() => clampLeverage(leverage, safeMax));
  const [sliderWidth, setSliderWidth] = useState(0);
  const marks = useMemo(() => getLeverageMarks(safeMax), [safeMax]);
  const progress = safeMax <= 1 ? 0 : (draft - 1) / (safeMax - 1);

  useEffect(() => {
    if (visible) {
      setDraft(clampLeverage(leverage, safeMax));
    }
  }, [leverage, safeMax, visible]);

  const updateDraft = useCallback(
    (value: number) => setDraft(clampLeverage(value, safeMax)),
    [safeMax],
  );
  const updateFromSliderEvent = useCallback(
    (event: GestureResponderEvent) => {
      if (sliderWidth <= 0) return;
      const ratio = Math.max(
        0,
        Math.min(1, event.nativeEvent.locationX / sliderWidth),
      );
      updateDraft(1 + Math.round(ratio * (safeMax - 1)));
    },
    [safeMax, sliderWidth, updateDraft],
  );
  const handleSliderLayout = useCallback((event: LayoutChangeEvent) => {
    setSliderWidth(event.nativeEvent.layout.width);
  }, []);

  return (
    <Modal
      animationType="fade"
      statusBarTranslucent
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <Pressable accessible={false} style={styles.overlay} onPress={onClose}>
        <Pressable
          accessible={false}
          style={styles.dialog}
          onPress={event => event.stopPropagation()}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{t('contract.adjustLeverageTitle')}</Text>
            <Pressable
              accessibilityLabel={t('common.cancel')}
              accessibilityRole="button"
              android_ripple={{color: 'rgba(212, 175, 55, 0.12)'}}
              style={({pressed}) => [
                styles.closeButton,
                pressed ? styles.pressed : null,
              ]}
              onPress={onClose}
            >
              <X color={colors.textMuted} size={19} />
            </Pressable>
          </View>

          <View style={styles.pairContext}>
            <Text style={styles.pairContextText}>
              {t('contract.currentTradingPair')}
              <Text style={styles.pairSymbol}>{symbol}</Text>
              <Text style={styles.pairSeparator}> · </Text>
              {t('contract.isolated')}
            </Text>
          </View>

          <Text style={styles.fieldLabel}>
            {t('contract.leverageMultiplier')}
          </Text>
          <View style={styles.inputWrap}>
            <TextInput
              accessibilityLabel={t('contract.leverageInputA11y')}
              keyboardType="number-pad"
              maxLength={String(safeMax).length}
              returnKeyType="done"
              selectTextOnFocus
              style={styles.input}
              value={String(draft)}
              onChangeText={value => updateDraft(Number(value))}
            />
            <Text style={styles.inputSuffix}>x</Text>
          </View>

          <View style={styles.sliderSection}>
            <View
              accessible
              accessibilityActions={[
                {
                  name: 'decrement',
                  label: t('contract.decreaseLeverage'),
                },
                {
                  name: 'increment',
                  label: t('contract.increaseLeverage'),
                },
              ]}
              accessibilityLabel={t('contract.leverageSliderA11y')}
              accessibilityRole="adjustable"
              accessibilityValue={{
                min: 1,
                max: safeMax,
                now: draft,
                text: `${draft}x`,
              }}
              style={styles.sliderTouchArea}
              onAccessibilityAction={event => {
                if (event.nativeEvent.actionName === 'increment') {
                  updateDraft(draft + 1);
                }
                if (event.nativeEvent.actionName === 'decrement') {
                  updateDraft(draft - 1);
                }
              }}
              onLayout={handleSliderLayout}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={updateFromSliderEvent}
              onResponderMove={updateFromSliderEvent}
              onStartShouldSetResponder={() => true}
            >
              <View pointerEvents="none" style={styles.sliderTrack}>
                <View
                  style={[
                    styles.sliderFill,
                    {width: `${progress * 100}%`},
                  ]}
                />
                <View
                  style={[
                    styles.sliderThumb,
                    {left: `${progress * 100}%`},
                  ]}
                />
              </View>
            </View>

            <View style={styles.marks}>
              {marks.map(mark => (
                <Pressable
                  accessibilityLabel={t('contract.selectLeverageA11y', {
                    leverage: mark,
                  })}
                  accessibilityRole="button"
                  key={mark}
                  style={({pressed}) => [
                    styles.markButton,
                    pressed ? styles.pressed : null,
                  ]}
                  onPress={() => updateDraft(mark)}
                >
                  <Text
                    style={[
                      styles.markText,
                      mark === draft ? styles.markTextSelected : null,
                    ]}
                  >
                    {mark}x
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.warning}>
            <Text style={styles.warningText}>
              {t('contract.adjustLeverageMarginWarning')}
            </Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              accessibilityLabel={t('common.cancel')}
              accessibilityRole="button"
              style={({pressed}) => [
                styles.actionButton,
                styles.cancelButton,
                pressed ? styles.pressed : null,
              ]}
              onPress={onClose}
            >
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={t('contract.confirmLeverageA11y', {
                leverage: draft,
              })}
              accessibilityRole="button"
              accessibilityState={{disabled: maxLeverage === null}}
              disabled={maxLeverage === null}
              style={({pressed}) => [
                styles.actionButton,
                styles.confirmButton,
                maxLeverage === null ? styles.confirmButtonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onConfirm(draft)}
            >
              <Text style={styles.confirmText}>{t('common.confirm')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default React.memo(ContractLeverageSelectorSheet);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.68)',
    padding: 18,
  },
  dialog: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 16,
  },
  header: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 17,
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  pairContext: {
    marginTop: 10,
    borderRadius: 9,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pairContextText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  pairSymbol: {
    ...typography.bold,
    color: colors.text,
  },
  pairSeparator: {
    color: colors.textSubtle,
  },
  fieldLabel: {
    marginTop: 14,
    marginBottom: 7,
    color: colors.textMuted,
    fontSize: 12,
  },
  inputWrap: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 12,
  },
  input: {
    ...typography.number,
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    color: colors.text,
    fontSize: 16,
  },
  inputSuffix: {
    color: colors.textMuted,
    fontSize: 13,
  },
  sliderSection: {
    marginTop: 15,
  },
  sliderTouchArea: {
    height: 40,
    justifyContent: 'center',
  },
  sliderTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.line,
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 3,
    backgroundColor: colors.white,
  },
  sliderThumb: {
    position: 'absolute',
    top: -7,
    width: 19,
    height: 19,
    marginLeft: -9.5,
    borderRadius: 10,
    backgroundColor: colors.white,
  },
  marks: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -2,
  },
  markButton: {
    minWidth: 28,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    paddingHorizontal: 3,
  },
  markText: {
    ...typography.number,
    color: colors.textSubtle,
    fontSize: 10,
  },
  markTextSelected: {
    color: colors.text,
  },
  warning: {
    marginTop: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(243,179,74,0.24)',
    backgroundColor: 'rgba(243,179,74,0.10)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warningText: {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 16,
  },
  actionButton: {
    minHeight: 44,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  confirmButton: {
    backgroundColor: colors.white,
  },
  confirmButtonDisabled: {
    opacity: 0.45,
  },
  cancelText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 14,
  },
  confirmText: {
    ...typography.bold,
    color: colors.black,
    fontSize: 14,
  },
  pressed: {
    opacity: 0.76,
  },
});
