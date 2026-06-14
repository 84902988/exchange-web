CREATE TABLE IF NOT EXISTS contract_market_quotes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  symbol VARCHAR(64) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  provider_symbol VARCHAR(64) NOT NULL,
  bid_price DECIMAL(36,18) NOT NULL,
  ask_price DECIMAL(36,18) NOT NULL,
  last_price DECIMAL(36,18) NOT NULL,
  mark_price DECIMAL(36,18) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'LIVE',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_contract_market_quotes_symbol (symbol),
  KEY idx_contract_market_quotes_provider (provider),
  KEY idx_contract_market_quotes_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
