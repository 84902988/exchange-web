import React, { type ReactNode, useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  ArrowLeft,
  ChevronDown,
  Clipboard,
  RefreshCw,
  Search,
  X,
} from 'lucide-react-native';
import PrimaryButton from '../../common/PrimaryButton';
import { useLanguage, type Translator } from '../../../i18n';
import { colors, typography } from '../../../theme';

type HeaderProps = {
  title: string;
  subtitle?: string;
  backAccessibilityLabel?: string;
  onBack: () => void;
  right?: ReactNode;
};

type StateCardProps = {
  title: string;
  description?: string;
  actionTitle?: string;
  onActionPress?: () => void;
};

type Option = {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
};

type SelectChipsProps = {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  emptyText?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
};

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
  maxLength?: number;
  right?: ReactNode;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  editable?: boolean;
};

export function ActionHeader({
  title,
  subtitle,
  backAccessibilityLabel,
  onBack,
  right,
}: HeaderProps) {
  const { t } = useLanguage();
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel={backAccessibilityLabel ?? t('common.back')}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(216, 176, 74, 0.14)', borderless: true }}
        hitSlop={6}
        style={({ pressed }) => [
          styles.backButton,
          pressed ? styles.iconButtonPressed : null,
        ]}
        onPress={onBack}
      >
        <ArrowLeft color={colors.text} size={20} strokeWidth={2.2} />
      </Pressable>
      <View style={styles.headerTextWrap}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? (
          <Text style={styles.headerSubtitle}>{subtitle}</Text>
        ) : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

export function ActionCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function StateCard({
  title,
  description,
  actionTitle,
  onActionPress,
}: StateCardProps) {
  return (
    <ActionCard>
      <Text style={styles.stateTitle}>{title}</Text>
      {description ? <Text style={styles.stateDesc}>{description}</Text> : null}
      {actionTitle && onActionPress ? (
        <View style={styles.stateAction}>
          <PrimaryButton title={actionTitle} onPress={onActionPress} />
        </View>
      ) : null}
    </ActionCard>
  );
}

export function AuthRequiredCard({
  onLoginPress,
  title,
  description,
  actionTitle,
}: {
  onLoginPress: () => void;
  title?: string;
  description?: string;
  actionTitle?: string;
}) {
  const { t } = useLanguage();
  return (
    <StateCard
      title={title ?? t('assetAction.auth.title')}
      description={description ?? t('assetAction.auth.description')}
      actionTitle={actionTitle ?? t('assetAction.auth.login')}
      onActionPress={onLoginPress}
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function SelectChips({
  label,
  value,
  options,
  onChange,
  emptyText,
  searchable = false,
  searchPlaceholder,
}: SelectChipsProps) {
  const { t } = useLanguage();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedOption = useMemo(
    () => options.find(option => option.value === value) ?? null,
    [options, value],
  );
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter(option =>
      [option.label, option.value, option.meta]
        .filter(Boolean)
        .some(part =>
          String(part).toLocaleLowerCase().includes(normalizedQuery),
        ),
    );
  }, [options, query]);
  const closePicker = () => {
    setPickerOpen(false);
    setQuery('');
  };

  if (searchable) {
    return (
      <View style={styles.fieldBlock}>
        <SectionLabel>{label}</SectionLabel>
        {options.length === 0 ? (
          <Text style={styles.emptyText}>
            {emptyText ?? t('assetAction.noOptions')}
          </Text>
        ) : (
          <>
            <Pressable
              accessibilityLabel={`${label}${t('common.a11ySeparator')}${
                selectedOption?.label ?? t('assetAction.selectOption')
              }`}
              accessibilityRole="button"
              accessibilityState={{ expanded: pickerOpen }}
              android_ripple={{ color: 'rgba(216, 176, 74, 0.12)' }}
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [
                styles.pickerTrigger,
                pressed ? styles.pickerPressed : null,
              ]}
            >
              <View style={styles.pickerTriggerText}>
                <Text numberOfLines={1} style={styles.pickerTriggerLabel}>
                  {selectedOption?.label ?? t('assetAction.selectOption')}
                </Text>
                {selectedOption?.meta ? (
                  <Text numberOfLines={1} style={styles.pickerTriggerMeta}>
                    {selectedOption.meta}
                  </Text>
                ) : null}
              </View>
              <ChevronDown color={colors.textMuted} size={18} />
            </Pressable>
            <Modal
              animationType="slide"
              onRequestClose={closePicker}
              transparent
              visible={pickerOpen}
            >
              <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.pickerModal}
              >
                <Pressable
                  accessibilityLabel={t('common.cancel')}
                  accessibilityRole="button"
                  onPress={closePicker}
                  style={styles.pickerBackdrop}
                />
                <View style={styles.pickerSheet}>
                  <View style={styles.pickerHeader}>
                    <Text style={styles.pickerTitle}>{label}</Text>
                    <Pressable
                      accessibilityLabel={t('common.cancel')}
                      accessibilityRole="button"
                      android_ripple={{
                        color: 'rgba(212, 175, 55, 0.12)',
                        borderless: true,
                      }}
                      hitSlop={8}
                      onPress={closePicker}
                      style={({ pressed }) => [
                        styles.pickerClose,
                        pressed ? styles.pickerPressed : null,
                      ]}
                    >
                      <X color={colors.text} size={20} />
                    </Pressable>
                  </View>
                  <View style={styles.pickerSearchWrap}>
                    <Search color={colors.textMuted} size={17} />
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus
                      onChangeText={setQuery}
                      placeholder={
                        searchPlaceholder ?? t('assetAction.searchOptions')
                      }
                      placeholderTextColor={colors.textSubtle}
                      style={styles.pickerSearchInput}
                      value={query}
                    />
                  </View>
                  {filteredOptions.length === 0 ? (
                    <Text style={styles.pickerEmpty}>
                      {t('assetAction.noMatchingOptions')}
                    </Text>
                  ) : (
                    <FlatList
                      data={filteredOptions}
                      keyboardShouldPersistTaps="handled"
                      keyExtractor={item => item.value}
                      renderItem={({ item }) => {
                        const active = value === item.value;
                        return (
                          <Pressable
                            accessibilityLabel={
                              item.meta
                                ? `${item.label}${t('common.a11ySeparator')}${
                                    item.meta
                                  }`
                                : item.label
                            }
                            accessibilityRole="button"
                            accessibilityState={{
                              disabled: item.disabled,
                              selected: active,
                            }}
                            disabled={item.disabled}
                            android_ripple={{
                              color: 'rgba(216, 176, 74, 0.1)',
                            }}
                            onPress={() => {
                              onChange(item.value);
                              closePicker();
                            }}
                            style={({ pressed }) => [
                              styles.pickerOption,
                              active ? styles.pickerOptionActive : null,
                              item.disabled ? styles.chipDisabled : null,
                              pressed ? styles.pickerPressed : null,
                            ]}
                          >
                            <View style={styles.pickerOptionText}>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.pickerOptionLabel,
                                  active ? styles.chipLabelActive : null,
                                ]}
                              >
                                {item.label}
                              </Text>
                              {item.meta ? (
                                <Text style={styles.pickerOptionMeta}>
                                  {item.meta}
                                </Text>
                              ) : null}
                            </View>
                            {active ? (
                              <View style={styles.pickerSelectedDot} />
                            ) : null}
                          </Pressable>
                        );
                      }}
                      style={styles.pickerList}
                    />
                  )}
                </View>
              </KeyboardAvoidingView>
            </Modal>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.fieldBlock}>
      <SectionLabel>{label}</SectionLabel>
      {options.length === 0 ? (
        <Text style={styles.emptyText}>
          {emptyText ?? t('assetAction.noOptions')}
        </Text>
      ) : (
        <View style={styles.chipWrap}>
          {options.map(option => {
            const active = value === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityLabel={
                  option.meta
                    ? `${option.label}${t('common.a11ySeparator')}${
                        option.meta
                      }`
                    : option.label
                }
                accessibilityRole="button"
                accessibilityState={{
                  disabled: option.disabled,
                  selected: active,
                }}
                disabled={option.disabled}
                android_ripple={{ color: 'rgba(216, 176, 74, 0.12)' }}
                style={({ pressed }) => [
                  styles.chip,
                  active ? styles.chipActive : null,
                  option.disabled ? styles.chipDisabled : null,
                  pressed && !option.disabled ? styles.controlPressed : null,
                ]}
                onPress={() => onChange(option.value)}
              >
                <Text
                  style={[
                    styles.chipLabel,
                    active ? styles.chipLabelActive : null,
                  ]}
                >
                  {option.label}
                </Text>
                {option.meta ? (
                  <Text style={styles.chipMeta}>{option.meta}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

export function ActionTextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  maxLength,
  right,
  autoCapitalize,
  autoCorrect,
  editable = true,
}: FieldProps) {
  return (
    <View style={styles.fieldBlock}>
      <SectionLabel>{label}</SectionLabel>
      <View
        style={[styles.inputWrap, multiline ? styles.inputWrapMultiline : null]}
      >
        <TextInput
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textSubtle}
          keyboardType={keyboardType}
          maxLength={maxLength}
          multiline={multiline}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          editable={editable}
          style={[
            styles.input,
            multiline ? styles.inputMultiline : null,
            !editable ? styles.inputDisabled : null,
          ]}
        />
        {right ? <View style={styles.inputRight}>{right}</View> : null}
      </View>
    </View>
  );
}

export function InfoRow({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: 'green' | 'gold' | 'red';
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text
        style={[
          styles.infoValue,
          mono ? styles.mono : null,
          tone === 'green' ? styles.greenText : null,
          tone === 'gold' ? styles.goldText : null,
          tone === 'red' ? styles.redText : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

export function InlineNotice({
  children,
  tone = 'gold',
}: {
  children: ReactNode;
  tone?: 'gold' | 'red' | 'green';
}) {
  return (
    <View
      style={[
        styles.notice,
        tone === 'red' ? styles.noticeRed : null,
        tone === 'green' ? styles.noticeGreen : null,
      ]}
    >
      <Text
        style={[
          styles.noticeText,
          tone === 'red' ? styles.redText : null,
          tone === 'green' ? styles.greenText : null,
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

export function SmallTextButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{ color: 'rgba(216, 176, 74, 0.12)', borderless: true }}
      disabled={disabled}
      hitSlop={7}
      style={({ pressed }) => [
        styles.textButton,
        pressed && !disabled ? styles.controlPressed : null,
      ]}
      onPress={onPress}
    >
      <Text
        style={[styles.textButtonLabel, disabled ? styles.disabledText : null]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function RefreshButton({
  onPress,
  disabled,
  accessibilityLabel,
}: {
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? t('common.refresh')}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{ color: 'rgba(216, 176, 74, 0.14)', borderless: true }}
      disabled={disabled}
      hitSlop={5}
      style={({ pressed }) => [
        styles.refreshButton,
        pressed && !disabled ? styles.iconButtonPressed : null,
      ]}
      onPress={onPress}
    >
      <RefreshCw color={disabled ? colors.textSubtle : colors.gold} size={17} />
    </Pressable>
  );
}

export function CopyIconButton({
  text,
  onCopied,
  accessibilityLabel,
}: {
  text: string;
  onCopied?: () => void;
  accessibilityLabel?: string;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? t('assetAction.copyA11y')}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(216, 176, 74, 0.14)', borderless: true }}
      hitSlop={5}
      style={({ pressed }) => [
        styles.copyButton,
        pressed ? styles.iconButtonPressed : null,
      ]}
      onPress={async () => {
        await copyText(text);
        onCopied?.();
      }}
    >
      <Clipboard color={colors.gold} size={16} strokeWidth={2.2} />
    </Pressable>
  );
}

export function maskMiddle(value: string, head = 8, tail = 8) {
  const text = value.trim();
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

export function formatAmount(value: unknown, precision = 8) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (match) {
    const sign = match[1] === '-' ? '-' : '';
    const whole = (match[2] || '0').replace(/^0+(?=\d)/, '') || '0';
    const fraction = (match[3] || '')
      .slice(0, Math.max(0, precision))
      .replace(/0+$/, '');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, precision),
  });
}

export function toChineseError(
  error: unknown,
  fallback = '操作失败，请稍后重试',
  t?: Translator,
) {
  const message = error instanceof Error ? error.message : fallback;
  const normalized = message.toLowerCase();
  if (normalized.includes('insufficient') || normalized.includes('balance')) {
    return t ? t('assetAction.error.insufficientBalance') : '可用余额不足';
  }
  if (normalized.includes('amount')) {
    return t
      ? t('assetAction.error.invalidAmount')
      : '数量不正确，请检查后重试';
  }
  if (normalized.includes('network') || normalized.includes('timeout')) {
    return t ? t('assetAction.error.network') : '网络连接异常，请稍后重试';
  }
  if (normalized.includes('code') || normalized.includes('captcha')) {
    return t ? t('assetAction.error.code') : '验证码不正确或已过期';
  }
  if (normalized.includes('address')) {
    return t ? t('assetAction.error.address') : '地址不正确，请检查后重试';
  }
  if (normalized.includes('not supported') || normalized.includes('disabled')) {
    return t ? t('assetAction.error.unavailable') : '当前币种或网络暂不可用';
  }
  if (/[\u4e00-\u9fa5]/.test(message)) return message;
  return fallback;
}

async function copyText(text: string) {
  const nav = (
    globalThis as {
      navigator?: {
        clipboard?: { writeText?: (value: string) => Promise<void> };
      };
    }
  ).navigator;
  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(text);
    return;
  }
  const nativeClipboard = NativeModules.Clipboard as
    | { setString?: (value: string) => void }
    | undefined;
  nativeClipboard?.setString?.(text);
}

const styles = StyleSheet.create({
  header: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  headerTextWrap: {
    flex: 1,
  },
  headerTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 20,
  },
  headerSubtitle: {
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 12,
  },
  headerRight: {
    flexShrink: 0,
  },
  card: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  stateTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
  },
  stateDesc: {
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  stateAction: {
    marginTop: 12,
  },
  sectionLabel: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
    marginBottom: 8,
  },
  fieldBlock: {
    marginTop: 14,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    minHeight: 44,
    minWidth: 76,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: {
    borderColor: colors.gold,
    backgroundColor: colors.goldSoft,
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipLabel: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 12,
  },
  chipLabelActive: {
    color: colors.gold,
  },
  chipMeta: {
    marginTop: 2,
    color: colors.textSubtle,
    fontSize: 10,
  },
  pickerTrigger: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
  },
  pickerPressed: {
    opacity: 0.76,
  },
  controlPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.985 }],
  },
  iconButtonPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.94 }],
  },
  pickerTriggerText: {
    flex: 1,
    minWidth: 0,
  },
  pickerTriggerLabel: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  pickerTriggerMeta: {
    marginTop: 2,
    color: colors.textSubtle,
    fontSize: 10,
  },
  pickerModal: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  pickerBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.64)',
  },
  pickerSheet: {
    maxHeight: '78%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
  },
  pickerHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pickerTitle: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 17,
  },
  pickerClose: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.cardAlt,
  },
  pickerSearchWrap: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
  },
  pickerSearchInput: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  pickerList: {
    flexGrow: 0,
  },
  pickerOption: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 9,
    paddingHorizontal: 4,
  },
  pickerOptionActive: {
    backgroundColor: colors.goldSoft,
  },
  pickerOptionText: {
    flex: 1,
    minWidth: 0,
  },
  pickerOptionLabel: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  pickerOptionMeta: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 11,
  },
  pickerSelectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.gold,
  },
  pickerEmpty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 30,
  },
  inputWrap: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
  },
  inputWrapMultiline: {
    minHeight: 72,
    alignItems: 'flex-start',
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  inputMultiline: {
    minHeight: 56,
    textAlignVertical: 'top',
  },
  inputDisabled: {
    opacity: 0.6,
  },
  inputRight: {
    marginLeft: 8,
  },
  infoRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  infoLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  infoValue: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 12,
    textAlign: 'right',
  },
  mono: {
    ...typography.identifier,
  },
  notice: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.26)',
    backgroundColor: 'rgba(214,168,50,0.1)',
    padding: 10,
  },
  noticeRed: {
    borderColor: 'rgba(240,90,90,0.28)',
    backgroundColor: 'rgba(240,90,90,0.1)',
  },
  noticeGreen: {
    borderColor: 'rgba(25,195,125,0.28)',
    backgroundColor: 'rgba(25,195,125,0.1)',
  },
  noticeText: {
    color: colors.gold,
    fontSize: 12,
    lineHeight: 17,
  },
  greenText: {
    color: colors.green,
  },
  goldText: {
    color: colors.gold,
  },
  redText: {
    color: colors.red,
  },
  textButton: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  textButtonLabel: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  disabledText: {
    color: colors.textSubtle,
  },
  refreshButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  copyButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
});
