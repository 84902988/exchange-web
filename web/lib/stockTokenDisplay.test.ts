import { describe, expect, it } from "@jest/globals";
import { formatDailyReleaseRate } from "./stockTokenDisplay";

describe("stock token batch daily release rate", () => {
  it.each([
    ["0.00123457", "0.123457%"],
    ["0.001200000000000000", "0.12%"],
    ["0.00142857", "0.142857%"],
    ["0.00000001", "0.000001%"],
    ["0.05000000", "5%"],
    ["0.1", "10%"],
    ["1.00000000", "100%"],
    ["0", "0%"],
    [" 00.0012345700 ", "0.123457%"],
  ])("displays %s as %s without rounding the batch rate", (input, expected) => {
    expect(formatDailyReleaseRate(input)).toBe(expected);
  });

  it.each(["", "NaN", "-0.01", "1.01", "5", "0.12%", "0.001x"])(
    "does not reinterpret invalid fraction %s as a percentage",
    input => expect(formatDailyReleaseRate(input)).toBe("--"),
  );
});
