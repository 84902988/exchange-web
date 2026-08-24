export function shouldUseCompactAssetLayout(
  width: number,
  fontScale: number,
) {
  return width < 360 || fontScale >= 1.25;
}
