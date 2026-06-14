ALTER TABLE trading_pairs
  ADD COLUMN market_sub_category VARCHAR(50) NULL;

CREATE INDEX idx_trading_pairs_market_sub_category ON trading_pairs (market_sub_category);

UPDATE trading_pairs
SET market_sub_category = 'STOCK_TOKEN'
WHERE market_category = 'STOCK'
  AND asset_type = 'STOCK'
  AND (symbol LIKE '%ONUSDT' OR external_symbol IS NOT NULL);

UPDATE trading_pairs
SET market_sub_category = 'US_STOCK'
WHERE market_category = 'STOCK'
  AND asset_type = 'STOCK'
  AND market_sub_category IS NULL;
