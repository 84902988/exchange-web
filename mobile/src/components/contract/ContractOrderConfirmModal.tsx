import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import {
  formatContractNumber,
  type ContractOrderType,
} from '../../api/contract';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import type {
  ContractActionMode,
  ContractDirection,
} from './ContractOrderForm';

type Props = {
  visible: boolean;
  actionMode: ContractActionMode;
  direction: ContractDirection;
  orderType: ContractOrderType;
  quantity: number | null;
  quantityText: string;
  leverage: number;
  referencePrice: number | null;
  pricePrecision: number;
  closableQuantity: number | null;
  baseAsset: string;
  quoteAsset: string;
  suppressChecked: boolean;
  submitting: boolean;
  onSuppressChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

function ContractOrderConfirmModal({
  visible,
  actionMode,
  direction,
  orderType,
  quantity,
  quantityText,
  leverage,
  referencePrice,
  pricePrecision,
  closableQuantity,
  baseAsset,
  quoteAsset,
  suppressChecked,
  submitting,
  onSuppressChange,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useLanguage();
  const [suppressInteractionReady, setSuppressInteractionReady] =
    useState(false);
  useEffect(() => {
    if (!visible) {
      setSuppressInteractionReady(false);
      return;
    }
    const timer = setTimeout(() => setSuppressInteractionReady(true), 300);
    return () => clearTimeout(timer);
  }, [visible]);
  const notional =
    referencePrice !== null &&
    referencePrice > 0 &&
    quantity !== null &&
    quantity > 0
      ? referencePrice * quantity
      : null;
  const estimatedMargin =
    actionMode === 'OPEN' && notional !== null && leverage > 0
      ? notional / leverage
      : null;
  const actionText =
    actionMode === 'OPEN'
      ? direction === 'LONG'
        ? t('contract.openLong')
        : t('contract.openShort')
      : direction === 'LONG'
      ? t('contract.closeLong')
      : t('contract.closeShort');
  const priceText =
    orderType === 'MARKET'
      ? t('contract.marketExecutionReference', {
          price: `${formatContractNumber(
            referencePrice,
            pricePrecision,
          )} ${quoteAsset}`,
        })
      : `${formatContractNumber(referencePrice, pricePrecision)} ${quoteAsset}`;
  const canConfirm =
    !submitting &&
    quantity !== null &&
    quantity > 0 &&
    referencePrice !== null &&
    referencePrice > 0;

  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={() => {
        if (!submitting) onCancel();
      }}
    >
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text style={styles.title}>{t('contract.confirmOrderTitle')}</Text>
          <Text style={styles.actionLine}>
            {actionText} {quantityText || '--'} {baseAsset}
          </Text>
          <DetailRow
            label={t('contract.confirmLeverageLabel')}
            value={`${leverage}x ${t('contract.isolated')}`}
          />
          <DetailRow
            label={t('trading.price')}
            value={priceText}
            valueTestId="contract-confirm-live-price"
          />
          <DetailRow
            label={t('contract.confirmNotionalLabel')}
            value={`${formatContractNumber(notional, 2)} ${quoteAsset}`}
            valueTestId="contract-confirm-live-notional"
          />
          {actionMode === 'OPEN' ? (
            <DetailRow
              label={t('contract.confirmMarginLabel')}
              value={`${formatContractNumber(
                estimatedMargin,
                2,
              )} ${quoteAsset}`}
              valueTestId="contract-confirm-live-margin"
            />
          ) : (
            <DetailRow
              label={t('contract.confirmClosableLabel')}
              value={`${formatContractNumber(
                closableQuantity,
                8,
              )} ${baseAsset}`}
            />
          )}
          <Text style={styles.marketHint}>
            {orderType === 'MARKET'
              ? t('contract.marketConfirmLiveHint')
              : t('contract.limitConfirmHint')}
          </Text>
          <Text style={styles.risk}>{t('contract.confirmRisk')}</Text>

          <Pressable
            accessibilityLabel={t('contract.dontShowAgain')}
            accessibilityRole="checkbox"
            accessibilityState={{
              checked: suppressChecked,
              disabled: submitting || !suppressInteractionReady,
            }}
            disabled={submitting || !suppressInteractionReady}
            style={({ pressed }) => [
              styles.suppressRow,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => {
              if (suppressInteractionReady) {
                onSuppressChange(!suppressChecked);
              }
            }}
          >
            <View
              style={[
                styles.checkbox,
                suppressChecked ? styles.checkboxChecked : null,
              ]}
            >
              {suppressChecked ? (
                <Check color={colors.bg} size={14} strokeWidth={3} />
              ) : null}
            </View>
            <Text style={styles.suppressText}>
              {t('contract.dontShowAgain')}
            </Text>
          </Pressable>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.button,
                pressed ? styles.pressed : null,
              ]}
              onPress={onCancel}
            >
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: submitting, disabled: !canConfirm }}
              disabled={!canConfirm}
              style={({ pressed }) => [
                styles.button,
                styles.confirmButton,
                !canConfirm ? styles.disabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={onConfirm}
            >
              <Text style={styles.confirmText}>
                {submitting
                  ? t('contract.preparing')
                  : actionMode === 'CLOSE'
                  ? t('contract.confirmClose')
                  : t('contract.confirmSubmit')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default React.memo(ContractOrderConfirmModal);

function DetailRow({
  label,
  value,
  valueTestId,
}: {
  label: string;
  value: string;
  valueTestId?: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text testID={valueTestId} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingHorizontal: 22,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 18,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 19,
    marginBottom: 14,
  },
  actionLine: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  detailRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14,
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: 13,
  },
  detailValue: {
    ...typography.number,
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'right',
  },
  marketHint: {
    color: colors.gold,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 7,
  },
  risk: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  suppressRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.textMuted,
    marginRight: 9,
  },
  checkboxChecked: {
    borderColor: colors.gold,
    backgroundColor: colors.gold,
  },
  suppressText: {
    color: colors.text,
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  button: {
    minWidth: 92,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 13,
  },
  confirmButton: {
    backgroundColor: colors.green,
  },
  cancelText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 14,
  },
  confirmText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 14,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
  },
});
