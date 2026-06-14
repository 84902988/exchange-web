CREATE TABLE IF NOT EXISTS stock_token_lock_configs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  lock_symbol VARCHAR(50) NOT NULL,
  trade_symbol VARCHAR(50) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  lock_days INT NOT NULL DEFAULT 90,
  daily_release_rate DECIMAL(18,8) NOT NULL DEFAULT 0.05000000,
  conversion_rate DECIMAL(36,18) NOT NULL DEFAULT 1.000000000000000000,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  remark VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_stock_lock_symbol (lock_symbol),
  UNIQUE KEY uk_stock_trade_symbol (trade_symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_stock_token_locks (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  config_id BIGINT NOT NULL,
  lock_symbol VARCHAR(50) NOT NULL,
  total_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  locked_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  available_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  converted_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  conversion_rate_snapshot DECIMAL(36,18) NOT NULL DEFAULT 1.000000000000000000,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  source_type VARCHAR(50) NOT NULL DEFAULT 'OTC_DEPOSIT',
  source_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_stock_token_locks_user (user_id),
  KEY idx_user_stock_token_locks_config (config_id),
  KEY idx_user_stock_token_locks_status (status),
  KEY idx_user_stock_token_locks_symbol (lock_symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_token_convert_records (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  config_id BIGINT NOT NULL,
  from_symbol VARCHAR(50) NOT NULL,
  to_symbol VARCHAR(50) NOT NULL,
  from_amount DECIMAL(36,18) NOT NULL,
  to_amount DECIMAL(36,18) NOT NULL,
  conversion_rate DECIMAL(36,18) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_token_convert_records_user (user_id),
  KEY idx_stock_token_convert_records_config (config_id),
  KEY idx_stock_token_convert_records_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
