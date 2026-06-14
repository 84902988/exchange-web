-- Ethereum mainnet ETH-1 seed.
-- Opens USDT deposits only; withdrawals remain closed.

INSERT INTO chains
  (chain_key, name, chain_id, native_symbol, confirmations, explorer_tx_url, enabled, created_at, updated_at)
VALUES
  ('ethereum', 'Ethereum', 1, 'ETH', 12, 'https://etherscan.io/tx/{tx}', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  chain_id = VALUES(chain_id),
  native_symbol = VALUES(native_symbol),
  confirmations = VALUES(confirmations),
  explorer_tx_url = VALUES(explorer_tx_url),
  enabled = VALUES(enabled),
  updated_at = UTC_TIMESTAMP(3);

INSERT INTO asset_chains
  (asset_id, chain_id, contract_address, decimals, enabled, deposit_enabled, withdraw_enabled,
   min_deposit, min_withdraw, confirmations, sort, created_at, updated_at)
SELECT
  a.id,
  c.id,
  '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  6,
  1,
  1,
  0,
  0,
  0,
  12,
  100,
  UTC_TIMESTAMP(3),
  UTC_TIMESTAMP(3)
FROM assets a
JOIN chains c ON c.chain_key = 'ethereum'
WHERE UPPER(a.symbol) = 'USDT'
ON DUPLICATE KEY UPDATE
  contract_address = VALUES(contract_address),
  decimals = VALUES(decimals),
  enabled = VALUES(enabled),
  deposit_enabled = 1,
  withdraw_enabled = 0,
  confirmations = VALUES(confirmations),
  updated_at = UTC_TIMESTAMP(3);
