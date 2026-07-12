import {
  shouldShowSpotDisplayPriceOverlay,
  type SpotDisplayPrice,
} from '../spotDisplayPrice';

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

function overlayTimeSeconds(displayPrice: SpotDisplayPrice): number {
  const timeMs = Number(displayPrice.eventTimeMs || displayPrice.receivedAtMs || Date.now());
  return Math.max(1, Math.floor(timeMs / 1000));
}

const SPOT_PRICE_OVERLAY_UP_COLOR = '#00c087';
const SPOT_PRICE_OVERLAY_DOWN_COLOR = '#f6465d';
const SPOT_PRICE_OVERLAY_LINE_STYLE_DASHED = 2;

function overlayPoint(displayPrice: SpotDisplayPrice) {
  return {
    time: overlayTimeSeconds(displayPrice),
    price: Number(displayPrice.price),
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

function overlayRenderKey(displayPrice: SpotDisplayPrice): string {
  return [
    Number(displayPrice.price),
    displayPrice.sourceDomain,
    displayPrice.source,
    displayPrice.provider || '',
    displayPrice.freshness,
    displayPrice.isRealTrade ? 'trade' : 'reference',
    displayPrice.eventTimeMs ?? displayPrice.receivedAtMs ?? '',
  ].join(':');
}

export class SpotTradingViewPriceOverlayController {
  private entityId: SpotTradingViewOverlayEntityId | null = null;
  private pendingDisplayPrice: SpotDisplayPrice | null = null;
  private createGeneration = 0;
  private creating = false;
  private destroyed = false;
  private renderedKey: string | null = null;
  private activeSymbol: string | null = null;
  private lastPrice: number | null = null;
  private color = SPOT_PRICE_OVERLAY_UP_COLOR;

  constructor(private readonly chart: SpotTradingViewOverlayChart) {}

  update(displayPrice: SpotDisplayPrice) {
    if (this.destroyed) return;
    const symbol = String(displayPrice.symbol || '').trim().toUpperCase();
    if (this.activeSymbol !== null && symbol !== this.activeSymbol) {
      this.clear();
      this.lastPrice = null;
      this.color = SPOT_PRICE_OVERLAY_UP_COLOR;
    }
    this.activeSymbol = symbol;
    if (!shouldShowSpotDisplayPriceOverlay(displayPrice)) {
      this.clear();
      return;
    }

    this.updateDirectionColor(Number(displayPrice.price));
    this.pendingDisplayPrice = displayPrice;
    if (this.entityId !== null) {
      const nextRenderKey = overlayRenderKey(displayPrice);
      if (nextRenderKey === this.renderedKey) return;
      if (!this.apply(displayPrice)) this.replace(displayPrice);
      return;
    }
    if (this.creating) return;

    const generation = ++this.createGeneration;
    this.creating = true;
    const createdRenderKey = overlayRenderKey(displayPrice);
    const point = overlayPoint(displayPrice);
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
      if (this.destroyed || generation !== this.createGeneration || !this.pendingDisplayPrice) {
        this.removeEntity(entityId);
        const pending = this.pendingDisplayPrice;
        if (!this.destroyed && pending) this.update(pending);
        return;
      }
      this.entityId = entityId;
      this.applyProperties(entityId);
      this.renderedKey = createdRenderKey;
      const pending = this.pendingDisplayPrice;
      if (pending && overlayRenderKey(pending) !== this.renderedKey) this.update(pending);
    }).catch(() => {
      this.creating = false;
      if (generation === this.createGeneration) this.pendingDisplayPrice = null;
    });
  }

  clear() {
    this.pendingDisplayPrice = null;
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

  private apply(displayPrice: SpotDisplayPrice): boolean {
    if (this.entityId === null) return false;
    try {
      const shape = this.chart.getShapeById(this.entityId);
      const currentPoints = shape.getPoints?.() || [];
      const price = Number(displayPrice.price);
      const nextPoints = currentPoints.length
        ? currentPoints.map((point) => ({ ...point, price }))
        : [overlayPoint(displayPrice)];
      shape.setPoints(nextPoints);
      shape.setProperties?.(overlayProperties(this.color));
      this.renderedKey = overlayRenderKey(displayPrice);
      return true;
    } catch {
      return false;
    }
  }

  private replace(displayPrice: SpotDisplayPrice) {
    const entityId = this.entityId;
    this.entityId = null;
    this.renderedKey = null;
    if (entityId !== null) this.removeEntity(entityId);
    this.update(displayPrice);
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
