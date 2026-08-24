import React, { useState } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { useLanguage } from '../../i18n';
import { colors, radius, spacing, typography } from '../../theme';

type Props = Omit<
  TextInputProps,
  'keyboardType' | 'onChangeText' | 'showSoftInputOnFocus' | 'value'
> & {
  value: string;
  onChangeText: (value: string) => void;
};

const keyRows = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'backspace'],
] as const;

export default function TradingNumericInput({
  accessibilityLabel,
  editable = true,
  onFocus,
  onPressIn,
  value,
  onChangeText,
  ...inputProps
}: Props) {
  const { t } = useLanguage();
  const [keypadVisible, setKeypadVisible] = useState(false);
  const usesNativeTradingKeypad = Platform.OS === 'android';

  const openKeypad = () => {
    if (!editable || !usesNativeTradingKeypad) return;
    Keyboard.dismiss();
    setKeypadVisible(true);
  };

  return (
    <>
      <TextInput
        {...inputProps}
        accessibilityLabel={accessibilityLabel}
        editable={editable}
        keyboardType="decimal-pad"
        showSoftInputOnFocus={!usesNativeTradingKeypad}
        value={value}
        onChangeText={onChangeText}
        onFocus={event => {
          onFocus?.(event);
          openKeypad();
        }}
        onPressIn={event => {
          onPressIn?.(event);
          openKeypad();
        }}
      />
      {usesNativeTradingKeypad ? (
        <Modal
          transparent
          animationType="fade"
          statusBarTranslucent
          visible={keypadVisible}
          onRequestClose={() => setKeypadVisible(false)}
        >
          <View
            accessibilityViewIsModal
            style={styles.overlay}
          >
            <Pressable
              accessibilityLabel={t('common.cancel')}
              style={StyleSheet.absoluteFill}
              onPress={() => setKeypadVisible(false)}
            />
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.valueRow}>
                <Text
                  maxFontSizeMultiplier={1.2}
                  numberOfLines={1}
                  style={styles.label}
                >
                  {accessibilityLabel}
                </Text>
                <Text
                  maxFontSizeMultiplier={1.1}
                  numberOfLines={1}
                  style={styles.value}
                >
                  {value || '0'}
                </Text>
              </View>
              {keyRows.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.keyRow}>
                  {row.map(key => (
                    <Pressable
                      key={key}
                      accessibilityLabel={key === 'backspace' ? '⌫' : key}
                      accessibilityRole="button"
                      android_ripple={{ color: 'rgba(255,255,255,0.08)' }}
                      style={({ pressed }) => [
                        styles.key,
                        pressed ? styles.keyPressed : null,
                      ]}
                      onLongPress={
                        key === 'backspace'
                          ? () => onChangeText('')
                          : undefined
                      }
                      onPress={() => {
                        onChangeText(
                          key === 'backspace'
                            ? removeTradingNumericCharacter(value)
                            : appendTradingNumericCharacter(value, key),
                        );
                      }}
                    >
                      <Text style={styles.keyText}>
                        {key === 'backspace' ? '⌫' : key}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))}
              <Pressable
                accessibilityRole="button"
                android_ripple={{ color: 'rgba(0,0,0,0.16)' }}
                style={({ pressed }) => [
                  styles.confirm,
                  pressed ? styles.confirmPressed : null,
                ]}
                onPress={() => setKeypadVisible(false)}
              >
                <Text style={styles.confirmText}>{t('common.confirm')}</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

export function appendTradingNumericCharacter(value: string, key: string) {
  if (key === '.') {
    if (value.includes('.')) return value;
    return value ? `${value}.` : '0.';
  }
  if (!/^\d$/.test(key)) return value;
  if (value === '0' && !value.includes('.')) return key;
  return `${value}${key}`;
}

export function removeTradingNumericCharacter(value: string) {
  return value.slice(0, -1);
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  handle: {
    width: 42,
    height: 4,
    alignSelf: 'center',
    marginBottom: spacing.xs,
    borderRadius: 2,
    backgroundColor: colors.line,
  },
  valueRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  label: {
    ...typography.medium,
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: 14,
  },
  value: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 23,
    textAlign: 'right',
  },
  keyRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  key: {
    minHeight: 52,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  keyPressed: {
    backgroundColor: colors.line,
  },
  keyText: {
    ...typography.medium,
    color: colors.text,
    fontSize: 22,
  },
  confirm: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginTop: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  confirmPressed: {
    opacity: 0.86,
  },
  confirmText: {
    ...typography.bold,
    color: colors.black,
    fontSize: 16,
  },
});
