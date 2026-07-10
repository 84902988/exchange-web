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

function overlayColor(displayPrice: SpotDisplayPrice): string {
  if (displayPrice.freshness === 'LIVE' && displayPrice.isRealTrade) return '#00c087';
  if (displayPrice.freshness === 'LIVE') return '#38bdf8';
  return '#f0b90b';
}

function overlayText(displayPrice: SpotDisplayPrice): string {
  if (displayPrice.isRealTrade) return 'Latest trade';
  if (displayPrice.sourceDomain === 'ticker') return 'Ticker display';
  return 'Candle display';
}

function overlayPoint(displayPrice: SpotDisplayPrice) {
  return {
    time: overlayTimeSeconds(displayPrice),
    price: Number(displayPrice.price),
  };
}

function overlayProperties(displayPrice: SpotDisplayPrice): Record<string, unknown> {
  const color = overlayColor(displayPrice);
  return {
    text: overlayText(displayPrice),
    linecolor: color,
    textcolor: color,
    linewidth: 1,
    linestyle: displayPrice.isRealTrade ? 0 : 2,
    showPrice: true,
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

  constructor(private readonly chart: SpotTradingViewOverlayChart) {}

  update(displayPrice: SpotDisplayPrice) {
    if (this.destroyed) return;
    if (!shouldShowSpotDisplayPriceOverlay(displayPrice)) {
      this.clear();
      return;
    }

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
      text: overlayText(displayPrice),
      overrides: {
        'linetoolhorzline.linecolor': overlayColor(displayPrice),
        'linetoolhorzline.textcolor': overlayColor(displayPrice),
        'linetoolhorzline.linewidth': 1,
        'linetoolhorzline.linestyle': displayPrice.isRealTrade ? 0 : 2,
        'linetoolhorzline.showPrice': true,
      },
    }).then((entityId) => {
      this.creating = false;
      if (this.destroyed || generation !== this.createGeneration || !this.pendingDisplayPrice) {
        this.removeEntity(entityId);
        const pending = this.pendingDisplayPrice;
        if (!this.destroyed && pending) this.update(pending);
        return;
      }
      this.entityId = entityId;
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
      shape.setProperties?.(overlayProperties(displayPrice));
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

  private removeEntity(entityId: SpotTradingViewOverlayEntityId) {
    try {
      this.chart.removeEntity(entityId, { disableUndo: true });
    } catch {
      // The chart may already have removed non-persistent drawings during a layout cleanup.
    }
  }
}
