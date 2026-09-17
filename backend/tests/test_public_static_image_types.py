import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from starlette.applications import Starlette
from starlette.routing import Mount

from app.services.public_static_files import KycIsolatedStaticFiles


@pytest.fixture
def client(tmp_path: Path):
    for folder in ["mobile", "site", "kyc"]:
        target = tmp_path / "uploads" / folder
        target.mkdir(parents=True)
        for extension in ["webp", "avif"]:
            (target / f"image.{extension}").write_bytes(b"test-image-body")
    app = Starlette(routes=[Mount("/static", KycIsolatedStaticFiles(directory=tmp_path))])
    class Client:
        def request(self, method, url, headers=None):
            async def run():
                messages = []

                async def receive():
                    return {"type": "http.request", "body": b"", "more_body": False}

                async def send(message):
                    messages.append(message)

                await app({
                    "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                    "method": method, "scheme": "http", "path": url, "raw_path": url.encode(),
                    "root_path": "", "query_string": b"", "server": ("test", 80), "client": ("127.0.0.1", 1234),
                    "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
                }, receive, send)
                start = next(m for m in messages if m["type"] == "http.response.start")
                return SimpleNamespace(
                    status_code=start["status"],
                    headers={k.decode(): v.decode() for k, v in start["headers"]},
                    content=b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body"),
                )
            return asyncio.run(run())

        def get(self, url, headers=None):
            return self.request("GET", url, headers)

        def head(self, url):
            return self.request("HEAD", url)

    return Client()


@pytest.mark.parametrize("extension,media_type", [("webp", "image/webp"), ("avif", "image/avif")])
@pytest.mark.parametrize("folder", ["mobile", "site"])
def test_public_cms_images_without_system_mime_database(client, extension, media_type, folder):
    with patch("starlette.responses.guess_type", return_value=(None, None)):
        url = f"/static/uploads/{folder}/image.{extension}"
        response = client.get(url)
        assert response.status_code == 200
        assert response.headers["content-type"] == media_type
        assert response.content == b"test-image-body"
        head = client.head(url)
        assert head.status_code == 200
        assert head.headers["content-type"] == media_type
        assert head.content == b""
        cached = client.get(url, headers={"If-None-Match": response.headers["etag"]})
        assert cached.status_code == 304
        assert cached.content == b""


@pytest.mark.parametrize("extension", ["webp", "avif"])
def test_private_kyc_images_still_blocked(client, extension):
    response = client.get(f"/static/uploads/kyc/image.{extension}")
    assert response.status_code == 404
    assert response.content == b""


def test_missing_public_image_stays_not_found(client):
    response = client.get("/static/uploads/mobile/missing.webp")
    assert response.status_code == 404
    assert response.headers.get("content-type") != "image/webp"
