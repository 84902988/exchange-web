from scripts import test_collection_real_send_guarded
from scripts import test_collection_send_guard
from scripts import test_collection_worker_send_helper_dryrun


def test_collection_send_guard_is_fail_closed_and_db_authorized() -> None:
    test_collection_send_guard._test_guard_matrix()
    test_collection_send_guard._test_send_helper_guard_rejects_before_tx_actions()


def test_real_send_routes_and_helpers_cannot_bypass_guards() -> None:
    test_collection_real_send_guarded._test_real_send_routes_fail_closed_when_master_disabled()
    test_collection_real_send_guarded._test_send_helper_guard_rejects_before_tx_actions()
    test_collection_real_send_guarded._test_dry_run_routes_stay_dry_when_master_enabled()
    test_collection_real_send_guarded._test_send_helper_force_dry_run_when_master_enabled()


def test_collection_workers_dry_run_without_live_database_or_rpc() -> None:
    def run() -> None:
        test_collection_worker_send_helper_dryrun._test_worker_dry_run_without_database_or_rpc()

    test_collection_worker_send_helper_dryrun._replace_env(
        {
            "COLLECTION_REAL_SEND_MASTER_SWITCH": "false",
            "COLLECTION_ENABLE_REAL_SEND": "false",
        },
        run,
    )
