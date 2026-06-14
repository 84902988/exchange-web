ALTER TABLE contract_orders
  ADD COLUMN position_id BIGINT NULL AFTER user_id,
  ADD KEY idx_contract_orders_position (position_id);
