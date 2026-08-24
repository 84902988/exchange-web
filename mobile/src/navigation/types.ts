import type { NavigatorScreenParams } from '@react-navigation/native';

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ResetPassword: undefined;
};

export type MarketRouteCategory = 'crypto' | 'stock' | 'cfd';

export type TradingRouteParams = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  displayLabel: string;
  logoUrl?: string | null;
};

export type ContractTradingRouteParams = TradingRouteParams & {
  marketCategory?: Extract<MarketRouteCategory, 'crypto' | 'stock' | 'cfd'>;
};

export type MarketDetailInitialKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketDetailReferencePriceLine = {
  key: string;
  kind: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
  label: string;
  price: number;
};

type MarketDetailPreviewParams = {
  initialInterval?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  initialKlines?: MarketDetailInitialKline[];
  referencePriceLines?: MarketDetailReferencePriceLine[];
};

export type MarketDetailRouteParams =
  | (TradingRouteParams & MarketDetailPreviewParams & {
      market: 'spot';
    })
  | (ContractTradingRouteParams & MarketDetailPreviewParams & {
      market: 'contract';
    });

export type MainTabParamList = {
  Home: undefined;
  Markets: { category?: MarketRouteCategory } | undefined;
  Trade: TradingRouteParams | undefined;
  Contract: ContractTradingRouteParams | undefined;
  Assets:
    | { section?: 'overview' | 'spot' | 'contract' | 'invite' | 'bd' }
    | undefined;
};

export type RootStackParamList = {
  Splash: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Auth: NavigatorScreenParams<AuthStackParamList> | undefined;
  AssetDeposit: undefined;
  AssetWithdraw: undefined;
  AssetUserTransfer: undefined;
  AssetTransfer: undefined;
  UserTransferRecords: undefined;
  AssetHistory:
    | {
        initialFilter?:
          | 'all'
          | 'deposit'
          | 'withdraw'
          | 'userTransfer'
          | 'transfer'
          | 'trade'
          | 'tradeFee'
          | 'dividend'
          | 'bdCommission'
          | 'inviteReward';
      }
    | undefined;
  StockTokenCenter: undefined;
  Account: undefined;
  ProfileEdit: undefined;
  AccountSecurity: undefined;
  EmailSecurity: undefined;
  ChangePassword: undefined;
  LoginActivity: undefined;
  SecurityEvents: undefined;
  SessionManagement: undefined;
  Kyc: undefined;
  DividendCenter: undefined;
  HomeMessageCenter: { initialTab?: 'announcements' | 'support' } | undefined;
  SupportTicketCreate: undefined;
  SupportTicketDetail: { ticketId: number };
  VipCenter: undefined;
  BlackCard: undefined;
  RcbLock: undefined;
  LegalPage: { pageKey: 'terms' | 'privacy' | 'risk' };
  MarketDetail: MarketDetailRouteParams;
  MobileAnnouncementDetail: { announcementId: string; title: string };
  AnnouncementCenter: undefined;
  ActivityCenter: undefined;
  ActivityDetail: { activityId: number; title: string };
  HelpCenter: undefined;
  HelpArticle: { articleId: string; title: string };
  AboutPage: undefined;
  LanguageSettings: undefined;
};
