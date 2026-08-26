import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import {
  formatContractNumber,
  type ContractOrderType,
} from '../../api/contract';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import TradingNumericInput from '../common/TradingNumericInput';
import ContractLeverageSelectorSheet from './ContractLeverageSelectorSheet';

export type ContractActionMode = 'OPEN' | 'CLOSE';
export type ContractDirection = 'LONG' | 'SHORT';

type Props = {
  actionMode: ContractActionMode;
  direction: ContractDirection;
  orderType: ContractOrderType;
  price: string;
  quantity: string;
  leverage: number;
  maxLeverage: number | null;
  availableMargin: number | null;
  equity: number | null;
  lastPrice: number | null;
  markPrice: number | null;
  spreadFeePrice: number | null | undefined;
  pricePrecision: number;
  baseAsset: string;
  quoteAsset: string;
  isLoggedIn: boolean;
  submitting: boolean;
  submitDisabled: boolean;
  feedbackText: string;
  feedbackTone: 'error' | 'success' | null;
  pendingIntentReviewVisible?: boolean;
  pendingIntentReviewBusy?: boolean;
  pendingIntentReviewLabel?: string;
  onActionModeChange: (mode: ContractActionMode) => void;
  onDirectionChange: (direction: ContractDirection) => void;
  onOrderTypeChange: (type: ContractOrderType) => void;
  onPriceChange: (price: string) => void;
  onQuantityChange: (quantity: string) => void;
  onLeverageChange: (leverage: number) => void;
  onPercentPress: (percent: number) => void;
  onBboPress: () => void;
  onLoginPress: () => void;
  onSubmitPress: () => void;
  onPendingIntentReviewPress?: () => void;
};

const percentSteps = [25, 50, 75, 100];

