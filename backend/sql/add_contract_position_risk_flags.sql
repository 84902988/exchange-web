ALTER TABLE contract_positions
  ADD COLUMN is_liquidatable TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN last_risk_check_at DATETIME NULL AFTER is_liquidatable,
  ADD KEY idx_contract_positions_liquidatable (is_liquidatable);
