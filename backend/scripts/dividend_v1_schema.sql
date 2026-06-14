CREATE TABLE IF NOT EXISTS system_configs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  config_key VARCHAR(100) NOT NULL,
  config_value TEXT NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_system_configs_key (config_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dividend_pools (
  id BIGINT NOT NULL AUTO_INCREMENT,
  dividend_date DATE NOT NULL,
  total_fee_usdt DECIMAL(36,18) NOT NULL DEFAULT 0,
  rcb_price_used DECIMAL(36,18) NOT NULL DEFAULT 0,
  total_dividend_usdt DECIMAL(36,18) NOT NULL DEFAULT 0,
  total_dividend_rcb DECIMAL(36,18) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  run_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dividend_pools_date (dividend_date),
  KEY idx_dividend_pools_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dividend_pool_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pool_id BIGINT NOT NULL,
  level_code VARCHAR(30) NOT NULL,
  level_dividend_rate DECIMAL(18,8) NOT NULL DEFAULT 0.05,
  level_fee_usdt DECIMAL(36,18) NOT NULL DEFAULT 0,
  eligible_user_count INT NOT NULL DEFAULT 0,
  per_user_usdt DECIMAL(36,18) NOT NULL DEFAULT 0,
  per_user_rcb DECIMAL(36,18) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dividend_pool_items_pool_id (pool_id),
  CONSTRAINT fk_dividend_pool_items_pool
    FOREIGN KEY (pool_id) REFERENCES dividend_pools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_dividend_records (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pool_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  level_code VARCHAR(30) NOT NULL,
  dividend_usdt DECIMAL(36,18) NOT NULL DEFAULT 0,
  rcb_price_used DECIMAL(36,18) NOT NULL DEFAULT 0,
  dividend_rcb DECIMAL(36,18) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_dividend_records_pool_user (pool_id, user_id),
  KEY idx_user_dividend_records_user_id (user_id),
  KEY idx_user_dividend_records_status (status),
  CONSTRAINT fk_user_dividend_records_pool
    FOREIGN KEY (pool_id) REFERENCES dividend_pools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO system_configs (config_key, config_value, description)
VALUES ('dividend_run_time_utc', '00:10', 'Daily dividend run time in UTC/GMT, HH:MM')
ON DUPLICATE KEY UPDATE
  config_value = config_value,
  description = VALUES(description);
