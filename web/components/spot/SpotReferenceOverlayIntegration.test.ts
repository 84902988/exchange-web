import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const spotComponentDir = join(process.cwd(), 'components', 'spot');

describe('Spot advanced chart reference overlay integration', () => {
  it('keeps the RWA capability connected from SpotPage to the TradingView consumer', () => {
    const pageSource = readFileSync(join(spotComponentDir, 'SpotPage.tsx'), 'utf8');
    const chartSource = readFileSync(join(spotComponentDir, 'SpotTradingViewChart.tsx'), 'utf8');

    expect(pageSource).toMatch(/showRwaReference=\{showRwaReference\}/);
    expect(chartSource).toMatch(/showRwaReference = false/);
    expect(chartSource).toMatch(/getReferenceOverlay\(normalizedSymbol\)/);
    expect(chartSource).toMatch(/normalizeReferenceOverlayConfig\(payload, t\)/);
    expect(chartSource).toMatch(/<ReferenceOverlayBadge config=\{visibleReferenceOverlayConfig\}/);
  });

  it('owns reference and candle-close drawings independently', () => {
    const chartSource = readFileSync(join(spotComponentDir, 'SpotTradingViewChart.tsx'), 'utf8');

    expect(chartSource).toMatch(/new SpotTradingViewPriceOverlayController/);
    expect(chartSource).toMatch(/new SpotTradingViewReferenceOverlayController/);
    expect(chartSource).toMatch(/referenceOverlayControllerRef\.current\?\.destroy\(\)/);
    expect(chartSource).toMatch(/priceOverlayControllerRef\.current\?\.destroy\(\)/);
    expect(chartSource).toMatch(/SpotReferenceViewportCoordinator/);
  });
});
