import type { ContractDepthMode } from '@/lib/api/modules/contract';

export type ContractDepthBootstrapPresentation = {
  exposeRows: boolean;
  delayRows: boolean;
  depthMode: ContractDepthMode | null;
};

export function resolveContractDepthBootstrapPresentation(
  depthMode: ContractDepthMode | null | undefined,
  hasRows: boolean,
  fallbackGraceExpired: boolean,
): ContractDepthBootstrapPresentation {
  const normalizedMode = String(depthMode || '').trim().toUpperCase();
  const providerModeReady = normalizedMode === 'FULL_DEPTH'
    || normalizedMode === 'BBO_ONLY';
  const exposeRows = hasRows && (providerModeReady || fallbackGraceExpired);

  return {
    exposeRows,
    delayRows: hasRows && !exposeRows,
    depthMode: exposeRows ? depthMode || null : null,
  };
}
