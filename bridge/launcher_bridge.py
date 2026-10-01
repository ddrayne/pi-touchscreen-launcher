#!/usr/bin/env python3
"""Local-only bridge for the Pi kitchen screen.

The browser never receives a Home Assistant token. This process serves the
static screen, proxies the Mac broker (shopping, household, weather, the
kitchen speaker and kitchen presence), relays BirdFrame's live garden data and
recordings, caches bird photos from Wikipedia, sleeps the display's backlight,
and switches between the screen and BirdFrame's own display window.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
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
VOICE_BROKER_URL = os.environ.get(
    "VOICE_BROKER_URL", "http://192.168.86.24:18890"
).rstrip("/")
LVA_PERIPHERAL_PORT = int(os.environ.get("LVA_PERIPHERAL_PORT", "6055"))
WIKIPEDIA_SUMMARY_URL = os.environ.get(
    "WIKIPEDIA_SUMMARY_URL", "https://en.wikipedia.org/api/rest_v1/page/summary/"
)
# systemd's CacheDirectory= hands the service a directory of its own; run by
# hand, the bridge uses the usual per-user cache.
PHOTO_CACHE_DIR = (
    Path(os.environ["CACHE_DIRECTORY"].split(":")[0]) / "bird-photos"
    if os.environ.get("CACHE_DIRECTORY")
    else Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    / "touchscreen-launcher"
    / "bird-photos"
)
BACKLIGHT_ROOT = Path(os.environ.get("BACKLIGHT_ROOT", "/sys/class/backlight"))
DISPLAY_SLEEP = os.environ.get("DISPLAY_SLEEP", "1") != "0"
USER_AGENT = "PiKitchenScreen/2 (household display)"

WINDOW_MATCHES = {
    "assistant": os.environ.get(
        "LAUNCHER_WINDOW_MATCH", "app_id:chrome-127.0.0.1__-Default"
    ),
    "birdframe": os.environ.get(
        "BIRDFRAME_WINDOW_MATCH", "app_id:com.example.birdframe_display"
    ),
}

DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SPECIES_NAME = re.compile(r"^[A-Za-z][A-Za-z .'()-]{1,79}$")
PHOTO_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
PHOTO_LIMIT = 3 * 1024 * 1024
CLIP_LIMIT = 8 * 1024 * 1024
PHOTO_RETRY_SECONDS = 6 * 3600
PHOTO_LOCK = threading.Lock()
PHOTO_MISSES: dict[str, float] = {}
MEMORY_PHOTOS: dict[str, tuple[str, bytes]] = {}


def fetch_json(url: str, timeout: float = 2.5) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def request_json(
    url: str,
    method: str,
    payload: dict[str, Any],
    timeout: float = 30.0,
) -> tuple[int, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            result = {"error": "Kitchen broker request failed"}
        return error.code, result


def endpoint_ready(url: str) -> bool:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            return 200 <= response.status < 500
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        return False


def port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.3):
            return True
    except OSError:
        return False


def service_active(name: str) -> bool:
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", "--user", "is-active", "--quiet", name],
            check=False,
            capture_output=True,
            timeout=3,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def focus_window(target: str) -> tuple[bool, str]:
    match = WINDOW_MATCHES[target]
    if target == "birdframe" and not service_active("birdframe-display.service"):
        subprocess.run(
            ["/usr/bin/systemctl", "--user", "start", "birdframe-display.service"],
            check=False,
            capture_output=True,
            timeout=8,
        )
    try:
        result = subprocess.run(
            ["/usr/bin/wlrctl", "toplevel", "focus", match],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return False, str(error)
    detail = (result.stderr or result.stdout).strip()
    return result.returncode == 0, detail


def birdframe_clip_url(day: str, quoted_name: str) -> str | None:
    """BirdFrame's recording URL for a validated day and species name."""
    name = urllib.parse.unquote(quoted_name)
    if not DAY.match(day) or not SPECIES_NAME.match(name):
        return None
    return f"{BIRDFRAME_URL}/api/clip/{day}/{urllib.parse.quote(name)}"


