# Chain Capabilities V1

## 1. 当前设计目标

链能力管理 V1 的目标是把“后台配置”和“真实链上能力”分开。

后台可以维护网络、币种网络关系、合约地址、确认数、风控阈值等配置；但充值、提现、归集、补 Gas 等涉及资金的能力，必须由系统代码白名单确认已经接入后，才能对用户开放。

这能避免管理员只打开数据库开关，就把尚未接入监听、发送、确认的钱包网络暴露到用户端。

## 2. 当前能力状态

当前代码白名单状态：

| chain_key | runtime_status | 说明 |
| --- | --- | --- |
| bsc | READY | 已接入充值地址、充值监听、提现发送、提现确认、归集、补 Gas |
| polygon | READY | 已接入充值地址、充值监听、提现发送、提现确认、归集、补 Gas |
| tron | CONFIG_ONLY | 仅允许后台配置，不允许开放充值/提现 |
| ethereum | CONFIG_ONLY | 仅允许后台配置，不允许开放充值/提现 |
| solana | CONFIG_ONLY | 仅允许后台配置，不允许开放充值/提现 |
| optimism | CONFIG_ONLY | 仅允许后台配置，不允许开放充值/提现 |
| avaxc | CONFIG_ONLY | Avalanche C-Chain 已完成代码配置预接入，待链上小额验收；当前不允许开放充值/提现 |

未列出的 chain_key 默认也是 CONFIG_ONLY，真实链上能力全部视为未接入。

## 3. Options 过滤规则

用户端充值/提现 options 不只看数据库开关，还会看代码能力白名单。

充值 options 必须同时满足：

- asset enabled
- chain enabled
- asset_chain enabled
- asset_chain.deposit_enabled = 1
- deposit_address_supported = true
- deposit_watch_supported = true

提现 options 必须同时满足：

- asset enabled
- chain enabled
- asset_chain enabled
- asset_chain.withdraw_enabled = 1
- withdraw_send_supported = true
- withdraw_confirm_supported = true

因此，即使 TRON、Ethereum、Solana、Optimism、Avalanche 在数据库中被误开了 deposit_enabled 或 withdraw_enabled，只要代码能力仍是 CONFIG_ONLY，就不会暴露给用户端 options。

## 4. 后台保存校验规则

币种-网络配置保存时会在 service 层做强校验。

开启充值时，当前 chain_key 必须支持：

- deposit_address_supported
- deposit_watch_supported

否则保存失败，不写库，不提交事务。

开启提现时，当前 chain_key 必须支持：

- withdraw_send_supported
- withdraw_confirm_supported

否则保存失败，不写库，不提交事务。

CONFIG_ONLY 链仍允许保存基础配置，例如 contract_address、decimals、confirmations、explorer_tx_url、min_deposit、min_withdraw、风控阈值、enabled 等，但不能开启充值或提现。

## 5. hot_wallet_address / collection_address 真实用途

hot_wallet_address 是可选安全校验地址，不是私钥来源。

真实提现签名使用环境变量 HOT_WALLET_PRIVATE_KEY 派生的钱包地址。若后台填写 hot_wallet_address，系统会校验它必须与私钥派生地址一致，用来降低误配热钱包的风险。

collection_address 是归集目标地址，仅在该链已接入归集能力时生效，不参与用户提现打款。

填写 collection_address 不代表该链已支持归集；是否支持归集由代码能力白名单决定。

## 6. 后续新增链的接入步骤

新增链不能只加数据库配置。至少需要完成以下验收：

1. 在链能力白名单中定义 chain_key、chain_family、runtime_status 和具体能力。
2. 接入或确认充值地址生成逻辑。
3. 接入或确认充值监听逻辑，并能正确识别 chain_key、合约地址、确认状态。
4. 接入或确认提现发送逻辑，包括签名、nonce、gas、广播、失败处理。
5. 接入或确认 tx 确认逻辑，包括 RPC、确认数、成功/失败状态映射。
6. 如需归集，接入归集发送、补 Gas、归集 tx 确认。
7. 完成测试环境真实链路验收。
8. 最后再把 runtime_status 改为 READY，并允许后台开启充值/提现。

EVM 链可以复用部分 Web3 能力，但仍需要逐项验收 RPC、chain_id、gas、确认数、监听 provider、合约精度和热钱包地址校验。

