import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatContractNumber } from '../../api/contract';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import type { ContractDirection } from './ContractOrderForm';

export type ContractCloseAllConfirmTarget = {
  side: ContractDirection;
  quantity: string;
  referencePrice: number | null;
};

type Props = {
  visible: boolean;
  targets: ContractCloseAllConfirmTarget[];
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  suppressChecked: boolean;
  submitting: boolean;
  onSuppressChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

function ContractCloseAllConfirmModal({
  visible,
  targets,
  baseAsset,
  quoteAsset,
  pricePrecision,
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

  const canConfirm =
    !submitting &&
    targets.length > 0 &&
    targets.every(
      target => target.referencePrice !== null && target.referencePrice > 0,
    );

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
          <Text style={styles.title}>{t('contract.closeAllConfirmTitle')}</Text>
          <Text style={styles.description}>
            {t('contract.closeAllConfirmDescription')}
          </Text>

          {targets.map(target => {
            const quantity = Number(target.quantity.replace(/,/g, ''));
            const notional =
              Number.isFinite(quantity) &&
              quantity > 0 &&
              target.referencePrice !== null &&
              target.referencePrice > 0
                ? quantity * target.referencePrice
                : null;
            const sideText = t(
              target.side === 'LONG'
                ? 'trading.position.long'
                : 'trading.position.short',
            );
            return (
              <View key={target.side} style={styles.targetCard}>
                <Text style={styles.targetTitle}>
                  {sideText} · {target.quantity} {baseAsset}
                </Text>
                <DetailRow
                  label={t('contract.closeAllReferenceLabel')}
                  valueTestID={`contract-close-all-${target.side.toLowerCase()}-price`}
                  value={`${formatContractNumber(
                    target.referencePrice,
                    pricePrecision,
                  )} ${quoteAsset}`}
                />
                <DetailRow
                  label={t('contract.confirmNotionalLabel')}
                  valueTestID={`contract-close-all-${target.side.toLowerCase()}-notional`}
                  value={`${formatContractNumber(notional, 2)} ${quoteAsset}`}
                />
              </View>
            );
          })}

          <Text style={styles.marketHint}>
            {t('contract.closeAllLiveHint')}
          </Text>
          <Text style={styles.risk}>{t('contract.confirmRisk')}</Text>

          <Pressable
            accessibilityLabel={t('contract.closeAllDontShowAgain')}
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
              {t('contract.closeAllDontShowAgain')}
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
                  ? t('contract.closeAllSubmitting')
                  : t('contract.closeAllConfirm')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default React.memo(ContractCloseAllConfirmModal);

function DetailRow({
  label,
  value,
  valueTestID,
}: {
  label: string;
  value: string;
  valueTestID: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text testID={valueTestID} style={styles.detailValue}>
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
  },
  description: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 7,
    marginBottom: 10,
  },
  targetCard: {
    borderRadius: 8,
    backgroundColor: colors.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 7,
  },
  targetTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
    marginBottom: 5,
  },
  detailRow: {
    minHeight: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  detailValue: {
    ...typography.number,
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  marketHint: {
    color: colors.gold,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 10,
  },
  risk: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  suppressRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
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
    marginTop: 10,
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
    backgroundColor: colors.red,
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
