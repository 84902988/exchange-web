import {
  fetchLegalPage,
  LegalPageContractError,
  normalizeLegalPage,
  repairSplitSectionNumbers,
} from '../src/api/legal';
import { publicApiClient } from '../src/api/client';
import { splitLegalContent } from '../src/screens/legal/LegalPageScreen';

describe('mobile legal content contract', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts bounded plain text from the backend legal-page endpoint', () => {
    expect(
      normalizeLegalPage(
        {
          key: 'privacy',
          title: '隐私政策',
          content: '第一条\r\n本平台如何处理数据。',
          locale: 'zh-CN',
        },
        'privacy',
      ),
    ).toEqual({
      key: 'privacy',
      title: '隐私政策',
      content: '第一条\n本平台如何处理数据。',
      locale: 'zh-CN',
    });
  });

  it('accepts and requests the public risk disclosure page', async () => {
    const riskPage = {
      key: 'risk' as const,
      title: '风险提示',
      content: '数字资产价格可能大幅波动，请充分了解相关风险。',
      locale: 'zh',
    };
    const get = jest.spyOn(publicApiClient, 'get').mockResolvedValue(riskPage);

    expect(normalizeLegalPage(riskPage, 'risk')).toEqual(riskPage);
    await expect(fetchLegalPage('risk')).resolves.toEqual(riskPage);
    expect(get).toHaveBeenCalledWith('/site/pages/legal/risk?lang=zh-CN', {
      signal: undefined,
    });
  });

  it.each([
    [
      { key: 'terms', title: '隐私政策', content: '正文', locale: 'zh' },
      'privacy',
    ],
    [
      {
        key: 'privacy',
        title: '隐私政策',
        content: '<script>x</script>',
        locale: 'zh',
      },
      'privacy',
    ],
    [{ key: 'privacy', title: '', content: '正文', locale: 'zh' }, 'privacy'],
    [
      { key: 'privacy', title: '隐私政策', content: '正文', locale: '../zh' },
      'privacy',
    ],
  ])('rejects mismatched or unsafe legal content %#', (payload, key) => {
    expect(() => normalizeLegalPage(payload, key as 'privacy')).toThrow(
      LegalPageContractError,
    );
  });

  it('splits long legal documents into bounded virtualized blocks without loss', () => {
    const content = '条款内容。'.repeat(1500);
    const blocks = splitLegalContent(content, 4000);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every(block => block.length <= 4000)).toBe(true);
    expect(blocks.join('')).toBe(content);
  });

  it('repairs only legacy two-digit headings split across paragraphs', () => {
    expect(
      repairSplitSectionNumbers(
        '9. 数据披露\n\n1\n\n0. 跨境传输\n\n1\n\n1. 数据安全',
      ),
    ).toBe('9. 数据披露\n\n10. 跨境传输\n\n11. 数据安全');
    expect(repairSplitSectionNumbers('数量\n\n1\n\n下一段正文')).toBe(
      '数量\n\n1\n\n下一段正文',
    );
  });
});
