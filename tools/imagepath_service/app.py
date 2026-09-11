"""FastAPI sidecar service for image -> drawable-path vectorization.

This is a developer/desktop tool that runs on the user's computer (never on the
ESP32). It exposes a local HTTP surface the web SPA can POST images to, runs
real OpenCV (``cv2``) + ``scikit-image``, and returns ready-to-draw polylines in
image-pixel space.

Launch:
    uvicorn app:app --host 127.0.0.1 --port 8765

The service binds to loopback (127.0.0.1) by default and is unauthenticated;
this is acceptable only for a single-user local dev tool.
"""

from typing import List

import cv2
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import vectorize as vectorize_mod
from vectorize import VectorizeParams

SERVICE_VERSION = "0.1.0"


def _parse_bool(value, default: bool) -> bool:
    """Parse a form-supplied boolean ("true"/"false"/"1"/"0"); default if None.

    FastAPI form fields arrive as strings; this normalizes the common truthy/
    falsy spellings (case-insensitive). An unrecognized value falls back to the
    supplied default so a stray string never crashes the request.
    """
    if value is None:
        return bool(default)
    s = str(value).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    return bool(default)

app = FastAPI(
    title="imagepath_service",
    version=SERVICE_VERSION,
    description="Local CV sidecar: image -> drawable polylines (skeleton-primary).",
)

# CORS for the Vite dev origin (and the loopback IP form) so the web SPA can
# call the service from http://localhost:5173. Also accepts any localhost or
# 127.0.0.1 variant via regex so the dev server's "Network" URL (e.g.
# http://192.168.1.166:5173, which Vite prints alongside the Local URL) is
# handled, plus other loopback ports the user may launch from. Loopback-only
# bind on the service side keeps the open CORS policy from being externally
# exploitable.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: str
    version: str
    cv2: str


class VectorizeResponse(BaseModel):
    """Vectorize result in image-pixel space.

    ``polylines`` is a list of polylines; each polyline is a list of ``[x, y]``
    integer pixel pairs with ``0 <= x < width`` and ``0 <= y < height``.
    """

    width: int
    height: int
    polylines: List[List[List[int]]]


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness/readiness probe with the loaded cv2 version."""
    return HealthResponse(status="ok", version=SERVICE_VERSION, cv2=cv2.__version__)


@app.post("/vectorize", response_model=VectorizeResponse)
async def vectorize_endpoint(
    file: UploadFile = File(...),
    mode: str = Form(VectorizeParams.mode),
    detail: float = Form(VectorizeParams.detail),
    contrast: float = Form(VectorizeParams.contrast),
    threshold: int = Form(VectorizeParams.threshold),
    tone_bands: int = Form(VectorizeParams.tone_bands),
    blur_sigma: float = Form(VectorizeParams.blur_sigma),
    max_dim: int = Form(VectorizeParams.max_dim),
    min_stroke_len: float = Form(VectorizeParams.min_stroke_len),
    run_spacing: float = Form(VectorizeParams.run_spacing),
    white_threshold: int = Form(VectorizeParams.white_threshold),
    edge_paths: str = Form(None),
    isolate_subject: str = Form(None),
    local_contrast: float = Form(VectorizeParams.local_contrast),
) -> VectorizeResponse:
    """Vectorize an uploaded image into drawable polylines (pixel space).

    Accepts ``multipart/form-data`` with a ``file`` image part plus optional
    params as form fields (each defaulting to ``VectorizeParams``). Delegates to
    the pure :func:`vectorize.vectorize` pipeline and returns the resulting
    ``{ width, height, polylines }``. Returns HTTP 400 with ``{"error": ...}``
    when the uploaded image cannot be decoded.

    ``mode`` may be ``skeleton`` / ``contour`` / ``both`` / ``hatch``. The
    hatch-specific fields ``run_spacing``, ``white_threshold`` and
    ``edge_paths`` default to the dataclass defaults when omitted;
    ``edge_paths`` parses ``"true"/"false"/1/0`` (case-insensitive).
    """
    image_bytes = await file.read()

    params = VectorizeParams(
        mode=mode,
        detail=detail,
        contrast=contrast,
        threshold=threshold,
        tone_bands=tone_bands,
        blur_sigma=blur_sigma,
        max_dim=max_dim,
        min_stroke_len=min_stroke_len,
        run_spacing=run_spacing,
        white_threshold=white_threshold,
        edge_paths=_parse_bool(edge_paths, VectorizeParams.edge_paths),
        isolate_subject=_parse_bool(isolate_subject, VectorizeParams.isolate_subject),
        local_contrast=local_contrast,
    )
    try:
        result = vectorize_mod.vectorize(image_bytes, params)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return VectorizeResponse(**result)
