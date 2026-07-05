'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import AssetTransferModal from '@/components/asset/AssetTransferModal'
import { useLocaleContext } from '@/contexts/LocaleContext'
import type { SpotAccountBalanceItem } from '@/lib/api/modules/spot'

type Props = {
  symbol: string
  baseAsset?: string | null
  quoteAsset?: string | null
  refreshKey?: number
  accountBalances?: SpotAccountBalanceItem[]
  loading?: boolean
  isLoggedIn?: boolean
  onTransferSuccess?: () => void | Promise<void>
}

function fmtBalance(v?: string | number, fixed = 4) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '0.0000'
  return n.toFixed(fixed)
}

export default function SpotAssetInfo({
  symbol,
  baseAsset: pairBaseAsset,
  quoteAsset: pairQuoteAsset,
  accountBalances = [],
  loading = false,
  isLoggedIn = false,
  onTransferSuccess,
}: Props) {
  const { t } = useLocaleContext()
  const [transferOpen, setTransferOpen] = useState(false)
  const copy = useMemo(
    () => ({
      title: t('spotAssets', 'asset'),
      loading: t('loading', 'common'),
      account: t('spotAccount', 'asset'),
      available: t('spotAvailable', 'asset'),
      frozen: t('spotFrozen', 'asset'),
      noData: t('spotNoAssetData', 'asset'),
      login: t('spotLoginToViewAssets', 'asset'),
      deposit: t('deposit', 'common'),
      transfer: t('transfer', 'common'),
      feeDiscount: t('spotFeeDiscount', 'asset'),
      feeDiscountTip: t('spotFeeDiscountTip', 'asset'),
    }),
    [t],
  )

  const { baseAsset, quoteAsset } = useMemo(() => {
    const metaBaseAsset = String(pairBaseAsset || '').trim().toUpperCase()
    const metaQuoteAsset = String(pairQuoteAsset || '').trim().toUpperCase()
    if (metaBaseAsset || metaQuoteAsset) {
      return {
        baseAsset: metaBaseAsset,
        quoteAsset: metaQuoteAsset,
      }
    }

    const upperSymbol = (symbol || '').trim().toUpperCase()
    const quoteCandidates = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH']

    for (const quoteCandidate of quoteCandidates) {
      if (
        upperSymbol.endsWith(quoteCandidate) &&
        upperSymbol.length > quoteCandidate.length
      ) {
        return {
          baseAsset: upperSymbol.slice(0, -quoteCandidate.length),
          quoteAsset: quoteCandidate,
        }
      }
    }

    return {
      baseAsset: upperSymbol,
      quoteAsset: '',
    }
  }, [pairBaseAsset, pairQuoteAsset, symbol])

  const spotBalanceMap = useMemo(() => {
    const map = new Map<
      string,
      {
        available: string
        frozen: string
      }
    >()

    for (const item of accountBalances) {
      if ((item.account_key || '').toLowerCase() !== 'spot') continue

      map.set((item.symbol || '').toUpperCase(), {
        available: item.available || '0',
        frozen: item.frozen || '0',
      })
    }

    return map
  }, [accountBalances])

  const base = spotBalanceMap.get(baseAsset)
  const quote = spotBalanceMap.get(quoteAsset)
  const rcb = spotBalanceMap.get('RCB')
  const shouldShowRcb =
    baseAsset.toUpperCase() !== 'RCB' && quoteAsset.toUpperCase() !== 'RCB'

  const hasAssetMeta = !!baseAsset || !!quoteAsset
  const hasAssetData = !!base || !!quote
  const transferCoin = quoteAsset || 'USDT'

  return (
    <div className="tabular-nums flex h-full flex-col overflow-visible rounded-xl border border-white/10 bg-[#12171f] p-1 xl:p-1.5">
      <div className="mb-1 flex items-center justify-between xl:mb-1.5">
        <div className="text-[14px] font-semibold text-white">{copy.title}</div>
        <div className="text-[12px] text-gray-400">
          {loading ? copy.loading : copy.account}
        </div>
      </div>

      {!isLoggedIn ? (
        <div className="flex min-h-[118px] flex-1 items-center justify-center rounded-lg bg-white/[0.03] px-3 py-8 text-center text-sm text-white/50">
          {copy.login}
        </div>
      ) : !loading && !hasAssetMeta && !hasAssetData ? (
        <div className="flex min-h-[118px] flex-1 items-center justify-center rounded-lg bg-white/[0.03] px-3 py-8 text-center text-sm text-white/40">
          {copy.noData}
        </div>
      ) : (
        <div className="space-y-1 xl:space-y-1.5">
          <BalanceCard asset={baseAsset || '--'} available={base?.available} frozen={base?.frozen} copy={copy} />
          <BalanceCard asset={quoteAsset || '--'} available={quote?.available} frozen={quote?.frozen} copy={copy} />

          {shouldShowRcb ? (
            <div className="space-y-0.5 rounded-xl border border-amber-300/10 bg-[#11161c] p-1.5 xl:space-y-1 xl:p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13px] text-amber-200">RCB</div>
                <div className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[10px] text-amber-200/80">
                  {copy.feeDiscount}
                </div>
              </div>
              <div className="text-xs text-gray-400">{copy.feeDiscountTip}</div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-gray-500">{copy.available}</div>
                <div className="text-[15px] font-semibold leading-none text-white">
                  {fmtBalance(rcb?.available)}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-gray-500">{copy.frozen}</div>
                <div className="text-[15px] font-semibold leading-none text-white">
                  {fmtBalance(rcb?.frozen)}
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Link
              href={`/asset/deposit?coin=${encodeURIComponent(transferCoin)}`}
              className="flex-1 rounded-lg border border-white/10 bg-white/5 py-2 text-center text-[13px] font-semibold text-white hover:bg-white/10 transition-colors"
            >
              {copy.deposit}
            </Link>
            <button
              type="button"
              onClick={() => setTransferOpen(true)}
              className="flex-1 rounded-lg bg-white text-center text-[13px] font-semibold text-black py-2 hover:bg-white/90 transition-colors"
            >
              {copy.transfer}
            </button>
          </div>
        </div>
      )}

      <AssetTransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        defaultFrom="funding"
        defaultTo="spot"
        defaultCoin={transferCoin}
        onSuccess={onTransferSuccess}
      />
    </div>
  )
}

function BalanceCard({
  asset,
  available,
  frozen,
  copy,
}: {
  asset: string
  available?: string
  frozen?: string
  copy: Record<string, string>
}) {
  return (
    <div className="space-y-0.5 rounded-xl bg-[#11161c] p-1.5 xl:space-y-1 xl:p-2.5">
      <div className="text-[13px] text-gray-300">{asset}</div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-gray-500">{copy.available}</div>
        <div className="text-[15px] font-semibold leading-none text-white">
          {fmtBalance(available)}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-gray-500">{copy.frozen}</div>
        <div className="text-[15px] font-semibold leading-none text-white">
          {fmtBalance(frozen)}
        </div>
      </div>
    </div>
  )
}
