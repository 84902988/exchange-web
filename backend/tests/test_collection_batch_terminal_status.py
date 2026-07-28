from app.db.models.collection import CollectionBatch, CollectionBatchStatus
from app.services.admin_queries import _collection_task_batch_status
from app.services.collection_service import _recompute_batch_status


def _batch(*, total: int, success: int = 0, failed: int = 0, skipped: int = 0) -> CollectionBatch:
    return CollectionBatch(
        batch_no="TEST_BATCH",
        trigger_type="MANUAL",
        target_address="0x0",
        status=CollectionBatchStatus.PENDING.value,
        total_tasks=total,
        success_tasks=success,
        failed_tasks=failed,
        skipped_tasks=skipped,
    )


def test_all_skipped_tasks_cancel_batch() -> None:
    batch = _batch(total=2, skipped=2)

    _recompute_batch_status(batch)

    assert batch.status == CollectionBatchStatus.CANCELED.value


def test_canceled_task_aggregate_is_not_labeled_waiting() -> None:
    status = _collection_task_batch_status(
        {
            "address_count": 1,
            "success_count": 0,
            "failed_count": 0,
            "canceled_count": 1,
            "batch_status": "PARTIAL",
        }
    )

    assert status == ("CANCELED", "已取消", "neutral")


def test_terminal_mixed_batch_is_partial_not_waiting() -> None:
    status = _collection_task_batch_status(
        {
            "address_count": 2,
            "success_count": 1,
            "failed_count": 0,
            "canceled_count": 1,
            "batch_status": "PARTIAL",
        }
    )

    assert status == ("PARTIAL", "部分成功", "warning")
