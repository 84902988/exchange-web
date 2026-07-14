export type ContractPriceDirection = 'up' | 'down' | 'flat';

export type ContractTradingViewPriceOverlayInput = {
  symbol: string;
  interval: string;
  displayPrice: number | null;
  priceDirection: ContractPriceDirection;
};

export type ContractTradingViewOverlayEntityId = string | number;

type ContractTradingViewOverlayShape = {
  getPoints?: () => Array<{ time: number; price?: number }>;
  setPoints: (points: Array<{ time: number; price: number }>) => void;
  setProperties?: (properties: Record<string, unknown>) => void;
};

export type ContractTradingViewOverlayChart = {
  createShape: (
    point: { time: number; price: number },
    options: Record<string, unknown>,
  ) => Promise<ContractTradingViewOverlayEntityId>;
  getShapeById: (
    entityId: ContractTradingViewOverlayEntityId,
  ) => ContractTradingViewOverlayShape;
  removeEntity: (
    entityId: ContractTradingViewOverlayEntityId,
    options?: { disableUndo?: boolean },
  ) => void;
};

const CONTRACT_PRICE_OVERLAY_UP_COLOR = '#00c087';
const CONTRACT_PRICE_OVERLAY_DOWN_COLOR = '#f6465d';
const CONTRACT_PRICE_OVERLAY_LINE_STYLE_DASHED = 2;

function normalizeScopePart(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function buildOverlayScope(input: ContractTradingViewPriceOverlayInput) {
  return `${normalizeScopePart(input.symbol)}|${normalizeScopePart(input.interval)}`;
}

function isDisplayPriceAvailable(value: unknown): value is number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function overlayPoint(displayPrice: number) {
  return {
    time: Math.max(1, Math.floor(Date.now() / 1000)),
    price: Number(displayPrice),
  };
}

function overlayProperties(color: string): Record<string, unknown> {
  return {
    text: '',
    linecolor: color,
    textcolor: color,
    linewidth: 1,
    linestyle: CONTRACT_PRICE_OVERLAY_LINE_STYLE_DASHED,
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

function resolveOverlayColor(direction: ContractPriceDirection, currentColor: string) {
  if (direction === 'up') return CONTRACT_PRICE_OVERLAY_UP_COLOR;
  if (direction === 'down') return CONTRACT_PRICE_OVERLAY_DOWN_COLOR;
  return currentColor;
}

function overlayRenderKey(input: ContractTradingViewPriceOverlayInput, color: string) {
  return [buildOverlayScope(input), Number(input.displayPrice), input.priceDirection, color].join(':');
}

export class ContractTradingViewPriceOverlayController {
  private entityId: ContractTradingViewOverlayEntityId | null = null;
  private pendingInput: ContractTradingViewPriceOverlayInput | null = null;
  private createGeneration = 0;
  private creatingGeneration = 0;
  private creating = false;
  private destroyed = false;
  private renderedKey: string | null = null;
  private activeScope: string | null = null;
  private color = CONTRACT_PRICE_OVERLAY_UP_COLOR;

  constructor(private readonly chart: ContractTradingViewOverlayChart) {}

  update(input: ContractTradingViewPriceOverlayInput) {
    if (this.destroyed) return;
    const scope = buildOverlayScope(input);
    if (this.activeScope !== null && scope !== this.activeScope) {
      this.clear();
      this.color = CONTRACT_PRICE_OVERLAY_UP_COLOR;
    }
    this.activeScope = scope;
    if (!scope || !isDisplayPriceAvailable(input.displayPrice)) {
      this.clear();
      return;
    }

    this.color = resolveOverlayColor(input.priceDirection, this.color);
    this.pendingInput = input;
    if (this.entityId !== null) {
      const nextRenderKey = overlayRenderKey(input, this.color);
      if (nextRenderKey === this.renderedKey) return;
      if (!this.apply(input)) this.replace(input);
      return;
    }
    if (this.creating) return;

    const generation = ++this.createGeneration;
    this.creatingGeneration = generation;
    this.creating = true;
    const createdRenderKey = overlayRenderKey(input, this.color);
    const point = overlayPoint(input.displayPrice);
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
      if (this.creatingGeneration === generation) this.creating = false;
      if (this.destroyed || generation !== this.createGeneration || !this.pendingInput) {
        this.removeEntity(entityId);
        const pending = this.pendingInput;
        if (!this.destroyed && pending) this.update(pending);
        return;
      }
      this.entityId = entityId;
      this.applyProperties(entityId);
      this.renderedKey = createdRenderKey;
      const pending = this.pendingInput;
      if (pending && overlayRenderKey(pending, this.color) !== this.renderedKey) {
        this.update(pending);
      }
    }).catch(() => {
      if (this.creatingGeneration === generation) this.creating = false;
      if (generation === this.createGeneration) this.pendingInput = null;
    });
  }

  clear() {
    this.pendingInput = null;
    this.createGeneration += 1;
    this.creatingGeneration = 0;
    this.creating = false;
    const entityId = this.entityId;
    this.entityId = null;
    this.renderedKey = null;
    if (entityId !== null) this.removeEntity(entityId);
  }

  reset() {
    this.clear();
    this.activeScope = null;
    this.color = CONTRACT_PRICE_OVERLAY_UP_COLOR;
  }

  destroy() {
    if (this.destroyed) return;
    this.reset();
    this.destroyed = true;
  }

  private apply(input: ContractTradingViewPriceOverlayInput) {
    if (this.entityId === null || !isDisplayPriceAvailable(input.displayPrice)) return false;
    try {
      const shape = this.chart.getShapeById(this.entityId);
      const currentPoints = shape.getPoints?.() || [];
      const nextPoints = currentPoints.length
        ? currentPoints.map((point) => ({ ...point, price: input.displayPrice as number }))
        : [overlayPoint(input.displayPrice)];
      shape.setPoints(nextPoints);
      shape.setProperties?.(overlayProperties(this.color));
      this.renderedKey = overlayRenderKey(input, this.color);
      return true;
    } catch {
      return false;
    }
  }

  private replace(input: ContractTradingViewPriceOverlayInput) {
    const entityId = this.entityId;
    this.entityId = null;
    this.renderedKey = null;
    if (entityId !== null) this.removeEntity(entityId);
    this.update(input);
  }

  private applyProperties(entityId: ContractTradingViewOverlayEntityId) {
    try {
      this.chart.getShapeById(entityId).setProperties?.(overlayProperties(this.color));
    } catch {
      // Creation overrides already carry the final style when shape mutation is unavailable.
    }
  }

  private removeEntity(entityId: ContractTradingViewOverlayEntityId) {
    try {
      this.chart.removeEntity(entityId, { disableUndo: true });
    } catch {
      // TradingView may already remove transient drawings during widget cleanup.
    }
  }
}
