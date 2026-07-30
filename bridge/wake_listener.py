#!/usr/bin/env python3
"""Offline wake-word gate for the touchscreen assistant.

Audio remains on the Pi. Short PipeWire recordings are decoded locally with
PocketSphinx; only a successful wake event is sent to the loopback bridge.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request


BRIDGE_WAKE_URL = os.environ.get(
    "WAKE_BRIDGE_URL", "http://127.0.0.1:8765/api/wake"
)
ALSA_DEVICE = os.environ.get("WAKE_ALSA_DEVICE", "pipewire")
KEYPHRASE = os.environ.get("WAKE_PHRASE", "computer").strip().lower()
THRESHOLD = os.environ.get("WAKE_THRESHOLD", "1e-19")
COOLDOWN_SECONDS = float(os.environ.get("WAKE_COOLDOWN_SECONDS", "20"))


def run_detector() -> None:
    process = subprocess.Popen(
        [
            "/usr/bin/pocketsphinx_continuous",
            "-inmic",
            "yes",
            "-adcdev",
            ALSA_DEVICE,
            "-keyphrase",
            KEYPHRASE,
            "-kws_threshold",
            THRESHOLD,
            "-ds",
            "2",
            "-logfn",
            "/dev/null",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    if process.stdout is None:
        raise RuntimeError("Wake detector did not expose its output")

    next_allowed = 0.0
    for line in process.stdout:
        if line.strip().lower() != KEYPHRASE or time.monotonic() < next_allowed:
            continue
        print(f"Wake phrase heard: {KEYPHRASE}", flush=True)
        try:
            notify_bridge()
        except urllib.error.URLError as error:
            print(f"Wake bridge notification failed: {error}", flush=True)
        next_allowed = time.monotonic() + COOLDOWN_SECONDS

    return_code = process.wait()
    raise RuntimeError(f"Wake detector exited with status {return_code}")


def notify_bridge() -> None:
    body = json.dumps({"action": "trigger", "phrase": KEYPHRASE}).encode("utf-8")
    request = urllib.request.Request(
        BRIDGE_WAKE_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "PiTouchscreenWake/1",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        response.read()


def main() -> None:
    print(
        f"Offline wake listener ready for {KEYPHRASE!r} "
        f"(ALSA device {ALSA_DEVICE}, threshold {THRESHOLD})",
        flush=True,
    )
    while True:
        try:
            run_detector()
        except (OSError, RuntimeError) as error:
            print(f"Wake listener recovered from: {error}", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
