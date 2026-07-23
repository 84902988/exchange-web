import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {formatContractNumber, type ContractOrderType} from '../../api/contract';
import {colors, typography} from '../../theme';

export type ContractActionMode = 'OPEN' | 'CLOSE';
export type ContractDirection = 'LONG' | 'SHORT';

type Props = {
  actionMode: ContractActionMode;
  direction: ContractDirection;
  orderType: ContractOrderType;
  price: string;
  quantity: string;
  leverage: number;
  availableMargin: number | null;
  equity: number | null;
  lastPrice: number | null;
  markPrice: number | null;
  spreadFeePrice: number | null | undefined;
  pricePrecision: number;
  isLoggedIn: boolean;
  onActionModeChange: (mode: ContractActionMode) => void;
  onDirectionChange: (direction: ContractDirection) => void;
  onOrderTypeChange: (type: ContractOrderType) => void;
  onPriceChange: (price: string) => void;
  onQuantityChange: (quantity: string) => void;
  onPercentPress: (percent: number) => void;
  onBboPress: () => void;
  onLoginPress: () => void;
  onSubmitPress: () => void;
};

const percentSteps = [25, 50, 75, 100];

function ContractOrderForm({
  actionMode,
  direction,
  orderType,
  price,
  quantity,
  leverage,
  availableMargin,
  equity,
  lastPrice,
  markPrice,
  spreadFeePrice,
  pricePrecision,
  isLoggedIn,
  onActionModeChange,
  onDirectionChange,
  onOrderTypeChange,
  onPriceChange,
  onQuantityChange,
  onPercentPress,
  onBboPress,
  onLoginPress,
  onSubmitPress,
}: Props) {
  const long = direction === 'LONG';
  const referencePrice =
    orderType === 'MARKET' ? markPrice ?? lastPrice : Number(price.replace(/,/g, ''));
  const quantityNumber = Number(quantity);
  const referenceValue = referencePrice ?? NaN;
  const notional =
    Number.isFinite(referenceValue) && Number.isFinite(quantityNumber)
      ? referenceValue * quantityNumber
      : null;
  const estimatedMargin = notional === null ? null : notional / leverage;
  const liquidationPrice = getEstimatedLiquidationPrice(
    referencePrice,
    direction,
    leverage,
  );
  const actionLabel =
    actionMode === 'OPEN'
      ? long
        ? '买入开多'
        : '卖出开空'
      : long
        ? '平多'
        : '平空';
  const submitText = isLoggedIn ? actionLabel : '登录';
  const submitStyle = !isLoggedIn
    ? styles.loginButton
    : long
      ? styles.longButton
      : styles.shortButton;

  return (
    <View style={styles.card}>
      <View style={styles.topSection}>
        <View style={styles.modeRow}>
          <Tag label="逐仓" />
          <Tag label={`${leverage}x`} active />
          <Tag label="单向" />
        </View>

        <View style={styles.actionTabs}>
          <Pressable
            style={[styles.actionTab, actionMode === 'OPEN' ? styles.actionActive : null]}
            onPress={() => onActionModeChange('OPEN')}>
            <Text style={styles.actionText}>开仓</Text>
          </Pressable>
          <Pressable
            style={[styles.actionTab, actionMode === 'CLOSE' ? styles.actionActive : null]}
            onPress={() => onActionModeChange('CLOSE')}>
            <Text style={styles.actionText}>平仓</Text>
          </Pressable>
        </View>

        <View style={styles.sideTabs}>
          <Pressable
            style={[styles.sideTab, long ? styles.longActive : null]}
            onPress={() => onDirectionChange('LONG')}>
            <Text style={[styles.sideText, long ? styles.activeSideText : null]}>
              {actionMode === 'OPEN' ? '开多' : '平多'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.sideTab, !long ? styles.shortActive : null]}
            onPress={() => onDirectionChange('SHORT')}>
            <Text style={[styles.sideText, !long ? styles.activeSideText : null]}>
              {actionMode === 'OPEN' ? '开空' : '平空'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.typeTabs}>
          <Pressable
            style={[styles.typeTab, orderType === 'LIMIT' ? styles.typeActive : null]}
            onPress={() => onOrderTypeChange('LIMIT')}>
            <Text style={styles.typeText}>限价</Text>
          </Pressable>
          <Pressable
            style={[styles.typeTab, orderType === 'MARKET' ? styles.typeActive : null]}
            onPress={() => onOrderTypeChange('MARKET')}>
            <Text style={styles.typeText}>市价</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.inputSection}>
      <Field
        actionLabel={orderType === 'LIMIT' ? 'BBO' : undefined}
        editable={orderType === 'LIMIT'}
        helperText={orderType === 'LIMIT' ? '以当前最优价填入' : undefined}
        label="价格"
        suffix="USDT"
        value={orderType === 'MARKET' ? '按市场最优价' : price}
        onActionPress={onBboPress}
        onChangeText={onPriceChange}
      />
      <Field
        label="数量"
        suffix="BTC"
        value={quantity}
        onChangeText={onQuantityChange}
      />
      </View>

      <View style={styles.percentRow}>
        {percentSteps.map(step => (
          <Pressable
            key={step}
            style={styles.percent}
            onPress={() => onPercentPress(step)}>
            <Text style={styles.percentText}>{step}%</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.metrics}>
        <Metric label="账户权益" value={`${formatContractNumber(equity, 2)} USDT`} />
        <Metric label="可用保证金" value={`${formatContractNumber(availableMargin, 2)} USDT`} />
        <Metric label="预计保证金" value={`${formatContractNumber(estimatedMargin, 2)} USDT`} />
        <Metric
          label="预估强平价"
          value={formatContractNumber(liquidationPrice, pricePrecision)}
        />
        <Metric
          label="点差/手续费提示"
          value={`${formatContractNumber(spreadFeePrice, pricePrecision)} USDT`}
        />
      </View>

      <View style={styles.bottomSection}>
        <Text style={styles.loginHint}>
          {isLoggedIn
            ? '合约下单功能暂未开放'
            : '登录后可交易，行情/K线可查看'}
        </Text>

        <Pressable
          style={[styles.submit, submitStyle]}
          onPress={isLoggedIn ? onSubmitPress : onLoginPress}>
          <Text style={styles.submitText}>{submitText}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default React.memo(ContractOrderForm);

function Field({
  editable = true,
  label,
  suffix,
  value,
  actionLabel,
  helperText,
  onActionPress,
  onChangeText,
}: {
  editable?: boolean;
  label: string;
  suffix: string;
  value: string;
  actionLabel?: string;
  helperText?: string;
  onActionPress?: () => void;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <TextInput
          editable={editable}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={colors.textSubtle}
          selectTextOnFocus={editable}
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
        />
        <Text style={styles.suffix}>{suffix}</Text>
        {actionLabel ? (
          <Pressable style={styles.inlineAction} onPress={onActionPress}>
            <Text style={styles.inlineActionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      {helperText ? <Text style={styles.fieldHelp}>{helperText}</Text> : null}
    </View>
  );
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function Tag({label, active = false}: {label: string; active?: boolean}) {
  return (
    <View style={[styles.tag, active ? styles.activeTag : null]}>
      <Text style={[styles.tagText, active ? styles.activeTagText : null]}>{label}</Text>
    </View>
  );
}

function getEstimatedLiquidationPrice(
  referencePrice: number | null,
  direction: ContractDirection,
  leverage: number,
) {
  if (referencePrice === null || !Number.isFinite(referencePrice) || leverage <= 0) {
    return null;
  }
  const buffer = 0.9 / leverage;
  return direction === 'LONG'
    ? referencePrice * (1 - buffer)
    : referencePrice * (1 + buffer);
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    height: '100%',
    minWidth: 0,
    justifyContent: 'space-between',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 8,
  },
  topSection: {
    minHeight: 151,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 5,
  },
  tag: {
    height: 22,
    justifyContent: 'center',
    borderRadius: 5,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 8,
  },
  activeTag: {
    backgroundColor: colors.primarySoft,
  },
  tagText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 10,
  },
  activeTagText: {
    color: colors.gold,
    fontWeight: '900',
  },
  actionTabs: {
    marginTop: 8,
    flexDirection: 'row',
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
    padding: 2,
  },
  actionTab: {
    flex: 1,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
  },
  actionActive: {
    backgroundColor: colors.primarySoft,
  },
  actionText: {
    ...typography.bold,
    color: colors.text,
    fontSize: 12,
  },
  sideTabs: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  sideTab: {
    flex: 1,
    height: 31,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
  },
  longActive: {
    backgroundColor: colors.green,
  },
  shortActive: {
    backgroundColor: colors.red,
  },
  sideText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 12,
  },
  activeSideText: {
    color: colors.white,
  },
  typeTabs: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  typeTab: {
    height: 26,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 5,
    backgroundColor: colors.cardAlt,
  },
  typeActive: {
    backgroundColor: colors.primarySoft,
  },
  typeText: {
    ...typography.medium,
    color: colors.text,
    fontSize: 11,
  },
  fieldWrap: {
    marginTop: 0,
  },
  inputSection: {
    gap: 8,
  },
  field: {
    minHeight: 39,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 8,
  },
  fieldLabel: {
    color: colors.textSubtle,
    fontSize: 10,
    width: 30,
  },
  input: {
    ...typography.number,
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 12,
    paddingVertical: 0,
  },
  suffix: {
    marginLeft: 6,
    color: colors.textMuted,
    fontSize: 10,
  },
  inlineAction: {
    width: 40,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    marginLeft: 9,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.42)',
  },
  inlineActionText: {
    ...typography.bold,
    color: colors.primary,
    fontSize: 10,
  },
  fieldHelp: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 9,
  },
  percentRow: {
    flexDirection: 'row',
    gap: 4,
  },
  percent: {
    flex: 1,
    height: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    backgroundColor: colors.cardAlt,
  },
  percentText: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  metrics: {
    minHeight: 92,
    justifyContent: 'center',
  },
  metaRow: {
    minHeight: 17,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metaLabel: {
    color: colors.textSubtle,
    fontSize: 9,
  },
  metaValue: {
    ...typography.number,
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    textAlign: 'right',
  },
  loginHint: {
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  bottomSection: {
    minHeight: 58,
    justifyContent: 'flex-end',
  },
  submit: {
    height: 38,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
  },
  loginButton: {
    backgroundColor: colors.green,
  },
  longButton: {
    backgroundColor: colors.green,
  },
  shortButton: {
    backgroundColor: colors.red,
  },
  submitText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 13,
  },
});
