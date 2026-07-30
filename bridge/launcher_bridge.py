#!/usr/bin/env python3
"""Local-only bridge for the Pi touchscreen launcher.

The browser never receives a Gateway bearer token. This process serves the
static launcher, proxies the read-only BirdFrame snapshot, reports appliance
health, and switches the two fullscreen windows through wlrctl.
"""

from __future__ import annotations

import json
import mimetypes
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = os.environ.get("LAUNCHER_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAUNCHER_PORT", "8765"))
STATIC_ROOT = Path(
    os.environ.get(
        "LAUNCHER_STATIC_ROOT",
        str(Path.home() / "touchscreen-launcher" / "current"),
    )
).resolve()
BIRDFRAME_URL = os.environ.get(
    "BIRDFRAME_URL", "http://192.168.86.24:8355"
).rstrip("/")
OPENCLAW_URL = os.environ.get(
    "OPENCLAW_URL", "http://192.168.86.24:18789"
).rstrip("/")
VOICE_BROKER_URL = os.environ.get(
    "VOICE_BROKER_URL", "http://192.168.86.24:18890"
).rstrip("/")

WINDOW_MATCHES = {
    "assistant": os.environ.get(
        "LAUNCHER_WINDOW_MATCH", "app_id:chrome-127.0.0.1__-Default"
    ),
    "birdframe": os.environ.get(
        "BIRDFRAME_WINDOW_MATCH", "app_id:com.example.birdframe_display"
    ),
}
CAMERA_LOCK = threading.Lock()
CAMERA_CACHE: tuple[float, bytes] = (0.0, b"")
WAKE_LOCK = threading.Lock()
WAKE_SEQUENCE = 0
WAKE_EXPIRES_AT = 0.0
WAKE_MUTED_UNTIL = 0.0