function ContractOrderForm({
  actionMode,
  direction,
  orderType,
  price,
  quantity,
  leverage,
  maxLeverage,
  availableMargin,
  equity,
  lastPrice,
  markPrice,
  spreadFeePrice,
  baseAsset,
  quoteAsset,
  isLoggedIn,
  submitting,
  submitDisabled,
  feedbackText,
  feedbackTone,
  pendingIntentReviewVisible = false,
  pendingIntentReviewBusy = false,
  pendingIntentReviewLabel,
  onActionModeChange,
  onDirectionChange,
  onOrderTypeChange,
  onPriceChange,
  onQuantityChange,
  onLeverageChange,
  onPercentPress,
  onBboPress,
  onLoginPress,
  onSubmitPress,
  onPendingIntentReviewPress,
}: Props) {
  const { t } = useLanguage();
  const { fontScale, width: windowWidth } = useWindowDimensions();
  const [leverageSelectorVisible, setLeverageSelectorVisible] = useState(false);
  const compact = isCompactContractOrderForm(windowWidth, fontScale);
  const long = direction === 'LONG';
  const buySelected = actionMode === 'OPEN' ? long : !long;
  const buyDirection: ContractDirection =
    actionMode === 'OPEN' ? 'LONG' : 'SHORT';
  const sellDirection: ContractDirection =
    actionMode === 'OPEN' ? 'SHORT' : 'LONG';
  const referencePrice =
    orderType === 'MARKET'
      ? markPrice ?? lastPrice
      : Number(price.replace(/,/g, ''));
  const quantityNumber = Number(quantity.replace(/,/g, ''));
  const referenceValue = referencePrice ?? NaN;
  const orderDraftValid =
    Number.isFinite(referenceValue) &&
    referenceValue > 0 &&
    Number.isFinite(quantityNumber) &&
    quantityNumber > 0;
  const notional =
    Number.isFinite(referenceValue) && Number.isFinite(quantityNumber)
      ? referenceValue * quantityNumber
      : null;
  const estimatedMargin = notional === null ? null : notional / leverage;
  const estimatedSpreadCost = calculateContractSpreadCost(
    spreadFeePrice,
    quantityNumber,
  );
  const actionLabel = buySelected
    ? t('contract.buyOpenLong')
    : t('contract.sellOpenShort');
  const submitText = isLoggedIn
    ? submitting
      ? t('trading.submitPending')
      : actionLabel
    : t('trading.login');
  const submitAccessibilityLabel = !isLoggedIn
    ? t('trading.login')
    : buySelected
    ? t('contract.submitBuyOrderA11y')
    : t('contract.submitSellOrderA11y');
  const submitStyle = !isLoggedIn
    ? styles.loginButton
    : buySelected
    ? styles.longButton
    : styles.shortButton;
  const tradeDisabled =
    isLoggedIn && (submitting || submitDisabled || !orderDraftValid);
  const leverageControlDisabled = submitting || maxLeverage === null;
  const reviewLabel = pendingIntentReviewLabel || t('trading.reviewOrder');

  return (
    <>
      <View style={[styles.card, compact ? styles.cardCompact : null]}>
        <View style={styles.topSection}>
          <View style={styles.modeRow}>
            <Tag label={t('contract.isolated')} />
            <Pressable
              accessibilityLabel={t('contract.currentLeverageA11y', {
                leverage,
              })}
              accessibilityHint={
                maxLeverage === null
                  ? t('contract.rulesBeforeAdjust')
                  : t('contract.leverageRange', { max: maxLeverage })
              }
              accessibilityRole="button"
              accessibilityState={{ disabled: leverageControlDisabled }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              accessibilityValue={{
                min: 1,
                max: maxLeverage ?? 1,
                now: leverage,
                text: t('contract.leverageValue', { leverage }),
              }}
              style={({ pressed }) => [
                styles.leverageControl,
                leverageControlDisabled ? styles.leverageControlDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              disabled={leverageControlDisabled}
              hitSlop={{ top: 5, bottom: 5 }}
              onPress={() => setLeverageSelectorVisible(true)}
            >
              <View style={styles.leverageValueWrap}>
                <Text maxFontSizeMultiplier={1.15} style={styles.leverageValue}>
                  {leverage}x
                </Text>
                <Text
                  maxFontSizeMultiplier={1.15}
                  numberOfLines={1}
                  style={styles.leverageLimitText}
                >
                  {maxLeverage === null
                    ? t('contract.loading')
                    : `≤${maxLeverage}x`}
                </Text>
              </View>
              <ChevronDown color={colors.gold} size={14} strokeWidth={2.2} />
            </Pressable>
            {compact ? null : <Tag label={t('contract.oneWay')} />}
          </View>

          <View style={styles.actionTabs}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{
                disabled: submitting,
                selected: actionMode === 'OPEN',
              }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              disabled={submitting}
              hitSlop={{ top: 9, bottom: 9 }}
              style={({ pressed }) => [
                styles.actionTab,
                actionMode === 'OPEN' ? styles.actionActive : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onActionModeChange('OPEN')}
            >
              <Text maxFontSizeMultiplier={1.15} style={styles.actionText}>
                {t('trading.action.open')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{
                disabled: submitting,
                selected: actionMode === 'CLOSE',
              }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              disabled={submitting}
              hitSlop={{ top: 9, bottom: 9 }}
              style={({ pressed }) => [
                styles.actionTab,
                actionMode === 'CLOSE' ? styles.actionActive : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onActionModeChange('CLOSE')}
            >
              <Text maxFontSizeMultiplier={1.15} style={styles.actionText}>
                {t('trading.action.close')}
              </Text>
            </Pressable>
          </View>

          <View style={styles.sideTabs}>
            <Pressable
              accessibilityLabel={t('contract.selectBuyOrderA11y')}
              accessibilityRole="button"
              accessibilityState={{
                disabled: submitting,
                selected: buySelected,
              }}
              android_ripple={{ color: 'rgba(25, 195, 125, 0.12)' }}
              disabled={submitting}
              hitSlop={{ top: 7, bottom: 7 }}
              style={({ pressed }) => [
                styles.sideTab,
                buySelected ? styles.longActive : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onDirectionChange(buyDirection)}
            >
              <Text
                maxFontSizeMultiplier={1.15}
                style={[
                  styles.sideText,
                  buySelected ? styles.activeSideText : null,
                ]}
              >
                {t('contract.openLong')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={t('contract.selectSellOrderA11y')}
              accessibilityRole="button"
              accessibilityState={{
                disabled: submitting,
                selected: !buySelected,
              }}
              android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
              disabled={submitting}
              hitSlop={{ top: 7, bottom: 7 }}
              style={({ pressed }) => [
                styles.sideTab,
                !buySelected ? styles.shortActive : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onDirectionChange(sellDirection)}
            >
              <Text
                maxFontSizeMultiplier={1.15}
                style={[
                  styles.sideText,
                  !buySelected ? styles.activeSideText : null,
                ]}
              >
                {t('contract.openShort')}
              </Text>
            </Pressable>
          </View>

          <View style={styles.typeTabs}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{
                disabled: submitting,
                selected: orderType === 'LIMIT',
              }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              disabled={submitting}
              hitSlop={{ top: 9, bottom: 9 }}
              style={({ pressed }) => [
                styles.typeTab,
                orderType === 'LIMIT' ? styles.typeActive : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onOrderTypeChange('LIMIT')}
            >
              <Text maxFontSizeMultiplier={1.15} style={styles.typeText}>
                {t('trading.limit')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{
                disabled: submitting,
                selected: orderType === 'MARKET',
              }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              disabled={submitting}
              hitSlop={{ top: 9, bottom: 9 }}
              style={({ pressed }) => [
                styles.typeTab,
                orderType === 'MARKET' ? styles.typeActive : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onOrderTypeChange('MARKET')}
            >
              <Text maxFontSizeMultiplier={1.15} style={styles.typeText}>
                {t('trading.market')}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.inputSection}>
          <Field
            actionLabel={orderType === 'LIMIT' ? 'BBO' : undefined}
            compact={compact}
            editable={orderType === 'LIMIT' && !submitting}
            helperText={
              orderType === 'LIMIT' && !compact
                ? t('contract.fillBestPriceHint')
                : undefined
            }
            label={t('trading.price')}
            suffix={compact ? '' : quoteAsset}
            value={
              orderType === 'MARKET' ? t('trading.marketBestPrice') : price
            }
            onActionPress={onBboPress}
            onChangeText={onPriceChange}
          />
          <Field
            compact={compact}
            editable={!submitting}
            label={t('trading.quantity')}
            suffix={compact ? '' : baseAsset}
            value={quantity}
            onChangeText={onQuantityChange}
          />
        </View>

        <View style={styles.percentRow}>
          {percentSteps.map(step => (
            <Pressable
              accessibilityLabel={t('trading.usePercentA11y', {
                percent: step,
              })}
              accessibilityRole="button"
              accessibilityState={{ disabled: submitting }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              disabled={submitting}
              hitSlop={{ top: 11, bottom: 11 }}
              key={step}
              style={({ pressed }) => [
                styles.percent,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onPercentPress(step)}
            >
              <Text maxFontSizeMultiplier={1.15} style={styles.percentText}>
                {step}%
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.metrics}>
          <Metric
            label={t('contract.accountEquity')}
            value={`${formatContractNumber(equity, 2)} ${quoteAsset}`}
          />
          <Metric
            label={t('contract.availableMargin')}
            value={`${formatContractNumber(availableMargin, 2)} ${quoteAsset}`}
          />
          <Metric
            label={t('contract.estimatedMargin')}
            value={`${formatContractNumber(estimatedMargin, 2)} ${quoteAsset}`}
          />
          <Metric
            label={t('contract.feeHint')}
            value={`${formatContractNumber(estimatedSpreadCost, 2)} ${quoteAsset}`}
          />
        </View>

        <View style={styles.bottomSection}>
          <View style={styles.feedbackRow}>
            <Text
              numberOfLines={2}
              maxFontSizeMultiplier={1.15}
              style={[
                styles.loginHint,
                feedbackTone === 'error' ? styles.errorText : null,
                feedbackTone === 'success' ? styles.successText : null,
              ]}
            >
              {feedbackText ||
                (isLoggedIn
                  ? t('contract.riskCheck')
                  : t('contract.loginMarketView'))}
            </Text>
            {pendingIntentReviewVisible && onPendingIntentReviewPress ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{
                  busy: pendingIntentReviewBusy,
                  disabled: pendingIntentReviewBusy,
                }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                disabled={pendingIntentReviewBusy}
                hitSlop={{ top: 11, bottom: 11, left: 4, right: 4 }}
                style={({ pressed }) => [
                  styles.reviewButton,
                  pressed ? styles.pressed : null,
                ]}
                onPress={onPendingIntentReviewPress}
              >
                <Text
                  maxFontSizeMultiplier={1.15}
                  style={styles.reviewButtonText}
                >
                  {pendingIntentReviewBusy
                    ? t('contract.reviewing')
                    : reviewLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>

          <Pressable
            accessibilityLabel={submitAccessibilityLabel}
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
            <Text maxFontSizeMultiplier={1.15} style={styles.submitText}>
              {submitText}
            </Text>
          </Pressable>
        </View>
      </View>
      <ContractLeverageSelectorSheet
        leverage={leverage}
        maxLeverage={maxLeverage}
        visible={leverageSelectorVisible}
        onClose={() => setLeverageSelectorVisible(false)}
        onSelect={nextLeverage => {
          onLeverageChange(nextLeverage);
          setLeverageSelectorVisible(false);
        }}
      />
    </>
  );
}

export default React.memo(ContractOrderForm);

export function isCompactContractOrderForm(
  windowWidth: number,
  fontScale: number,
) {
  return windowWidth < 360 || fontScale >= 1.2;
}

export function calculateContractSpreadCost(
  singleSideSpreadFeePrice: number | null | undefined,
  quantity: number,
) {
  if (
    singleSideSpreadFeePrice === null ||
    singleSideSpreadFeePrice === undefined ||
    !Number.isFinite(singleSideSpreadFeePrice) ||
    singleSideSpreadFeePrice <= 0 ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return null;
  }
  return singleSideSpreadFeePrice * quantity;
}

function Field({
  compact = false,
  editable = true,
  label,
  suffix,
  value,
  actionLabel,
  helperText,
  onActionPress,
  onChangeText,
}: {
  compact?: boolean;
  editable?: boolean;
  label: string;
  suffix: string;
  value: string;
  actionLabel?: string;
  helperText?: string;
  onActionPress?: () => void;
  onChangeText: (value: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.fieldWrap}>
      <View style={[styles.field, compact ? styles.fieldCompact : null]}>
        <Text
          maxFontSizeMultiplier={1.15}
          numberOfLines={1}
          style={[styles.fieldLabel, compact ? styles.fieldLabelCompact : null]}
        >
          {label}
        </Text>
        <TradingNumericInput
          accessibilityLabel={label}
          editable={editable}
          maxFontSizeMultiplier={1.15}
          placeholder="0"
          placeholderTextColor={colors.textSubtle}
          selectTextOnFocus={editable}
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
        />
        {suffix ? (
          <Text maxFontSizeMultiplier={1.15} style={styles.suffix}>
            {suffix}
          </Text>
        ) : null}
        {actionLabel ? (
          <Pressable
            accessibilityHint={helperText}
            accessibilityLabel={
              actionLabel === 'BBO'
                ? t('trading.fillBestPriceA11y')
                : actionLabel
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: !editable }}
            android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
            disabled={!editable}
            hitSlop={{ top: 10, bottom: 10 }}
            style={({ pressed }) => [
              styles.inlineAction,
              compact ? styles.inlineActionCompact : null,
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text maxFontSizeMultiplier={1.15} style={styles.metaLabel}>
        {label}
      </Text>
      <Text
        maxFontSizeMultiplier={1.15}
        numberOfLines={1}
        style={styles.metaValue}
      >
        {value}
      </Text>
    </View>
  );
}

function Tag({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <View style={[styles.tag, active ? styles.activeTag : null]}>
      <Text
        maxFontSizeMultiplier={1.15}
        style={[styles.tagText, active ? styles.activeTagText : null]}
      >
        {label}
      </Text>
    </View>
  );
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
    padding: 8,
  },
  cardCompact: {
    paddingHorizontal: 6,
  },
  topSection: {
    minHeight: 151,
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  leverageControl: {
    height: 34,
    minWidth: 76,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.42)',
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 8,
  },
  leverageControlDisabled: {
    opacity: 0.5,
  },
  leverageValueWrap: {
    minWidth: 38,
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    marginRight: 4,
  },
  leverageValue: {
    ...typography.number,
    color: colors.gold,
    fontSize: 11,
    fontWeight: '900',
    lineHeight: 14,
  },
  leverageLimitText: {
    color: colors.textSubtle,
    fontSize: 7,
    lineHeight: 9,
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
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 8,
  },
  fieldCompact: {
    paddingHorizontal: 6,
  },
  fieldLabel: {
    color: colors.textSubtle,
    fontSize: 10,
    width: 30,
  },
  fieldLabelCompact: {
    width: 24,
    fontSize: 9,
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
  inlineActionCompact: {
    width: 34,
    marginLeft: 4,
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
    fontSize: 10,
  },
  metaValue: {
    ...typography.number,
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'right',
  },
  loginHint: {
    flex: 1,
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  errorText: {
    color: colors.red,
  },
  successText: {
    color: colors.green,
  },
  bottomSection: {
    minHeight: 58,
    justifyContent: 'flex-end',
  },
  feedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  reviewButton: {
    minHeight: 22,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.gold,
    borderRadius: 6,
  },
  reviewButtonText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 9,
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
  submitDisabled: {
    opacity: 0.48,
  },
});
