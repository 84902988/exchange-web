import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {formatSpotNumber} from '../../api/spot';
import {colors, typography} from '../../theme';

export type TradeSide = 'BUY' | 'SELL';
export type TradeOrderType = 'LIMIT' | 'MARKET';

type Props = {
  side: TradeSide;
  orderType: TradeOrderType;
  price: string;
  amount: string;
  availableText: string;
  quoteAsset: string;
  baseAsset: string;
  isLoggedIn: boolean;
  lastPrice: number | null;
  onSideChange: (side: TradeSide) => void;
  onOrderTypeChange: (type: TradeOrderType) => void;
  onPriceChange: (price: string) => void;
  onAmountChange: (amount: string) => void;
  onPercentPress: (percent: number) => void;
  onLoginPress: () => void;
  onSubmitPress: () => void;
};

const percentSteps = [25, 50, 75, 100];

function TradeOrderForm({
  side,
  orderType,
  price,
  amount,
  availableText,
  quoteAsset,
  baseAsset,
  isLoggedIn,
  lastPrice,
  onSideChange,
  onOrderTypeChange,
  onPriceChange,
  onAmountChange,
  onPercentPress,
  onLoginPress,
  onSubmitPress,
}: Props) {
  const buy = side === 'BUY';
  const submitText = isLoggedIn
    ? `${buy ? '买入' : '卖出'} ${baseAsset}`
    : '登录';
  const tradeValue = getTradeValue(price, amount, orderType, lastPrice);

  return (
    <View style={styles.card}>
      <View style={styles.sideTabs}>
        <Pressable
          style={[styles.sideTab, buy ? styles.buyActive : null]}
          onPress={() => onSideChange('BUY')}>
          <Text style={[styles.sideText, buy ? styles.activeText : null]}>买入</Text>
        </Pressable>
        <Pressable
          style={[styles.sideTab, !buy ? styles.sellActive : null]}
          onPress={() => onSideChange('SELL')}>
          <Text style={[styles.sideText, !buy ? styles.activeText : null]}>卖出</Text>
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

      <Field
        editable={orderType === 'LIMIT'}
        label="价格"
        suffix={quoteAsset}
        value={orderType === 'MARKET' ? '按市场最优价' : price}
        onChangeText={onPriceChange}
      />
      <Pressable style={styles.bbo} onPress={() => onPriceChange(formatSpotNumber(lastPrice, 2))}>
        <Text style={styles.bboText}>BBO</Text>
        <Text style={styles.bboHint}>以当前最优价填入</Text>
      </Pressable>
      <Field
        label="数量"
        suffix={baseAsset}
        value={amount}
        onChangeText={onAmountChange}
      />

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

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>交易额</Text>
        <Text style={styles.metaValue}>{tradeValue} {quoteAsset}</Text>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>可用</Text>
        <Text style={styles.metaValue}>{availableText}</Text>
      </View>
      {!isLoggedIn ? (
        <Text style={styles.loginHint}>登录后可交易，当前仍可查看行情和盘口</Text>
      ) : (
        <Text style={styles.loginHint}>真实下单提交将在下一步接入</Text>
      )}

      <Pressable
        style={[styles.submit, buy ? styles.buyButton : styles.sellButton]}
        onPress={isLoggedIn ? onSubmitPress : onLoginPress}>
        <Text style={styles.submitText}>{submitText}</Text>
      </Pressable>
    </View>
  );
}

export default React.memo(TradeOrderForm);

function Field({
  editable = true,
  label,
  suffix,
  value,
  onChangeText,
}: {
  editable?: boolean;
  label: string;
  suffix: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        editable={editable}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={colors.textSubtle}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
      />
      <Text style={styles.suffix}>{suffix}</Text>
    </View>
  );
}

function getTradeValue(
  price: string,
  amount: string,
  orderType: TradeOrderType,
  lastPrice: number | null,
) {
  const priceNumber = orderType === 'MARKET' ? lastPrice : Number(price);
  const amountNumber = Number(amount);
  if (
    priceNumber === null ||
    !Number.isFinite(priceNumber) ||
    !Number.isFinite(amountNumber)
  ) {
    return '--';
  }
  return formatSpotNumber(priceNumber * amountNumber, 2);
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 0,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 10,
  },
  sideTabs: {
    flexDirection: 'row',
    borderRadius: 7,
    backgroundColor: colors.cardAlt,
    padding: 3,
  },
  sideTab: {
    flex: 1,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  buyActive: {
    backgroundColor: colors.green,
  },
  sellActive: {
    backgroundColor: colors.red,
  },
  sideText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 12,
  },
  activeText: {
    color: colors.white,
  },
  typeTabs: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  typeTab: {
    height: 28,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 6,
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
  field: {
    marginTop: 10,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 9,
  },
  fieldLabel: {
    color: colors.textSubtle,
    fontSize: 10,
    width: 30,
  },
  input: {
    ...typography.number,
    flex: 1,
    color: colors.text,
    fontSize: 12,
    paddingVertical: 0,
  },
  suffix: {
    color: colors.textMuted,
    fontSize: 10,
  },
  bbo: {
    height: 28,
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 7,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 9,
  },
  bboText: {
    ...typography.bold,
    color: colors.primary,
    fontSize: 11,
  },
  bboHint: {
    color: colors.textSubtle,
    fontSize: 9,
  },
  percentRow: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 9,
  },
  percent: {
    flex: 1,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
  },
  percentText: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  metaRow: {
    marginTop: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaLabel: {
    color: colors.textSubtle,
    fontSize: 10,
  },
  metaValue: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  loginHint: {
    marginTop: 10,
    color: colors.textSubtle,
    fontSize: 10,
    lineHeight: 14,
  },
  submit: {
    height: 38,
    marginTop: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  buyButton: {
    backgroundColor: colors.green,
  },
  sellButton: {
    backgroundColor: colors.red,
  },
  submitText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 13,
  },
});
