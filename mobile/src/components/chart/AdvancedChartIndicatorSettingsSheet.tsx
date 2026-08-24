import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import {
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  parseAdvancedChartPreferencesV2,
  type AdvancedChartPreferencesV2,
} from './advancedChartConfig';
import {
  ADVANCED_CHART_OVERLAY_INDICATORS,
  ADVANCED_CHART_PANE_INDICATORS,
  type AdvancedChartIndicator,
} from './advancedChartIndicators';

type Props = {
  visible: boolean;
  preferences: AdvancedChartPreferencesV2;
  onApply: (preferences: AdvancedChartPreferencesV2) => void;
  onClose: () => void;
};

type DraftFields = {
  maLength: string;
  emaLength: string;
  bollLength: string;
  multiplier: string;
  sarStart: string;
  sarIncrement: string;
  sarMaximum: string;
  avlLength: string;
  superLength: string;
  superMultiplier: string;
  showMA: boolean;
  volumeMaLength: string;
  fastLength: string;
  slowLength: string;
  signalLength: string;
  rsiLength: string;
  kdjLength: string;
  kdjKSmoothing: string;
  kdjDSmoothing: string;
  obvMaLength: string;
  wrLength: string;
  stochRsiLength: string;
  stochasticLength: string;
  stochKSmoothing: string;
  stochDSmoothing: string;
};

type ActiveKind = AdvancedChartIndicator;

const SHEET_OPEN_DURATION_MS = 160;
const SHEET_CLOSE_DURATION_MS = 120;

function fieldsFromPreferences(
  preferences: AdvancedChartPreferencesV2,
): DraftFields {
  const { profiles } = preferences;
  return {
    maLength: String(profiles.MA.length),
    emaLength: String(profiles.EMA.length),
    bollLength: String(profiles.BOLL.length),
    multiplier: String(profiles.BOLL.multiplier),
    sarStart: String(profiles.SAR.start),
    sarIncrement: String(profiles.SAR.increment),
    sarMaximum: String(profiles.SAR.maximum),
    avlLength: String(profiles.AVL.length),
    superLength: String(profiles.SUPER.length),
    superMultiplier: String(profiles.SUPER.multiplier),
    showMA: profiles.VOL.showMA,
    volumeMaLength: String(profiles.VOL.maLength),
    fastLength: String(profiles.MACD.fastLength),
    slowLength: String(profiles.MACD.slowLength),
    signalLength: String(profiles.MACD.signalLength),
    rsiLength: String(profiles.RSI.length),
    kdjLength: String(profiles.KDJ.length),
    kdjKSmoothing: String(profiles.KDJ.kSmoothing),
    kdjDSmoothing: String(profiles.KDJ.dSmoothing),
    obvMaLength: String(profiles.OBV.maLength),
    wrLength: String(profiles.WR.length),
    stochRsiLength: String(profiles.StochRSI.rsiLength),
    stochasticLength: String(profiles.StochRSI.stochasticLength),
    stochKSmoothing: String(profiles.StochRSI.kSmoothing),
    stochDSmoothing: String(profiles.StochRSI.dSmoothing),
  };
}

function buildPreferences(
  base: AdvancedChartPreferencesV2,
  fields: DraftFields,
  selection: AdvancedChartPreferencesV2['selection'],
) {
  return parseAdvancedChartPreferencesV2({
    version: 2,
    selection,
    profiles: {
      ...base.profiles,
      MA: { length: Number(fields.maLength) },
      EMA: { length: Number(fields.emaLength) },
      BOLL: {
        length: Number(fields.bollLength),
        multiplier: Number(fields.multiplier),
      },
      SAR: {
        start: Number(fields.sarStart),
        increment: Number(fields.sarIncrement),
        maximum: Number(fields.sarMaximum),
      },
      AVL: { length: Number(fields.avlLength) },
      SUPER: {
        length: Number(fields.superLength),
        multiplier: Number(fields.superMultiplier),
      },
      VOL: {
        showMA: fields.showMA,
        maLength: Number(fields.volumeMaLength),
      },
      MACD: {
        fastLength: Number(fields.fastLength),
        slowLength: Number(fields.slowLength),
        signalLength: Number(fields.signalLength),
      },
      RSI: { length: Number(fields.rsiLength) },
      KDJ: {
        length: Number(fields.kdjLength),
        kSmoothing: Number(fields.kdjKSmoothing),
        dSmoothing: Number(fields.kdjDSmoothing),
      },
      OBV: { maLength: Number(fields.obvMaLength) },
      WR: { length: Number(fields.wrLength) },
      StochRSI: {
        rsiLength: Number(fields.stochRsiLength),
        stochasticLength: Number(fields.stochasticLength),
        kSmoothing: Number(fields.stochKSmoothing),
        dSmoothing: Number(fields.stochDSmoothing),
      },
    },
  });
}

