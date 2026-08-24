import React from 'react';
import { FlatList, Platform, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  normalizeUserTransferRecipient,
  normalizeUserTransferRecords,
  normalizeUserTransferRequestStatus,
  normalizeUserTransferSubmit,
  type UserTransferRecord,
} from '../src/api/userTransfer';

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockFetchRecords = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ isLoggedIn: true }),
}));

jest.mock('../src/api/userTransfer', () => {
  const actual = jest.requireActual('../src/api/userTransfer');
  return {
    ...actual,
    fetchUserTransferRecords: (...args: unknown[]) => mockFetchRecords(...args),
  };
});

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import UserTransferRecordsScreen, {
  mergeUserTransferRecords,
} from '../src/screens/assets/UserTransferRecordsScreen';

const actualUserTransferApi = jest.requireActual(
  '../src/api/userTransfer',
) as typeof import('../src/api/userTransfer');

const outbound: UserTransferRecord = {
  id: 1,
  transferNo: 'UTR202608030001',
  requestId: 'intent-1',
  direction: 'out',
  counterpartyUserId: 202,
  counterpartyNickname: 'Alice',
  recipientNickname: 'Alice',
  recipientEmailMask: 'a***e@example.com',
  symbol: 'USDT',
  amount: '12.5',
  feeAmount: '0',
  netAmount: '12.5',
  status: 'SUCCESS',
  remark: '午餐',
  createdAt: '2026-08-03T08:00:00',
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

function screenText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .join(' ');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe('mobile user transfer records', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchRecords.mockResolvedValue({
      items: [outbound],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes the privacy-safe response and sends server-side filters', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 1,
              transfer_no: 'UTR202608030001',
              request_id: 'intent-1',
              direction: 'out',
              counterparty_user_id: 202,
              counterparty_nickname: 'Alice',
              recipient_nickname: 'Alice',
              recipient_email_mask: 'a***e@example.com',
              symbol: 'USDT',
              from_account: 'funding',
              to_account: 'funding',
              amount: '12.5000',
              fee_amount: '0',
              net_amount: '12.5',
              status: 'SUCCESS',
              remark: null,
              created_at: '2026-08-03T08:00:00',
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await actualUserTransferApi.fetchUserTransferRecords({
      direction: 'out',
      page: 1,
      pageSize: 20,
    });
    const url = String(fetchMock.mock.calls[0][0]);

    expect(url).toContain('direction=out');
    expect(url).toContain('page_size=20');
    expect(result.items[0]).toMatchObject({
      direction: 'out',
      amount: '12.5',
      counterpartyNickname: 'Alice',
    });
    expect(result.items[0]).not.toHaveProperty('senderAvailableBefore');
  });

  it('queries and normalizes the sender-only completed request status', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          request_id: 'intent-1',
          state: 'COMPLETED',
          record: {
            id: 1,
            transfer_no: 'UTR202608030001',
            request_id: 'intent-1',
            direction: 'out',
            counterparty_user_id: 202,
            counterparty_nickname: 'Alice',
            recipient_nickname: 'Alice',
            recipient_email_mask: 'a***e@example.com',
            symbol: 'USDT',
            from_account: 'funding',
            to_account: 'funding',
            amount: '12.5',
            fee_amount: '0',
            net_amount: '12.5',
            status: 'SUCCESS',
            remark: null,
            created_at: '2026-08-03T08:00:00',
          },
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await actualUserTransferApi.fetchUserTransferRequestStatus(
      ' intent-1 ',
    );
    const url = String(fetchMock.mock.calls[0][0]);

    expect(url).toContain('/user-transfer/request-status?');
    expect(url).toContain('request_id=intent-1');
    expect(result).toMatchObject({
      requestId: 'intent-1',
      state: 'COMPLETED',
      record: { requestId: 'intent-1', direction: 'out', status: 'SUCCESS' },
    });
  });

  it('resolves only a privacy-safe recipient summary', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          user_id: 202,
          email_mask: 'a***e@example.com',
          nickname: 'Alice',
          avatar_url: null,
          can_transfer: true,
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      actualUserTransferApi.resolveUserTransferRecipient(' Alice@Example.com '),
    ).resolves.toEqual({
      userId: 202,
      emailMask: 'a***e@example.com',
      nickname: 'Alice',
      canTransfer: true,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'email=alice%40example.com',
    );
    expect(() =>
      normalizeUserTransferRecipient({
        user_id: 202,
        email: 'alice@example.com',
        email_mask: 'a***e@example.com',
        can_transfer: true,
      }),
    ).toThrow('站内转账记录格式异常');
  });

  it('submits the exact idempotent intent and rejects a mismatched receipt', async () => {
    const serverRecord = {
      id: 1,
      transfer_no: 'UTR202608030001',
      request_id: 'mobile-intent-1',
      direction: 'out',
      counterparty_user_id: 202,
      counterparty_nickname: 'Alice',
      recipient_nickname: 'Alice',
      recipient_email_mask: 'a***e@example.com',
      symbol: 'USDT',
      from_account: 'funding',
      to_account: 'funding',
      amount: '12.5000',
      fee_amount: '0',
      net_amount: '12.5',
      status: 'SUCCESS',
      remark: '午餐',
      created_at: '2026-08-03T08:00:00',
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, data: { record: serverRecord } }),
      );
    globalThis.fetch = fetchMock as typeof fetch;
    const expected = {
      requestId: 'mobile-intent-1',
      recipientEmail: 'Alice@Example.com',
      recipientUserId: 202,
      symbol: 'usdt',
      amount: '0012.5000',
      remark: ' 午餐 ',
    };

    await expect(
      actualUserTransferApi.createUserTransfer(expected),
    ).resolves.toMatchObject({
      requestId: 'mobile-intent-1',
      counterpartyUserId: 202,
      symbol: 'USDT',
      amount: '12.5',
      status: 'SUCCESS',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      request_id: 'mobile-intent-1',
      recipient_email: 'alice@example.com',
      symbol: 'USDT',
      amount: '12.5',
      remark: '午餐',
    });
    expect(() =>
      normalizeUserTransferSubmit(
        { record: { ...serverRecord, counterparty_user_id: 999 } },
        expected,
      ),
    ).toThrow('站内转账记录格式异常');
  });

  it('accepts explicit not-found but rejects ambiguous or mismatched status payloads', () => {
    expect(
      normalizeUserTransferRequestStatus(
        { request_id: 'intent-1', state: 'NOT_FOUND', record: null },
        'intent-1',
      ),
    ).toEqual({ requestId: 'intent-1', state: 'NOT_FOUND', record: null });
    expect(() =>
      normalizeUserTransferRequestStatus(
        { request_id: 'other', state: 'NOT_FOUND', record: null },
        'intent-1',
      ),
    ).toThrow('站内转账记录格式异常');
    expect(() =>
      normalizeUserTransferRequestStatus(
        { request_id: 'intent-1', state: 'COMPLETED', record: null },
        'intent-1',
      ),
    ).toThrow('站内转账记录格式异常');
    expect(() =>
      normalizeUserTransferRequestStatus(
        { request_id: 'intent-1', state: 'PENDING', record: null },
        'intent-1',
      ),
    ).toThrow('站内转账记录格式异常');
  });

  it.each([
    'sender_available_before',
    'sender_available_after',
    'receiver_available_before',
    'receiver_available_after',
  ])('fails closed when stale backend exposes private field %s', field => {
    const row = {
      id: 1,
      transfer_no: 'UTR202608030001',
      request_id: 'intent-1',
      direction: 'in',
      counterparty_user_id: 101,
      recipient_email_mask: 'm***e@example.com',
      symbol: 'USDT',
      from_account: 'funding',
      to_account: 'funding',
      amount: '1',
      fee_amount: '0',
      net_amount: '1',
      status: 'SUCCESS',
      created_at: '2026-08-03T08:00:00',
      [field]: '999999',
    };

    expect(() =>
      normalizeUserTransferRecords({
        items: [row],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    ).toThrow('站内转账记录格式异常');
  });

  it('renders the mobile transfer records', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<UserTransferRecordsScreen />);
      await Promise.resolve();
    });

    const text = screenText(renderer);
    expect(text).toMatch(/转出\s+USDT/);
    expect(text).toMatch(/-\s*12\.5\s+USDT/);
    expect(text).toContain('Alice');
    expect(text).toContain('这里展示当前账户');
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: '发起站内转账' }),
    ).toHaveLength(0);
    const list = renderer.root.findByType(FlatList);
    expect(list.props.initialNumToRender).toBe(8);
    expect(list.props.maxToRenderPerBatch).toBe(8);
    expect(list.props.windowSize).toBe(7);
    expect(list.props.removeClippedSubviews).toBe(Platform.OS === 'android');
    act(() => renderer.unmount());
  });

  it('deduplicates appended records by server identity', () => {
    expect(
      mergeUserTransferRecords(
        [outbound],
        [outbound, { ...outbound, id: 2, transferNo: 'UTR202608030002' }],
      ).map(item => item.id),
    ).toEqual([1, 2]);
  });

  it('locks duplicate pagination taps and aborts the request on unmount', async () => {
    const nextPage = deferred<{
      items: UserTransferRecord[];
      total: number;
      page: number;
      pageSize: number;
    }>();
    let loadMoreSignal: AbortSignal | undefined;
    mockFetchRecords
      .mockReset()
      .mockResolvedValueOnce({
        items: [outbound],
        total: 21,
        page: 1,
        pageSize: 20,
      })
      .mockImplementationOnce(
        (_params: unknown, options?: { signal?: AbortSignal }) => {
          loadMoreSignal = options?.signal;
          return nextPage.promise;
        },
      );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<UserTransferRecordsScreen />);
      await Promise.resolve();
    });

    const loadMore = renderer.root.findByProps({
      testID: 'user-transfer-records-load-more',
    });
    act(() => {
      loadMore.props.onPress();
      loadMore.props.onPress();
    });

    expect(mockFetchRecords).toHaveBeenCalledTimes(2);
    expect(loadMoreSignal?.aborted).toBe(false);
    act(() => renderer.unmount());
    expect(loadMoreSignal?.aborted).toBe(true);
  });
});
