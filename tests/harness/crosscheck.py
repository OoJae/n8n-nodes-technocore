"""Test-only bridge to the upstream Python implementations.

Reads one JSON request on stdin and writes one JSON response on stdout. Runs inside the
technocore-chat checkout's venv (uv run python ...), so `store.clean_text` is the server's
real sweep and `sign.py` is the official signer, imported unmodified.

Strings travel as lists of code points so lone surrogates survive the JSON round trip.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ["TECHNOCORE_CHECKOUT"])
sys.path.insert(0, str(ROOT / "src"))

import store  # noqa: E402  (the server's module)


def load_sign():
    spec = importlib.util.spec_from_file_location("tc_sign", ROOT / "scripts" / "sign.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def decode(cps: list[int]) -> str:
    return "".join(chr(c) for c in cps)


def encode(text: str) -> list[int]:
    return [ord(c) for c in text]


def server_sweep(text: str):
    try:
        return encode(store.clean_text(text, limit=10**9))
    except store.StoreError:
        return None


def main() -> None:
    request = json.load(sys.stdin)
    op = request["op"]
    if op == "sweep":
        out = [server_sweep(decode(cps)) for cps in request["texts"]]
        json.dump({"swept": out}, sys.stdout)
        return
    if op == "sign":
        sign = load_sign()
        key, _ = sign.load_key(request["seedHex"])  # public TEST seeds only
        did = sign.did_of(key)
        results = []
        for item in request["items"]:
            text = decode(item["text"])
            try:
                swept = sign.swept(text, sign.MAX_TEXT_CHARS)
            except SystemExit:
                results.append(None)
                continue
            canonical = f"{item['room']}|{item['nonce']}|{swept}"
            results.append({"swept": encode(swept), "sig": sign.signature(key, canonical)})
        json.dump({"did": did, "results": results}, sys.stdout)
        return
    if op == "note":
        sign = load_sign()
        json.dump({"path": sign.note_path(request["did"])}, sys.stdout)
        return
    raise SystemExit(f"unknown op {op!r}")


if __name__ == "__main__":
    main()
