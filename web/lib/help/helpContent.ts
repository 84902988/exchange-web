import type { Language } from "@/utils/language";

export type LocalizedText = Partial<Record<Language, string>>;

export type HelpSection = {
  heading: LocalizedText;
  body?: LocalizedText[];
  steps?: LocalizedText[];
  bullets?: LocalizedText[];
};

export type HelpArticle = {
  id: string;
  slug: string;
  title: LocalizedText;
  summary: LocalizedText;
  sourceFiles?: string[];
  tags: string[];
  hot?: boolean;
  sections: HelpSection[];
};

export type HelpCategory = {
  id: string;
  title: LocalizedText;
  description: LocalizedText;
  articles: HelpArticle[];
};

const zh = (value: string): LocalizedText => ({ zh: value });

export function helpText(value: LocalizedText | undefined, locale: Language): string {
  if (!value) return "";
  return value[locale] || value.zh || value.en || value["zh-TW"] || value.ja || "";
}

export const helpCategories: HelpCategory[] = [
  {
    id: "account",
    title: zh("账户管理"),
    description: zh("注册、登录、密码、安全项和账户资料管理"),
    articles: [
      {
        id: "account-create",
        slug: "create-account",
        title: zh("如何注册账户"),
        summary: zh("使用邮箱创建账户、设置安全密码，并完成邮箱验证码验证。"),
        sourceFiles: ["如何注册账户.docx"],
        tags: ["注册", "账户", "邮箱"],
        hot: true,
        sections: [
          {
            heading: zh("注册流程"),
            steps: [
              zh("访问 Royal Exchange 官方网站，确认网址无误后点击注册。"),
              zh("输入有效邮箱，填写推荐码（如有），阅读并同意用户协议和隐私政策。"),
              zh("设置 8 至 32 位强密码，建议包含数字、大写字母和特殊字符。"),
              zh("输入邮箱收到的 6 位验证码，提交后完成注册。"),
            ],
          },
          {
            heading: zh("注册后建议"),
            bullets: [
              zh("尽快启用双因素认证（2FA）和资金密码。"),
              zh("不要与他人共享密码、验证码或账户资料。"),
              zh("如准备充值、提现或交易，请根据页面提示完成身份认证。"),
            ],
          },
        ],
      },
      {
        id: "account-login",
        slug: "login-account",
        title: zh("如何登录账户"),
        summary: zh("使用注册邮箱或手机号登录，并完成必要的安全验证。"),
        tags: ["登录", "账户"],
        hot: true,
        sections: [
          {
            heading: zh("登录步骤"),
            steps: [
              zh("打开 Royal Exchange 官方网站，点击登录。"),
              zh("输入注册邮箱或手机号以及账户密码。"),
              zh("如账户启用了 2FA、短信或邮箱验证，请按页面提示完成验证。"),
              zh("登录后可在用户中心查看账户、安全和资产相关功能。"),
            ],
          },
          {
            heading: zh("无法登录时"),
            bullets: [
              zh("确认访问的是官方域名，避免在可疑链接中输入账户信息。"),
              zh("如忘记密码，请使用找回密码流程。"),
              zh("如邮箱、手机号或多个安全项不可用，请参考账户恢复相关文章。"),
            ],
          },
        ],
      },
      {
        id: "account-reset-password",
        slug: "reset-password",
        title: zh("如何重置账户密码"),
        summary: zh("忘记密码或需要更新密码时，可通过邮箱、短信和 2FA 验证重置。"),
        sourceFiles: ["如何重置我的 Royal Exchange 帐户密码.docx", "如何修改我的 Royal Exchange 帐户密码.docx"],
        tags: ["密码", "重置", "安全"],
        hot: true,
        sections: [
          {
            heading: zh("重置密码"),
            steps: [
              zh("在登录页点击忘记密码，或直接进入密码重置页面。"),
              zh("输入注册邮箱或手机号，获取并填写验证码。"),
              zh("如已启用 Google Authenticator，请输入 6 位验证码。"),
              zh("设置新密码并再次确认，提交后完成重置。"),
            ],
          },
          {
            heading: zh("安全提示"),
            bullets: [
              zh("新密码应避免与其他网站重复使用。"),
              zh("重置密码后，提现和 C2C 等敏感功能可能会暂时限制 24 小时。"),
              zh("如果无法访问绑定邮箱或手机号，请先发起账户恢复。"),
            ],
          },
        ],
      },
      {
        id: "account-email-phone",
        slug: "change-email-phone",
        title: zh("如何修改邮箱或手机号"),
        summary: zh("账户邮箱或手机号变更需要完成安全验证，并可能触发短期提现限制。"),
        sourceFiles: ["如何更改我的 Royal Exchange 帐户的电子邮件地址.docx", "如何重置我的账户的手机号码.docx"],
        tags: ["邮箱", "手机号", "安全项"],
        sections: [
          {
            heading: zh("修改邮箱"),
            steps: [
              zh("进入账户安全设置，选择邮箱地址修改。"),
              zh("输入新的邮箱地址，并获取验证码。"),
              zh("完成当前邮箱、短信或 2FA 验证后确认修改。"),
            ],
          },
          {
            heading: zh("重置手机号"),
            steps: [
              zh("如当前手机号不可用，可在验证方式不可用入口选择手机号重置。"),
              zh("填写新的手机号并完成短信验证码验证。"),
              zh("根据页面提示确认重置请求。"),
            ],
          },
          {
            heading: zh("注意事项"),
            bullets: [
              zh("邮箱或手机号变更后，为保护资产安全，提现等功能可能暂停 24 小时。"),
              zh("同一邮箱或手机号通常只能绑定一个账户。"),
            ],
          },
        ],
      },
      {
        id: "account-funding-password",
        slug: "funding-password",
        title: zh("如何更改资金密码"),
        summary: zh("资金密码用于提现等敏感操作，建议与登录密码保持不同。"),
        sourceFiles: ["如何更改我的 Royal Exchange 账户的资金密码.docx"],
        tags: ["资金密码", "提现", "安全"],
        sections: [
          {
            heading: zh("更改或重置资金密码"),
            steps: [
              zh("进入安全中心，找到资金密码并点击修改。"),
              zh("输入新的资金密码，并再次确认。"),
              zh("完成当前资金密码、邮箱、短信或 2FA 验证。"),
              zh("提交后等待页面提示修改成功。"),
            ],
          },
          {
            heading: zh("密码要求"),
            bullets: [
              zh("建议使用 8 至 32 位字符。"),
              zh("包含数字、大写字母和特殊字符。"),
              zh("不要与登录密码、邮箱密码或其他平台密码重复。"),
            ],
          },
        ],
      },
      {
        id: "account-recovery",
        slug: "recover-inaccessible-account",
        title: zh("无法访问账户怎么办"),
        summary: zh("当邮箱、手机号或多个安全项不可用时，可提交账户恢复材料。"),
        sourceFiles: ["如何找回无法访问的 Royal Exchange 账户.docx", "当多个安全项丢失时.docx", "如何处理未收到验证邮件的情况.docx"],
        tags: ["账户恢复", "验证码", "安全项"],
        hot: true,
        sections: [
          {
            heading: zh("恢复前先检查"),
            bullets: [
              zh("确认邮箱地址或手机号填写正确。"),
              zh("检查垃圾邮件、广告邮件或短信拦截设置。"),
              zh("等待倒计时结束后尝试重新发送验证码。"),
            ],
          },
          {
            heading: zh("提交账户恢复"),
            steps: [
              zh("进入客服或自助服务入口，选择无法访问账户或重置安全项。"),
              zh("回答最近登录位置、设备、资产和交易活动等问题。"),
              zh("按要求上传身份证件、手持证件照片或充值/提现证明。"),
              zh("提交后等待客服审核，通常需要 1 至 3 个工作日。"),
            ],
          },
        ],
      },
      {
        id: "account-close",
        slug: "close-account",
        title: zh("如何注销账户"),
        summary: zh("注销账户是不可逆操作，请先处理资产、订单和安全事项。"),
        sourceFiles: ["如何注销我的 Royal Exchange 账户.docx"],
        tags: ["注销", "账户"],
        sections: [
          {
            heading: zh("注销前确认"),
            bullets: [
              zh("提取全部资产并确认没有待处理提现。"),
              zh("关闭所有未平仓位和未完成订单。"),
              zh("理解账户注销后登录、交易、API 和奖励等功能将停用。"),
            ],
          },
          {
            heading: zh("注销流程"),
            steps: [
              zh("进入用户中心或个人资料页面。"),
              zh("在页面底部找到注销账户入口。"),
              zh("阅读风险提示并勾选确认项。"),
              zh("完成密码和安全验证后提交注销请求。"),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "kyc",
    title: zh("身份认证 KYC"),
    description: zh("个人认证、企业认证、认证失败原因和材料要求"),
    articles: [
      {
        id: "kyc-overview",
        slug: "kyc-overview",
        title: zh("什么是 KYC 认证"),
        summary: zh("KYC 用于确认用户身份、满足合规要求，并保护账户与资产安全。"),
        sourceFiles: ["个人身份认证常见问题.docx"],
        tags: ["KYC", "身份认证", "合规"],
        hot: true,
        sections: [
          {
            heading: zh("为什么需要 KYC"),
            bullets: [
              zh("帮助平台识别用户身份并满足合规要求。"),
              zh("降低欺诈、洗钱和账户滥用风险。"),
              zh("解锁充值、交易、提现等核心功能。"),
            ],
          },
          {
            heading: zh("审核时间"),
            body: [
              zh("个人认证通常会在提交后尽快审核。若长时间未更新，请准备 UID 并联系在线客服。"),
            ],
          },
        ],
      },
      {
        id: "kyc-individual",
        slug: "complete-individual-kyc",
        title: zh("如何完成个人身份认证"),
        summary: zh("提交真实个人信息、有效身份证件和必要的人脸或视频验证。"),
        sourceFiles: ["如何完成 Royal Exchange 账户的身份认证.docx", "如何录制验证视频.docx"],
        tags: ["个人认证", "证件", "视频验证"],
        sections: [
          {
            heading: zh("认证步骤"),
            steps: [
              zh("进入用户中心的身份认证页面。"),
              zh("选择个人认证并填写与证件一致的身份信息。"),
              zh("上传清晰、完整、未过期的证件照片。"),
              zh("按页面提示完成自拍、人脸识别或验证视频。"),
              zh("提交后等待审核结果。"),
            ],
          },
          {
            heading: zh("录制验证视频时"),
            bullets: [
              zh("确保光线充足，脸部和证件信息清晰可见。"),
              zh("按照页面要求读出或展示指定内容。"),
              zh("不要遮挡脸部，不要裁剪或编辑视频。"),
            ],
          },
        ],
      },
      {
        id: "kyb-business",
        slug: "complete-business-kyb",
        title: zh("如何完成企业认证"),
        summary: zh("企业认证用于验证机构用户、授权人、董事和最终实益拥有人。"),
        sourceFiles: ["如何完成 Royal Exchange 账户的企业认证.docx", "KYB 常见问题.docx"],
        tags: ["KYB", "企业认证", "机构账户"],
        sections: [
          {
            heading: zh("企业认证流程"),
            steps: [
              zh("进入企业认证页面，选择最符合实际情况的组织类型。"),
              zh("填写企业基本信息、经营地址和联系人信息。"),
              zh("提交董事、授权人、最终实益拥有人等关联人员信息。"),
              zh("上传平台要求的企业文件和个人身份证明文件。"),
              zh("提交后等待审核，如需补充材料请按提示更新。"),
            ],
          },
          {
            heading: zh("角色说明"),
            bullets: [
              zh("董事通常是可代表实体签署或监督运营的人员。"),
              zh("最终实益拥有人通常指持有实体 25% 或以上权益或控制权的个人。"),
              zh("授权人是被企业授权代表账户执行操作的人员。"),
            ],
          },
        ],
      },
      {
        id: "kyb-documents",
        slug: "business-kyb-documents",
        title: zh("企业认证需要提交哪些文件"),
        summary: zh("不同组织类型的文件要求不同，常见材料包括注册、董事、股东和地址证明。"),
        sourceFiles: ["Royal Exchange 账户提交企业认证需要哪些文件.docx", "KYB 常见问题.docx"],
        tags: ["KYB", "文件", "企业"],
        sections: [
          {
            heading: zh("常见企业文件"),
            bullets: [
              zh("公司注册证书或同等法律文件。"),
              zh("近 12 个月内的公司查册报告、商业登记摘要或董事在职证明。"),
              zh("公司章程、组织大纲或同等章程文件。"),
              zh("最新股东名册、董事名册和所有权结构图。"),
              zh("董事、授权人、最终实益拥有人身份证件。"),
              zh("最终实益拥有人、控制人或企业经营地址的近期地址证明。"),
            ],
          },
          {
            heading: zh("提交建议"),
            bullets: [
              zh("以认证页面显示的组织类型要求为准。"),
              zh("确保文件清晰、完整、未过期，并包含最新董事和股东信息。"),
              zh("如果企业名称变更，请补充名称变更证明。"),
            ],
          },
        ],
      },
      {
        id: "kyc-failure",
        slug: "kyc-failure-reasons",
        title: zh("认证失败的常见原因"),
        summary: zh("信息不一致、文件质量低、证件过期或地区资格限制都可能导致认证失败。"),
        sourceFiles: ["身份认证失败的常见原因有哪些.docx"],
        tags: ["认证失败", "KYC", "文件"],
        hot: true,
        sections: [
          {
            heading: zh("常见失败原因"),
            bullets: [
              zh("姓名、出生日期、地址等信息与证件不一致。"),
              zh("证件照片模糊、裁剪、黑白或分辨率过低。"),
              zh("证件已过期，或仅提交了双面证件的一面。"),
              zh("自拍、人脸识别或验证视频不清晰。"),
              zh("年龄、地区或账户限制不符合认证要求。"),
            ],
          },
          {
            heading: zh("重新提交建议"),
            bullets: [
              zh("按证件原文准确填写个人信息。"),
              zh("使用高清彩色图片，并确保四个角完整可见。"),
              zh("在光线充足的环境完成自拍或视频验证。"),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "deposit-withdraw",
    title: zh("充值与提现"),
    description: zh("链上充值、提现、未到账处理、退款和账户划转"),
    articles: [
      {
        id: "deposit-crypto",
        slug: "deposit-crypto",
        title: zh("如何充值加密货币"),
        summary: zh("选择币种和网络，复制充值地址，从外部钱包或平台发起转账。"),
        sourceFiles: ["如何在 Royal Exchange 上充值加密货币.docx"],
        tags: ["充值", "链上", "网络"],
        hot: true,
        sections: [
          {
            heading: zh("充值步骤"),
            steps: [
              zh("进入资产页面并选择充值。"),
              zh("选择要充值的币种和对应网络。"),
              zh("复制充值地址或扫描二维码。"),
              zh("从外部钱包或平台向该地址转账。"),
              zh("等待区块链确认后，资金将显示在账户中。"),
            ],
          },
          {
            heading: zh("重要提醒"),
            bullets: [
              zh("币种和网络必须与转出平台一致。"),
              zh("部分币种可能需要 Memo、Tag 或备注，请按页面提示填写。"),
              zh("低于最小充值数量的转账可能无法入账。"),
            ],
          },
        ],
      },
      {
        id: "withdraw-crypto",
        slug: "withdraw-crypto",
        title: zh("如何提现加密货币"),
        summary: zh("填写提现地址、网络和数量，完成资金密码及验证码后提交。"),
        sourceFiles: ["如何从 Royal Exchange 提现加密货币.docx"],
        tags: ["提现", "链上", "资金密码"],
        hot: true,
        sections: [
          {
            heading: zh("提现步骤"),
            steps: [
              zh("进入资产页面并选择提现。"),
              zh("选择币种和提现网络。"),
              zh("填写提现地址、数量以及 Memo/Tag（如需要）。"),
              zh("确认手续费、到账数量和地址信息。"),
              zh("完成资金密码、邮箱、短信或 2FA 验证后提交。"),
            ],
          },
          {
            heading: zh("到账时间"),
            body: [
              zh("提现到账时间取决于平台审核、链上拥堵和目标网络确认速度。提交后可在提现记录中查看状态。"),
            ],
          },
        ],
      },
      {
        id: "deposit-refund",
        slug: "deposit-refund-uncredited",
        title: zh("如何处理充值未到账"),
        summary: zh("充值未到账时，先核对网络、地址、交易哈希和最小充值要求。"),
        sourceFiles: ["如何提交充值退款请求.docx"],
        tags: ["充值未到账", "退款", "TxID"],
        sections: [
          {
            heading: zh("先自查"),
            bullets: [
              zh("确认转账网络与充值页面网络一致。"),
              zh("确认地址、Memo 或 Tag 填写正确。"),
              zh("确认链上交易已成功并达到所需确认数。"),
              zh("确认充值金额不低于平台最小充值数量。"),
            ],
          },
          {
            heading: zh("提交处理请求"),
            steps: [
              zh("准备币种、网络、金额、交易哈希和转出平台截图。"),
              zh("在客服或充值记录页面提交未到账/退款请求。"),
              zh("等待平台核查链上记录和入账条件。"),
            ],
          },
        ],
      },
      {
        id: "network-selection",
        slug: "network-selection",
        title: zh("充值提现网络选择说明"),
        summary: zh("同一币种可能支持多个网络，错误网络可能导致资产无法找回。"),
        tags: ["网络", "充值", "提现"],
        sections: [
          {
            heading: zh("如何选择网络"),
            bullets: [
              zh("转出平台、钱包和 Royal Exchange 充值页面必须选择同一网络。"),
              zh("提现时请确认目标地址支持所选网络。"),
              zh("不同网络手续费和到账时间可能不同。"),
            ],
          },
          {
            heading: zh("风险提示"),
            body: [
              zh("如果选择了错误网络或遗漏 Memo/Tag，资产可能无法自动入账，甚至可能无法找回。提交前请逐项核对。"),
            ],
          },
        ],
      },
      {
        id: "internal-transfer",
        slug: "internal-transfer",
        title: zh("如何进行内部转账和账户划转"),
        summary: zh("在账户之间划转资产，或向平台内其他用户发起内部转账。"),
        sourceFiles: ["如何在 Royal Exchange 上进行内部转账.docx", "如何在 Royal Exchange 账户之间划转资产.docx"],
        tags: ["划转", "内部转账", "资产"],
        sections: [
          {
            heading: zh("账户划转"),
            steps: [
              zh("进入资产页面，选择划转。"),
              zh("选择转出账户、转入账户、币种和数量。"),
              zh("确认无误后提交，划转通常会即时完成。"),
            ],
          },
          {
            heading: zh("内部转账"),
            bullets: [
              zh("仅向确认无误的平台内账户信息转账。"),
              zh("提交前核对收款 UID、邮箱或手机号等识别信息。"),
              zh("如页面提示需要验证，请完成资金密码和验证码。"),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "trading",
    title: zh("交易指南"),
    description: zh("现货、合约、订单类型、费用、点差、强平和止盈止损"),
    articles: [
      {
        id: "spot-trading",
        slug: "spot-trading",
        title: zh("如何进行现货交易"),
        summary: zh("现货交易是在交易对市场中直接买入或卖出数字资产。"),
        tags: ["现货", "交易"],
        hot: true,
        sections: [
          {
            heading: zh("基本流程"),
            steps: [
              zh("完成账户登录、必要的身份认证和资金充值。"),
              zh("进入现货交易页面，选择交易对。"),
              zh("选择限价单或市价单，填写价格、数量或金额。"),
              zh("确认订单信息后提交，并在订单或成交记录中查看结果。"),
            ],
          },
          {
            heading: zh("交易前检查"),
            bullets: [
              zh("确认账户余额、交易对、价格和数量。"),
              zh("了解手续费和最小下单数量。"),
              zh("避免在网络不稳定时重复提交订单。"),
            ],
          },
        ],
      },
      {
        id: "contract-trading",
        slug: "contract-trading",
        title: zh("如何进行合约交易"),
        summary: zh("合约交易允许用户基于标的价格变化进行多空交易，风险高于现货。"),
        sourceFiles: ["合约服务协议.docx"],
        tags: ["合约", "杠杆", "风险"],
        hot: true,
        sections: [
          {
            heading: zh("开始前"),
            bullets: [
              zh("确认已了解合约产品规则、保证金、杠杆和强平风险。"),
              zh("将资金划转到合约账户。"),
              zh("选择合约品种、方向、杠杆和订单类型。"),
            ],
          },
          {
            heading: zh("下单流程"),
            steps: [
              zh("选择开多或开空。"),
              zh("选择市价单或限价单，并填写数量和价格。"),
              zh("检查预估保证金、手续费、止盈止损和风险提示。"),
              zh("提交后在持仓、委托和成交记录中跟踪订单。"),
            ],
          },
        ],
      },
      {
        id: "order-types",
        slug: "order-types",
        title: zh("限价单和市价单说明"),
        summary: zh("市价单追求立即成交，限价单按指定价格或更优价格成交。"),
        tags: ["限价单", "市价单", "订单"],
        sections: [
          {
            heading: zh("市价单"),
            body: [
              zh("市价单会按当前市场可成交价格立即买入或卖出，适合追求成交速度的场景。市场波动或盘口深度不足时，最终成交价可能与预期有差异。"),
            ],
          },
          {
            heading: zh("限价单"),
            body: [
              zh("限价单会按您设置的价格或更优价格成交。若市场未达到该价格，订单可能保持未成交或部分成交。"),
            ],
          },
        ],
      },
      {
        id: "spread",
        slug: "spread",
        title: zh("什么是点差"),
        summary: zh("点差通常指买一价和卖一价之间的差额，可能影响实际交易成本。"),
        tags: ["点差", "价格", "成本"],
        sections: [
          {
            heading: zh("点差如何影响交易"),
            body: [
              zh("买入通常参考卖方报价，卖出通常参考买方报价。买卖报价之间的差额就是自然市场点差。"),
              zh("部分合约品种还可能根据平台规则叠加固定点差加点，最终以交易页面、订单确认和成交记录展示为准。"),
            ],
          },
          {
            heading: zh("查看建议"),
            bullets: [
              zh("下单前关注买一、卖一、盘口深度和预估成交价格。"),
              zh("市场波动较大或流动性不足时，点差和滑点可能扩大。"),
            ],
          },
        ],
      },
      {
        id: "liquidation",
        slug: "liquidation",
        title: zh("什么是强平"),
        summary: zh("当账户保证金不足以维持持仓风险要求时，系统可能触发强制平仓。"),
        tags: ["强平", "保证金", "合约"],
        sections: [
          {
            heading: zh("强平原因"),
            bullets: [
              zh("价格向持仓不利方向大幅波动。"),
              zh("杠杆过高导致保证金缓冲不足。"),
              zh("未及时补充保证金或降低仓位。"),
            ],
          },
          {
            heading: zh("如何降低风险"),
            bullets: [
              zh("合理使用杠杆，不要满仓交易。"),
              zh("关注保证金率、预估强平价和市场波动。"),
              zh("使用止损或主动减仓控制风险。"),
            ],
          },
        ],
      },
      {
        id: "take-profit-stop-loss",
        slug: "take-profit-stop-loss",
        title: zh("如何设置止盈止损"),
        summary: zh("止盈止损用于在价格达到预设条件时帮助管理盈利和亏损。"),
        tags: ["止盈", "止损", "合约"],
        sections: [
          {
            heading: zh("设置方式"),
            steps: [
              zh("在下单面板或持仓区域找到止盈止损设置。"),
              zh("选择触发价格类型，并填写止盈价或止损价。"),
              zh("确认触发后执行方式、数量和价格规则。"),
              zh("保存后在持仓或委托记录中查看。"),
            ],
          },
          {
            heading: zh("注意事项"),
            bullets: [
              zh("止盈止损不保证最终成交价等于触发价。"),
              zh("行情剧烈波动时可能出现滑点或部分成交。"),
            ],
          },
        ],
      },
      {
        id: "trading-fees",
        slug: "trading-fees",
        title: zh("交易手续费说明"),
        summary: zh("手续费取决于产品类型、用户等级、订单方向和最终成交记录。"),
        tags: ["手续费", "费用", "交易"],
        sections: [
          {
            heading: zh("费用查看"),
            bullets: [
              zh("下单前查看订单确认区的预估费用。"),
              zh("成交后以订单记录、成交记录或资产流水为准。"),
              zh("不同产品、账户等级或活动规则可能对应不同费率。"),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "security",
    title: zh("安全中心"),
    description: zh("防钓鱼、官方渠道验证、诈骗处置和账户安全习惯"),
    articles: [
      {
        id: "phishing",
        slug: "avoid-phishing",
        title: zh("如何识别钓鱼网站"),
        summary: zh("钓鱼攻击会伪装成官方邮件、短信、网站或客服来窃取信息。"),
        sourceFiles: ["什么是网络钓鱼以及如何防范.docx"],
        tags: ["钓鱼", "安全", "诈骗"],
        hot: true,
        sections: [
          {
            heading: zh("常见特征"),
            bullets: [
              zh("制造紧急感，要求立即登录、转账或提供验证码。"),
              zh("发件地址、域名或链接与官方渠道不一致。"),
              zh("包含异常附件、短链接或拼写错误。"),
              zh("主动索要密码、验证码、私钥或财务信息。"),
            ],
          },
          {
            heading: zh("防范方式"),
            bullets: [
              zh("手动输入官方域名访问网站。"),
              zh("开启 2FA 和反钓鱼码。"),
              zh("不要点击来源不明的链接或下载未知附件。"),
            ],
          },
        ],
      },
      {
        id: "official-channel",
        slug: "verify-official-channel",
        title: zh("官方渠道验证"),
        summary: zh("通过官方验证工具核查网站、邮箱或社媒账号是否属于 Royal Exchange。"),
        sourceFiles: ["如何验证 Royal Exchange 官方渠道并举报可疑链接.docx"],
        tags: ["官方渠道", "举报", "验证"],
        sections: [
          {
            heading: zh("验证方式"),
            steps: [
              zh("打开 Royal Exchange 官方验证工具。"),
              zh("选择需要验证的信息类型，例如网页、邮箱或社媒账号。"),
              zh("输入链接、邮箱或用户名并点击搜索。"),
              zh("根据结果判断是否为官方渠道。"),
            ],
          },
          {
            heading: zh("举报可疑链接"),
            bullets: [
              zh("如果结果显示非官方渠道，请上传截图或相关证据。"),
              zh("提交后安全团队会进行调查和处理。"),
            ],
          },
        ],
      },
      {
        id: "scam-response",
        slug: "scam-response",
        title: zh("如果上当受骗该怎么办"),
        summary: zh("发现被骗后应立即保护账户、保留证据并联系平台支持。"),
        sourceFiles: ["如果上当受骗.docx"],
        tags: ["诈骗", "账户安全", "应急"],
        hot: true,
        sections: [
          {
            heading: zh("立即采取行动"),
            steps: [
              zh("更改 Royal Exchange 密码，并确保密码足够强。"),
              zh("启用或重置 2FA，移除未知登录设备。"),
              zh("保护绑定邮箱和其他相关钱包或平台账户。"),
              zh("保存聊天记录、链接、交易哈希和截图等证据。"),
              zh("尽快联系 Royal Exchange 支持团队。"),
            ],
          },
          {
            heading: zh("危险信号"),
            bullets: [
              zh("承诺保本或保证收益。"),
              zh("要求提供验证码、私钥或远程控制设备。"),
              zh("声称账户有风险并要求转账到安全地址。"),
            ],
          },
        ],
      },
      {
        id: "protect-account",
        slug: "protect-account",
        title: zh("如何保护账户安全"),
        summary: zh("使用强密码、2FA、设备管理和官方渠道验证降低账户风险。"),
        tags: ["账户安全", "2FA", "设备"],
        sections: [
          {
            heading: zh("安全清单"),
            bullets: [
              zh("使用独立且高强度的登录密码和资金密码。"),
              zh("启用 Google Authenticator、短信或邮箱等安全验证。"),
              zh("定期检查登录设备和账户活动。"),
              zh("不要在公共设备或不可信网络中登录。"),
              zh("遇到可疑信息先通过官方渠道验证。"),
            ],
          },
        ],
      },
      {
        id: "private-key",
        slug: "private-key-seed-security",
        title: zh("如何保护助记词和私钥"),
        summary: zh("助记词和私钥一旦泄露，链上资产可能被不可逆转移。"),
        tags: ["私钥", "助记词", "钱包"],
        sections: [
          {
            heading: zh("保护原则"),
            bullets: [
              zh("不要向任何人提供助记词、私钥或钱包签名权限。"),
              zh("不要把助记词保存在截图、聊天软件或云盘中。"),
              zh("确认钱包授权对象和签名内容，避免授权可疑合约。"),
              zh("如怀疑泄露，请尽快将资产转移到新的安全钱包。"),
            ],
          },
        ],
      },
    ],
  },
  {
    id: "policies",
    title: zh("平台政策"),
    description: zh("隐私、服务条款、合约协议、免责声明和风险提示"),
    articles: [
      {
        id: "privacy",
        slug: "privacy-statement",
        title: zh("隐私声明"),
        summary: zh("说明平台如何收集、使用、保存、披露和保护个人数据。"),
        sourceFiles: ["Royal Exchange 隐私声明.docx"],
        tags: ["隐私", "数据", "政策"],
        sections: [
          {
            heading: zh("主要内容"),
            bullets: [
              zh("平台会根据适用法律处理身份、联系、财务、交易、技术和账户资料等数据。"),
              zh("数据处理目的包括提供服务、账户安全、合规审查、风险控制、客户支持和产品优化。"),
              zh("用户可根据适用法律对个人数据提出访问、更正、删除或限制处理等请求。"),
            ],
          },
          {
            heading: zh("说明"),
            body: [
              zh("帮助中心仅展示隐私声明摘要。正式法律文本应以后续独立政策页或后台 CMS 发布内容为准。"),
            ],
          },
        ],
      },
      {
        id: "terms",
        slug: "terms-of-use",
        title: zh("用户协议和服务条款"),
        summary: zh("使用平台服务即表示用户同意遵守服务条款、产品规则和适用政策。"),
        sourceFiles: ["使用条款.docx"],
        tags: ["条款", "用户协议", "政策"],
        sections: [
          {
            heading: zh("条款范围"),
            bullets: [
              zh("规范用户访问平台和使用服务的权利、义务与限制。"),
              zh("包括账户管理、交易、费用、风险披露、服务变更和责任限制等内容。"),
              zh("平台可能根据业务或法律要求更新条款。"),
            ],
          },
          {
            heading: zh("风险提示"),
            body: [
              zh("数字资产价格波动较大，用户应根据自身财务状况和风险承受能力独立判断。"),
            ],
          },
        ],
      },
      {
        id: "contract-agreement",
        slug: "contract-service-agreement",
        title: zh("合约服务协议"),
        summary: zh("合约产品涉及杠杆、保证金、强平和市场波动风险，使用前应充分理解规则。"),
        sourceFiles: ["合约服务协议.docx"],
        tags: ["合约", "协议", "风险"],
        sections: [
          {
            heading: zh("核心风险"),
            bullets: [
              zh("合约交易可能因杠杆放大收益和亏损。"),
              zh("行情剧烈波动、流动性不足或系统规则可能影响成交和持仓。"),
              zh("保证金不足时可能触发强制平仓。"),
            ],
          },
          {
            heading: zh("使用建议"),
            bullets: [
              zh("开始交易前阅读产品规则和风险披露。"),
              zh("控制杠杆和仓位，设置止盈止损。"),
              zh("不要使用无法承受损失的资金进行高风险交易。"),
            ],
          },
        ],
      },
      {
        id: "risk-warning",
        slug: "risk-warning",
        title: zh("风险提示和免责声明"),
        summary: zh("平台信息不构成投资建议，用户应独立评估交易风险。"),
        sourceFiles: ["使用条款.docx", "合约服务协议.docx"],
        tags: ["风险", "免责声明"],
        hot: true,
        sections: [
          {
            heading: zh("风险提示"),
            bullets: [
              zh("数字资产和衍生品价格可能大幅波动。"),
              zh("部分市场活动可能受到监管、流动性或外部事件影响。"),
              zh("平台展示的信息不应被视为金融、投资或税务建议。"),
            ],
          },
          {
            heading: zh("用户责任"),
            body: [
              zh("用户应自行判断产品是否适合自身情况，并对交易决策和结果负责。"),
            ],
          },
        ],
      },
    ],
  },
];

export const helpQuickEntries = [
  { label: zh("账户安全"), articleId: "protect-account" },
  { label: zh("充值未到账"), articleId: "deposit-refund" },
  { label: zh("身份认证失败"), articleId: "kyc-failure" },
  { label: zh("合约风险"), articleId: "contract-agreement" },
];

export function flattenHelpArticles(categories = helpCategories): Array<HelpArticle & { categoryId: string; categoryTitle: LocalizedText }> {
  return categories.flatMap((category) =>
    category.articles.map((article) => ({
      ...article,
      categoryId: category.id,
      categoryTitle: category.title,
    })),
  );
}