export default function AdvancedChartIndicatorSettingsSheet({
  visible,
  preferences,
  onApply,
  onClose,
}: Props) {
  const { t } = useLanguage();
  const [activeKind, setActiveKind] = useState<ActiveKind>(
    preferences.selection.overlay,
  );
  const [draftSelection, setDraftSelection] = useState(preferences.selection);
  const [fields, setFields] = useState(() =>
    fieldsFromPreferences(preferences),
  );
  const [rendered, setRendered] = useState(visible);
  const animationProgress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const visibleRef = useRef(visible);

  useEffect(() => {
    visibleRef.current = visible;
    animationProgress.stopAnimation();

    if (visible) {
      setRendered(true);
      animationProgress.setValue(0);
      const frame = requestAnimationFrame(() => {
        Animated.timing(animationProgress, {
          toValue: 1,
          duration: SHEET_OPEN_DURATION_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      });
      return () => {
        cancelAnimationFrame(frame);
        animationProgress.stopAnimation();
      };
    }

    Animated.timing(animationProgress, {
      toValue: 0,
      duration: SHEET_CLOSE_DURATION_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visibleRef.current) setRendered(false);
    });
    return () => animationProgress.stopAnimation();
  }, [animationProgress, visible]);

  useEffect(() => {
    if (!visible) return;
    setActiveKind(preferences.selection.overlay);
    setDraftSelection(preferences.selection);
    setFields(fieldsFromPreferences(preferences));
  }, [preferences, visible]);

  const validatedPreferences = useMemo(
    () => buildPreferences(preferences, fields, draftSelection),
    [draftSelection, fields, preferences],
  );

  const resetActive = () => {
    const defaults = fieldsFromPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES);
    setFields(current => {
      if (activeKind === 'MA' || activeKind === 'EMA') {
        return activeKind === 'MA'
          ? { ...current, maLength: defaults.maLength }
          : { ...current, emaLength: defaults.emaLength };
      }
      if (activeKind === 'BOLL') {
        return {
          ...current,
          bollLength: defaults.bollLength,
          multiplier: defaults.multiplier,
        };
      }
      if (activeKind === 'SAR') {
        return {
          ...current,
          sarStart: defaults.sarStart,
          sarIncrement: defaults.sarIncrement,
          sarMaximum: defaults.sarMaximum,
        };
      }
      if (activeKind === 'AVL') {
        return { ...current, avlLength: defaults.avlLength };
      }
      if (activeKind === 'SUPER') {
        return {
          ...current,
          superLength: defaults.superLength,
          superMultiplier: defaults.superMultiplier,
        };
      }
      if (activeKind === 'VOL') {
        return {
          ...current,
          showMA: defaults.showMA,
          volumeMaLength: defaults.volumeMaLength,
        };
      }
      if (activeKind === 'MACD') {
        return {
          ...current,
          fastLength: defaults.fastLength,
          slowLength: defaults.slowLength,
          signalLength: defaults.signalLength,
        };
      }
      if (activeKind === 'RSI') {
        return { ...current, rsiLength: defaults.rsiLength };
      }
      if (activeKind === 'KDJ') {
        return {
          ...current,
          kdjLength: defaults.kdjLength,
          kdjKSmoothing: defaults.kdjKSmoothing,
          kdjDSmoothing: defaults.kdjDSmoothing,
        };
      }
      if (activeKind === 'OBV') {
        return { ...current, obvMaLength: defaults.obvMaLength };
      }
      if (activeKind === 'WR') {
        return { ...current, wrLength: defaults.wrLength };
      }
      if (activeKind === 'StochRSI') {
        return {
          ...current,
          stochRsiLength: defaults.stochRsiLength,
          stochasticLength: defaults.stochasticLength,
          stochKSmoothing: defaults.stochKSmoothing,
          stochDSmoothing: defaults.stochDSmoothing,
        };
      }
      return current;
    });
  };

  return (
    <Modal
      transparent
      animationType="none"
      visible={rendered}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <Animated.View
          style={[styles.backdrop, { opacity: animationProgress }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            testID="indicator-settings-backdrop"
            onPress={onClose}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              opacity: animationProgress,
              transform: [
                {
                  translateY: animationProgress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [36, 0],
                  }),
                },
              ],
            },
          ]}
          testID="indicator-settings-sheet"
        >
          <View style={styles.handle} />
          <Text style={styles.title}>{t('indicatorSettings.title')}</Text>
          <Text style={styles.groupTitle}>
            {t('indicatorSettings.overlayGroup')}
          </Text>
          <View style={styles.chips}>
            {ADVANCED_CHART_OVERLAY_INDICATORS.map(kind => {
              const selected = draftSelection.overlay === kind;
              return (
                <Pressable
                  key={kind}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                  style={({ pressed }) => [
                    styles.chip,
                    selected ? styles.chipSelected : null,
                    activeKind === kind ? styles.chipActive : null,
                    pressed ? styles.pressed : null,
                  ]}
                  testID={`indicator-settings-chip-${kind.toLowerCase()}`}
                  onPress={() => {
                    setActiveKind(kind);
                    setDraftSelection(current => ({
                      ...current,
                      overlay: kind,
                    }));
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selected || activeKind === kind
                        ? styles.chipTextActive
                        : null,
                    ]}
                  >
                    {kind}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.groupTitle}>
            {t('indicatorSettings.paneGroup')}
          </Text>
          <View style={styles.chips}>
            {ADVANCED_CHART_PANE_INDICATORS.map(kind => {
              const selected = draftSelection.pane === kind;
              return (
                <Pressable
                  key={kind}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                  style={({ pressed }) => [
                    styles.chip,
                    selected ? styles.chipSelected : null,
                    activeKind === kind ? styles.chipActive : null,
                    pressed ? styles.pressed : null,
                  ]}
                  testID={`indicator-settings-chip-${kind.toLowerCase()}`}
                  onPress={() => {
                    setActiveKind(kind);
                    setDraftSelection(current => ({ ...current, pane: kind }));
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selected || activeKind === kind
                        ? styles.chipTextActive
                        : null,
                    ]}
                  >
                    {kind}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={styles.content}
          >
            {(activeKind === 'MA' || activeKind === 'EMA') && (
              <NumericField
                label={t('indicatorSettings.period')}
                maximum={500}
                minimum={1}
                step={1}
                testID="indicator-settings-length"
                value={activeKind === 'MA' ? fields.maLength : fields.emaLength}
                onChange={value =>
                  setFields(current =>
                    activeKind === 'MA'
                      ? { ...current, maLength: value }
                      : { ...current, emaLength: value },
                  )
                }
              />
            )}
            {activeKind === 'BOLL' && (
              <>
                <NumericField
                  label={t('indicatorSettings.period')}
                  maximum={500}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-length"
                  value={fields.bollLength}
                  onChange={value =>
                    setFields(current => ({ ...current, bollLength: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.stdDev')}
                  maximum={10}
                  minimum={0.1}
                  step={0.1}
                  testID="indicator-settings-multiplier"
                  value={fields.multiplier}
                  onChange={value =>
                    setFields(current => ({ ...current, multiplier: value }))
                  }
                />
              </>
            )}
            {activeKind === 'SAR' && (
              <>
                <NumericField
                  label={t('indicatorSettings.sarStart')}
                  maximum={0.2}
                  minimum={0.01}
                  step={0.01}
                  testID="indicator-settings-sar-start"
                  value={fields.sarStart}
                  onChange={value =>
                    setFields(current => ({ ...current, sarStart: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.sarIncrement')}
                  maximum={0.2}
                  minimum={0.01}
                  step={0.01}
                  testID="indicator-settings-sar-increment"
                  value={fields.sarIncrement}
                  onChange={value =>
                    setFields(current => ({ ...current, sarIncrement: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.sarMaximum')}
                  maximum={1}
                  minimum={0.1}
                  step={0.01}
                  testID="indicator-settings-sar-maximum"
                  value={fields.sarMaximum}
                  onChange={value =>
                    setFields(current => ({ ...current, sarMaximum: value }))
                  }
                />
              </>
            )}
            {activeKind === 'AVL' && (
              <NumericField
                label={t('indicatorSettings.avlPeriod')}
                maximum={500}
                minimum={0}
                step={1}
                testID="indicator-settings-avl-length"
                value={fields.avlLength}
                onChange={value =>
                  setFields(current => ({ ...current, avlLength: value }))
                }
              />
            )}
            {activeKind === 'SUPER' && (
              <>
                <NumericField
                  label={t('indicatorSettings.atrPeriod')}
                  maximum={100}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-super-length"
                  value={fields.superLength}
                  onChange={value =>
                    setFields(current => ({ ...current, superLength: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.atrMultiplier')}
                  maximum={10}
                  minimum={1}
                  step={0.1}
                  testID="indicator-settings-super-multiplier"
                  value={fields.superMultiplier}
                  onChange={value =>
                    setFields(current => ({
                      ...current,
                      superMultiplier: value,
                    }))
                  }
                />
              </>
            )}
            {activeKind === 'VOL' && (
              <>
                <View style={styles.switchRow}>
                  <Text style={styles.fieldLabel}>
                    {t('indicatorSettings.showVolumeMa')}
                  </Text>
                  <Switch
                    accessibilityLabel={t('indicatorSettings.showVolumeMaA11y')}
                    value={fields.showMA}
                    onValueChange={value =>
                      setFields(current => ({ ...current, showMA: value }))
                    }
                  />
                </View>
                <NumericField
                  disabled={!fields.showMA}
                  label={t('indicatorSettings.volumeMaPeriod')}
                  maximum={500}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-volume-ma-length"
                  value={fields.volumeMaLength}
                  onChange={value =>
                    setFields(current => ({
                      ...current,
                      volumeMaLength: value,
                    }))
                  }
                />
              </>
            )}
            {activeKind === 'MACD' && (
              <>
                <NumericField
                  label={t('indicatorSettings.fast')}
                  minimum={1}
                  maximum={200}
                  step={1}
                  testID="indicator-settings-fast"
                  value={fields.fastLength}
                  onChange={value =>
                    setFields(current => ({ ...current, fastLength: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.slow')}
                  minimum={1}
                  maximum={200}
                  step={1}
                  testID="indicator-settings-slow"
                  value={fields.slowLength}
                  onChange={value =>
                    setFields(current => ({ ...current, slowLength: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.signal')}
                  minimum={1}
                  maximum={50}
                  step={1}
                  testID="indicator-settings-signal"
                  value={fields.signalLength}
                  onChange={value =>
                    setFields(current => ({ ...current, signalLength: value }))
                  }
                />
              </>
            )}
            {activeKind === 'RSI' && (
              <NumericField
                label={t('indicatorSettings.period')}
                minimum={1}
                maximum={200}
                step={1}
                testID="indicator-settings-rsi-length"
                value={fields.rsiLength}
                onChange={value =>
                  setFields(current => ({ ...current, rsiLength: value }))
                }
              />
            )}
            {activeKind === 'KDJ' && (
              <>
                <NumericField
                  label={t('indicatorSettings.period')}
                  maximum={200}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-kdj-length"
                  value={fields.kdjLength}
                  onChange={value =>
                    setFields(current => ({ ...current, kdjLength: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.kSmoothing')}
                  maximum={50}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-kdj-k-smoothing"
                  value={fields.kdjKSmoothing}
                  onChange={value =>
                    setFields(current => ({ ...current, kdjKSmoothing: value }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.dSmoothing')}
                  maximum={50}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-kdj-d-smoothing"
                  value={fields.kdjDSmoothing}
                  onChange={value =>
                    setFields(current => ({ ...current, kdjDSmoothing: value }))
                  }
                />
              </>
            )}
            {activeKind === 'OBV' && (
              <NumericField
                label={t('indicatorSettings.obvMaPeriod')}
                maximum={500}
                minimum={0}
                step={1}
                testID="indicator-settings-obv-ma-length"
                value={fields.obvMaLength}
                onChange={value =>
                  setFields(current => ({ ...current, obvMaLength: value }))
                }
              />
            )}
            {activeKind === 'WR' && (
              <NumericField
                label={t('indicatorSettings.period')}
                maximum={200}
                minimum={1}
                step={1}
                testID="indicator-settings-wr-length"
                value={fields.wrLength}
                onChange={value =>
                  setFields(current => ({ ...current, wrLength: value }))
                }
              />
            )}
            {activeKind === 'StochRSI' && (
              <>
                <NumericField
                  label={t('indicatorSettings.rsiPeriod')}
                  maximum={200}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-stoch-rsi-length"
                  value={fields.stochRsiLength}
                  onChange={value =>
                    setFields(current => ({
                      ...current,
                      stochRsiLength: value,
                    }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.stochasticPeriod')}
                  maximum={200}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-stochastic-length"
                  value={fields.stochasticLength}
                  onChange={value =>
                    setFields(current => ({
                      ...current,
                      stochasticLength: value,
                    }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.kSmoothing')}
                  maximum={50}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-stoch-k-smoothing"
                  value={fields.stochKSmoothing}
                  onChange={value =>
                    setFields(current => ({
                      ...current,
                      stochKSmoothing: value,
                    }))
                  }
                />
                <NumericField
                  label={t('indicatorSettings.dSmoothing')}
                  maximum={50}
                  minimum={1}
                  step={1}
                  testID="indicator-settings-stoch-d-smoothing"
                  value={fields.stochDSmoothing}
                  onChange={value =>
                    setFields(current => ({
                      ...current,
                      stochDSmoothing: value,
                    }))
                  }
                />
              </>
            )}
            {!validatedPreferences ? (
              <Text style={styles.error} testID="indicator-settings-error">
                {t('indicatorSettings.invalid')}
              </Text>
            ) : null}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed ? styles.pressed : null,
              ]}
              testID="indicator-settings-cancel"
              onPress={onClose}
            >
              <Text style={styles.secondaryText}>
                {t('indicatorSettings.cancel')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed ? styles.pressed : null,
              ]}
              testID="indicator-settings-reset"
              onPress={resetActive}
            >
              <Text style={styles.secondaryText}>
                {t('indicatorSettings.reset')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !validatedPreferences }}
              android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
              disabled={!validatedPreferences}
              style={({ pressed }) => [
                styles.applyButton,
                !validatedPreferences ? styles.disabled : null,
                pressed ? styles.applyPressed : null,
              ]}
              testID="indicator-settings-apply"
              onPress={() => {
                if (!validatedPreferences) return;
                onApply(validatedPreferences);
                onClose();
              }}
            >
              <Text style={styles.applyText}>
                {t('indicatorSettings.apply')}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NumericField({
  disabled = false,
  label,
  maximum,
  minimum,
  step,
  testID,
  value,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  maximum: number;
  minimum: number;
  step: number;
  testID: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const adjust = (direction: -1 | 1) => {
    const numeric = Number(value);
    const base = Number.isFinite(numeric) ? numeric : minimum;
    const next = Math.min(maximum, Math.max(minimum, base + direction * step));
    const precision = decimalPlaces(step);
    onChange(
      precision > 0 ? next.toFixed(precision) : String(Math.round(next)),
    );
  };
  return (
    <View style={[styles.field, disabled ? styles.disabled : null]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityLabel={`${label} -1`}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          disabled={disabled}
          style={({ pressed }) => [
            styles.stepButton,
            pressed ? styles.pressed : null,
          ]}
          testID={`${testID}-minus`}
          onPress={() => adjust(-1)}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <TextInput
          accessibilityLabel={label}
          editable={!disabled}
          keyboardType="decimal-pad"
          selectTextOnFocus
          style={styles.input}
          testID={testID}
          value={value}
          onChangeText={onChange}
        />
        <Pressable
          accessibilityLabel={`${label} +1`}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          disabled={disabled}
          style={({ pressed }) => [
            styles.stepButton,
            pressed ? styles.pressed : null,
          ]}
          testID={`${testID}-plus`}
          onPress={() => adjust(1)}
        >
          <Text style={styles.stepText}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

function decimalPlaces(value: number) {
  const normalized = String(value);
  return normalized.includes('.') ? normalized.split('.')[1].length : 0;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  applyPressed: { opacity: 0.86, transform: [{ scale: 0.992 }] },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  sheet: {
    maxHeight: '82%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginBottom: 10,
  },
  title: { ...typography.bold, color: colors.text, fontSize: 16 },
  groupTitle: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 10,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  chip: {
    minWidth: 64,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 22,
  },
  chipSelected: { borderColor: colors.gold },
  chipActive: { borderColor: colors.gold, backgroundColor: colors.goldSoft },
  chipText: { ...typography.bold, color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold },
  content: { marginTop: 10 },
  field: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  fieldLabel: { ...typography.medium, color: colors.text, fontSize: 13 },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  stepText: { ...typography.bold, color: colors.text, fontSize: 17 },
  input: {
    ...typography.number,
    width: 76,
    height: 44,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    textAlign: 'center',
  },
  switchRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  error: {
    ...typography.medium,
    marginTop: 8,
    color: colors.red,
    fontSize: 11,
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
  },
  secondaryText: { ...typography.bold, color: colors.text, fontSize: 12 },
  applyButton: {
    flex: 1.2,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.gold,
  },
  applyText: { ...typography.bold, color: colors.black, fontSize: 12 },
  disabled: { opacity: 0.45 },
});
