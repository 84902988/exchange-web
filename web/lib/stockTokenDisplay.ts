// The API returns a decimal fraction from each lock batch, not a percentage.
// Shift its decimal point as text so small release rates retain their precision.
export function formatDailyReleaseRate(value: string): string {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return "--";

  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = match[2] ?? "";
  if (whole !== "0" && (whole !== "1" || /[1-9]/.test(fraction))) {
    return "--";
  }

  const percentWhole = `${whole}${fraction.padEnd(2, "0").slice(0, 2)}`
    .replace(/^0+(?=\d)/, "");
  const percentFraction = fraction.slice(2).replace(/0+$/, "");
  return `${percentWhole}${percentFraction ? `.${percentFraction}` : ""}%`;
}
