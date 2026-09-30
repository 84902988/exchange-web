type ConfirmationRecord = {
  withdrawId?: number;
  withdraw_id?: number;
  id?: number;
  status?: string;
  txHash?: string | null;
  tx_hash?: string | null;
  txid?: string | null;
  txId?: string | null;
};

const knownStatuses = new Set([
  'VERIFYING', 'REVIEWING', 'FROZEN', 'APPROVED', 'PROCESSING',
  'SENDING', 'SENT', 'SUCCESS', 'FAILED', 'REJECTED', 'CANCELED', 'CANCELLED',
]);

export function confirmationRecordStatus(record: ConfirmationRecord): string | null {
  const status = String(record.status ?? '').trim().toUpperCase();
  if (!knownStatuses.has(status)) return null;
  // A transaction hash always rules out repeating email verification.
  const hash = record.txHash || record.tx_hash || record.txid || record.txId;
  return hash && ['VERIFYING', 'REVIEWING', 'FROZEN', 'APPROVED'].includes(status)
    ? 'SENT' : status;
}

/** Recover only this request. Failure/missing/unknown data never authorizes a retry. */
export async function findWithdrawalConfirmation<T extends ConfirmationRecord>(
  withdrawId: number,
  readPage: (offset: number) => Promise<T[]>,
  isCurrent: () => boolean = () => true,
): Promise<T | null> {
  if (!Number.isSafeInteger(withdrawId) || withdrawId <= 0) return null;
  // The existing authenticated list endpoint has no lookup-by-id endpoint.
  // Keep recovery bounded; an older/missing request stays unconfirmed.
  for (let offset = 0; offset < 100 && isCurrent(); offset += 20) {
    const rows = await readPage(offset);
    if (!isCurrent()) return null;
    const row = rows.find(item => Number(item.withdrawId ?? item.withdraw_id ?? item.id) === withdrawId);
    if (row) return confirmationRecordStatus(row) ? row : null;
    if (rows.length < 20) break;
  }
  return null;
}
