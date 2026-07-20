import type {
  SpotTradingViewOverlayChart,
  SpotTradingViewOverlayEntityId,
} from './spotTradingViewPriceOverlay';

export type SpotTradingViewVisiblePriceRange = {
  from: number;
  to: number;
};

type SpotTradingViewReferencePriceScale = {
  getVisiblePriceRange?: () => SpotTradingViewVisiblePriceRange | null;
  setVisiblePriceRange?: (range: SpotTradingViewVisiblePriceRange) => void;
};

type SpotTradingViewReferencePane = {
  hasMainSeries?: () => boolean;
  getMainSourcePriceScale?: () => SpotTradingViewReferencePriceScale | null;
};

export type SpotTradingViewReferenceOverlayChart = SpotTradingViewOverlayChart & {
  getPanes?: () => SpotTradingViewReferencePane[];
};

export type SpotTradingViewReferenceOverlayValue = {
  symbol: string;
  interval: string;
  price: number;
  anchorTime: number;
  title: string;
  color: string;
};

export type SpotReferenceViewportResult = 'UNAVAILABLE' | 'VISIBLE' | 'APPLIED' | 'ALREADY';

const REFERENCE_LINE_STYLE_DASHED = 2;

function normalizeSymbol(value: string) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function normalizeColor(value: string) {
  const color = String(value || '').trim();
  return color || '#f0b90b';
}

function isValidValue(value: SpotTradingViewReferenceOverlayValue) {
  return (
    normalizeSymbol(value.symbol).length > 0
    && String(value.interval || '').trim().length > 0
    && Number.isFinite(value.price)
    && value.price > 0
    && Number.isFinite(value.anchorTime)
    && value.anchorTime > 0
  );
}

function overlayPoint(value: SpotTradingViewReferenceOverlayValue) {
  return {
    time: Math.max(1, Math.floor(value.anchorTime / 1000)),
    price: value.price,
  };
}

function overlayProperties(value: SpotTradingViewReferenceOverlayValue): Record<string, unknown> {
  const color = normalizeColor(value.color);
  return {
    text: String(value.title || '').trim(),
    linecolor: color,
    textcolor: color,
    linewidth: 1,
    linestyle: REFERENCE_LINE_STYLE_DASHED,
    showPrice: true,
  };
}

function overlayCreateOverrides(value: SpotTradingViewReferenceOverlayValue) {
  const properties = overlayProperties(value);
  return {
    'linetoolhorzline.linecolor': properties.linecolor,
    'linetoolhorzline.textcolor': properties.textcolor,
    'linetoolhorzline.linewidth': properties.linewidth,
    'linetoolhorzline.linestyle': properties.linestyle,
    'linetoolhorzline.showPrice': properties.showPrice,
  };
}

function overlayScopeKey(value: SpotTradingViewReferenceOverlayValue) {
  return `${normalizeSymbol(value.symbol)}:${String(value.interval || '').trim()}`;
}

function overlayRenderKey(value: SpotTradingViewReferenceOverlayValue) {
  return [
    overlayScopeKey(value),
    value.price,
    String(value.title || '').trim(),
    normalizeColor(value.color),
  ].join(':');
}

export function ensureSpotReferencePriceViewport({
  chart,
  referencePrice,
  isCurrent,
}: {
  chart: SpotTradingViewReferenceOverlayChart | null;
  referencePrice: number | null;
  isCurrent: () => boolean;
}): Exclude<SpotReferenceViewportResult, 'ALREADY'> {
  if (
    !chart
    || referencePrice === null
    || !Number.isFinite(referencePrice)
    || referencePrice <= 0
    || !isCurrent()
  ) return 'UNAVAILABLE';

  try {
    const panes = chart.getPanes?.() || [];
    const mainPane = panes.find((pane) => pane.hasMainSeries?.()) || panes[0];
    const priceScale = mainPane?.getMainSourcePriceScale?.() || null;
    const visibleRange = priceScale?.getVisiblePriceRange?.() || null;
    if (
      !priceScale?.setVisiblePriceRange
      || !visibleRange
      || !Number.isFinite(visibleRange.from)
      || !Number.isFinite(visibleRange.to)
    ) return 'UNAVAILABLE';

    const lower = Math.min(visibleRange.from, visibleRange.to);
    const upper = Math.max(visibleRange.from, visibleRange.to);
    if (referencePrice >= lower && referencePrice <= upper) return 'VISIBLE';

    const expandedLower = Math.min(lower, referencePrice);
    const expandedUpper = Math.max(upper, referencePrice);
    const expandedSpan = Math.max(
      expandedUpper - expandedLower,
      Math.abs(referencePrice) * 0.001,
    );
    // Keep an outlying reference line below TradingView's symbol/legend header instead of
    // merely placing it on the first hidden pixel at the pane boundary.
    const padding = expandedSpan * 0.18;
    if (!isCurrent()) return 'UNAVAILABLE';
    priceScale.setVisiblePriceRange({
      from: Math.max(0, expandedLower - padding),
      to: expandedUpper + padding,
    });
    return 'APPLIED';
  } catch {
    return 'UNAVAILABLE';
  }
}

