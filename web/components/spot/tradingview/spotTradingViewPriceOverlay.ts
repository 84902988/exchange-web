export type SpotTradingViewCandleOverlayValue = {
  symbol: string;
  interval: string;
  close: number;
  barTime: number;
  source: string;
  receivedAtMs?: number;
};

export type SpotTradingViewOverlayEntityId = string | number;

type SpotTradingViewOverlayShape = {
  getPoints?: () => Array<{ time: number; price?: number }>;
  setPoints: (points: Array<{ time: number; price: number }>) => void;
  setProperties?: (properties: Record<string, unknown>) => void;
};

export type SpotTradingViewOverlayChart = {
  createShape: (
    point: { time: number; price: number },
    options: Record<string, unknown>,
  ) => Promise<SpotTradingViewOverlayEntityId>;
  getShapeById: (entityId: SpotTradingViewOverlayEntityId) => SpotTradingViewOverlayShape;
  removeEntity: (entityId: SpotTradingViewOverlayEntityId, options?: { disableUndo?: boolean }) => void;
};

export function isCurrentSpotTradingViewKlineFallback({
  eventSymbol,
  eventInterval,
  activeSymbol,
  activeBackendInterval,
}: {
  eventSymbol: string;
  eventInterval: string;
  activeSymbol: string;
  activeBackendInterval: string;
}): boolean {
  const normalizeSymbol = (value: string) => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return (
    normalizeSymbol(eventSymbol) === normalizeSymbol(activeSymbol)
    && String(eventInterval || '').trim() === String(activeBackendInterval || '').trim()
  );
}

function isValidCandleOverlayValue(value: SpotTradingViewCandleOverlayValue): boolean {
  return (
    String(value.symbol || '').trim().length > 0
    && String(value.interval || '').trim().length > 0
    && Number.isFinite(value.close)
    && value.close > 0
    && Number.isFinite(value.barTime)
    && value.barTime > 0
  );
}

const SPOT_PRICE_OVERLAY_UP_COLOR = '#00c087';
const SPOT_PRICE_OVERLAY_DOWN_COLOR = '#f6465d';
const SPOT_PRICE_OVERLAY_LINE_STYLE_DASHED = 2;

function overlayPoint(value: SpotTradingViewCandleOverlayValue) {
  return {
    time: Math.max(1, Math.floor(value.barTime / 1000)),
    price: value.close,
  };
}

function overlayProperties(color: string): Record<string, unknown> {
  return {
    text: '',
    linecolor: color,
    textcolor: color,
    linewidth: 1,
    linestyle: SPOT_PRICE_OVERLAY_LINE_STYLE_DASHED,
    showPrice: true,
  };
}

function overlayCreateOverrides(color: string): Record<string, unknown> {
  const properties = overlayProperties(color);
  return {
    'linetoolhorzline.linecolor': properties.linecolor,
    'linetoolhorzline.textcolor': properties.textcolor,
    'linetoolhorzline.linewidth': properties.linewidth,
    'linetoolhorzline.linestyle': properties.linestyle,
    'linetoolhorzline.showPrice': properties.showPrice,
  };
}

function overlayRenderKey(value: SpotTradingViewCandleOverlayValue): string {
  return [
    value.symbol,
    value.interval,
    value.barTime,
    value.close,
    value.source,
    value.receivedAtMs ?? '',
  ].join(':');
}

export class SpotTradingViewPriceOverlayController {
  private entityId: SpotTradingViewOverlayEntityId | null = null;
  private pendingValue: SpotTradingViewCandleOverlayValue | null = null;
  private createGeneration = 0;
  private creating = false;
  private destroyed = false;
  private renderedKey: string | null = null;
  private activeScopeKey: string | null = null;
  private activeBarKey: string | null = null;
  private lastPrice: number | null = null;
  private color = SPOT_PRICE_OVERLAY_UP_COLOR;

  constructor(private readonly chart: SpotTradingViewOverlayChart) {}