def fetch_json(url: str, timeout: float = 2.5) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "PiTouchscreenLauncher/1"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(
    url: str, payload: dict[str, Any], timeout: float = 30.0
) -> tuple[int, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "PiTouchscreenLauncher/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            result = {"error": "Voice broker request failed"}
        return error.code, result


def endpoint_ready(url: str) -> bool:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "PiTouchscreenLauncher/1"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            return 200 <= response.status < 500
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        return False


def service_active(name: str) -> bool:
    result = subprocess.run(
        ["/usr/bin/systemctl", "--user", "is-active", "--quiet", name],
        check=False,
        capture_output=True,
        timeout=3,
    )
    return result.returncode == 0


def focus_window(target: str) -> tuple[bool, str]:
    match = WINDOW_MATCHES[target]
    if target == "birdframe" and not service_active("birdframe-display.service"):
        subprocess.run(
            ["/usr/bin/systemctl", "--user", "start", "birdframe-display.service"],
            check=False,
            capture_output=True,
            timeout=8,
        )

    command = [
        "/usr/bin/wlrctl",
        "toplevel",
        "focus",
        match,
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return False, str(error)
    detail = (result.stderr or result.stdout).strip()
    return result.returncode == 0, detail


def capture_camera_jpeg() -> bytes:
    global CAMERA_CACHE

    captured_at, cached_image = CAMERA_CACHE
    if cached_image and time.monotonic() - captured_at < 1.5:
        return cached_image

    if not CAMERA_LOCK.acquire(blocking=False):
        if cached_image:
            return cached_image
        raise RuntimeError("Camera is starting")

    try:
        result = subprocess.run(
            [
                "/usr/bin/rpicam-still",
                "-n",
                "--immediate",
                "--width",
                "1536",
                "--height",
                "864",
                "--quality",
                "82",
                "-o",
                "-",
            ],
            check=False,
            capture_output=True,
            timeout=12,
        )
        if result.returncode != 0 or not result.stdout.startswith(b"\xff\xd8"):
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail or "Camera capture failed")
        CAMERA_CACHE = (time.monotonic(), result.stdout)
        return result.stdout
    finally:
        CAMERA_LOCK.release()


def wake_status() -> dict[str, Any]:
    with WAKE_LOCK:
        return {
            "pending": time.monotonic() < WAKE_EXPIRES_AT,
            "sequence": WAKE_SEQUENCE,
            "muted": time.monotonic() < WAKE_MUTED_UNTIL,
        }


def trigger_wake() -> dict[str, Any]:
    global WAKE_EXPIRES_AT, WAKE_SEQUENCE

    with WAKE_LOCK:
        if time.monotonic() < WAKE_MUTED_UNTIL:
            return {
                "pending": False,
                "sequence": WAKE_SEQUENCE,
                "muted": True,
                "focused": False,
                "detail": "Wake word is muted during the active conversation",
            }
        WAKE_SEQUENCE += 1
        WAKE_EXPIRES_AT = time.monotonic() + 45
        payload = {
            "pending": True,
            "sequence": WAKE_SEQUENCE,
            "muted": False,
        }
    focused, detail = focus_window("assistant")
    payload.update({"focused": focused, "detail": detail})
    return payload


def acknowledge_wake(sequence: int | None) -> dict[str, Any]:
    global WAKE_EXPIRES_AT

    with WAKE_LOCK:
        if sequence is None or sequence == WAKE_SEQUENCE:
            WAKE_EXPIRES_AT = 0.0
        return {
            "pending": time.monotonic() < WAKE_EXPIRES_AT,
            "sequence": WAKE_SEQUENCE,
            "muted": time.monotonic() < WAKE_MUTED_UNTIL,
        }


def mute_wake(seconds: float) -> dict[str, Any]:
    global WAKE_EXPIRES_AT, WAKE_MUTED_UNTIL

    duration = max(0.0, min(seconds, 60.0))
    with WAKE_LOCK:
        WAKE_EXPIRES_AT = 0.0
        WAKE_MUTED_UNTIL = time.monotonic() + duration
        return {
            "pending": False,
            "sequence": WAKE_SEQUENCE,
            "muted": duration > 0,
        }


class LauncherHandler(SimpleHTTPRequestHandler):
    server_version = "PiTouchscreenLauncher/1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def end_headers(self) -> None:
        if self.path.split("?", 1)[0] in {"/", "/index.html"}:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, message: str, *args: Any) -> None:
        print(f"{self.address_string()} - {message % args}", flush=True)

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_jpeg(self, image: bytes) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(image)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(image)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/status":
            self.send_json(
                {
                    "gatewayReady": endpoint_ready(f"{OPENCLAW_URL}/"),
                    "voiceReady": endpoint_ready(f"{VOICE_BROKER_URL}/health"),
                    "birdframeReady": endpoint_ready(f"{BIRDFRAME_URL}/api/now"),
                    "birdframeRunning": service_active(
                        "birdframe-display.service"
                    ),
                    "wakeReady": service_active("touchscreen-wake.service"),
                    "openClawUrl": OPENCLAW_URL,
                }
            )
            return

        if self.path == "/api/birdframe":
            try:
                self.send_json(fetch_json(f"{BIRDFRAME_URL}/api/now"))
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {"error": "BirdFrame is unavailable", "detail": str(error)},
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path == "/api/wake":
            self.send_json(wake_status())
            return

        if self.path.startswith("/api/camera.jpg"):
            try:
                self.send_jpeg(capture_camera_jpeg())
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                self.send_json(
                    {"error": "Camera is unavailable", "detail": str(error)},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
            return

        if self.path.startswith("/api/"):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        requested = self.path.split("?", 1)[0]
        candidate = (STATIC_ROOT / requested.lstrip("/")).resolve()
        if requested == "/" or not candidate.is_file():
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        voice_paths = {
            "/api/voice/session": "/session",
            "/api/voice/tool": "/tool",
            "/api/voice/control": "/control",
        }
        if self.path not in {"/api/window", "/api/wake", *voice_paths}:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        body_limit = 128 * 1024 if self.path in voice_paths else 1024
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json({"error": "Invalid content length"}, HTTPStatus.BAD_REQUEST)
            return
        if content_length > body_limit:
            self.send_json(
                {"error": "Request body is too large"},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
            return
        length = max(0, content_length)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self.send_json({"error": "Invalid JSON"}, HTTPStatus.BAD_REQUEST)
            return
        if not isinstance(payload, dict):
            self.send_json(
                {"error": "JSON body must be an object"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        if self.path in voice_paths:
            timeout = 130.0 if self.path == "/api/voice/tool" else 35.0
            try:
                status, result = post_json(
                    f"{VOICE_BROKER_URL}{voice_paths[self.path]}",
                    payload,
                    timeout=timeout,
                )
                self.send_json(result, status)
            except (
                OSError,
                ValueError,
                TimeoutError,
                urllib.error.URLError,
            ) as error:
                self.send_json(
                    {
                        "error": "The OpenClaw voice service is unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path == "/api/wake":
            action = payload.get("action", "trigger")
            if action == "trigger":
                self.send_json(trigger_wake())
                return
            if action == "ack":
                sequence = payload.get("sequence")
                self.send_json(
                    acknowledge_wake(sequence if isinstance(sequence, int) else None)
                )
                return
            if action == "mute":
                seconds = payload.get("seconds", 30)
                if not isinstance(seconds, (int, float)):
                    self.send_json(
                        {"error": "seconds must be a number"},
                        HTTPStatus.BAD_REQUEST,
                    )
                    return
                self.send_json(mute_wake(float(seconds)))
                return
            self.send_json(
                {"error": "action must be trigger, ack, or mute"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        target = payload.get("target")
        if target not in WINDOW_MATCHES:
            self.send_json(
                {"error": "target must be assistant or birdframe"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        ok, detail = focus_window(target)
        self.send_json(
            {"ok": ok, "target": target, "detail": detail},
            HTTPStatus.OK if ok else HTTPStatus.SERVICE_UNAVAILABLE,
        )

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main() -> None:
    if not STATIC_ROOT.is_dir():
        raise SystemExit(f"Launcher static root does not exist: {STATIC_ROOT}")
    server = ThreadingHTTPServer((HOST, PORT), LauncherHandler)
    print(
        f"Touchscreen launcher bridge on http://{HOST}:{PORT} "
        f"(static root {STATIC_ROOT})",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
