import {
  DividendContractError,
  normalizeDividendRecordPage,
  normalizeDividendSummary,
} from '../src/api/dividend';

describe('mobile dividend API contracts', () => {
  it('maps the backend snake-case summary and records into mobile fields', () => {
    expect(
      normalizeDividendSummary({
        total_rcb: '120.50000000',
        month_rcb: '20.50000000',
        latest_amount_rcb: '10.25000000',
        latest_dividend_date: '2026-07-31',
        latest_status: 'PAID',
        current_svip_level: 'SVIP1',
        eligible: true,
      }),
    ).toMatchObject({
      totalRcb: '120.50000000',
      monthRcb: '20.50000000',
      latestAmountRcb: '10.25000000',
      currentSvipLevel: 'SVIP1',
      eligible: true,
    });

    expect(
      normalizeDividendRecordPage({
        items: [
          {
            id: 7,
            dividend_date: '2026-07-31',
            svip_level_code: 'SVIP1',
            amount_rcb: '10.25000000',
            amount_usdt: '8.50000000',
            status: 'PAID',
            paid_at: '2026-08-01T02:30:00Z',
          },
        ],
        total: 1,
        page: 1,
        page_size: 20,
      }).items[0],
    ).toMatchObject({
      id: 7,
      dividendDate: '2026-07-31',
      amountRcb: '10.25000000',
      amountUsdt: '8.50000000',
      paidAt: '2026-08-01T02:30:00Z',
    });
  });

  it('fails closed when financial fields or pagination are malformed', () => {
    expect(() =>
      normalizeDividendSummary({
        total_rcb: 'not-a-number',
        month_rcb: '0',
        latest_amount_rcb: null,
        latest_dividend_date: null,
        latest_status: null,
        current_svip_level: null,
        eligible: false,
      }),
    ).toThrow(DividendContractError);
    expect(() =>
      normalizeDividendRecordPage({items: [], total: -1, page: 1, page_size: 20}),
    ).toThrow(DividendContractError);
  });
});
