from __future__ import annotations

from app.services.help_content_service import _normalize_article_payload


def _payload(*, title: str, slug: str = "") -> dict[str, object]:
    return {
        "category_id": "1",
        "slug": slug,
        "title": title,
        "summary": "",
        "content": "content",
        "enabled": "1",
    }


def test_article_slug_falls_back_to_normalized_title() -> None:
    data = _normalize_article_payload(
        _payload(title="  Deposit / Withdrawal Guide  ")
    )

    assert data["slug"] == "deposit-withdrawal-guide"


def test_article_slug_fallback_preserves_supported_cjk_characters() -> None:
    data = _normalize_article_payload(_payload(title="充币 / 提币指南"))

    assert data["slug"] == "充币-提币指南"


def test_explicit_article_slug_remains_authoritative() -> None:
    data = _normalize_article_payload(
        _payload(title="Ignored title", slug="Custom Article Slug")
    )

    assert data["slug"] == "custom-article-slug"
