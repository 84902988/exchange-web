import { normalizeContractTimestampMs } from './contractTimestamp';

describe('normalizeContractTimestampMs', () => {
  test('treats legacy timezone-less Contract REST timestamps as UTC', () => {
    expect(normalizeContractTimestampMs('2026-07-21T12:23:20.825893'))
      .toBe(Date.UTC(2026, 6, 21, 12, 23, 20, 825));
  });

  test('preserves explicit UTC and offset timestamps as the same instant', () => {
    const expected = Date.UTC(2026, 6, 21, 12, 23, 20, 825);
    expect(normalizeContractTimestampMs('2026-07-21T12:23:20.825Z')).toBe(expected);
    expect(normalizeContractTimestampMs('2026-07-21T20:23:20.825+08:00')).toBe(expected);
  });

  test('normalizes provider seconds and milliseconds without wall-clock parsing', () => {
    expect(normalizeContractTimestampMs(1_784_636_600)).toBe(1_784_636_600_000);
    expect(normalizeContractTimestampMs('1784636600000')).toBe(1_784_636_600_000);
  });

  test('rejects empty, invalid, and non-positive timestamps', () => {
    expect(normalizeContractTimestampMs(null)).toBeNull();
    expect(normalizeContractTimestampMs('not-a-time')).toBeNull();
    expect(normalizeContractTimestampMs(0)).toBeNull();
  });
});