def photo_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def larger_thumbnail(url: str, width: int = 640) -> str:
    """Wikimedia thumbnails carry their width in the path, e.g. /330px-Robin.jpg."""

    def widen(match: re.Match[str]) -> str:
        if int(match.group(1)) >= width:
            return match.group(0)
        return f"/{width}px-{match.group(2)}"

    return re.sub(r"/(\d+)px-([^/]+)$", widen, url)


def read_image(url: str) -> tuple[str, bytes] | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=8) as response:
        content_type = response.headers.get_content_type()
        data = response.read(PHOTO_LIMIT + 1)
    if content_type not in PHOTO_TYPES or len(data) > PHOTO_LIMIT:
        return None
    return content_type, data


def fetch_bird_photo(name: str) -> tuple[str, bytes] | None:
    """The lead image of the species' Wikipedia article."""
    title = urllib.parse.quote(name.replace(" ", "_"))
    summary = fetch_json(f"{WIKIPEDIA_SUMMARY_URL}{title}", timeout=6)
    source = (summary.get("thumbnail") or {}).get("source") or (
        summary.get("originalimage") or {}
    ).get("source")
    if not isinstance(source, str) or not source.startswith(
        "https://upload.wikimedia.org/"
    ):
        return None
    for candidate in dict.fromkeys([larger_thumbnail(source), source]):
        try:
            photo = read_image(candidate)
        except (OSError, urllib.error.URLError):
            continue
        if photo:
            return photo
    return None


def cached_photo(slug: str) -> tuple[str, bytes] | None:
    if slug in MEMORY_PHOTOS:
        return MEMORY_PHOTOS[slug]
    for content_type, suffix in PHOTO_TYPES.items():
        path = PHOTO_CACHE_DIR / f"{slug}{suffix}"
        try:
            return content_type, path.read_bytes()
        except OSError:
            continue
    return None


def store_photo(slug: str, content_type: str, data: bytes) -> None:
    try:
        PHOTO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = PHOTO_CACHE_DIR / f".{slug}.{os.getpid()}.tmp"
        temporary.write_bytes(data)
        temporary.replace(PHOTO_CACHE_DIR / f"{slug}{PHOTO_TYPES[content_type]}")
    except OSError:
        # A read-only home still gets photos for this session.
        if len(MEMORY_PHOTOS) >= 60:
            MEMORY_PHOTOS.pop(next(iter(MEMORY_PHOTOS)))
        MEMORY_PHOTOS[slug] = (content_type, data)


def bird_photo(name: str) -> tuple[str, bytes] | None:
    slug = photo_slug(name)
    with PHOTO_LOCK:
        cached = cached_photo(slug)
        if cached:
            return cached
        missed_at = PHOTO_MISSES.get(slug)
        if missed_at is not None and time.monotonic() - missed_at < PHOTO_RETRY_SECONDS:
            return None
    try:
        photo = fetch_bird_photo(name)
    except (OSError, ValueError, urllib.error.URLError):
        photo = None
    with PHOTO_LOCK:
        if photo:
            store_photo(slug, *photo)
        else:
            PHOTO_MISSES[slug] = time.monotonic()
    return photo


def backlight_device() -> Path | None:
    try:
        devices = sorted(
            path for path in BACKLIGHT_ROOT.iterdir() if (path / "brightness").exists()
        )
    except OSError:
        return None
    return devices[0] if devices else None


def set_display_awake(awake: bool) -> dict[str, Any]:
    """Power the panel's backlight down while the kitchen is empty."""
    if not DISPLAY_SLEEP:
        return {"ok": False, "awake": awake, "detail": "Display sleep is disabled"}
    device = backlight_device()
    if device is None:
        return {"ok": False, "awake": awake, "detail": "No backlight control found"}
    try:
        power = device / "bl_power"
        if power.exists():
            power.write_text("0" if awake else "4")
        else:
            maximum = (device / "max_brightness").read_text().strip()
            (device / "brightness").write_text(maximum if awake else "0")
    except OSError as error:
        return {
            "ok": False,
            "awake": awake,
            "detail": f"The backlight is not writable ({error.strerror})",
        }
    return {"ok": True, "awake": awake}


