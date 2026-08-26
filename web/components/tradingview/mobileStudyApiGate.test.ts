import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('mobile TradingView study API gate', () => {
  test.each([
    ['Spot', 'components/spot/SpotTradingViewChart.tsx'],
    ['Contract', 'components/contract/ContractTradingViewChart.tsx'],
  ])('%s chart exposes configured creation and readback only after capability checks', (_name, path) => {
    const chartSource = source(path);
    expect(chartSource).toMatch(/inputs\?: Readonly<Record<string, string \| number \| boolean>>/);
    expect(chartSource).toMatch(/options\?: Readonly<\{ disableUndo\?: boolean \}>/);
    expect(chartSource).toMatch(/getStudyById\?: \(entityId: string \| number\)/);
    expect(chartSource).toMatch(
      /'createStudy' \| 'removeEntity' \| 'getAllStudies' \| 'getStudyById'/,
    );
    expect(chartSource).toMatch(/&& chart\.getAllStudies\s*&& chart\.getStudyById/);
  });
});
