type AdvancedChartComponentMarket = 'spot' | 'contract';

let spotModulePromise: ReturnType<typeof importSpotChart> | null = null;
let contractModulePromise: ReturnType<typeof importContractChart> | null = null;

function importSpotChart() {
  return import('@/components/spot/SpotTradingViewChart');
}

function importContractChart() {
  return import('@/components/contract/ContractTradingViewChart');
}

export function loadSpotAdvancedChartComponent() {
  if (spotModulePromise) return spotModulePromise;
  const request = importSpotChart();
  spotModulePromise = request;
  void request.catch(() => {
    if (spotModulePromise === request) spotModulePromise = null;
  });
  return request;
}

export function loadContractAdvancedChartComponent() {
  if (contractModulePromise) return contractModulePromise;
  const request = importContractChart();
  contractModulePromise = request;
  void request.catch(() => {
    if (contractModulePromise === request) contractModulePromise = null;
  });
  return request;
}

export function preloadAdvancedChartComponent(
  market: AdvancedChartComponentMarket,
) {
  return market === 'spot'
    ? loadSpotAdvancedChartComponent()
    : loadContractAdvancedChartComponent();
}