非 EVM 链必须单独接入对应 SDK、地址格式、签名、广播、确认和归集逻辑。

## 6.1 Avalanche C-Chain 预接入状态

`avaxc` 当前状态仍是 CONFIG_ONLY。

已完成：

- `chain_config.py` 增加 Avalanche C-Chain 基础配置，chain_id = 43114。
- EVM 地址派生 allowlist 增加 `avaxc`，使用独立 chain offset。
- Moralis Stream 配置预留 `MORALIS_STREAM_ID_AVAXC`。
- webhook 增加 Avalanche C-Chain 的 chain / chainId 识别。
- 提现手续费预估增加 `avaxc` RPC 与 AVAX 价格 env 映射。

未完成：

- 真实充值监听小额验收。
- 提现发送小额验收。
- tx watcher 确认验收。
- 归集与补 Gas 验收。

READY 条件：

- 完成小额充值、提现、确认、归集全链路验收。
- 确认 USDT 合约地址、decimals、确认数、RPC 稳定性、Moralis payload 和热钱包地址校验。
- 验收通过后，才允许修改 `chain_capabilities.py`，把 `avaxc` 从 CONFIG_ONLY 提升为 READY。

## 6.2 Avalanche C-Chain Step 2 后台配置准备

`avaxc` Step 2 只做后台配置与只读验收准备，不代表已开放用户充值/提现。

准备内容：

- `chains` 中准备 `avaxc` 网络配置：Avalanche C-Chain、chain_id = 43114、native_symbol = AVAX、confirmations = 12、explorer_tx_url = `https://snowtrace.io/tx/{tx}`。
- `asset_chains` 中准备 USDT + avaxc 绑定。
- `deposit_enabled` 必须保持 0。
- `withdraw_enabled` 必须保持 0。
- Avalanche C-Chain 仅支持原生 USDT，不支持 USDT.e。
- 原生 USDT ERC20 合约地址为 `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7`。

辅助脚本：

- `backend/scripts/prepare_avaxc_config.py`：幂等准备 `chains` 和 USDT `asset_chains` 配置；缺少 USDT asset 时直接失败，不自动创建资产；通过 `AVAXC_USDT_CONTRACT_ADDRESS` 写入已确认的原生 USDT 合约地址。
- `backend/scripts/check_avaxc_db_config.py`：只读检查 `avaxc` 后台配置、安全开关和 CONFIG_ONLY 状态。

进入小额充值监听验收前必须满足：

- `check_avaxc_db_config.py` 检查通过，且 contract_address 为 Avalanche C-Chain 原生 USDT 地址。
- `/asset/deposit/options` 不出现 avaxc。
- `/asset/withdraw/options` 不出现 avaxc。
- `chain_capabilities.py` 中 `avaxc` 仍保持 CONFIG_ONLY。

## 6.3 Avalanche C-Chain 小额充值验收模式

小额充值验收阶段仍不开放普通用户充值。

必须保持：

- `asset_chains.deposit_enabled = 0`
- `asset_chains.withdraw_enabled = 0`
- `chain_capabilities.py` 中 `avaxc` 仍为 CONFIG_ONLY
- `/asset/deposit/options` 不出现 avaxc
- `/asset/withdraw/options` 不出现 avaxc

内部入账验收可通过环境变量开启：

```text
AVAXC_INTERNAL_DEPOSIT_TEST_ENABLED=true
AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS=100000001
```

该模式只允许满足以下条件的 webhook 绕过 `deposit_enabled=0`：

- chain_key 必须是 `avaxc`
- user_id 必须在 `AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS` allowlist 中
- contract_address 必须是 Avalanche C-Chain 原生 USDT：`0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7`
- asset、chain、asset_chain 都必须 enabled

该模式只用于内部小额入账验收；验收完成前不允许对普通用户开放。

## 7. 禁止事项

- 不能只打开 DB 开关就开放用户充值/提现。
- 不能在监听、发送、确认未验收前开放提现。
- 不能把 CONFIG_ONLY 链暴露给用户端 options。
- 非 EVM 链不能复用 EVM sender、EVM 地址派生或 Web3 ERC20 逻辑。
- hot_wallet_address 不能被当作私钥来源。
- collection_address 不能被当作用户提现打款地址。
