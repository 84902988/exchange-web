import configuration from './branding.json';

export type BrandingConfiguration = {
  displayName: string;
  supportEmail: string;
  complianceLicenses: Array<{title: string; subtitle: string}>;
  legacyLocaleStorageKeys: string[];
  legacyFavoritesStorageKeys: string[];
  blackCard: {enabled: boolean; supportEmail: string; backgroundUrl: string; imageUrl: string};
  blackCardTranslations: Record<string, Record<string, string>>;
};

// Replace the neutral JSON with an external profile in an isolated delivery build.
export const branding: BrandingConfiguration = configuration;
