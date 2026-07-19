export type SpotRwaLogoCandidate = {
  symbol?: string | null;
  showSpotLogo?: boolean | null;
  spotLogoUrl?: string | null;
  spotLogoAlt?: string | null;
  assetType?: string | null;
  marketCategory?: string | null;
  marketSubCategory?: string | null;
  displayCategory?: string | null;
};

export type SpotRwaLogo = {
  url: string;
  alt: string | null;
};

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isRwaCategory(value: unknown): boolean {
  return String(value ?? '').trim().toUpperCase() === 'RWA';
}

export function resolveSpotRwaLogo(
  candidate: SpotRwaLogoCandidate | null | undefined,
  activeSymbol: string,
): SpotRwaLogo | null {
  if (!candidate?.showSpotLogo) return null;
  if (normalizeSymbol(candidate.symbol) !== normalizeSymbol(activeSymbol)) return null;

  const url = String(candidate.spotLogoUrl ?? '').trim();
  if (!url) return null;
  if (![
    candidate.assetType,
    candidate.marketCategory,
    candidate.marketSubCategory,
    candidate.displayCategory,
  ].some(isRwaCategory)) return null;

  return {
    url,
    alt: String(candidate.spotLogoAlt ?? '').trim() || null,
  };
}

export function renderSpotTradingViewLogo(
  slot: HTMLElement,
  params: {
    url?: string | null;
    alt?: string | null;
    displayName: string;
    getCurrentUrl: () => string;
  },
): HTMLImageElement | null {
  const url = String(params.url ?? '').trim();
  const alt = String(params.alt ?? '').trim();

  slot.replaceChildren();
  slot.style.display = url ? 'inline-flex' : 'none';
  if (!url) return null;

  const image = slot.ownerDocument.createElement('img');
  image.src = url;
  image.alt = alt || `${params.displayName} logo`;
  image.style.display = 'block';
  image.style.height = '64px';
  image.style.width = 'auto';
  image.style.maxWidth = '190px';
  image.style.objectFit = 'contain';
  image.addEventListener('error', () => {
    if (params.getCurrentUrl() === url && slot.contains(image)) {
      slot.style.display = 'none';
    }
  });
  slot.appendChild(image);
  return image;
}
