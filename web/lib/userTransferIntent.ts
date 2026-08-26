export type UserTransferIntentPayload = {
  recipientEmail: string;
  symbol: string;
  amount: string;
  remark?: string;
};

export type UserTransferRequestIntent = {
  fingerprint: string;
  requestId: string;
};

export type UserTransferRecoveryRecord = {
  request_id: string;
  direction: "in" | "out";
  counterparty_user_id: number;
  symbol: string;
  amount: string;
  status: string;
  remark?: string | null;
};

export type UserTransferRecoveryStatus<TRecord extends UserTransferRecoveryRecord> = {
  request_id: string;
  state: "COMPLETED" | "NOT_FOUND";
  record?: TRecord | null;
};

function canonicalizeDecimalText(value: string): string {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  const match = raw.match(/^\+?(\d*)(?:\.(\d*))?$/);
  if (!match) return raw;

  const integer = (match[1] || "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[2] || "").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

export function buildUserTransferIntentFingerprint(payload: UserTransferIntentPayload): string {
  return JSON.stringify([
    payload.recipientEmail.trim().toLocaleLowerCase("en-US"),
    payload.symbol.trim().toUpperCase(),
    canonicalizeDecimalText(payload.amount),
    (payload.remark || "").trim(),
  ]);
}

export function reuseOrCreateUserTransferIntent(
  existing: UserTransferRequestIntent | null,
  payload: UserTransferIntentPayload,
  createRequestId: () => string,
): UserTransferRequestIntent {
  const fingerprint = buildUserTransferIntentFingerprint(payload);
  if (existing?.fingerprint === fingerprint) return existing;
  return { fingerprint, requestId: createRequestId() };
}

export function matchesUserTransferRecoveryRecord(
  record: UserTransferRecoveryRecord,
  intent: UserTransferRequestIntent,
  payload: UserTransferIntentPayload,
  expectedRecipientUserId: number,
): boolean {
  return (
    record.request_id === intent.requestId &&
    record.direction === "out" &&
    record.counterparty_user_id === expectedRecipientUserId &&
    record.symbol.trim().toUpperCase() === payload.symbol.trim().toUpperCase() &&
    canonicalizeDecimalText(record.amount) === canonicalizeDecimalText(payload.amount) &&
    (record.remark || "").trim() === (payload.remark || "").trim() &&
    record.status.trim().toUpperCase() === "SUCCESS"
  );
}

export async function submitUserTransferWithRecovery<
  TRecord extends UserTransferRecoveryRecord,
>(args: {
  intent: UserTransferRequestIntent;
  payload: UserTransferIntentPayload;
  expectedRecipientUserId: number;
  submit: () => Promise<TRecord>;
  getStatus: () => Promise<UserTransferRecoveryStatus<TRecord>>;
}): Promise<TRecord> {
  let submitError: unknown;
  try {
    const submittedRecord = await args.submit();
    if (
      matchesUserTransferRecoveryRecord(
        submittedRecord,
        args.intent,
        args.payload,
        args.expectedRecipientUserId,
      )
    ) {
      return submittedRecord;
    }
    submitError = new Error("user transfer response does not match submitted intent");
  } catch (error) {
    submitError = error;
  }
  let status: UserTransferRecoveryStatus<TRecord>;
  try {
    status = await args.getStatus();
  } catch {
    throw submitError;
  }
  if (
    status.request_id === args.intent.requestId &&
    status.state === "COMPLETED" &&
    status.record &&
    matchesUserTransferRecoveryRecord(
      status.record,
      args.intent,
      args.payload,
      args.expectedRecipientUserId,
    )
  ) {
    return status.record;
  }
  throw submitError;
}