export class SpotReferenceViewportCoordinator {
  private readonly handledScopes = new Set<string>();

  ensure(params: {
    scope: string;
    chart: SpotTradingViewReferenceOverlayChart | null;
    referencePrice: number | null;
    isCurrent: () => boolean;
  }): SpotReferenceViewportResult {
    if (params.scope && this.handledScopes.has(params.scope)) return 'ALREADY';
    const result = ensureSpotReferencePriceViewport(params);
    if (params.scope && (result === 'VISIBLE' || result === 'APPLIED')) {
      this.handledScopes.add(params.scope);
    }
    return result;
  }

  reset() {
    this.handledScopes.clear();
  }
}

export class SpotTradingViewReferenceOverlayController {
  private entityId: SpotTradingViewOverlayEntityId | null = null;
  private pendingValue: SpotTradingViewReferenceOverlayValue | null = null;
  private createGeneration = 0;
  private creating = false;
  private destroyed = false;
  private renderedKey: string | null = null;
  private activeScopeKey: string | null = null;

  constructor(private readonly chart: SpotTradingViewReferenceOverlayChart) {}

  update(value: SpotTradingViewReferenceOverlayValue) {
    if (this.destroyed) return;
    if (!isValidValue(value)) {
      this.clear();
      return;
    }

    const scopeKey = overlayScopeKey(value);
    if (this.activeScopeKey !== null && scopeKey !== this.activeScopeKey) this.clear();
    this.activeScopeKey = scopeKey;
    this.pendingValue = value;

    if (this.entityId !== null) {
      const nextRenderKey = overlayRenderKey(value);
      if (nextRenderKey === this.renderedKey && this.hasEntity()) return;
      if (!this.apply(value)) this.replace(value);
      return;
    }
    if (this.creating) return;

    const generation = ++this.createGeneration;
    const createdRenderKey = overlayRenderKey(value);
    this.creating = true;
    void this.chart.createShape(overlayPoint(value), {
      shape: 'horizontal_line',
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
      zOrder: 'top',
      text: String(value.title || '').trim(),
      overrides: overlayCreateOverrides(value),
    }).then((entityId) => {
      this.creating = false;
      if (this.destroyed || generation !== this.createGeneration || !this.pendingValue) {
        this.removeEntity(entityId);
        const pending = this.pendingValue;
        if (!this.destroyed && pending) this.update(pending);
        return;
      }
      this.entityId = entityId;
      this.applyProperties(entityId, this.pendingValue);
      this.renderedKey = createdRenderKey;
      const pending = this.pendingValue;
      if (overlayRenderKey(pending) !== this.renderedKey) this.update(pending);
    }).catch(() => {
      this.creating = false;
    });
  }

  clear() {
    this.pendingValue = null;
    this.activeScopeKey = null;
    this.createGeneration += 1;
    const entityId = this.entityId;
    this.entityId = null;
    this.renderedKey = null;
    if (entityId !== null) this.removeEntity(entityId);
  }

  destroy() {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
  }

  private hasEntity() {
    if (this.entityId === null) return false;
    try {
      this.chart.getShapeById(this.entityId);
      return true;
    } catch {
      return false;
    }
  }

  private apply(value: SpotTradingViewReferenceOverlayValue) {
    if (this.entityId === null) return false;
    try {
      const shape = this.chart.getShapeById(this.entityId);
      const currentPoints = shape.getPoints?.() || [];
      const nextPoints = currentPoints.length
        ? currentPoints.map((point) => ({ ...point, price: value.price }))
        : [overlayPoint(value)];
      shape.setPoints(nextPoints);
      shape.setProperties?.(overlayProperties(value));
      this.renderedKey = overlayRenderKey(value);
      return true;
    } catch {
      return false;
    }
  }

  private replace(value: SpotTradingViewReferenceOverlayValue) {
    const entityId = this.entityId;
    this.entityId = null;
    this.renderedKey = null;
    if (entityId !== null) this.removeEntity(entityId);
    this.update(value);
  }

  private applyProperties(
    entityId: SpotTradingViewOverlayEntityId,
    value: SpotTradingViewReferenceOverlayValue,
  ) {
    try {
      this.chart.getShapeById(entityId).setProperties?.(overlayProperties(value));
    } catch {
      // Creation overrides already carry the same final style when the drawing API is unavailable.
    }
  }

  private removeEntity(entityId: SpotTradingViewOverlayEntityId) {
    try {
      this.chart.removeEntity(entityId, { disableUndo: true });
    } catch {
      // TradingView may already have removed non-persistent drawings during a resolution reset.
    }
  }
}
