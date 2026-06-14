ALTER TABLE trading_pairs
  ADD COLUMN market_category VARCHAR(30) NULL DEFAULT 'CRYPTO',
  ADD COLUMN display_group VARCHAR(50) NULL,
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0,
  ADD COLUMN is_hot TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX idx_trading_pairs_market_category ON trading_pairs (market_category);
CREATE INDEX idx_trading_pairs_sort_order ON trading_pairs (sort_order);
CREATE INDEX idx_trading_pairs_is_hot ON trading_pairs (is_hot);
