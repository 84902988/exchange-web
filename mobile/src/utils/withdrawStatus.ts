import type { Translator } from '../i18n';

export function mapWithdrawStatus(status: string, t: Translator) {
  const normalized = status.toUpperCase();
  const statuses = {
    REVIEWING: 'reviewing',
    VERIFYING: 'verifying',
    FROZEN: 'frozen',
    APPROVED: 'frozen',
    PROCESSING: 'processing',
    SENDING: 'processing',
    SENT: 'sent',
    SUCCESS: 'completed',
    FAILED: 'failed',
    REJECTED: 'rejected',
    CANCELED: 'canceled',
    CANCELLED: 'canceled',
  } as const;
  const key = statuses[normalized as keyof typeof statuses] || 'updating';
  return t(`withdraw.status.${key}`);
}

export function canSendWithdraw(status: string, txHash: string) {
  return !txHash && ['FROZEN', 'APPROVED', 'PROCESSING'].includes(status);
}

export function canCancelWithdraw(status: string, txHash: string) {
  return !txHash && ['VERIFYING', 'REVIEWING', 'FROZEN'].includes(status);
}
