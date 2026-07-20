import type { ContractPositionItem } from '@/lib/api/modules/contract';

import type {
  ContractTradingViewOverlayChart,
  ContractTradingViewOverlayEntityId,
} from './contractTradingViewPriceOverlay';

export type ContractTradingViewPositionLineKind = 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';

export type ContractTradingViewPositionLine = {
  key: string;
  kind: ContractTradingViewPositionLineKind;
  price: number;
  text: string;
};

type PositionLineEntity = {
  id: ContractTradingViewOverlayEntityId;
  renderKey: string;
};

const POSITION_LINE_STYLE: Record<ContractTradingViewPositionLineKind, { color: string; lineStyle: number }> = {
  ENTRY: { color: '#f0b90b', lineStyle: 2 },
  TAKE_PROFIT: { color: '#00c087', lineStyle: 1 },
  STOP_LOSS: { color: '#f6465d', lineStyle: 1 },
};

const POSITION_LINE_CREATE_RETRY_LIMIT = 3;
const POSITION_LINE_INITIAL_CREATE_DELAY_MS = 80;
const POSITION_LINE_RETRY_DELAY_MS = 120;
const POSITION_LINE_APPLY_READY_ATTEMPTS = 5;
const POSITION_LINE_APPLY_INITIAL_DELAY_MS = 120;
const POSITION_LINE_APPLY_READY_DELAY_MS = 60;

