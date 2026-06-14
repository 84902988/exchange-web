SET @column_exists := (
  SELECT COUNT(1)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'asset_chains'
    AND COLUMN_NAME = 'review_threshold_amount'
);

SET @ddl := IF(
  @column_exists = 0,
  'ALTER TABLE asset_chains ADD COLUMN review_threshold_amount DECIMAL(36,18) NULL COMMENT ''单笔提现达到该金额后进入人工审核'' AFTER min_withdraw',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
