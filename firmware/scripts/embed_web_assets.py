#!/usr/bin/env python3
"""Embed the gzipped SPA bundle into the firmware as a PROGMEM byte array.

Design references: §2.4.4 (Web Asset Hosting — embedded in RA4M1 PROGMEM) and
§10.3 (Firmware Build). The web build (web/vite.config.ts, gzipAndBudget
plugin) produces a single gzip-compressed SPA blob; this script bakes those
bytes into ``firmware/src/web_assets.h`` so the HTTP server can stream them
straight from flash with ``Content-Encoding: gzip``.

Behavior
--------
1. Locate the gzipped bundle. Preference order:
     a. an explicit path (argv[1] standalone, or $ETCH_WEB_ASSETS_INPUT)
     b. web/dist.gz/index.html.gz   (the path the web build actually writes)
     c. web/dist/index.html.gz      (legacy/spec-text fallback)
2. Verify the gzip size is <= 120 KB (122880 bytes); fail the build otherwise.
3. Emit firmware/src/web_assets.h with a `#pragma once`, a generated-file
   banner, a PROGMEM `static const unsigned char WEB_INDEX_GZ[]` array, and the
   length constant `WEB_INDEX_GZ_LEN` (consumed by http_server.cpp).

Usage
-----
Standalone (always runs)::

    python3 embed_web_assets.py [INPUT_GZ] [OUTPUT_H]

PlatformIO pre-build hook (wired via ``extra_scripts`` in platformio.ini); only
runs for the ``uno_r4_wifi`` environment so ``pio test -e host_test`` is never
blocked by a missing web bundle::

    extra_scripts = pre:scripts/embed_web_assets.py

The generated header is gitignored (firmware/.gitignore); it is regenerated on
every firmware build.
"""

from __future__ import annotations

import os
import sys

# --- Constants ---------------------------------------------------------------

# Hard size budget for the always-resident SPA blob (Design §2.4.1 / §10.2).
SIZE_BUDGET_BYTES = 120 * 1024  # 122880

# Names of the PlatformIO environments that actually embed the web assets.
# The WiFi images host the SPA over HTTP and need web_assets.h; the BLE image
# and host_test do not. `uno_r4_wifi` is the legacy/default WiFi env and
# `uno_r4_wifi_wifi` is the partitioned WiFi env (Design §4).
FIRMWARE_ENV_NAMES = frozenset({"uno_r4_wifi", "uno_r4_wifi_wifi"})

# C identifiers emitted into web_assets.h. These MUST match the symbols read by
# firmware/src/http/http_server.cpp (handleGetIndex): WEB_INDEX_GZ /
# WEB_INDEX_GZ_LEN. Design §10.3 names the array WEB_INDEX_GZ.
ARRAY_NAME = "WEB_INDEX_GZ"
LENGTH_NAME = "WEB_INDEX_GZ_LEN"

# gzip magic bytes (RFC 1952): 0x1f 0x8b. Used for a soft sanity check only.
GZIP_MAGIC = b"\x1f\x8b"


# --- Path resolution ---------------------------------------------------------

def _script_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


# When executed as a PlatformIO `extra_scripts` hook, the script is run via
# SCons `exec()` and `__file__` is NOT defined, so the `__file__`-based path
# helpers above would raise NameError. In that case platformio_main() sets this
# override from the SCons env's PROJECT_DIR (the firmware/ project root).
_FIRMWARE_ROOT_OVERRIDE: str | None = None


def firmware_root() -> str:
    """Absolute path to the firmware/ project root (parent of scripts/)."""
    if _FIRMWARE_ROOT_OVERRIDE is not None:
        return _FIRMWARE_ROOT_OVERRIDE
    return os.path.dirname(_script_dir())


def repo_root() -> str:
    """Absolute path to the repository root (parent of firmware/)."""
    return os.path.dirname(firmware_root())


def default_input_candidates() -> list[str]:
    """Gzip-bundle locations to probe, in preference order.

    The web build writes web/dist.gz/index.html.gz; the spec task text names
    web/dist/index.html.gz, so both are supported.
    """
    web = os.path.join(repo_root(), "web")
    return [
        os.path.join(web, "dist.gz", "index.html.gz"),
        os.path.join(web, "dist", "index.html.gz"),
    ]


def default_output_path() -> str:
    return os.path.join(firmware_root(), "src", "web_assets.h")


def resolve_input(explicit: str | None) -> str | None:
    """Return the first existing input path, or None if none is found.

    `explicit` (argv or env override) takes priority; if it is provided it is
    returned verbatim so a missing override surfaces a clear "not found" error
    pointing at exactly what the user asked for.
    """
    if explicit:
        return explicit
    for candidate in default_input_candidates():
        if os.path.isfile(candidate):
            return candidate
    # Nothing on disk: return the preferred location so the error names it.
    return None


# --- Header generation -------------------------------------------------------

def _format_byte_array(data: bytes, per_line: int = 12) -> str:
    """Render `data` as comma-separated 0xNN literals, `per_line` per line."""
    lines = []
    for start in range(0, len(data), per_line):
        chunk = data[start:start + per_line]
        lines.append("  " + ", ".join(f"0x{b:02x}" for b in chunk) + ",")
    return "\n".join(lines)


