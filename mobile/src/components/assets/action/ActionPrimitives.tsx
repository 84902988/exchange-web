import React, {type ReactNode} from 'react';
import {
  NativeModules,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {ArrowLeft, Clipboard, RefreshCw} from 'lucide-react-native';
import PrimaryButton from '../../common/PrimaryButton';
import {colors, typography} from '../../../theme';

type HeaderProps = {
  title: string;
  subtitle?: string;
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
};

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
  right?: ReactNode;
};

export function ActionHeader({title, subtitle, onBack, right}: HeaderProps) {
  return (
    <View style={styles.header}>
      <Pressable style={styles.backButton} onPress={onBack}>
        <ArrowLeft color={colors.text} size={20} strokeWidth={2.2} />
      </Pressable>
      <View style={styles.headerTextWrap}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
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

export function AuthRequiredCard({onLoginPress}: {onLoginPress: () => void}) {
  return (
    <StateCard
      title="请先登录"
      description="充值、提现、划转和资金流水都需要读取你的账户数据。"
      actionTitle="去登录"
      onActionPress={onLoginPress}
    />
  );
}

export function SectionLabel({children}: {children: ReactNode}) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function SelectChips({
  label,
  value,
  options,
  onChange,
  emptyText = '暂无可选项',
}: SelectChipsProps) {
  return (
    <View style={styles.fieldBlock}>
      <SectionLabel>{label}</SectionLabel>
      {options.length === 0 ? (
        <Text style={styles.emptyText}>{emptyText}</Text>
      ) : (
        <View style={styles.chipWrap}>
          {options.map(option => {
            const active = value === option.value;
            return (
              <Pressable
                key={option.value}
                disabled={option.disabled}
                style={[
                  styles.chip,
                  active ? styles.chipActive : null,
                  option.disabled ? styles.chipDisabled : null,
                ]}
                onPress={() => onChange(option.value)}>
                <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>
                  {option.label}
                </Text>
                {option.meta ? <Text style={styles.chipMeta}>{option.meta}</Text> : null}
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
  right,
}: FieldProps) {
  return (
    <View style={styles.fieldBlock}>
      <SectionLabel>{label}</SectionLabel>
      <View style={[styles.inputWrap, multiline ? styles.inputWrapMultiline : null]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textSubtle}
          keyboardType={keyboardType}
          multiline={multiline}
          style={[styles.input, multiline ? styles.inputMultiline : null]}
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
        ]}>
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
      ]}>
      <Text
        style={[
          styles.noticeText,
          tone === 'red' ? styles.redText : null,
          tone === 'green' ? styles.greenText : null,
        ]}>
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
    <Pressable disabled={disabled} style={styles.textButton} onPress={onPress}>
      <Text style={[styles.textButtonLabel, disabled ? styles.disabledText : null]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function RefreshButton({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable disabled={disabled} style={styles.refreshButton} onPress={onPress}>
      <RefreshCw color={disabled ? colors.textSubtle : colors.gold} size={17} />
    </Pressable>
  );
}

export function CopyIconButton({
  text,
  onCopied,
}: {
  text: string;
  onCopied?: () => void;
}) {
  return (
    <Pressable
      style={styles.copyButton}
      onPress={async () => {
        await copyText(text);
        onCopied?.();
      }}>
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
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return num
    .toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: precision,
    })
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

export function toChineseError(error: unknown, fallback = '操作失败，请稍后重试') {
  const message = error instanceof Error ? error.message : fallback;
  const normalized = message.toLowerCase();
  if (normalized.includes('insufficient') || normalized.includes('balance')) {
    return '可用余额不足';
  }
  if (normalized.includes('amount')) return '数量不正确，请检查后重试';
  if (normalized.includes('network') || normalized.includes('timeout')) {
    return '网络连接异常，请稍后重试';
  }
  if (normalized.includes('code') || normalized.includes('captcha')) {
    return '验证码不正确或已过期';
  }
  if (normalized.includes('address')) return '地址不正确，请检查后重试';
  if (normalized.includes('not supported') || normalized.includes('disabled')) {
    return '当前币种或网络暂不可用';
  }
  if (/[\u4e00-\u9fa5]/.test(message)) return message;
  return fallback;
}

async function copyText(text: string) {
  const nav = (
    globalThis as {
      navigator?: {clipboard?: {writeText?: (value: string) => Promise<void>}};
    }
  ).navigator;
  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(text);
    return;
  }
  const nativeClipboard = NativeModules.Clipboard as
    | {setString?: (value: string) => void}
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
    minHeight: 38,
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
    ...typography.number,
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
