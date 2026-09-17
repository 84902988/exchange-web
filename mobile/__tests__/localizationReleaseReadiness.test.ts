import {branding} from '../src/config/brandingConfig';
import {
  createTranslator,
  supportedLocales,
  translationKeys,
  type TranslationKey,
} from '../src/i18n';

function placeholderNames(value: string) {
  return Array.from(value.matchAll(/\{\{(\w+)\}\}/g), match => match[1]).sort();
}

describe('mobile localization release readiness', () => {
  it('keeps the complete four-language catalog non-empty and interpolation-safe', () => {
    const uniqueKeys = new Set<TranslationKey>(translationKeys);
    const sourceTranslator = createTranslator('zh-CN');
    const issues: string[] = [];

    if (uniqueKeys.size !== translationKeys.length) {
      issues.push('translation catalog contains duplicate keys');
    }

    for (const {locale} of supportedLocales) {
      const translator = createTranslator(locale);

      for (const key of translationKeys) {
        const sourceValue = sourceTranslator(key);
        const value = translator(key);

        const unpublishedCardContent = !branding.blackCard.enabled &&
          key.startsWith('blackCard.marketing.') &&
          !['blackCard.marketing.pageTitle', 'blackCard.marketing.informationOnlyNotice'].includes(key);
        if (!value.trim() && !unpublishedCardContent) {
          issues.push(`${locale}:${key}:empty`);
        }

        if (value === key) {
          issues.push(`${locale}:${key}:raw-key`);
        }

        if (
          placeholderNames(value).join(',') !==
          placeholderNames(sourceValue).join(',')
        ) {
          issues.push(`${locale}:${key}:placeholder-mismatch`);
        }

        if (locale === 'en' && /[\u3400-\u9fff]/u.test(value)) {
          issues.push(`${locale}:${key}:contains-han`);
        }
      }
    }

    expect(translationKeys.length).toBeGreaterThan(0);
    expect(issues).toEqual([]);
  });
});
