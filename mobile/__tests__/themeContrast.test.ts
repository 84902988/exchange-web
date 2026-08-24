import {colors} from '../src/theme';

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map(index =>
    Number.parseInt(hex.slice(index, index + 2), 16) / 255,
  );
  return channels
    .map(channel =>
      channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (total, channel, index) =>
        total + channel * [0.2126, 0.7152, 0.0722][index],
      0,
    );
}

function contrastRatio(foreground: string, background: string) {
  const values = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('dark theme text contrast', () => {
  it.each([
    ['text/card', colors.text, colors.card],
    ['muted/card', colors.textMuted, colors.card],
    ['subtle/card-alt', colors.textSubtle, colors.cardAlt],
    ['gold/card-alt', colors.gold, colors.cardAlt],
    ['green/card-alt', colors.green, colors.cardAlt],
    ['red/card-alt', colors.red, colors.cardAlt],
    ['market-subtle/market-card-alt', colors.marketSubtle, colors.marketCardAlt],
    ['inactive-tab/tab-bar', colors.tabInactive, colors.tabBarBackground],
  ])('%s remains at or above the WCAG AA normal-text ratio', (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
