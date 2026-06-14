ALTER TABLE contract_orders
  ADD COLUMN take_profit_price DECIMAL(36,18) NULL AFTER trigger_price,
  ADD COLUMN stop_loss_price DECIMAL(36,18) NULL AFTER take_profit_price;

ALTER TABLE contract_positions
  ADD COLUMN take_profit_price DECIMAL(36,18) NULL AFTER warning_price,
  ADD COLUMN stop_loss_price DECIMAL(36,18) NULL AFTER take_profit_price,
  ADD COLUMN close_reason VARCHAR(30) NULL AFTER status;
