// 集中类型定义文件

// 语言相关类型
import { Language as MenuLanguage, MegaMenu, MenuItem, NavMenuConfig, TranslatedLabel } from '@/config/menuConfig';

// API相关类型
import { 
  ApiResponse, 
  ApiError,
  AssetOverview as ApiAssetOverview,
  Asset as ApiAsset,
  AssetListResponse,
  FuturesAccountOverview,
  FuturesPosition,
  FuturesOrder,
  FuturesSymbol,
  SpotOrder,
  UserInfo,
  FinanceAccount,
  FinanceProduct,
  FinanceProductListResponse
} from '@/lib/api';

// 语言变化事件类型
export type LanguageChangedEvent = CustomEvent<Language>;

// 重新导出语言相关类型
export type Language = MenuLanguage;
export type { MegaMenu, MenuItem, NavMenuConfig, TranslatedLabel };

// 重新导出API相关类型
export type {
  ApiResponse,
  ApiError,
  ApiAssetOverview,
  ApiAsset,
  AssetListResponse,
  FuturesAccountOverview,
  FuturesPosition,
  FuturesOrder,
  FuturesSymbol,
  SpotOrder,
  UserInfo,
  FinanceAccount,
  FinanceProduct,
  FinanceProductListResponse
};

// 表单相关类型
export interface LoginFormData {
  emailOrPhone: string;
  password: string;
  captchaCode?: string;
  rememberMe?: boolean;
}

export interface RegisterFormData {
  emailOrPhone: string;
  password: string;
  confirmPassword: string;
  captcha: string;
  agreeTerms: boolean;
}

export interface ForgotPasswordFormData {
  emailOrPhone: string;
  captcha: string;
  password: string;
  confirmPassword: string;
}

export interface PasswordStrength {
  valid: boolean;
  hasLowercase: boolean;
  hasUppercase: boolean;
  hasNumber: boolean;
  hasSpecialChar: boolean;
  lengthValid: boolean;
}

// KYC相关类型
export interface KycStep {
  id: number;
  title: TranslatedLabel;
  description: TranslatedLabel;
  status: 0 | 1 | 2; // 0: 未开始, 1: 进行中, 2: 已完成
}

export interface KycStatus {
  isCompleted: boolean;
  steps: KycStep[];
}

// 资产相关类型
export interface AssetTableProps {

  isLoading: boolean;
  onRecharge: (symbol: string) => void;
  onWithdraw: (symbol: string) => void;
  currentLanguage: Language;
}

export interface AssetOverviewProps {

  isLoading: boolean;
  currentLanguage: Language;
}

// 布局相关类型
export type HeaderProps = Record<string, never>;

export type FooterProps = Record<string, never>;

export type MegaMenuProps = Record<string, never>;

// 首页组件相关类型
export type HomeHeroProps = Record<string, never>;

export type HomeNoticeProps = Record<string, never>;

export interface PromoCard {
  id: string;
  title: TranslatedLabel;
  description: TranslatedLabel;
  image: string;
  link: string;
}

export interface PromoCardsProps {
  cards: PromoCard[];
  isLoading: boolean;
  currentLanguage: Language;
}
