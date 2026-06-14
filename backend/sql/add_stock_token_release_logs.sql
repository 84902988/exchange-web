ALTER TABLE user_stock_token_locks
  ADD COLUMN IF NOT EXISTS conversion_rate_snapshot DECIMAL(36,18) NOT NULL DEFAULT 1.000000000000000000
  AFTER converted_amount;

UPDATE user_stock_token_locks AS l
JOIN stock_token_lock_configs AS c ON c.id = l.config_id
SET l.conversion_rate_snapshot = c.conversion_rate;

CREATE TABLE IF NOT EXISTS stock_token_release_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  trigger_type VARCHAR(20) NOT NULL DEFAULT 'AUTO',
  status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',
  scanned_count INT NOT NULL DEFAULT 0,
  released_count INT NOT NULL DEFAULT 0,
  total_release_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  item_ids TEXT NULL,
  message VARCHAR(500) NOT NULL DEFAULT '',
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_token_release_logs_trigger (trigger_type),
  KEY idx_stock_token_release_logs_status (status),
  KEY idx_stock_token_release_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
