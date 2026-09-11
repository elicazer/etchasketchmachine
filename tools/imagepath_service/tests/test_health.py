"""Smoke test for the sidecar: cv2 imports and GET /health works."""

from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_cv2_imports():
    import cv2

    assert isinstance(cv2.__version__, str)
    assert cv2.__version__


def test_health_endpoint_ok():
    resp = client.get("/health")
    assert resp.status_code == 200

    body = resp.json()
    assert body["status"] == "ok"
    # cv2 version must be a non-empty string.
    assert isinstance(body["cv2"], str)
    assert body["cv2"]
    # service version present.
    assert body["version"]
