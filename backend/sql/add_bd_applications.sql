CREATE TABLE IF NOT EXISTS bd_applications (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  apply_level VARCHAR(20) NOT NULL DEFAULT 'BD1',
  deposit_coin_symbol VARCHAR(20) NOT NULL DEFAULT 'USDT',
  deposit_amount DECIMAL(36,18) NOT NULL DEFAULT 0.000000000000000000,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  remark VARCHAR(255) NULL,
  admin_remark VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by BIGINT NULL,
  PRIMARY KEY (id),
  KEY idx_bd_applications_user_id (user_id),
  KEY idx_bd_applications_status (status),
  KEY idx_bd_applications_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
