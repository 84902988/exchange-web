from __future__ import annotations

from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.moralis_service import add_address_to_streams


def main():
    """
    补偿任务（生产级）：
    - 扫描 user_chain_addresses.watch_registered=0 的记录
    - join chains 获取 chain_key
    - 调 Moralis Streams 添加 address
    - 成功后标记 watch_registered=1（200/201都算成功）
    - 失败记录 watch_register_err
    """

    limit = 200

    with SessionLocal() as db:
        rows = db.execute(
            text(
                """
                SELECT
                  uca.id,
                  uca.user_id,
                  uca.chain_id,
                  uca.address,
                  c.chain_key
                FROM user_chain_addresses uca
                JOIN chains c ON c.id = uca.chain_id
                WHERE uca.watch_registered = 0
                  AND uca.enabled = 1
                  AND c.enabled = 1
                ORDER BY uca.id ASC
                LIMIT :limit
                """
            ),
            {"limit": limit},
        ).mappings().all()

        if not rows:
            print("[sync_stream] nothing to do")
            return

        ok_cnt = 0
        fail_cnt = 0

        for r in rows:
            rid = int(r["id"])
            uid = int(r["user_id"])
            chain_id = int(r["chain_id"])
            chain_key = (r.get("chain_key") or "").strip().lower()
            addr = (r.get("address") or "").strip().lower()

            if not chain_key or not addr:
                msg = f"invalid row: chain_key={chain_key} addr={addr}"
                print(f"[sync_stream] FAIL id={rid} user={uid} chain_id={chain_id} err={msg}")
                fail_cnt += 1
                db.execute(
                    text(
                        """
                        UPDATE user_chain_addresses
                        SET watch_register_err=:err
                        WHERE id=:id
                        """
                    ),
                    {"id": rid, "err": msg[:250]},
                )
                db.commit()
                continue

            network_code = chain_key.upper()

            try:
                # 200(已存在) / 201(新增) 都算成功
                add_address_to_streams(network_code=network_code, address=addr)

                db.execute(
                    text(
                        """
                        UPDATE user_chain_addresses
                        SET watch_registered=1,
                            watch_registered_at=UTC_TIMESTAMP(),
                            watch_register_err=NULL
                        WHERE id=:id
                        """
                    ),
                    {"id": rid},
                )
                db.commit()

                ok_cnt += 1
                print(f"[sync_stream] OK id={rid} user={uid} chain={chain_key} addr={addr}")

            except Exception as e:
                db.rollback()

                msg = str(e)[:250]
                db.execute(
                    text(
                        """
                        UPDATE user_chain_addresses
                        SET watch_register_err=:err
                        WHERE id=:id
                        """
                    ),
                    {"id": rid, "err": msg},
                )
                db.commit()

                fail_cnt += 1
                print(f"[sync_stream] FAIL id={rid} user={uid} chain={chain_key} addr={addr} err={msg}")

        print(f"[sync_stream] done ok={ok_cnt} fail={fail_cnt} total={len(rows)}")


if __name__ == "__main__":
    main()
