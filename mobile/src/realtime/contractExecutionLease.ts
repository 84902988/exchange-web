export const CONTRACT_EXECUTION_LEASE_MAX_TTL_MS = 5_000;
export const CONTRACT_EXECUTION_LEASE_SAFETY_MARGIN_MS = 250;
export const CONTRACT_EXECUTION_POLL_MIN_MS = 750;
export const CONTRACT_EXECUTION_POLL_MAX_MS = 2_000;
export const CONTRACT_EXECUTION_POLL_DEFAULT_MS = 1_000;

export type ContractExecutionLeaseInput = {
  executable?: boolean | null;
  executionBid?: number | null;
  executionAsk?: number | null;
  priceAgeMs?: number | null;
  executionTtlMs?: number | null;
  receivedAtMs?: number | null;
};

export type ContractExecutionLease = {
  executionBid: number;
  executionAsk: number;
  priceAgeMs: number;
  executionTtlMs: number;
  receivedAtMs: number;
  expiresAtMs: number;
};

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function createContractExecutionLease(
  input: ContractExecutionLeaseInput,
): ContractExecutionLease | null {
  if (input.executable !== true) return null;

  const {
    executionBid,
    executionAsk,
    priceAgeMs,
    executionTtlMs,
    receivedAtMs,
  } = input;
  if (
    !isFinitePositive(executionBid) ||
    !isFinitePositive(executionAsk) ||
    executionAsk < executionBid ||
    !isFiniteNonNegative(priceAgeMs) ||
    !isFinitePositive(executionTtlMs) ||
    !isFiniteNonNegative(receivedAtMs)
  ) {
    return null;
  }

  const effectiveTtlMs = Math.min(
    executionTtlMs,
    CONTRACT_EXECUTION_LEASE_MAX_TTL_MS,
  );
  const expiresAtMs =
    receivedAtMs +
    effectiveTtlMs -
    priceAgeMs -
    CONTRACT_EXECUTION_LEASE_SAFETY_MARGIN_MS;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= receivedAtMs) {
    return null;
  }

  return {
    executionBid,
    executionAsk,
    priceAgeMs,
    executionTtlMs: effectiveTtlMs,
    receivedAtMs,
    expiresAtMs,
  };
}

export function getContractExecutionPollDelayMs(
  lease: Pick<ContractExecutionLease, 'expiresAtMs'> | null | undefined,
  nowMs: number,
) {
  if (
    !lease ||
    !isFiniteNonNegative(lease.expiresAtMs) ||
    !isFiniteNonNegative(nowMs)
  ) {
    return CONTRACT_EXECUTION_POLL_DEFAULT_MS;
  }

  const leaseRemainingMs = Math.max(0, lease.expiresAtMs - nowMs);
  return Math.min(
    CONTRACT_EXECUTION_POLL_MAX_MS,
    Math.max(
      CONTRACT_EXECUTION_POLL_MIN_MS,
      leaseRemainingMs - CONTRACT_EXECUTION_LEASE_SAFETY_MARGIN_MS,
    ),
  );
}

export function isContractExecutionLeaseActive(
  lease: ContractExecutionLease | null | undefined,
  nowMs = Date.now(),
) {
  return (
    lease !== null &&
    lease !== undefined &&
    isFiniteNonNegative(nowMs) &&
    lease.expiresAtMs > nowMs &&
    isFinitePositive(lease.executionBid) &&
    isFinitePositive(lease.executionAsk) &&
    lease.executionAsk >= lease.executionBid
  );
}
