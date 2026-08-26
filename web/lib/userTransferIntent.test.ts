import {
  buildUserTransferIntentFingerprint,
  matchesUserTransferRecoveryRecord,
  reuseOrCreateUserTransferIntent,
  submitUserTransferWithRecovery,
} from "./userTransferIntent";

describe("user transfer request intent", () => {
  test("reuses the request id when the same financial intent is retried", () => {
    const createRequestId = jest.fn(() => "request-1");
    const payload = {
      recipientEmail: " Friend@Example.com ",
      symbol: "usdt",
      amount: "001.2300",
      remark: " lunch ",
    };

    const first = reuseOrCreateUserTransferIntent(null, payload, createRequestId);
    const retried = reuseOrCreateUserTransferIntent(
      first,
      { ...payload, recipientEmail: "friend@example.com", amount: "1.23", remark: "lunch" },
      createRequestId,
    );

    expect(retried).toBe(first);
    expect(createRequestId).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["recipient", { recipientEmail: "other@example.com" }],
    ["symbol", { symbol: "BTC" }],
    ["amount", { amount: "1.24" }],
    ["remark", { remark: "dinner" }],
  ])("creates a new request id when %s changes", (_label, change) => {
    let nextId = 0;
    const createRequestId = () => `request-${++nextId}`;
    const payload = {
      recipientEmail: "friend@example.com",
      symbol: "USDT",
      amount: "1.23",
      remark: "lunch",
    };
    const first = reuseOrCreateUserTransferIntent(null, payload, createRequestId);
    const changed = reuseOrCreateUserTransferIntent(first, { ...payload, ...change }, createRequestId);

    expect(changed.requestId).toBe("request-2");
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  test("fingerprint canonicalizes decimal formatting without using floating point", () => {
    const base = {
      recipientEmail: "friend@example.com",
      symbol: "USDT",
      amount: "9007199254740993.1000",
      remark: "",
    };
    expect(buildUserTransferIntentFingerprint(base)).toBe(
      buildUserTransferIntentFingerprint({ ...base, amount: "09007199254740993.1" }),
    );
  });

  const recoveryPayload = {
    recipientEmail: "friend@example.com",
    symbol: "USDT",
    amount: "12.50",
    remark: "lunch",
  };
  const recoveryIntent = {
    fingerprint: buildUserTransferIntentFingerprint(recoveryPayload),
    requestId: "request-recovery",
  };
  const recoveryRecord = {
    request_id: "request-recovery",
    direction: "out" as const,
    counterparty_user_id: 202,
    symbol: "USDT",
    amount: "12.5",
    status: "SUCCESS",
    remark: "lunch",
  };

  test("accepts a direct response only when it matches the financial intent", async () => {
    const getStatus = jest.fn();
    const result = await submitUserTransferWithRecovery({
      intent: recoveryIntent,
      payload: recoveryPayload,
      expectedRecipientUserId: 202,
      submit: async () => recoveryRecord,
      getStatus,
    });

    expect(result).toBe(recoveryRecord);
    expect(getStatus).not.toHaveBeenCalled();
  });

  test("fails closed when both direct response and status mismatch the intent", async () => {
    await expect(
      submitUserTransferWithRecovery({
        intent: recoveryIntent,
        payload: recoveryPayload,
        expectedRecipientUserId: 202,
        submit: async () => ({...recoveryRecord, amount: "99"}),
        getStatus: async () => ({
          request_id: recoveryIntent.requestId,
          state: "NOT_FOUND",
          record: null,
        }),
      }),
    ).rejects.toThrow("user transfer response does not match submitted intent");
  });

  test("recovers a completed response only when it matches the full financial intent", async () => {
    const submitError = new Error("network timeout");
    const result = await submitUserTransferWithRecovery({
      intent: recoveryIntent,
      payload: recoveryPayload,
      expectedRecipientUserId: 202,
      submit: async () => {
        throw submitError;
      },
      getStatus: async () => ({
        request_id: recoveryIntent.requestId,
        state: "COMPLETED",
        record: recoveryRecord,
      }),
    });

    expect(result).toBe(recoveryRecord);
    expect(
      matchesUserTransferRecoveryRecord(
        recoveryRecord,
        recoveryIntent,
        recoveryPayload,
        202,
      ),
    ).toBe(true);
  });

  test.each([
    ["status request id", {}, { request_id: "different-request" }],
    ["record request id", { request_id: "different-request" }, {}],
    ["direction", { direction: "in" as const }, {}],
    ["recipient", { counterparty_user_id: 303 }, {}],
    ["symbol", { symbol: "BTC" }, {}],
    ["amount", { amount: "12.51" }, {}],
    ["remark", { remark: "dinner" }, {}],
    ["record status", { status: "PENDING" }, {}],
  ])("does not recover a completed-looking response with mismatched %s", async (_label, recordChange, statusChange) => {
    const submitError = new Error("network timeout");
    await expect(
      submitUserTransferWithRecovery({
        intent: recoveryIntent,
        payload: recoveryPayload,
        expectedRecipientUserId: 202,
        submit: async () => {
          throw submitError;
        },
        getStatus: async () => ({
          request_id: recoveryIntent.requestId,
          state: "COMPLETED",
          record: { ...recoveryRecord, ...recordChange },
          ...statusChange,
        }),
      }),
    ).rejects.toBe(submitError);
  });

  test("preserves the original submission error when status is missing or unavailable", async () => {
    const submitError = new Error("network timeout");
    const base = {
      intent: recoveryIntent,
      payload: recoveryPayload,
      expectedRecipientUserId: 202,
      submit: async () => {
        throw submitError;
      },
    };

    await expect(
      submitUserTransferWithRecovery({
        ...base,
        getStatus: async () => ({
          request_id: recoveryIntent.requestId,
          state: "NOT_FOUND",
          record: null,
        }),
      }),
    ).rejects.toBe(submitError);
    await expect(
      submitUserTransferWithRecovery({
        ...base,
        getStatus: async () => {
          throw new Error("status unavailable");
        },
      }),
    ).rejects.toBe(submitError);
  });
});
