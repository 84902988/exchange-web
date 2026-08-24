import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { formatSpotNumber } from '../../api/spot';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import TradingNumericInput from '../common/TradingNumericInput';

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
  submitting: boolean;
  submitDisabled: boolean;
  feedbackText: string;
  feedbackTone: 'error' | 'success' | null;
  pendingIntentReviewVisible?: boolean;
  pendingIntentReviewBusy?: boolean;
  pendingIntentReviewLabel?: string;
  estimatedFeeLabel: string;
  estimatedFeeText: string;
  onSideChange: (side: TradeSide) => void;
  onOrderTypeChange: (type: TradeOrderType) => void;
  onPriceChange: (price: string) => void;
  onAmountChange: (amount: string) => void;
  onPercentPress: (percent: number) => void;
  onBboPress: () => void;
  onLoginPress: () => void;
  onSubmitPress: () => void;
  onPendingIntentReviewPress?: () => void;
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
  submitting,
  submitDisabled,
  feedbackText,
  feedbackTone,
  pendingIntentReviewVisible = false,
  pendingIntentReviewBusy = false,
  pendingIntentReviewLabel,
  estimatedFeeLabel,
  estimatedFeeText,
  onSideChange,
  onOrderTypeChange,
  onPriceChange,
  onAmountChange,
  onPercentPress,
  onBboPress,
  onLoginPress,
  onSubmitPress,
  onPendingIntentReviewPress,
}: Props) {
  const { t } = useLanguage();
  const { width: screenWidth } = useWindowDimensions();
  const compactFields = screenWidth < 360;
  const buy = side === 'BUY';
  const submitText = isLoggedIn
    ? submitting
      ? t('trading.submitPending')
      : `${t(buy ? 'trading.buy' : 'trading.sell')} ${baseAsset}`
    : t('trading.login');
  const submitStyle = !isLoggedIn
    ? styles.loginButton
    : buy
    ? styles.buyButton
    : styles.sellButton;
  const tradeValue = getTradeValue(price, amount, orderType, lastPrice);
  const tradeDisabled = isLoggedIn && submitting;
  const reviewLabel = pendingIntentReviewLabel || t('trading.reviewOrder');
  const visibleFeedback =
    feedbackText || (!isLoggedIn ? t('trading.loginToTrade') : '');

  return (
    <View style={styles.card}>
      <View style={styles.topSection}>
        <View style={styles.sideTabs}>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: buy, disabled: submitting }}
            android_ripple={{ color: 'rgba(25, 195, 125, 0.12)' }}
            disabled={submitting}
            hitSlop={{ top: 5, bottom: 5 }}
            style={({ pressed }) => [
              styles.sideTab,
              buy ? styles.buyActive : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onSideChange('BUY')}
          >
            <Text style={[styles.sideText, buy ? styles.activeText : null]}>
              {t('trading.buy')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: !buy, disabled: submitting }}
            android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
            disabled={submitting}
            hitSlop={{ top: 5, bottom: 5 }}
            style={({ pressed }) => [
              styles.sideTab,
              !buy ? styles.sellActive : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onSideChange('SELL')}
          >
            <Text style={[styles.sideText, !buy ? styles.activeText : null]}>
              {t('trading.sell')}
            </Text>
          </Pressable>
        </View>

        <View style={styles.typeTabs}>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{
              selected: orderType === 'LIMIT',
              disabled: submitting,
            }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            disabled={submitting}
            hitSlop={{ top: 8, bottom: 8 }}
            style={({ pressed }) => [
              styles.typeTab,
              orderType === 'LIMIT' ? styles.typeActive : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onOrderTypeChange('LIMIT')}
          >
            <Text style={styles.typeText}>{t('trading.limit')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{
              selected: orderType === 'MARKET',
              disabled: submitting,
            }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            disabled={submitting}
            hitSlop={{ top: 8, bottom: 8 }}
            style={({ pressed }) => [
              styles.typeTab,
              orderType === 'MARKET' ? styles.typeActive : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onOrderTypeChange('MARKET')}
          >
            <Text style={styles.typeText}>{t('trading.market')}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.inputSection}>
        <Field
          actionLabel={orderType === 'LIMIT' ? 'BBO' : undefined}
          compact={compactFields}
          editable={orderType === 'LIMIT' && !submitting}
          label={t('trading.price')}
          suffix={quoteAsset}
          value={orderType === 'MARKET' ? t('trading.marketBestPrice') : price}
          onActionPress={onBboPress}
          onChangeText={onPriceChange}
        />
        <Field
          compact={compactFields}
          editable={!submitting}
          label={t('trading.quantity')}
          suffix={baseAsset}
          value={amount}
          onChangeText={onAmountChange}
        />
      </View>

      <View style={styles.percentRow}>
        {percentSteps.map(step => (
          <Pressable
            accessibilityLabel={t('trading.useAvailablePercentA11y', {
              percent: step,
            })}
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            disabled={submitting}
            hitSlop={{ top: 9, bottom: 9 }}
            key={step}
            style={({ pressed }) => [
              styles.percent,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onPercentPress(step)}
          >
            <Text
              maxFontSizeMultiplier={compactFields ? 1 : 1.15}
              numberOfLines={1}
              style={[
                styles.percentText,
                compactFields ? styles.percentTextCompact : null,
              ]}
            >
              {step}%
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.metrics} testID="trade-order-form-metrics">
        <Metric
          label={t('trading.tradeValue')}
          value={`${tradeValue} ${quoteAsset}`}
        />
        <Metric label={t('trading.available')} value={availableText} />
        <Metric label={estimatedFeeLabel} value={estimatedFeeText} />
      </View>

      <View style={styles.bottomSection}>
        <View
          style={styles.feedbackRow}
          testID="trade-order-form-feedback-slot"
        >
          {visibleFeedback ? (
            <Text
              numberOfLines={2}
              style={[
                styles.loginHint,
                feedbackTone === 'error' ? styles.errorText : null,
                feedbackTone === 'success' ? styles.successText : null,
              ]}
            >
              {visibleFeedback}
            </Text>
          ) : (
            <View style={styles.feedbackSpacer} />
          )}
          {pendingIntentReviewVisible && onPendingIntentReviewPress ? (
            <Pressable
              accessibilityLabel={reviewLabel}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              disabled={pendingIntentReviewBusy}
              hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
              style={({ pressed }) => [
                styles.reviewButton,
                pressed ? styles.pressed : null,
              ]}
              onPress={onPendingIntentReviewPress}
            >
              <Text numberOfLines={1} style={styles.reviewButtonText}>
                {pendingIntentReviewBusy
                  ? t('trading.processing')
                  : reviewLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <Pressable
          accessibilityHint={submitDisabled ? visibleFeedback : undefined}
          accessibilityLabel={submitText}
          accessibilityRole="button"
          accessibilityState={{ busy: submitting, disabled: tradeDisabled }}
          android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
          disabled={tradeDisabled}
          style={({ pressed }) => [
            styles.submit,
            submitStyle,
            tradeDisabled ? styles.submitDisabled : null,
            pressed ? styles.submitPressed : null,
          ]}
          onPress={isLoggedIn ? onSubmitPress : onLoginPress}
        >
          <Text style={styles.submitText}>{submitText}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default React.memo(TradeOrderForm);

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text numberOfLines={1} style={styles.metaLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function Field({
  editable = true,
  label,
  suffix,
  value,
  actionLabel,
  compact = false,
  helperText,
  onActionPress,
  onChangeText,
}: {
  editable?: boolean;
  label: string;
  suffix: string;
  value: string;
  actionLabel?: string;
  compact?: boolean;
  helperText?: string;
  onActionPress?: () => void;
  onChangeText: (value: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.field}>
        <View style={styles.fieldMain}>
          <Text style={styles.fieldLabel}>
            {compact ? `${label}(${suffix})` : label}
          </Text>
          <TradingNumericInput
            accessibilityLabel={label}
            accessibilityState={{ disabled: !editable }}
            editable={editable}
            maxFontSizeMultiplier={compact ? 1.1 : 1.3}
            placeholder="0"
            placeholderTextColor={colors.textSubtle}
            selectTextOnFocus={editable}
            style={styles.input}
            value={value}
            onChangeText={onChangeText}
          />
        </View>
        {!compact ? <Text style={styles.suffix}>{suffix}</Text> : null}
        {actionLabel ? (
          <Pressable
            accessibilityHint={helperText}
            accessibilityLabel={t('trading.fillBestPriceA11y')}
            accessibilityRole="button"
            accessibilityState={{ disabled: !editable }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
            disabled={!editable}
            hitSlop={{ top: 9, bottom: 9 }}
            style={({ pressed }) => [
              styles.inlineAction,
              pressed ? styles.pressed : null,
            ]}
            onPress={onActionPress}
          >
            <Text style={styles.inlineActionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      {helperText ? <Text style={styles.fieldHelp}>{helperText}</Text> : null}
    </View>
  );
}

function getTradeValue(
  price: string,
  amount: string,
  orderType: TradeOrderType,
  lastPrice: number | null,
) {
  const priceNumber =
    orderType === 'MARKET' ? lastPrice : Number(price.replace(/,/g, ''));
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
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  submitPressed: { opacity: 0.86, transform: [{ scale: 0.992 }] },
  card: {
    flex: 1,
    height: '100%',
    minWidth: 0,
    justifyContent: 'space-between',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 10,
  },
  topSection: {
    minHeight: 78,
  },
  sideTabs: {
    flexDirection: 'row',
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    padding: 3,
  },
  sideTab: {
    flex: 1,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
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
    fontSize: 13,
  },
  activeText: {
    color: colors.white,
  },
  typeTabs: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  typeTab: {
    flex: 1,
    height: 29,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  typeActive: {
    backgroundColor: colors.primarySoft,
    borderColor: 'rgba(214,168,50,0.52)',
  },
  typeText: {
    ...typography.medium,
    color: colors.text,
    fontSize: 12,
  },
  fieldWrap: {
    marginTop: 0,
  },
  inputSection: {
    gap: 10,
  },
  field: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 9,
  },
  fieldMain: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  fieldLabel: {
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  input: {
    ...typography.number,
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 14,
    lineHeight: 18,
    paddingVertical: 0,
  },
  suffix: {
    marginLeft: 5,
    color: colors.textMuted,
    fontSize: 10,
  },
  inlineAction: {
    width: 38,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    marginLeft: 6,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.42)',
  },
  inlineActionText: {
    ...typography.bold,
    color: colors.primary,
    fontSize: 11,
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
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    backgroundColor: colors.cardAlt,
  },
  percentText: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  percentTextCompact: {
    fontSize: 9,
  },
  metrics: {
    height: 76,
    justifyContent: 'center',
  },
  metaRow: {
    height: 23,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metaLabel: {
    color: colors.textSubtle,
    fontSize: 11,
  },
  metaValue: {
    ...typography.number,
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
  },
  loginHint: {
    flex: 1,
    color: colors.textSubtle,
    fontSize: 11,
    lineHeight: 15,
  },
  errorText: {
    color: colors.red,
  },
  successText: {
    color: colors.green,
  },
  bottomSection: {
    height: 84,
    justifyContent: 'flex-end',
  },
  feedbackRow: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  feedbackSpacer: {
    flex: 1,
  },
  reviewButton: {
    minHeight: 30,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.gold,
    borderRadius: 8,
  },
  reviewButtonText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 10,
  },
  submit: {
    height: 44,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  loginButton: {
    backgroundColor: colors.green,
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
    fontSize: 14,
  },
  submitDisabled: {
    opacity: 0.48,
  },
});