function waitForPositionLineCreate(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function positivePrice(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function validEntityId(value: unknown): value is ContractTradingViewOverlayEntityId {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '');
}

function positionLinePoint(price: number) {
  return {
    time: Math.max(1, Math.floor(Date.now() / 1000)),
    price,
  };
}

function lineProperties(line: ContractTradingViewPositionLine) {
  const style = POSITION_LINE_STYLE[line.kind];
  return {
    text: line.text,
    linecolor: style.color,
    textcolor: style.color,
    linewidth: 1,
    linestyle: style.lineStyle,
    showPrice: true,
  };
}

function lineOverrides(line: ContractTradingViewPositionLine) {
  const properties = lineProperties(line);
  return {
    'linetoolhorzline.linecolor': properties.linecolor,
    'linetoolhorzline.textcolor': properties.textcolor,
    'linetoolhorzline.linewidth': properties.linewidth,
    'linetoolhorzline.linestyle': properties.linestyle,
    'linetoolhorzline.showPrice': properties.showPrice,
  };
}

function lineRenderKey(line: ContractTradingViewPositionLine) {
  return [line.key, line.kind, line.price, line.text].join('|');
}

export function buildContractTradingViewPositionLines(
  positions: ContractPositionItem[] | null | undefined,
  symbol: string,
): ContractTradingViewPositionLine[] {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return [];

  const eligiblePositions = (positions || []).filter((position) => (
    normalizeSymbol(position.symbol) === normalizedSymbol
    && String(position.status || '').trim().toUpperCase() === 'OPEN'
    && positivePrice(position.quantity) !== null
  )).sort((left, right) => Number(left.id) - Number(right.id));

  const lines: ContractTradingViewPositionLine[] = [];
  for (const [positionIndex, position] of eligiblePositions.entries()) {

    const side = String(position.side || '').trim().toUpperCase();
    const sideLabel = side === 'SHORT' ? 'SELL' : 'BUY';
    const positionNumber = positionIndex + 1;
    const entryPrice = positivePrice(position.entry_price);
    const takeProfitPrice = positivePrice(position.take_profit_price);
    const stopLossPrice = positivePrice(position.stop_loss_price);

    if (entryPrice !== null) {
      lines.push({
        key: `${position.id}:ENTRY`,
        kind: 'ENTRY',
        price: entryPrice,
        text: `${sideLabel} ENTRY#${positionNumber}`,
      });
    }
    if (takeProfitPrice !== null) {
      lines.push({
        key: `${position.id}:TP`,
        kind: 'TAKE_PROFIT',
        price: takeProfitPrice,
        text: `${sideLabel} TP#${positionNumber}`,
      });
    }
    if (stopLossPrice !== null) {
      lines.push({
        key: `${position.id}:SL`,
        kind: 'STOP_LOSS',
        price: stopLossPrice,
        text: `${sideLabel} SL#${positionNumber}`,
      });
    }
  }

  return lines.sort((left, right) => left.key.localeCompare(right.key));
}

export class ContractTradingViewPositionLinesController {
  private activeScope = '';
  private createSequence = 0;
  private scopeGeneration = 0;
  private readonly creating = new Map<string, number>();
  private readonly createAttempts = new Map<string, number>();
  private readonly createQueue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly desired = new Map<string, ContractTradingViewPositionLine>();
  private readonly entities = new Map<string, PositionLineEntity>();
  private processingCreateQueue = false;
  private destroyed = false;

  constructor(private readonly chart: ContractTradingViewOverlayChart) {}

  update(symbol: string, lines: ContractTradingViewPositionLine[]) {
    if (this.destroyed) return;
    const scope = normalizeSymbol(symbol);
    if (scope !== this.activeScope) {
      this.clear();
      this.activeScope = scope;
    }

    this.desired.clear();
    for (const line of lines) {
      if (positivePrice(line.price) !== null && line.key) this.desired.set(line.key, line);
    }

    for (const [key, entity] of this.entities) {
      if (!this.desired.has(key)) {
        this.removeEntity(entity.id);
        this.entities.delete(key);
      }
    }

    for (const [key, line] of this.desired) {
      const entity = this.entities.get(key);
      if (entity) {
        const nextRenderKey = lineRenderKey(line);
        if (entity.renderKey !== nextRenderKey && !this.apply(entity.id, line)) {
          this.removeEntity(entity.id);
          this.entities.delete(key);
          this.enqueueCreate(key);
        }
      } else if (!this.creating.has(key)) {
        this.enqueueCreate(key);
      }
    }
  }

  clear() {
    this.scopeGeneration += 1;
    this.desired.clear();
    this.creating.clear();
    this.createAttempts.clear();
    this.createQueue.length = 0;
    this.queued.clear();
    for (const entity of this.entities.values()) this.removeEntity(entity.id);
    this.entities.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.clear();
    this.activeScope = '';
    this.destroyed = true;
  }

  private enqueueCreate(key: string) {
    if (
      this.destroyed
      || this.entities.has(key)
      || this.creating.has(key)
      || this.queued.has(key)
      || !this.desired.has(key)
    ) return;
    this.queued.add(key);
    this.createQueue.push(key);
    void this.drainCreateQueue();
  }

  private async drainCreateQueue() {
    if (this.processingCreateQueue || this.destroyed) return;
    this.processingCreateQueue = true;
    try {
      while (!this.destroyed && this.createQueue.length) {
        const key = this.createQueue.shift();
        if (!key) continue;
        let line = this.desired.get(key);
        if (!line || this.entities.has(key) || this.creating.has(key)) {
          this.queued.delete(key);
          continue;
        }
        const attempts = this.createAttempts.get(key) || 0;
        const delayMs = attempts > 0
          ? POSITION_LINE_RETRY_DELAY_MS * attempts
          : POSITION_LINE_INITIAL_CREATE_DELAY_MS;
        if (delayMs > 0) await waitForPositionLineCreate(delayMs);
        this.queued.delete(key);
        line = this.desired.get(key);
        if (this.destroyed || !line || this.entities.has(key) || this.creating.has(key)) continue;
        await this.create(key, line);
      }
    } finally {
      this.processingCreateQueue = false;
      if (!this.destroyed && this.createQueue.length) void this.drainCreateQueue();
    }
  }

  private async create(key: string, line: ContractTradingViewPositionLine) {
    const sequence = ++this.createSequence;
    const generation = this.scopeGeneration;
    this.creating.set(key, sequence);
    try {
      const entityId = await this.chart.createShape(positionLinePoint(this.creationAnchorPrice(line)), {
        shape: 'horizontal_line',
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        showInObjectsTree: false,
        zOrder: 'top',
        text: line.text,
        overrides: lineOverrides(line),
      });
      const isCurrentCreate = this.creating.get(key) === sequence;
      if (isCurrentCreate) this.creating.delete(key);
      const desiredLine = this.desired.get(key);
      if (!validEntityId(entityId) || this.hasEntityId(entityId)) {
        if (!this.destroyed && generation === this.scopeGeneration && isCurrentCreate && desiredLine) {
          this.retryCreate(key);
        }
        return;
      }
      if (this.destroyed || generation !== this.scopeGeneration || !isCurrentCreate || !desiredLine) {
        this.removeEntity(entityId);
        return;
      }
      const applied = await this.applyWhenReady(key, entityId, generation, desiredLine);
      if (!applied) {
        this.entities.delete(key);
        this.removeEntity(entityId);
        if (!this.destroyed && generation === this.scopeGeneration && this.desired.has(key)) {
          this.retryCreate(key);
        }
        return;
      }
      this.createAttempts.delete(key);
    } catch {
      if (this.creating.get(key) === sequence) this.creating.delete(key);
      if (this.destroyed || generation !== this.scopeGeneration || !this.desired.has(key)) return;
      this.retryCreate(key);
    }
  }

  private async applyWhenReady(
    key: string,
    entityId: ContractTradingViewOverlayEntityId,
    generation: number,
    fallbackLine: ContractTradingViewPositionLine,
  ) {
    if (fallbackLine.kind !== 'ENTRY') {
      await waitForPositionLineCreate(POSITION_LINE_APPLY_INITIAL_DELAY_MS);
    }
    for (let attempt = 0; attempt < POSITION_LINE_APPLY_READY_ATTEMPTS; attempt += 1) {
      if (this.destroyed || generation !== this.scopeGeneration || !this.desired.has(key)) return false;
      const line = this.desired.get(key) || fallbackLine;
      if (this.apply(entityId, line)) return true;
      if (attempt + 1 < POSITION_LINE_APPLY_READY_ATTEMPTS) {
        await waitForPositionLineCreate(POSITION_LINE_APPLY_READY_DELAY_MS * (attempt + 1));
      }
    }
    return false;
  }

  private hasEntityId(entityId: ContractTradingViewOverlayEntityId) {
    for (const entity of this.entities.values()) {
      if (entity.id === entityId) return true;
    }
    return false;
  }

  private creationAnchorPrice(line: ContractTradingViewPositionLine) {
    if (line.kind === 'ENTRY') return line.price;
    const separator = line.key.lastIndexOf(':');
    const positionKey = separator > 0 ? line.key.slice(0, separator) : line.key;
    return this.desired.get(`${positionKey}:ENTRY`)?.price ?? line.price;
  }

  private retryCreate(key: string) {
    const attempts = (this.createAttempts.get(key) || 0) + 1;
    this.createAttempts.set(key, attempts);
    if (attempts < POSITION_LINE_CREATE_RETRY_LIMIT) this.enqueueCreate(key);
  }

  private apply(entityId: ContractTradingViewOverlayEntityId, line: ContractTradingViewPositionLine) {
    try {
      const shape = this.chart.getShapeById(entityId);
      const currentPoints = shape.getPoints?.() || [];
      const nextPoints = currentPoints.length
        ? currentPoints.map((point) => ({ ...point, price: line.price }))
        : [positionLinePoint(line.price)];
      shape.setPoints(nextPoints);
      shape.setProperties?.(lineProperties(line));
      this.entities.set(line.key, { id: entityId, renderKey: lineRenderKey(line) });
      return true;
    } catch {
      return false;
    }
  }

  private removeEntity(entityId: ContractTradingViewOverlayEntityId) {
    try {
      this.chart.removeEntity(entityId, { disableUndo: true });
    } catch {
      // TradingView can remove drawings first while a widget is being destroyed.
    }
  }
}
