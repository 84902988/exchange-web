import {useContractMarketRealtime} from './useContractMarketRealtime';
import type {
  ContractMarketRealtimeDependencies,
  ContractMarketRealtimeState,
} from '../realtime/contractMarketRealtime';

/**
 * Compatibility bridge for callers that still use the old hook name.
 * The former independent polling authority has intentionally been removed;
 * Contract realtime now owns the single WS + REST fallback lifecycle.
 */
export type ContractMarketPollingState = ContractMarketRealtimeState;
export type ContractMarketPollingDependencies =
  ContractMarketRealtimeDependencies;

export function useContractMarketPolling(
  symbol: string,
  active: boolean,
  _dependencies?: ContractMarketPollingDependencies,
) {
  return useContractMarketRealtime(
    symbol,
    'contract-market-polling-compat',
    active,
  );
}
