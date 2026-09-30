import type {Language} from '@/utils/language';

const copy = {
  en: {
    title: 'Confirmation pending',
    message: 'The verification result is not yet confirmed. Refresh the original withdrawal request before creating another.',
    refresh: 'Refresh request status',
  },
  zh: {
    title: '状态待确认',
    message: '暂时无法确认验证结果，请刷新原提现申请的状态。请勿重复创建提现。',
    refresh: '刷新申请状态',
  },
  'zh-TW': {
    title: '狀態待確認',
    message: '暫時無法確認驗證結果，請重新整理原提現申請的狀態。請勿重複建立提現。',
    refresh: '重新整理申請狀態',
  },
  ja: {
    title: '確認待ち',
    message: '確認結果を取得できません。新しい出金を作成せず、元の申請の状態を更新してください。',
    refresh: '申請状況を更新',
  },
};

export const getWithdrawConfirmationCopy = (language?: Language) => copy[language ?? 'en'] ?? copy.en;
