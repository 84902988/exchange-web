CREATE TABLE IF NOT EXISTS `bd_accounts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `bd_level` VARCHAR(20) NOT NULL DEFAULT 'BD1',
  `commission_rate` DECIMAL(10,6) NOT NULL DEFAULT 0.300000,
  `invite_code` VARCHAR(64) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `remark` VARCHAR(255) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bd_accounts_user_id` (`user_id`),
  UNIQUE KEY `uq_bd_accounts_invite_code` (`invite_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bd_user_relations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `bd_user_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `invite_code` VARCHAR(64) NULL,
  `bound_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bd_user_relations_user_id` (`user_id`),
  KEY `idx_bd_user_relations_bd_user_id` (`bd_user_id`),
  KEY `idx_bd_user_relations_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bd_commission_records` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `bd_user_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `order_id` BIGINT NULL,
  `trade_id` BIGINT NULL,
  `source_balance_log_id` BIGINT NULL,
  `fee_asset_id` BIGINT NOT NULL,
  `fee_coin_symbol` VARCHAR(20) NOT NULL,
  `original_fee_amount` DECIMAL(36,18) NOT NULL,
  `commission_rate` DECIMAL(10,6) NOT NULL,
  `commission_amount` DECIMAL(36,18) NOT NULL,
  `pool_amount` DECIMAL(36,18) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  `paid_balance_log_id` BIGINT NULL,
  `paid_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bd_commission_trade_bd` (`trade_id`, `bd_user_id`),
  KEY `idx_bd_commission_records_bd_user_id` (`bd_user_id`),
  KEY `idx_bd_commission_records_user_id` (`user_id`),
  KEY `idx_bd_commission_records_trade_id` (`trade_id`),
  KEY `idx_bd_commission_records_status` (`status`),
  KEY `idx_bd_commission_records_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
