import {
  fetchPublicSupportContact,
  normalizePublicSupportContact,
  PublicSupportContactContractError,
} from '../src/api/siteContact';
import { publicApiClient } from '../src/api/client';

describe('public support contact contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts only the official support email from a mixed site config', () => {
    expect(
      normalizePublicSupportContact({
        support_email: ' info@service.example ',
        site_slogan: '213213',
        home_hero_title: 'TEST',
        risk_disclaimer: '12324125123',
      }),
    ).toEqual({ email: 'info@service.example' });
  });

  it('allows a truthful missing contact without inventing a fallback', () => {
    expect(normalizePublicSupportContact({ support_email: '' })).toEqual({
      email: null,
    });
    expect(normalizePublicSupportContact({ support_email: null })).toEqual({
      email: null,
    });
  });

  it.each([
    'support@example.com',
    'admin@localhost',
    'admin@example.test',
    'not-an-email',
    '<script>@service.example',
    'two@@service.example',
  ])('rejects an invalid or placeholder address: %s', email => {
    expect(() =>
      normalizePublicSupportContact({ support_email: email }),
    ).toThrow(PublicSupportContactContractError);
  });

  it('uses the public localized site-config route and abort signal', async () => {
    const get = jest
      .spyOn(publicApiClient, 'get')
      .mockResolvedValue({ support_email: 'info@service.example' });
    const controller = new AbortController();
    await expect(
      fetchPublicSupportContact({
        locale: 'zh_CN',
        signal: controller.signal,
      }),
    ).resolves.toEqual({ email: 'info@service.example' });
    expect(get).toHaveBeenCalledWith('/site/config?lang=zh-CN', {
      signal: controller.signal,
    });
  });

  it('fails before transport when the request is already aborted', async () => {
    const get = jest.spyOn(publicApiClient, 'get');
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchPublicSupportContact({ signal: controller.signal }),
    ).rejects.toThrow('支持联系方式请求已取消');
    expect(get).not.toHaveBeenCalled();
  });
});