def render_header(data: bytes, source_path: str) -> str:
    """Build the full text of web_assets.h for the given gzip bytes."""
    rel_source = os.path.relpath(source_path, repo_root())
    body = _format_byte_array(data)
    return f"""\
#pragma once
/* =========================================================================
 * web_assets.h - GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Produced by firmware/scripts/embed_web_assets.py from the gzip-compressed
 * single-file SPA bundle. Regenerated on every firmware build by the
 * `pre:scripts/embed_web_assets.py` PlatformIO hook (Design §2.4.4, §10.3).
 *
 *   Source bundle : {rel_source}
 *   Gzip size     : {len(data)} bytes (budget {SIZE_BUDGET_BYTES} bytes / 120 KB)
 *
 * The bytes below are GZIP-COMPRESSED. The HTTP handler for `GET /` streams
 * this blob verbatim and MUST send `Content-Encoding: gzip` so the browser
 * inflates it transparently. See http_server.cpp::handleGetIndex.
 * ========================================================================= */

#include <stddef.h>  /* size_t */

/* PROGMEM is provided by <Arduino.h> on the Renesas RA4M1 core. Define it away
 * on host / native builds (platform = native, standalone syntax checks) so this
 * header still compiles where PROGMEM does not exist. */
#ifndef PROGMEM
#define PROGMEM
#endif

static const unsigned char {ARRAY_NAME}[] PROGMEM = {{
{body}
}};

static const size_t {LENGTH_NAME} = {len(data)};
"""


# --- Core driver -------------------------------------------------------------

class EmbedError(Exception):
    """Raised on any condition that should fail the build."""


def generate(input_path: str | None, output_path: str) -> int:
    """Read the gzip bundle, enforce the budget, and write web_assets.h.

    Returns the number of bytes embedded. Raises EmbedError on any failure.
    """
    if not input_path or not os.path.isfile(input_path):
        looked = input_path or os.path.join(
            repo_root(), "web", "dist.gz", "index.html.gz"
        )
        raise EmbedError(
            "gzipped SPA bundle not found at '{0}'.\n"
            "  Run the web build first:  cd web && npm run build\n"
            "  (the build writes web/dist.gz/index.html.gz)".format(looked)
        )

    with open(input_path, "rb") as fh:
        data = fh.read()

    size = len(data)
    if size == 0:
        raise EmbedError(
            "gzipped SPA bundle '{0}' is empty; rebuild the web bundle "
            "(cd web && npm run build).".format(input_path)
        )

    if size > SIZE_BUDGET_BYTES:
        raise EmbedError(
            "SPA bundle exceeds the 120 KB gzipped budget: "
            "{0} bytes > {1} bytes ({2}).\n"
            "  Trim the web bundle or move to an external/SD hosting mode "
            "(Design §10.4).".format(size, SIZE_BUDGET_BYTES, input_path)
        )

    if data[:2] != GZIP_MAGIC:
        # Soft check: the firmware sends Content-Encoding: gzip, so a non-gzip
        # blob would be undecodable by the browser. Warn but proceed.
        sys.stderr.write(
            "embed_web_assets: warning: '{0}' does not start with the gzip "
            "magic bytes (0x1f 0x8b); is this really a .gz file?\n".format(
                input_path
            )
        )

    header_text = render_header(data, input_path)

    out_dir = os.path.dirname(output_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(output_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(header_text)

    sys.stdout.write(
        "embed_web_assets: embedded {0} bytes "
        "({1:.1f} KB, {2:.0f}% of 120 KB budget) from {3} -> {4}\n".format(
            size,
            size / 1024.0,
            100.0 * size / SIZE_BUDGET_BYTES,
            os.path.relpath(input_path, repo_root()),
            os.path.relpath(output_path, repo_root()),
        )
    )
    return size


# --- Entry points ------------------------------------------------------------

def cli_main(argv: list[str]) -> int:
    """Standalone entry point: `python3 embed_web_assets.py [INPUT] [OUTPUT]`."""
    input_override = (
        argv[0] if len(argv) >= 1 else os.environ.get("ETCH_WEB_ASSETS_INPUT")
    )
    output_path = (
        argv[1] if len(argv) >= 2
        else os.environ.get("ETCH_WEB_ASSETS_OUTPUT") or default_output_path()
    )
    input_path = resolve_input(input_override)
    try:
        generate(input_path, output_path)
    except EmbedError as err:
        sys.stderr.write("embed_web_assets: error: {0}\n".format(err))
        return 1
    return 0


def platformio_main(env) -> None:
    """PlatformIO pre-build hook. Only runs for the firmware env."""
    try:
        env_name = env["PIOENV"]
    except Exception:  # pragma: no cover - defensive
        env_name = None

    if env_name not in FIRMWARE_ENV_NAMES:
        # host_test / the BLE image must not be blocked by a missing bundle.
        return

    # Under the SCons/PlatformIO executor `__file__` is undefined, so resolve
    # the firmware root from the build environment instead and feed it to the
    # path helpers via the module-level override.
    global _FIRMWARE_ROOT_OVERRIDE
    try:
        _FIRMWARE_ROOT_OVERRIDE = env.subst("$PROJECT_DIR")
    except Exception:  # pragma: no cover - defensive
        _FIRMWARE_ROOT_OVERRIDE = os.getcwd()

    input_override = os.environ.get("ETCH_WEB_ASSETS_INPUT")
    output_path = os.environ.get("ETCH_WEB_ASSETS_OUTPUT") or default_output_path()
    input_path = resolve_input(input_override)
    try:
        generate(input_path, output_path)
    except EmbedError as err:
        sys.stderr.write("embed_web_assets: error: {0}\n".format(err))
        # Abort the PlatformIO build with a clear, non-zero failure.
        env.Exit(1)


# SCons/PlatformIO injects `Import` into the script's globals when it executes
# an extra_script. When run as a normal program that global is absent.
if "Import" in globals():  # pragma: no cover - exercised only under PlatformIO
    Import("env")  # noqa: F821  (provided by the SCons build environment)
    platformio_main(env)  # noqa: F821
elif __name__ == "__main__":
    sys.exit(cli_main(sys.argv[1:]))
