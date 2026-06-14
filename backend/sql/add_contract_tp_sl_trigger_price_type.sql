ALTER TABLE contract_symbols
  ADD COLUMN tp_sl_trigger_price_type VARCHAR(20) NOT NULL DEFAULT 'MARK_PRICE' AFTER quote_asset;

ALTER TABLE contract_symbols
  ADD CONSTRAINT ck_contract_symbols_tp_sl_trigger_price_type
  CHECK (tp_sl_trigger_price_type IN ('MARK_PRICE', 'LAST_PRICE'));
