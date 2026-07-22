import { formatRcbFeePayPercent, resolveRcbFeePayPercent } from './vip.utils';

describe('RCB fee payment percentage', () => {
  it('prefers the explicit payment percentage returned by the current backend', () => {
    expect(resolveRcbFeePayPercent('25', '75')).toBe(25);
    expect(formatRcbFeePayPercent(25)).toBe('25%');
  });

  it('derives the payment percentage from the legacy saved-percentage field during rolling deploys', () => {
    expect(resolveRcbFeePayPercent(undefined, '75')).toBe(25);
  });
});
