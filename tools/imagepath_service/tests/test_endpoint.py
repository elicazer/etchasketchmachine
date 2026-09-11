"""Endpoint tests for POST /vectorize via the FastAPI TestClient.

Validates: Requirements 4.2, 6.1, 6.2
"""

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def _thick_plus_png(h: int = 64, w: int = 64, bar: int = 8) -> bytes:
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    cy, cx = h // 2, w // 2
    half = bar // 2
    img[cy - half : cy + half, :, :] = 0
    img[:, cx - half : cx + half, :] = 0
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def test_vectorize_multipart_returns_wellformed_body():
    png = _thick_plus_png()
    resp = client.post(
        "/vectorize",
        files={"file": ("plus.png", png, "image/png")},
        data={"mode": "both", "blur_sigma": "0.0", "min_stroke_len": "2.0", "tone_bands": "1"},
    )
    assert resp.status_code == 200, resp.text

    body = resp.json()
    assert body["width"] > 0 and body["height"] > 0
    assert isinstance(body["polylines"], list)
    assert len(body["polylines"]) >= 1

    w, h = body["width"], body["height"]
    for poly in body["polylines"]:
        for pt in poly:
            assert len(pt) == 2
            x, y = pt
            assert 0 <= x < w
            assert 0 <= y < h


def test_vectorize_uses_defaults_without_params():
    png = _thick_plus_png()
    resp = client.post("/vectorize", files={"file": ("plus.png", png, "image/png")})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["width"] > 0 and body["height"] > 0
    assert isinstance(body["polylines"], list)


def test_vectorize_undecodable_upload_returns_400():
    garbage = b"this is not an image at all \x00\x01\x02"
    resp = client.post(
        "/vectorize",
        files={"file": ("junk.png", garbage, "image/png")},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert "error" in body
    assert isinstance(body["error"], str) and body["error"]
