from sqlalchemy import bindparam, text


def load_deposit_credit_destinations(db, user_id, deposit_ids):
    """Read settlement evidence; chain confirmation alone does not prove credit."""
    if not deposit_ids:
        return {}
    statement = text("""
        SELECT d.id,
          CASE WHEN EXISTS (
            SELECT 1 FROM balance_logs b
            WHERE b.user_id = d.user_id AND HEX(b.coin_symbol) = HEX(d.coin_symbol)
              AND b.biz_type = 'DEPOSIT' AND HEX(b.biz_id) = HEX(CAST(d.id AS CHAR))
              AND b.change_amount >= d.amount AND d.amount > 0
          ) THEN 'funding'
          WHEN EXISTS (
            SELECT 1 FROM user_stock_token_locks l
            WHERE l.user_id = d.user_id AND HEX(l.lock_symbol) = HEX(d.coin_symbol)
              AND l.source_type = 'DEPOSIT' AND l.source_id = d.id
              AND l.total_amount >= d.amount AND d.amount > 0
          ) THEN 'stock_token_lock'
          ELSE NULL END AS credit_destination
        FROM deposits d WHERE d.user_id = :user_id AND d.id IN :deposit_ids
    """).bindparams(bindparam('deposit_ids', expanding=True))
    rows = db.execute(statement, {'user_id': user_id, 'deposit_ids': list(deposit_ids)}).mappings()
    return {int(row['id']): row['credit_destination'] for row in rows}
