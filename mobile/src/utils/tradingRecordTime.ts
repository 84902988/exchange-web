function padDateTimePart(value: number) {
  return String(value).padStart(2, '0');
}

export function formatTradingRecordTime(value?: string | null) {
  if (!value) return '--';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '--';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${padDateTimePart(
    date.getMonth() + 1,
  )}-${padDateTimePart(date.getDate())} ${padDateTimePart(
    date.getHours(),
  )}:${padDateTimePart(date.getMinutes())}:${padDateTimePart(
    date.getSeconds(),
  )}`;
}
