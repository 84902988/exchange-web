UPDATE contract_symbols
SET price_precision = 1,
    updated_at = NOW()
WHERE symbol = 'BTCUSDT_PERP';
