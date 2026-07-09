'use client';

import type { ContractOrderListItem, ContractPositionItem } from '@/lib/api/modules/contract';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatPrice } from '@/lib/marketPrecision';
import { formatNumber, formatTime, toNumber } from './contractFormat';

type ContractTranslator = (key: string, namespace?: 'contracts') => string;

type ContractOrderTabsProps = {
  rows: ContractOrderListItem[];
  emptyText: string;
  pricePrecision: number;
  loading?: boolean;
  loadingText?: string;
  loadingDescription?: string;
  showOperation?: boolean;
  positions?: ContractPositionItem[];
  cancelingOrderId?: number | null;
  onCancel?: (orderId: number) => void;
};

export default function ContractOrderTabs({
  rows,
  emptyText,
  pricePrecision,
  loading = false,
  loadingText,
  loadingDescription,
  showOperation = false,
  positions = [],
  cancelingOrderId = null,
  onCancel,
}: ContractOrderTabsProps) {
  const { t } = useLocaleContext();
  const displayLoadingText = loadingText || t('ordersRefreshingData', 'contracts');
  const displayLoadingDescription = loadingDescription || t('ordersSyncingDesc', 'contracts');

  if (rows.length === 0 && loading) {
    return <EmptyState title={displayLoadingText} description={displayLoadingDescription} />;
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyText} description={t('ordersAutoRefreshDesc', 'contracts')} />;
  }

  return (
    <div className="space-y-2 p-3">
      {rows.map((item) => {
        const action = formatContractOrderAction(item, t);
        const actionTone = contractOrderActionTone(item);
        const filledQuantity = toNumber(item.filled_quantity);
        const quantity = toNumber(item.quantity);
        const remainingQuantity = Math.max(quantity - filledQuantity, 0);
        const canCancel = canCancelOrder(item);
        const triggerDisplay = getTpSlTriggerDisplay(item, positions, pricePrecision, t);
        const priceMetrics = getOrderPriceMetrics(item, triggerDisplay, pricePrecision, t);

        return (
          <div
            key={item.id}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{displaySymbol(item.symbol)}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${actionBadgeClassName(actionTone)}`}>
                    {action}
                  </span>
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-white/65">
                    {formatOrderType(item.order_type, t)}
                  </span>
                  <OrderStatusBadge status={item.status} filledQuantity={filledQuantity} t={t} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-white/38">
                  <span>{formatTime(item.created_at)}</span>
                  <span title={item.order_no}>{t('orderPrefix', 'contracts')} {shortOrderNo(item.order_no)}</span>
                </div>
              </div>

              {showOperation && canCancel ? (
                <button
                  type="button"
                  disabled={cancelingOrderId === item.id}
                  onClick={() => onCancel?.(item.id)}
                  className="h-8 shrink-0 rounded-md border border-white/10 px-3 text-[12px] font-semibold text-white/70 transition-colors hover:border-[#f0b90b]/60 hover:text-[#f0b90b] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {cancelingOrderId === item.id ? t('cancelOrderPending', 'contracts') : t('cancelOrderAction', 'contracts')}
                </button>
              ) : null}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {priceMetrics.map((metric) => (
                <OrderMetric key={metric.label} label={metric.label} value={metric.value} />
              ))}
              <OrderMetric label={t('orderQuantity', 'contracts')} value={formatQuantity(item.quantity)} />
              <OrderMetric label={t('filledQuantity', 'contracts')} value={formatQuantity(item.filled_quantity)} />
              <OrderMetric label={t('remainingQuantity', 'contracts')} value={formatQuantity(remainingQuantity)} />
              <OrderMetric label={t('margin', 'contracts')} value={`${formatNumber(item.margin_amount, 2)} USDT`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function canCancelOrder(item: ContractOrderListItem) {
  return item.status === 'OPEN' || item.status === 'NEW' || item.status === 'PARTIALLY_FILLED';
}

function displaySymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}

export function formatContractOrderAction(item: Pick<ContractOrderListItem, 'action' | 'position_side'>, t?: ContractTranslator) {
  const isOpen = item.action === 'OPEN';
  if (isOpen && item.position_side === 'LONG') return t ? t('openLong', 'contracts') : '开多';
  if (isOpen && item.position_side === 'SHORT') return t ? t('openShort', 'contracts') : '开空';
  if (!isOpen && item.position_side === 'LONG') return t ? t('closeLong', 'contracts') : '平多';
  if (!isOpen && item.position_side === 'SHORT') return t ? t('closeShort', 'contracts') : '平空';
  return item.position_side || '--';
}

export function contractOrderActionTone(item: Pick<ContractOrderListItem, 'action' | 'position_side'>): 'green' | 'red' | undefined {
  if (item.action === 'OPEN' && item.position_side === 'LONG') return 'green';
  if (item.action === 'CLOSE' && item.position_side === 'SHORT') return 'green';
  if (item.action === 'OPEN' && item.position_side === 'SHORT') return 'red';
  if (item.action === 'CLOSE' && item.position_side === 'LONG') return 'red';
  return undefined;
}

export function formatOrderType(value: string, t?: ContractTranslator) {
  if (value === 'MARKET') return t ? t('market', 'contracts') : '市价';
  if (value === 'LIMIT') return t ? t('limit', 'contracts') : '限价';
  return value || '--';
}

export function formatContractOrderStatus(status: string, filledQuantity = 0, t?: ContractTranslator) {
  if (status === 'OPEN' || status === 'NEW' || status === 'PENDING') return t ? t('orderStatusPendingFill', 'contracts') : '等待成交';
  if (status === 'PARTIALLY_FILLED') return t ? t('orderStatusPartiallyFilled', 'contracts') : '部分成交';
  if (status === 'FILLED') return t ? t('orderStatusFilled', 'contracts') : '已完成';
  if (status === 'CANCELED' || status === 'CANCELLED') {
    if (filledQuantity > 0) return t ? t('orderStatusCanceledAfterPartial', 'contracts') : '部分成交后撤销';
    return t ? t('orderStatusCanceled', 'contracts') : '已撤销';
  }
  if (status === 'FAILED') return t ? t('orderStatusFailed', 'contracts') : '失败';
  return status || '--';
}

function actionBadgeClassName(tone?: 'green' | 'red') {
  if (tone === 'green') return 'bg-[#00c087]/12 text-[#00c087]';
  if (tone === 'red') return 'bg-[#f6465d]/12 text-[#f6465d]';
  return 'bg-white/[0.06] text-white/65';
}

function statusClassName(value: string) {
  if (value === 'OPEN' || value === 'NEW' || value === 'PENDING') return 'border-[#177ddc]/30 bg-[#177ddc]/12 text-[#69c0ff]';
  if (value === 'PARTIALLY_FILLED') return 'border-[#f0b90b]/30 bg-[#f0b90b]/12 text-[#f0b90b]';
  if (value === 'FILLED') return 'border-[#00c087]/30 bg-[#00c087]/12 text-[#00c087]';
  if (value === 'CANCELED' || value === 'CANCELLED') return 'border-white/10 bg-white/[0.04] text-white/55';
  if (value === 'FAILED') return 'border-[#f6465d]/30 bg-[#f6465d]/12 text-[#f6465d]';
  return 'border-white/10 bg-white/[0.04] text-white/65';
}

function OrderStatusBadge({ status, filledQuantity, t }: { status: string; filledQuantity: number; t: ContractTranslator }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${statusClassName(status)}`}>
      {formatContractOrderStatus(status, filledQuantity, t)}
    </span>
  );
}

function shortOrderNo(value?: string | null) {
  const text = String(value || '');
  if (!text) return '--';
  return text.length > 8 ? text.slice(-8) : text;
}

function formatOrderPrice(value: string | number | null | undefined, pricePrecision: number) {
  if (value === null || value === undefined || value === '') return '--';
  const num = toNumber(value);
  if (!Number.isFinite(num) || num <= 0) return '--';
  return `${formatPrice(num, pricePrecision)} USDT`;
}

function formatQuantity(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '--';
  const num = toNumber(value);
  if (!Number.isFinite(num)) return '--';
  return formatNumber(num, 6);
}

function getTpSlTriggerDisplay(
  item: ContractOrderListItem,
  positions: ContractPositionItem[],
  pricePrecision: number,
  t: ContractTranslator,
) {
  if (item.action !== 'CLOSE' || item.order_type !== 'MARKET') return null;

  const reason = String(item.fail_reason || '').trim().toUpperCase();
  if (reason !== 'TAKE_PROFIT' && reason !== 'STOP_LOSS') return null;

  const position = positions.find((record) => Number(record.id) === Number(item.position_id));
  const rawPrice = reason === 'TAKE_PROFIT'
    ? item.take_profit_price ?? position?.take_profit_price
    : item.stop_loss_price ?? position?.stop_loss_price;
  const label = reason === 'TAKE_PROFIT' ? t('takeProfitPrice', 'contracts') : t('stopLossPrice', 'contracts');

  return {
    label,
    value: formatOrderPrice(rawPrice, pricePrecision),
  };
}

function getOrderPriceMetrics(
  item: ContractOrderListItem,
  triggerDisplay: { label: string; value: string } | null,
  pricePrecision: number,
  t: ContractTranslator,
) {
  if (item.order_type === 'LIMIT') {
    return [
      { label: t('orderPrice', 'contracts'), value: formatOrderPrice(item.price, pricePrecision) },
      { label: t('averageFillPrice', 'contracts'), value: formatOrderPrice(item.avg_price, pricePrecision) },
    ];
  }
  if (triggerDisplay) {
    return [
      triggerDisplay,
      { label: t('averageFillPrice', 'contracts'), value: formatOrderPrice(item.avg_price, pricePrecision) },
    ];
  }
  return [
    { label: t('tradeExecutionMethod', 'contracts'), value: t('market', 'contracts') },
    { label: t('averageFillPrice', 'contracts'), value: formatOrderPrice(item.avg_price, pricePrecision) },
  ];
}

function OrderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-white/[0.025] px-2 py-2">
      <div className="truncate text-[11px] text-white/38">{label}</div>
      <div className="mt-1 truncate font-mono text-[12px] text-white/86 tabular-nums">{value}</div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-white/10 px-2 py-8 text-center">
      <div className="text-[13px] text-white/38">{title}</div>
      <div className="mt-1 text-[12px] text-white/24">{description}</div>
    </div>
  );
}
