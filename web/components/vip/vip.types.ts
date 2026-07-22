export type VipSystemType = "VIP" | "SVIP";

export interface VipHeroContent {
  eyebrow: string;
  title: string;
  description: string;
  highlights: (string | { title: string; description: string })[];
}

export type VipLevelCondition = {
  min_30d_volume: string | null;
  min_rcb_hold: string | null;
  min_lock_amount: string | null;
  lock_period_days: number | null;
  user_limit: number | null;
  dividend_rate: string | null;
};

export type VipLevelItem = {
  level_code: string;
  level_name: string;
  sort_order: number;
  spot_maker_fee: string;
  spot_taker_fee: string;
  contract_maker_fee: string | null;
  contract_taker_fee: string | null;
  rcb_discount_rate: string | null;
  condition: VipLevelCondition;
};

export type VipUserSummary = {
  vip_level_code: string | null;
  svip_level_code: string | null;
  effective_level_code: string | null;
  effective_fee_source: string | null;
  effective_spot_maker_fee: string | null;
  effective_spot_taker_fee: string | null;
  volume_30d: string | null;
  rcb_available: string | null;
  rcb_funding_available: string | null;
  rcb_locked: string | null;
  rcb_lock_period_days: number | null;
};

export type VipAuthState = "anonymous" | "authenticated" | "expired";

export type VipOverviewResponse = {
  vip_levels: VipLevelItem[];
  svip_levels: VipLevelItem[];
  user_summary: VipUserSummary;
  auth_state: VipAuthState;
  rcb_fee_pay_percent?: string | null;
  rcb_discount_percent: string | null;
};

export interface VipOverviewMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface VipOverviewPanelData {
  type: VipSystemType;
  title: string;
  subtitle: string;
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  metrics: VipOverviewMetric[];
}

export interface VipRuleItem {
  title: string;
  description: string;
}

// Compatibility export so the legacy mock file can remain in-tree
// without affecting the new API-driven VIP page.
export type VipPageMockData = unknown;
