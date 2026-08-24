import {
  CONTRACT_EXECUTION_LEASE_MAX_TTL_MS,
  CONTRACT_EXECUTION_POLL_DEFAULT_MS,
  CONTRACT_EXECUTION_POLL_MAX_MS,
  CONTRACT_EXECUTION_POLL_MIN_MS,
  createContractExecutionLease,
  getContractExecutionPollDelayMs,
  isContractExecutionLeaseActive,
  type ContractExecutionLeaseInput,
} from '../src/realtime/contractExecutionLease';

const RECEIVED_AT_MS = 10_000;

function validInput(
  overrides: Partial<ContractExecutionLeaseInput> = {},
): ContractExecutionLeaseInput {
  return {
    executable: true,
    executionBid: 100,
    executionAsk: 101,
    priceAgeMs: 100,
    executionTtlMs: 1_500,
    receivedAtMs: RECEIVED_AT_MS,
    ...overrides,
  };
}

describe('contract execution lease', () => {
  it('creates a lease after subtracting price age and the safety margin', () => {
    expect(createContractExecutionLease(validInput())).toEqual({
      executionBid: 100,
      executionAsk: 101,
      priceAgeMs: 100,
      executionTtlMs: 1_500,
      receivedAtMs: RECEIVED_AT_MS,
      expiresAtMs: 11_150,
    });
  });

  it('caps the trusted server TTL at five seconds', () => {
    const lease = createContractExecutionLease(
      validInput({executionTtlMs: 20_000}),
    );

    expect(lease).toMatchObject({
      executionTtlMs: CONTRACT_EXECUTION_LEASE_MAX_TTL_MS,
      expiresAtMs: 14_650,
    });
  });

  it('accepts a complete non-crossed BBO with equal bid and ask', () => {
    expect(
      createContractExecutionLease(
        validInput({executionBid: 100, executionAsk: 100}),
      ),
    ).not.toBeNull();
  });

  it.each([
    ['executable', {executable: undefined}],
    ['execution bid', {executionBid: null}],
    ['execution ask', {executionAsk: null}],
    ['price age', {priceAgeMs: null}],
    ['execution TTL', {executionTtlMs: null}],
    ['received time', {receivedAtMs: null}],
  ])('fails closed when %s is missing', (_label, overrides) => {
    expect(
      createContractExecutionLease(
        validInput(overrides as Partial<ContractExecutionLeaseInput>),
      ),
    ).toBeNull();
  });

  it.each([
    ['not executable', {executable: false}],
    ['zero bid', {executionBid: 0}],
    ['negative bid', {executionBid: -1}],
    ['infinite bid', {executionBid: Number.POSITIVE_INFINITY}],
    ['zero ask', {executionAsk: 0}],
    ['NaN ask', {executionAsk: Number.NaN}],
    ['crossed BBO', {executionBid: 102, executionAsk: 101}],
    ['negative age', {priceAgeMs: -1}],
    ['infinite age', {priceAgeMs: Number.POSITIVE_INFINITY}],
    ['zero TTL', {executionTtlMs: 0}],
    ['negative TTL', {executionTtlMs: -1}],
    ['NaN TTL', {executionTtlMs: Number.NaN}],
    ['negative received time', {receivedAtMs: -1}],
    ['infinite received time', {receivedAtMs: Number.POSITIVE_INFINITY}],
  ])('fails closed for %s', (_label, overrides) => {
    expect(
      createContractExecutionLease(
        validInput(overrides as Partial<ContractExecutionLeaseInput>),
      ),
    ).toBeNull();
  });

  it('rejects a lease that is expired when the response is received', () => {
    expect(
      createContractExecutionLease(
        validInput({priceAgeMs: 250, executionTtlMs: 500}),
      ),
    ).toBeNull();
    expect(
      createContractExecutionLease(
        validInput({priceAgeMs: 251, executionTtlMs: 500}),
      ),
    ).toBeNull();
  });

  it('accepts the smallest lease that remains after the safety margin', () => {
    const lease = createContractExecutionLease(
      validInput({priceAgeMs: 0, executionTtlMs: 251}),
    );

    expect(lease?.expiresAtMs).toBe(RECEIVED_AT_MS + 1);
  });
});

describe('contract execution fallback poll delay', () => {
  it('uses the default delay when no lease is available', () => {
    expect(getContractExecutionPollDelayMs(null, RECEIVED_AT_MS)).toBe(
      CONTRACT_EXECUTION_POLL_DEFAULT_MS,
    );
  });

  it('caps long leases at the maximum poll delay', () => {
    expect(
      getContractExecutionPollDelayMs(
        {expiresAtMs: RECEIVED_AT_MS + 10_000},
        RECEIVED_AT_MS,
      ),
    ).toBe(CONTRACT_EXECUTION_POLL_MAX_MS);
  });

  it('schedules before a live lease expires', () => {
    expect(
      getContractExecutionPollDelayMs(
        {expiresAtMs: RECEIVED_AT_MS + 1_250},
        RECEIVED_AT_MS,
      ),
    ).toBe(1_000);
  });

  it('uses the minimum delay for short or already elapsed leases', () => {
    expect(
      getContractExecutionPollDelayMs(
        {expiresAtMs: RECEIVED_AT_MS + 1_000},
        RECEIVED_AT_MS,
      ),
    ).toBe(CONTRACT_EXECUTION_POLL_MIN_MS);
    expect(
      getContractExecutionPollDelayMs(
        {expiresAtMs: RECEIVED_AT_MS - 1},
        RECEIVED_AT_MS,
      ),
    ).toBe(CONTRACT_EXECUTION_POLL_MIN_MS);
  });

  it('falls back safely when the lease or clock is invalid', () => {
    expect(
      getContractExecutionPollDelayMs(
        {expiresAtMs: Number.NaN},
        RECEIVED_AT_MS,
      ),
    ).toBe(CONTRACT_EXECUTION_POLL_DEFAULT_MS);
    expect(
      getContractExecutionPollDelayMs(
        {expiresAtMs: RECEIVED_AT_MS + 1_000},
        Number.NaN,
      ),
    ).toBe(CONTRACT_EXECUTION_POLL_DEFAULT_MS);
  });
});

describe('contract confirmation lease', () => {
  it('is active only before expiry with a valid BBO', () => {
    const lease = createContractExecutionLease(validInput());
    expect(lease).not.toBeNull();
    expect(isContractExecutionLeaseActive(lease, 11_149)).toBe(true);
    expect(isContractExecutionLeaseActive(lease, 11_150)).toBe(false);
    expect(
      isContractExecutionLeaseActive(
        lease ? {...lease, executionAsk: 99} : null,
        11_000,
      ),
    ).toBe(false);
    expect(isContractExecutionLeaseActive(null, 11_000)).toBe(false);
  });
});
