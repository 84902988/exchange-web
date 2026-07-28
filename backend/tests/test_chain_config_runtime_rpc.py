from app.core.chain_config import get_runtime_chain_config_from_row


def test_runtime_rpc_pool_uses_non_empty_db_value_without_appending_defaults():
    configured = "https://rpc-a.example\nhttps://rpc-b.example"

    cfg = get_runtime_chain_config_from_row(
        {
            "chain_key": "polygon",
            "chain_id": 137,
            "rpc_url": configured,
            "confirmations": 12,
        },
        "polygon",
    )

    assert cfg.rpc_urls == (
        "https://rpc-a.example",
        "https://rpc-b.example",
    )


def test_runtime_rpc_pool_falls_back_when_db_value_is_empty():
    cfg = get_runtime_chain_config_from_row(
        {
            "chain_key": "polygon",
            "chain_id": 137,
            "rpc_url": "",
            "confirmations": 12,
        },
        "polygon",
    )

    assert cfg.rpc_urls
    assert cfg.rpc_urls[0] == "https://polygon.drpc.org"
