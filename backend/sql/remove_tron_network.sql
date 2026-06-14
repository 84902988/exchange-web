-- Disable the unsupported Tron network without deleting historical records.

UPDATE asset_chains ac
JOIN chains c ON c.id = ac.chain_id
SET ac.enabled = 0,
    ac.deposit_enabled = 0,
    ac.withdraw_enabled = 0,
    ac.updated_at = UTC_TIMESTAMP(3)
WHERE LOWER(c.chain_key) = 'tron';

UPDATE chains
SET enabled = 0,
    updated_at = UTC_TIMESTAMP(3)
WHERE LOWER(chain_key) = 'tron';