  update(value: SpotTradingViewCandleOverlayValue) {
    if (this.destroyed) return;
    if (!isValidCandleOverlayValue(value)) {
      this.clear();
      return;
    }

    const symbol = String(value.symbol || '').trim().toUpperCase();
    const interval = String(value.interval || '').trim();
    const scopeKey = `${symbol}:${interval}`;
    const barKey = `${scopeKey}:${value.barTime}`;
    if (this.activeScopeKey !== null && scopeKey !== this.activeScopeKey) {
      this.clear();
      this.lastPrice = null;
      this.color = SPOT_PRICE_OVERLAY_UP_COLOR;
    }
    this.activeScopeKey = scopeKey;
    this.updateDirectionColor(value.close);
    if (this.activeBarKey !== null && barKey !== this.activeBarKey) {
      this.clear();
    }
    this.activeBarKey = barKey;

    this.pendingValue = value;
    if (this.entityId !== null) {
      const nextRenderKey = overlayRenderKey(value);
      if (nextRenderKey === this.renderedKey) return;
      if (!this.apply(value)) this.replace(value);
      return;
    }
    if (this.creating) return;

    const generation = ++this.createGeneration;
    this.creating = true;
    const createdRenderKey = overlayRenderKey(value);
    const point = overlayPoint(value);
    void this.chart.createShape(point, {
      shape: 'horizontal_line',
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
      zOrder: 'top',
      text: '',
      overrides: overlayCreateOverrides(this.color),
    }).then((entityId) => {
      this.creating = false;
      if (this.destroyed || generation !== this.createGeneration || !this.pendingValue) {
        this.removeEntity(entityId);
        const pending = this.pendingValue;
        if (!this.destroyed && pending) this.update(pending);
        return;
      }
      this.entityId = entityId;
      this.applyProperties(entityId);
      this.renderedKey = createdRenderKey;
      const pending = this.pendingValue;
      if (pending && overlayRenderKey(pending) !== this.renderedKey) this.update(pending);
    }).catch(() => {
      this.creating = false;
      if (generation === this.createGeneration) this.pendingValue = null;
    });
  }

  clear() {
    this.pendingValue = null;
    this.activeBarKey = null;
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

  private apply(value: SpotTradingViewCandleOverlayValue): boolean {
    if (this.entityId === null) return false;
    try {
      const shape = this.chart.getShapeById(this.entityId);
      const currentPoints = shape.getPoints?.() || [];
      const price = value.close;
      const nextPoints = currentPoints.length
        ? currentPoints.map((point) => ({ ...point, price }))
        : [overlayPoint(value)];
      shape.setPoints(nextPoints);
      shape.setProperties?.(overlayProperties(this.color));
      this.renderedKey = overlayRenderKey(value);
      return true;
    } catch {
      return false;
    }
  }

  private replace(value: SpotTradingViewCandleOverlayValue) {
    const entityId = this.entityId;
    this.entityId = null;
    this.renderedKey = null;
    if (entityId !== null) this.removeEntity(entityId);
    this.update(value);
  }

  private updateDirectionColor(price: number) {
    if (this.lastPrice !== null) {
      if (price > this.lastPrice) this.color = SPOT_PRICE_OVERLAY_UP_COLOR;
      if (price < this.lastPrice) this.color = SPOT_PRICE_OVERLAY_DOWN_COLOR;
    }
    this.lastPrice = price;
  }

  private applyProperties(entityId: SpotTradingViewOverlayEntityId) {
    try {
      this.chart.getShapeById(entityId).setProperties?.(overlayProperties(this.color));
    } catch {
      // Creation overrides already carry the same final style when the drawing API is unavailable.
    }
  }

  private removeEntity(entityId: SpotTradingViewOverlayEntityId) {
    try {
      this.chart.removeEntity(entityId, { disableUndo: true });
    } catch {
      // The chart may already have removed non-persistent drawings during a layout cleanup.
    }
  }
}
