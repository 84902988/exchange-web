import type { DepositRecord } from '../api/assets';

export function depositStage(row: DepositRecord) {
  if (['FAILED', 'REJECTED', 'REVERSED', 'CANCELED'].includes(row.status))
    return 'failed';
  if (row.credited === true) return 'credited';
  if (
    ['CONFIRMED', 'SUCCESS', 'SUCCEEDED', 'COMPLETED', 'CREDITED'].includes(
      row.status,
    )
  )
    return 'confirmed';
  if (['PENDING', 'CONFIRMING', 'PROCESSING'].includes(row.status))
    return 'processing';
  if (row.status === 'DETECTING') return 'detected';
  return 'unknown';
}