class LauncherHandler(SimpleHTTPRequestHandler):
    server_version = "PiKitchenScreen/2"
    protocol_version = "HTTP/1.1"

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

    def send_bytes(self, data: bytes, content_type: str, cache_control: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def read_json_payload(self, body_limit: int) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json({"error": "Invalid content length"}, HTTPStatus.BAD_REQUEST)
            return None
        if content_length > body_limit:
            self.send_json(
                {"error": "Request body is too large"},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
            return None
        length = max(0, content_length)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self.send_json({"error": "Invalid JSON"}, HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(payload, dict):
            self.send_json(
                {"error": "JSON body must be an object"},
                HTTPStatus.BAD_REQUEST,
            )
            return None
        return payload

    def send_upstream_json(self, url: str, unavailable: str, timeout: float = 12.0) -> None:
        try:
            self.send_json(fetch_json(url, timeout=timeout))
        except urllib.error.HTTPError as error:
            self.send_json({"error": unavailable}, error.code)
        except (OSError, ValueError, urllib.error.URLError) as error:
            self.send_json(
                {"error": unavailable, "detail": str(error)},
                HTTPStatus.BAD_GATEWAY,
            )

    def send_upstream_bytes(
        self,
        url: str,
        allowed_type_prefix: str,
        limit: int,
        cache_control: str,
    ) -> None:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=10) as upstream:
                content_type = upstream.headers.get_content_type()
                data = upstream.read(limit + 1)
        except urllib.error.HTTPError as error:
            status = HTTPStatus.NOT_FOUND if error.code == 404 else HTTPStatus.BAD_GATEWAY
            self.send_json({"error": "Not available"}, status)
            return
        except (OSError, urllib.error.URLError) as error:
            self.send_json(
                {"error": "Not available", "detail": str(error)},
                HTTPStatus.BAD_GATEWAY,
            )
            return
        if not content_type.startswith(allowed_type_prefix) or len(data) > limit:
            self.send_json({"error": "Unexpected response"}, HTTPStatus.BAD_GATEWAY)
            return
        self.send_bytes(data, content_type, cache_control)

    def proxy_event_stream(self, broker_path: str) -> None:
        request = urllib.request.Request(
            f"{VOICE_BROKER_URL}{broker_path}",
            headers={"Accept": "text/event-stream", "User-Agent": USER_AGENT},
            method="GET",
        )
        headers_sent = False
        try:
            with urllib.request.urlopen(request, timeout=70.0) as upstream:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store, no-transform")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                headers_sent = True
                while True:
                    line = upstream.readline()
                    if not line:
                        break
                    self.wfile.write(line)
                    self.wfile.flush()
        except (
            BrokenPipeError,
            ConnectionResetError,
            TimeoutError,
            urllib.error.URLError,
        ) as error:
            if not headers_sent:
                self.send_json(
                    {"error": "Live updates are unavailable", "detail": str(error)},
                    HTTPStatus.BAD_GATEWAY,
                )
            self.close_connection = True

    def proxy_broker_write(self, method: str, broker_path: str, body_limit: int) -> None:
        payload = self.read_json_payload(body_limit)
        if payload is None:
            return
        try:
            status, result = request_json(
                f"{VOICE_BROKER_URL}{broker_path}",
                method,
                payload,
                timeout=15.0,
            )
            self.send_json(result, status)
        except (OSError, ValueError, TimeoutError, urllib.error.URLError) as error:
            self.send_json(
                {"error": "The kitchen broker is unavailable", "detail": str(error)},
                HTTPStatus.BAD_GATEWAY,
            )

    def shopping_write_path(self, method: str, path: str) -> str | None:
        if method == "POST" and path in {
            "/api/shopping/items",
            "/api/shopping/items/batch",
            "/api/shopping/reconcile",
            "/api/shopping/organize",
            "/api/shopping/share",
            "/api/shopping/household",
            "/api/shopping/clear-completed",
        }:
            return path.removeprefix("/api")
        if method in {"PATCH", "DELETE"} and path.startswith("/api/shopping/items/"):
            return path.removeprefix("/api")
        return None

    def send_bird_photo(self, query: str) -> None:
        name = (urllib.parse.parse_qs(query).get("name") or [""])[0].strip()
        if not SPECIES_NAME.match(name):
            self.send_json({"error": "A species name is required"}, HTTPStatus.BAD_REQUEST)
            return
        photo = bird_photo(name)
        if not photo:
            self.send_json({"error": "No photo for that species"}, HTTPStatus.NOT_FOUND)
            return
        self.send_bytes(photo[1], photo[0], "public, max-age=604800")

    def do_GET(self) -> None:  # noqa: N802
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path

        if path == "/api/status":
            self.send_json(
                {
                    "brokerReady": endpoint_ready(f"{VOICE_BROKER_URL}/health"),
                    "birdframeReady": endpoint_ready(f"{BIRDFRAME_URL}/api/now"),
                    "voiceReady": port_open("127.0.0.1", LVA_PERIPHERAL_PORT),
                }
            )
            return
        if path == "/api/birdframe":
            self.send_upstream_json(
                f"{BIRDFRAME_URL}/api/now", "BirdFrame is unavailable", timeout=4.0
            )
            return
        if path == "/api/birdframe/today":
            self.send_upstream_json(
                f"{BIRDFRAME_URL}/api/today", "BirdFrame is unavailable", timeout=6.0
            )
            return
        clip = re.fullmatch(r"/api/birdframe/clip/([^/]+)/([^/]+)", path)
        if clip:
            url = birdframe_clip_url(clip.group(1), clip.group(2))
            if url is None:
                self.send_json({"error": "Invalid recording"}, HTTPStatus.BAD_REQUEST)
                return
            self.send_upstream_bytes(url, "audio/", CLIP_LIMIT, "private, max-age=3600")
            return
        if path == "/api/birds/photo":
            self.send_bird_photo(parts.query)
            return
        if path in {"/api/weather", "/api/media", "/api/household", "/api/shopping"}:
            broker_path = path.removeprefix("/api")
            self.send_upstream_json(
                f"{VOICE_BROKER_URL}{broker_path}",
                "The kitchen broker is unavailable",
                timeout=15.0,
            )
            return
        if path == "/api/media/art":
            self.send_upstream_bytes(
                f"{VOICE_BROKER_URL}/media/art",
                "image/",
                4 * 1024 * 1024,
                "private, max-age=600",
            )
            return
        if path in {"/api/home/events", "/api/shopping/events"}:
            self.proxy_event_stream(path.removeprefix("/api"))
            return
        if path == "/api/shopping/activity":
            suffix = f"?{parts.query}" if parts.query else ""
            self.send_upstream_json(
                f"{VOICE_BROKER_URL}/shopping/activity{suffix}",
                "Shopping activity is unavailable",
            )
            return
        if path == "/api/shopping/household":
            self.send_upstream_json(
                f"{VOICE_BROKER_URL}/shopping/household",
                "Household shopping settings are unavailable",
            )
            return
        if path.startswith("/api/"):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        candidate = (STATIC_ROOT / path.lstrip("/")).resolve()
        if path == "/" or not candidate.is_file():
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        shopping = self.shopping_write_path("POST", path)
        if shopping:
            self.proxy_broker_write("POST", shopping, 24 * 1024)
            return
        if path in {"/api/household/control", "/api/media/control"}:
            self.proxy_broker_write("POST", path.removeprefix("/api"), 1024)
            return
        if path == "/api/display":
            payload = self.read_json_payload(1024)
            if payload is None:
                return
            if not isinstance(payload.get("awake"), bool):
                self.send_json({"error": "awake must be true or false"}, HTTPStatus.BAD_REQUEST)
                return
            self.send_json(set_display_awake(payload["awake"]))
            return
        if path == "/api/window":
            payload = self.read_json_payload(1024)
            if payload is None:
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
            return
        self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:  # noqa: N802
        self.proxy_shopping_item("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self.proxy_shopping_item("DELETE")

    def proxy_shopping_item(self, method: str) -> None:
        path = urllib.parse.urlsplit(self.path).path
        shopping = self.shopping_write_path(method, path)
        if not shopping:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        self.proxy_broker_write(method, shopping, 24 * 1024)

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main() -> None:
    if not STATIC_ROOT.is_dir():
        raise SystemExit(f"Launcher static root does not exist: {STATIC_ROOT}")
    server = ThreadingHTTPServer((HOST, PORT), LauncherHandler)
    print(
        f"Kitchen screen bridge on http://{HOST}:{PORT} (static root {STATIC_ROOT})",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
