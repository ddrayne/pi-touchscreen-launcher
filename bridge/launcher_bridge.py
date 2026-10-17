#!/usr/bin/env python3
"""Local-only bridge for the Pi touchscreen launcher.

The browser never receives a Gateway bearer token. This process serves the
static launcher, proxies the read-only BirdFrame snapshot, reports appliance
health, and switches the two fullscreen windows through wlrctl.

For the frame it also keeps one long poll open to BirdFrame and republishes
arrivals as server-sent events, caches Wikimedia portraits and the day's
painting on the Pi so a cold boot or a LAN outage never shows an empty
frame, proxies recordings to the speaker, and sets the panel backlight.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from launcher_watchdog import LauncherWatchdog
from portrait_features import pillow_available, portrait_features


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
LAUNCHER_LATITUDE = float(os.environ.get("LAUNCHER_LATITUDE", "55.95"))
LAUNCHER_LONGITUDE = float(os.environ.get("LAUNCHER_LONGITUDE", "-3.19"))
LAUNCHER_FACING = float(os.environ.get("LAUNCHER_FACING", "180"))
LAUNCHER_PLACE = os.environ.get("LAUNCHER_PLACE", "Edinburgh").strip() or "Edinburgh"
LAUNCHER_SERVICE = os.environ.get("LAUNCHER_SERVICE", "touchscreen-launcher.service")
LAUNCHER_DEVTOOLS_URL = os.environ.get("LAUNCHER_DEVTOOLS_URL", "http://127.0.0.1:9222").rstrip("/")
# Chromium keeps its shared memory in one of these tmpfs mounts (Debian's
# wrapper picks /tmp); a leak there is the first sign of a wedge.
LAUNCHER_SHM_DIRS = [
    path for path in os.environ.get("LAUNCHER_SHM_DIRS", "/tmp:/dev/shm").split(":") if path
]
WATCHDOG_INTERVAL = float(os.environ.get("LAUNCHER_WATCHDOG_INTERVAL", "30"))
CACHE_ROOT = Path(
    os.environ.get(
        "LAUNCHER_CACHE_ROOT",
        str(Path.home() / ".cache" / "touchscreen-launcher"),
    )
)
PORTRAIT_CACHE = CACHE_ROOT / "portraits"
MEDIA_CACHE = CACHE_ROOT / "media"
SNAPSHOT_CACHE = CACHE_ROOT / "last-now.json"
BACKLIGHT_ROOT = Path(os.environ.get("LAUNCHER_BACKLIGHT_ROOT", "/sys/class/backlight"))
WIKIMEDIA_USER_AGENT = (
    "PiTouchscreenLauncher/1 (https://github.com/ddrayne/pi-touchscreen-launcher)"
)
PORTRAIT_RETRY_SECONDS = 24 * 60 * 60
SNAPSHOT_INTERVAL = 30.0
LONG_POLL_SECONDS = 15
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
    return request_json(url, "POST", payload, timeout)


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
            "User-Agent": "PiTouchscreenLauncher/1",
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
            result = {"error": "Touchscreen broker request failed"}
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


def detect_camera_barcode(image: bytes) -> str:
    scanner = shutil.which("zbarimg")
    if not scanner:
        return ""
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as image_file:
            image_file.write(image)
            temp_path = image_file.name
        result = subprocess.run(
            [scanner, "--quiet", "--raw", temp_path],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode not in {0, 4}:
            return ""
        return "".join(
            character
            for character in result.stdout.splitlines()[0].strip()
            if character.isalnum() or character == "-"
        )[:64] if result.stdout.strip() else ""
    except (OSError, subprocess.SubprocessError):
        return ""
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


class EventHub:
    """Fan-out of small events to every open server-sent event stream."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.clients: set[queue.Queue[tuple[str, dict[str, Any]]]] = set()

    def subscribe(self) -> queue.Queue[tuple[str, dict[str, Any]]]:
        client: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue(maxsize=50)
        with self.lock:
            self.clients.add(client)
        return client

    def unsubscribe(self, client: queue.Queue[tuple[str, dict[str, Any]]]) -> None:
        with self.lock:
            self.clients.discard(client)

    def broadcast(self, event: str, payload: dict[str, Any]) -> None:
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.put_nowait((event, payload))
            except queue.Full:
                self.unsubscribe(client)


WAKE_EVENTS = EventHub()


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
    WAKE_EVENTS.broadcast("wake", dict(payload))
    focused, detail = focus_window("assistant")
    payload.update({"focused": focused, "detail": detail})
    return payload


def acknowledge_wake(sequence: int | None) -> dict[str, Any]:
    global WAKE_EXPIRES_AT

    with WAKE_LOCK:
        if sequence is None or sequence == WAKE_SEQUENCE:
            WAKE_EXPIRES_AT = 0.0
    status = wake_status()
    WAKE_EVENTS.broadcast("wake", status)
    return status


def mute_wake(seconds: float) -> dict[str, Any]:
    global WAKE_EXPIRES_AT, WAKE_MUTED_UNTIL

    duration = max(0.0, min(seconds, 60.0))
    with WAKE_LOCK:
        WAKE_EXPIRES_AT = 0.0
        WAKE_MUTED_UNTIL = time.monotonic() + duration
        status = {
            "pending": False,
            "sequence": WAKE_SEQUENCE,
            "muted": duration > 0,
        }
    WAKE_EVENTS.broadcast("wake", dict(status))
    return status


def launcher_uptime() -> float | None:
    """Seconds since the kiosk service last became active, or None when it is not."""
    try:
        result = subprocess.run(
            [
                "/usr/bin/systemctl",
                "--user",
                "show",
                LAUNCHER_SERVICE,
                "-p",
                "ActiveState",
                "-p",
                "ActiveEnterTimestampMonotonic",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if values.get("ActiveState") != "active":
        return None
    try:
        entered = int(values.get("ActiveEnterTimestampMonotonic", "0")) / 1_000_000
    except ValueError:
        return None
    return max(0.0, time.monotonic() - entered)


def launcher_window_active() -> bool:
    """True unless the compositor says another window has the screen."""
    try:
        result = subprocess.run(
            ["/usr/bin/wlrctl", "toplevel", "find", WINDOW_MATCHES["assistant"], "state:active"],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    return result.returncode == 0


def devtools_ok() -> bool:
    """The browser's UI thread answers this; a wedged one never does."""
    try:
        with urllib.request.urlopen(f"{LAUNCHER_DEVTOOLS_URL}/json/version", timeout=5) as response:
            return 200 <= response.status < 300
    except (OSError, ValueError, urllib.error.URLError):
        return False


def shared_memory_used() -> int:
    used = 0
    for path in LAUNCHER_SHM_DIRS:
        try:
            stats = os.statvfs(path)
        except OSError:
            continue
        used = max(used, (stats.f_blocks - stats.f_bfree) * stats.f_frsize)
    return used


def restart_launcher(reason: str) -> None:
    subprocess.run(
        ["/usr/bin/systemctl", "--user", "restart", LAUNCHER_SERVICE],
        check=False,
        capture_output=True,
        timeout=90,
    )


WATCHDOG = LauncherWatchdog(
    launcher_uptime=launcher_uptime,
    window_active=launcher_window_active,
    devtools_ok=devtools_ok,
    tmp_used_bytes=shared_memory_used,
    restart=restart_launcher,
    log=lambda message: print(message, flush=True),
)


def run_watchdog() -> None:
    while True:
        time.sleep(WATCHDOG_INTERVAL)
        try:
            WATCHDOG.tick()
        except Exception as error:  # noqa: BLE001 - the watchdog must outlive any surprise
            print(f"Launcher watchdog error: {error}", flush=True)


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._")
    return cleaned[:120] or "unknown"


def strip_tags(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def fetch_bytes(url: str, timeout: float = 20.0, user_agent: str = "PiTouchscreenLauncher/1") -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get("Content-Type", "application/octet-stream")
        return response.read(), content_type.split(";")[0].strip()


class BirdframeWatcher:
    """One long poll to BirdFrame, republished to every open event stream."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.clients: set[queue.Queue[tuple[str, dict[str, Any]]]] = set()
        self.snapshot: dict[str, Any] | None = None
        self.today: dict[str, Any] | None = None
        self.reachable = False
        self.cursor = 0
        self.thread: threading.Thread | None = None
        self._load_cached_snapshot()

    def _load_cached_snapshot(self) -> None:
        try:
            cached = json.loads(SNAPSHOT_CACHE.read_text("utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(cached, dict) and isinstance(cached.get("now"), dict):
            self.snapshot = cached["now"]
            self.today = cached.get("today") if isinstance(cached.get("today"), dict) else None

    def start(self) -> None:
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._run, name="birdframe-watcher", daemon=True)
        self.thread.start()

    def subscribe(self) -> queue.Queue[tuple[str, dict[str, Any]]]:
        client: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue(maxsize=200)
        with self.lock:
            self.clients.add(client)
        self.start()
        return client

    def unsubscribe(self, client: queue.Queue[tuple[str, dict[str, Any]]]) -> None:
        with self.lock:
            self.clients.discard(client)

    def broadcast(self, event: str, payload: dict[str, Any]) -> None:
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.put_nowait((event, payload))
            except queue.Full:
                self.unsubscribe(client)

    def snapshot_event(self) -> dict[str, Any]:
        return {"now": self.snapshot, "today": self.today, "reachable": self.reachable}

    def _refresh_snapshot(self) -> None:
        now = fetch_json(f"{BIRDFRAME_URL}/api/now", timeout=8.0)
        try:
            today = fetch_json(f"{BIRDFRAME_URL}/api/today", timeout=8.0)
        except (OSError, ValueError, urllib.error.URLError):
            today = self.today
        if not isinstance(now, dict):
            raise ValueError("BirdFrame returned an unexpected snapshot")
        self.snapshot = now
        self.today = today if isinstance(today, dict) else None
        self.reachable = True
        cursor = now.get("cursor")
        if isinstance(cursor, int) and cursor > self.cursor:
            self.cursor = cursor
        try:
            CACHE_ROOT.mkdir(parents=True, exist_ok=True)
            SNAPSHOT_CACHE.write_text(
                json.dumps({"now": now, "today": self.today, "saved_at": time.time()}),
                "utf-8",
            )
        except OSError:
            pass
        self.broadcast("snapshot", self.snapshot_event())

    def _long_poll(self) -> None:
        rows = fetch_json(
            f"{BIRDFRAME_URL}/api/detections?after_id={self.cursor}&wait={LONG_POLL_SECONDS}&limit=20",
            timeout=LONG_POLL_SECONDS + 10,
        )
        self.reachable = True
        detections = rows.get("detections") if isinstance(rows, dict) else rows
        if isinstance(rows, dict) and not isinstance(detections, list):
            detections = rows.get("rows") or rows.get("items") or []
        for row in sorted(
            (entry for entry in (detections or []) if isinstance(entry, dict)),
            key=lambda entry: entry.get("id", 0),
        ):
            row_id = row.get("id")
            if isinstance(row_id, int) and row_id > self.cursor:
                self.cursor = row_id
            self.broadcast("detection", row)
        next_cursor = rows.get("next_cursor") if isinstance(rows, dict) else None
        if isinstance(next_cursor, int) and next_cursor > self.cursor:
            self.cursor = next_cursor
        self.broadcast("heartbeat", {"reachable": True})

    def _run(self) -> None:
        last_snapshot = 0.0
        while True:
            try:
                if time.monotonic() - last_snapshot >= SNAPSHOT_INTERVAL:
                    self._refresh_snapshot()
                    last_snapshot = time.monotonic()
                self._long_poll()
            except (OSError, ValueError, urllib.error.URLError) as error:
                if self.reachable:
                    print(f"BirdFrame watcher lost contact: {error}", flush=True)
                self.reachable = False
                self.broadcast("heartbeat", {"reachable": False})
                time.sleep(5)


WATCHER = BirdframeWatcher()


class PortraitCache:
    """Wikimedia portraits with their credits, kept on the Pi."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.Lock()
        self.warming = False

    def _paths(self, scientific_name: str) -> tuple[Path, str]:
        key = safe_name(scientific_name)
        return self.root / f"{key}.json", key

    def lookup(self, scientific_name: str) -> dict[str, Any] | None:
        meta_path, key = self._paths(scientific_name)
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
        except (OSError, ValueError):
            meta = None
        if isinstance(meta, dict):
            if meta.get("missing"):
                if time.time() - float(meta.get("checked_at", 0)) < PORTRAIT_RETRY_SECONDS:
                    return None
            elif (self.root / str(meta.get("file", ""))).is_file():
                if "tint" in meta or meta.get("features_checked"):
                    return meta
                return self._with_features(meta, meta_path)
        with self.lock:
            return self._fetch(scientific_name, meta_path, key)

    def _with_features(self, meta: dict[str, Any], meta_path: Path) -> dict[str, Any]:
        """Add the tint and focal point to a portrait cached before they existed, once.

        Without Pillow the meta is left exactly as it is, so a later run with
        python3-pil installed still backfills it; only an image Pillow cannot
        read is marked ``features_checked`` so it is not reopened every lookup.
        """
        if not pillow_available(log=lambda message: print(message, flush=True)):
            return meta
        with self.lock:
            try:
                fresh = json.loads(meta_path.read_text("utf-8"))
                if isinstance(fresh, dict) and ("tint" in fresh or fresh.get("features_checked")):
                    return fresh
            except (OSError, ValueError):
                pass
            try:
                features = portrait_features((self.root / str(meta["file"])).read_bytes())
            except Exception:  # noqa: BLE001 - a portrait without features is still a portrait
                features = None
            if features:
                meta.update(features)
            else:
                meta["features_checked"] = True
            try:
                meta_path.write_text(json.dumps(meta), "utf-8")
            except OSError:
                pass
            return meta

    def _fetch(self, scientific_name: str, meta_path: Path, key: str) -> dict[str, Any] | None:
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            page = self._wikipedia_page(scientific_name)
            info = self._commons_info(page["file"]) if page else None
            if not page or not info:
                raise LookupError("no free portrait")
            image, content_type = fetch_bytes(info["url"], timeout=30.0, user_agent=WIKIMEDIA_USER_AGENT)
            extension = {"image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}.get(content_type, ".jpg")
            file_name = f"{key}{extension}"
            (self.root / file_name).write_bytes(image)
            meta = {
                "file": file_name,
                "contentType": content_type,
                "title": page["title"],
                "artist": info["artist"],
                "license": info["license"],
                "source": info["source"],
                "checked_at": time.time(),
            }
            features = portrait_features(image)
            if features:
                meta.update(features)
            meta_path.write_text(json.dumps(meta), "utf-8")
            return meta
        except (OSError, ValueError, LookupError, KeyError, urllib.error.URLError) as error:
            try:
                meta_path.write_text(json.dumps({"missing": True, "checked_at": time.time(), "reason": str(error)}), "utf-8")
            except OSError:
                pass
            return None

    def _wikipedia_page(self, scientific_name: str) -> dict[str, str] | None:
        params = urllib.parse.urlencode(
            {
                "action": "query",
                "prop": "pageimages|info",
                "titles": scientific_name,
                "pithumbsize": "1000",
                "piprop": "name|thumbnail",
                "pilicense": "free",
                "inprop": "url",
                "redirects": "1",
                "format": "json",
                "formatversion": "2",
            }
        )
        data, _ = fetch_bytes(f"https://en.wikipedia.org/w/api.php?{params}", user_agent=WIKIMEDIA_USER_AGENT)
        pages = json.loads(data).get("query", {}).get("pages", [])
        if not pages:
            return None
        page = pages[0]
        file_name = page.get("pageimage")
        if not file_name:
            return None
        return {"file": str(file_name), "title": str(page.get("title") or scientific_name)}

    def _commons_info(self, file_name: str) -> dict[str, str] | None:
        params = urllib.parse.urlencode(
            {
                "action": "query",
                "prop": "imageinfo",
                "titles": f"File:{file_name}",
                "iiprop": "url|extmetadata",
                "iiurlwidth": "1000",
                "iiextmetadatafilter": "Artist|Credit|Attribution|LicenseShortName|LicenseUrl|UsageTerms",
                "format": "json",
                "formatversion": "2",
            }
        )
        data, _ = fetch_bytes(f"https://commons.wikimedia.org/w/api.php?{params}", user_agent=WIKIMEDIA_USER_AGENT)
        pages = json.loads(data).get("query", {}).get("pages", [])
        if not pages or not pages[0].get("imageinfo"):
            return None
        info = pages[0]["imageinfo"][0]
        metadata = info.get("extmetadata", {})

        def field(name: str) -> str:
            value = metadata.get(name, {}).get("value")
            return strip_tags(str(value)) if value else ""

        url = info.get("thumburl") or info.get("url")
        if not url:
            return None
        return {
            "url": str(url),
            "artist": field("Attribution") or field("Artist") or "Wikimedia contributor",
            "license": field("LicenseShortName") or field("UsageTerms") or "See source for licence",
            "source": str(info.get("descriptionurl") or ""),
        }

    def warm(self, scientific_names: list[str]) -> None:
        if self.warming:
            return
        self.warming = True

        def run() -> None:
            try:
                for name in scientific_names:
                    meta_path, _ = self._paths(name)
                    if meta_path.exists():
                        continue
                    self.lookup(name)
                    time.sleep(1.5)
            finally:
                self.warming = False

        threading.Thread(target=run, name="portrait-warm", daemon=True).start()


PORTRAITS = PortraitCache(PORTRAIT_CACHE)


def warm_portraits_from_census() -> None:
    try:
        census = fetch_json(f"{BIRDFRAME_URL}/api/census", timeout=10.0)
    except (OSError, ValueError, urllib.error.URLError):
        return
    entries = census.get("life_list") if isinstance(census, dict) else census
    if isinstance(census, dict) and not isinstance(entries, list):
        entries = census.get("species") or census.get("rows") or []
    names = [
        str(entry.get("scientific_name"))
        for entry in (entries or [])
        if isinstance(entry, dict) and entry.get("scientific_name")
    ]
    if names:
        PORTRAITS.warm(names)


def cached_media(path: str, timeout: float = 20.0) -> tuple[bytes, str]:
    """A BirdFrame byte resource, cached by path on the Pi."""
    MEDIA_CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(path.encode("utf-8")).hexdigest()[:40]
    data_path = MEDIA_CACHE / key
    type_path = MEDIA_CACHE / f"{key}.type"
    if data_path.is_file() and type_path.is_file():
        return data_path.read_bytes(), type_path.read_text("utf-8").strip()
    data, content_type = fetch_bytes(f"{BIRDFRAME_URL}{path}", timeout=timeout)
    try:
        data_path.write_bytes(data)
        type_path.write_text(content_type, "utf-8")
    except OSError:
        pass
    return data, content_type


NARRATION_CACHE: tuple[float, str, str] = (0.0, "", "")


def day_record() -> dict[str, Any]:
    global NARRATION_CACHE
    today = date.today().isoformat()
    try:
        detail = fetch_json(f"{BIRDFRAME_URL}/api/day/{today}", timeout=10.0)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        detail = {}
    if not isinstance(detail, dict):
        detail = {}
    cached_at, cached_day, narration = NARRATION_CACHE
    if cached_day != today or time.monotonic() - cached_at > 600:
        try:
            result = fetch_json(f"{BIRDFRAME_URL}/api/narration", timeout=20.0)
            narration = str(result.get("narration") or "") if isinstance(result, dict) else ""
        except (OSError, ValueError, urllib.error.URLError):
            narration = narration if cached_day == today else ""
        NARRATION_CACHE = (time.monotonic(), today, narration)
    images = [
        {"id": image.get("id"), "url": f"/api/birdframe/artwork/{image.get('id')}?w=1200"}
        for image in (detail.get("images") or [])
        if isinstance(image, dict) and isinstance(image.get("id"), int)
    ]
    clips = [
        {
            "common_name": clip.get("common_name"),
            "url": f"/api/birdframe/clip/{today}/{urllib.parse.quote(str(clip.get('common_name')))}",
        }
        for clip in (detail.get("clips") or [])
        if isinstance(clip, dict) and clip.get("common_name")
    ]
    return {
        "date": today,
        "species": detail.get("species") or [],
        "new_species": detail.get("new_species") or [],
        "clips": clips,
        "images": images,
        "narration": narration,
    }


def backlight_files() -> tuple[Path, Path] | None:
    if not BACKLIGHT_ROOT.is_dir():
        return None
    for candidate in sorted(BACKLIGHT_ROOT.iterdir()):
        brightness = candidate / "brightness"
        maximum = candidate / "max_brightness"
        if brightness.is_file() and maximum.is_file():
            return brightness, maximum
    return None


def read_backlight() -> dict[str, Any]:
    files = backlight_files()
    if files is None:
        return {"available": False, "brightness": None}
    brightness, maximum = files
    try:
        current = int(brightness.read_text("utf-8").strip())
        top = int(maximum.read_text("utf-8").strip())
    except (OSError, ValueError):
        return {"available": False, "brightness": None}
    return {"available": True, "brightness": current / top if top else None, "raw": current, "max": top}


def write_backlight(fraction: float) -> dict[str, Any]:
    files = backlight_files()
    if files is None:
        return {"available": False, "brightness": None, "error": "No backlight under " + str(BACKLIGHT_ROOT)}
    brightness, maximum = files
    top = int(maximum.read_text("utf-8").strip())
    level = max(1, min(top, round(top * max(0.0, min(1.0, fraction)))))
    brightness.write_text(f"{level}\n", "utf-8")
    return {"available": True, "brightness": level / top, "raw": level, "max": top}


class LauncherHandler(SimpleHTTPRequestHandler):
    server_version = "PiTouchscreenLauncher/1"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def end_headers(self) -> None:
        if self.path.split("?", 1)[0] in {"/", "/index.html"}:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        # Routine successful reads (the heartbeat poll, assets, snapshots)
        # would be a hundred thousand journal lines a day; keep writes and errors.
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        if self.command == "GET" and 200 <= status < 400:
            return
        super().log_request(code, size)

    def log_message(self, message: str, *args: Any) -> None:
        print(f"{self.address_string()} - {message % args}", flush=True)

    def note_page_activity(self) -> None:
        """Only the page's own main thread makes these requests."""
        WATCHDOG.heartbeat()

    def stream_wake_events(self) -> None:
        client = WAKE_EVENTS.subscribe()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(f"event: wake\ndata: {json.dumps(wake_status())}\n\n".encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    event, payload = client.get(timeout=15.0)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            WAKE_EVENTS.unsubscribe(client)

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

    def proxy_shopping_write(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        if method == "POST" and path == "/api/shopping/items":
            broker_path = "/shopping/items"
        elif method == "POST" and path == "/api/shopping/items/batch":
            broker_path = "/shopping/items/batch"
        elif method == "POST" and path == "/api/shopping/reconcile":
            broker_path = "/shopping/reconcile"
        elif method == "POST" and path == "/api/shopping/organize":
            broker_path = "/shopping/organize"
        elif method == "POST" and path == "/api/shopping/share":
            broker_path = "/shopping/share"
        elif method == "POST" and path == "/api/shopping/household":
            broker_path = "/shopping/household"
        elif method == "POST" and path == "/api/shopping/clear-completed":
            broker_path = "/shopping/clear-completed"
        elif method in {"PATCH", "DELETE"} and path.startswith(
            "/api/shopping/items/"
        ):
            broker_path = path.removeprefix("/api")
        else:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        payload = self.read_json_payload(24 * 1024)
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
        except (
            OSError,
            ValueError,
            TimeoutError,
            urllib.error.URLError,
        ) as error:
            self.send_json(
                {
                    "error": "The household shopping list is unavailable",
                    "detail": str(error),
                },
                HTTPStatus.BAD_GATEWAY,
            )

    def proxy_shopping_events(self) -> None:
        request = urllib.request.Request(
            f"{VOICE_BROKER_URL}/shopping/events",
            headers={
                "Accept": "text/event-stream",
                "User-Agent": "PiTouchscreenLauncher/1",
            },
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
                    {
                        "error": "Shopping updates are unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            self.close_connection = True

    def stream_birdframe_events(self) -> None:
        client = WATCHER.subscribe()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(b": hello\n\n")
            self.wfile.write(
                f"event: snapshot\ndata: {json.dumps(WATCHER.snapshot_event())}\n\n".encode("utf-8")
            )
            self.wfile.flush()
            while True:
                try:
                    event, payload = client.get(timeout=15.0)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(
                    f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
                )
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            WATCHER.unsubscribe(client)

    def serve_portrait(self) -> None:
        rest = self.path[len("/api/birdframe/portrait/"):].split("?", 1)[0]
        parts = [urllib.parse.unquote(part) for part in rest.split("/") if part]
        if not parts:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        scientific_name = parts[0].strip()
        meta = PORTRAITS.lookup(scientific_name)
        if meta is None:
            self.send_json({"error": "No free portrait is known for this species"}, HTTPStatus.NOT_FOUND)
            return
        if len(parts) > 1 and parts[1] == "image":
            file_path = PORTRAIT_CACHE / str(meta["file"])
            try:
                image = file_path.read_bytes()
            except OSError:
                self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", str(meta.get("contentType") or "image/jpeg"))
            self.send_header("Content-Length", str(len(image)))
            self.send_header("Cache-Control", "max-age=2592000, immutable")
            self.end_headers()
            self.wfile.write(image)
            return
        self.send_json(
            {
                "image": f"/api/birdframe/portrait/{urllib.parse.quote(scientific_name)}/image",
                "title": meta.get("title"),
                "artist": meta.get("artist"),
                "license": meta.get("license"),
                "source": meta.get("source"),
                "tint": meta.get("tint"),
                "focal": meta.get("focal"),
            }
        )

    def serve_artwork(self) -> None:
        path, _, query = self.path.partition("?")
        image_id = path[len("/api/birdframe/artwork/"):]
        if not image_id.isdigit():
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        width = urllib.parse.parse_qs(query).get("w", ["1200"])[0]
        suffix = f"?w={width}" if width.isdigit() else ""
        try:
            data, content_type = cached_media(f"/api/image/{image_id}{suffix}", timeout=30.0)
        except (OSError, urllib.error.URLError) as error:
            self.send_json(
                {"error": "The painting is unavailable", "detail": str(error)},
                HTTPStatus.BAD_GATEWAY,
            )
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def serve_clip(self) -> None:
        path, _, query = self.path.partition("?")
        upstream = ""
        if path.startswith("/api/birdframe/clip/"):
            upstream = "/api/clip/" + path[len("/api/birdframe/clip/"):]
        else:
            upstream = urllib.parse.parse_qs(query).get("url", [""])[0]
        if not upstream.startswith("/api/clip/") or ".." in upstream:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            data, content_type = fetch_bytes(f"{BIRDFRAME_URL}{upstream}", timeout=15.0)
        except urllib.error.HTTPError as error:
            self.send_json({"error": "No recording"}, HTTPStatus.NOT_FOUND if error.code == 404 else HTTPStatus.BAD_GATEWAY)
            return
        except (OSError, urllib.error.URLError) as error:
            self.send_json(
                {"error": "The recording is unavailable", "detail": str(error)},
                HTTPStatus.BAD_GATEWAY,
            )
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "audio/ogg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def analyze_camera_for_shopping(self) -> None:
        payload = self.read_json_payload(1024)
        if payload is None:
            return
        try:
            image = capture_camera_jpeg()
            barcode = detect_camera_barcode(image)
            status, result = request_json(
                f"{VOICE_BROKER_URL}/shopping/camera/analyze",
                "POST",
                {
                    "imageBase64": base64.b64encode(image).decode("ascii"),
                    **({"barcode": barcode} if barcode else {}),
                },
                timeout=75.0,
            )
            self.send_json(result, status)
        except (
            OSError,
            RuntimeError,
            ValueError,
            TimeoutError,
            urllib.error.URLError,
        ) as error:
            self.send_json(
                {
                    "error": "The camera could not be analysed",
                    "detail": str(error),
                },
                HTTPStatus.BAD_GATEWAY,
            )

    def do_GET(self) -> None:  # noqa: N802
        self.note_page_activity()

        if self.path == "/api/wake/events":
            self.stream_wake_events()
            return

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
                    "shoppingReady": endpoint_ready(
                        f"{VOICE_BROKER_URL}/shopping"
                    ),
                    "openClawUrl": OPENCLAW_URL,
                    "frame": True,
                    "watchdog": WATCHDOG.status(),
                }
            )
            return

        if self.path == "/api/config":
            self.send_json(
                {
                    "latitude": LAUNCHER_LATITUDE,
                    "longitude": LAUNCHER_LONGITUDE,
                    "facing": LAUNCHER_FACING,
                    "place": LAUNCHER_PLACE,
                }
            )
            return

        if self.path.startswith("/api/birdframe/events"):
            self.stream_birdframe_events()
            return

        if self.path.startswith("/api/birdframe/today"):
            try:
                self.send_json(fetch_json(f"{BIRDFRAME_URL}/api/today", timeout=8.0))
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {"error": "BirdFrame is unavailable", "detail": str(error)},
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path.startswith("/api/birdframe/day"):
            try:
                self.send_json(day_record())
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {"error": "BirdFrame is unavailable", "detail": str(error)},
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path.startswith("/api/birdframe/portrait/"):
            self.serve_portrait()
            return

        if self.path.startswith("/api/birdframe/artwork/"):
            self.serve_artwork()
            return

        if self.path.startswith("/api/birdframe/clip"):
            self.serve_clip()
            return

        if self.path == "/api/display":
            self.send_json(read_backlight())
            return

        if self.path == "/api/household":
            try:
                self.send_json(
                    fetch_json(f"{VOICE_BROKER_URL}/household", timeout=15.0)
                )
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {
                        "error": "The household hub is unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path == "/api/shopping/events":
            self.proxy_shopping_events()
            return

        if self.path.startswith("/api/shopping/activity"):
            query = self.path.partition("?")[2]
            suffix = f"?{query}" if query else ""
            try:
                self.send_json(
                    fetch_json(
                        f"{VOICE_BROKER_URL}/shopping/activity{suffix}",
                        timeout=12.0,
                    )
                )
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {
                        "error": "Shopping activity is unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path == "/api/shopping/household":
            try:
                self.send_json(
                    fetch_json(
                        f"{VOICE_BROKER_URL}/shopping/household",
                        timeout=12.0,
                    )
                )
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {
                        "error": "Household shopping settings are unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path == "/api/shopping":
            try:
                self.send_json(fetch_json(f"{VOICE_BROKER_URL}/shopping", timeout=12.0))
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json(
                    {
                        "error": "The household shopping list is unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path.startswith("/api/birdframe"):
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
        # Wake triggers come from the wake listener and window switches from
        # BirdFrame's Home pill; everything else is the page itself.
        if self.path not in {"/api/wake", "/api/window"}:
            self.note_page_activity()

        if self.path == "/api/shopping/camera/analyze":
            self.analyze_camera_for_shopping()
            return

        if self.path == "/api/display":
            payload = self.read_json_payload(256)
            if payload is None:
                return
            brightness = payload.get("brightness")
            if not isinstance(brightness, (int, float)):
                self.send_json(
                    {"error": "brightness must be a number between 0 and 1"},
                    HTTPStatus.BAD_REQUEST,
                )
                return
            try:
                self.send_json(write_backlight(float(brightness)))
            except (OSError, ValueError) as error:
                self.send_json(
                    {"error": "The backlight could not be set", "detail": str(error)},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
            return

        if self.path == "/api/household/control":
            payload = self.read_json_payload(1024)
            if payload is None:
                return
            try:
                status, result = post_json(
                    f"{VOICE_BROKER_URL}/household/control",
                    payload,
                    timeout=18.0,
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
                        "error": "The household control is unavailable",
                        "detail": str(error),
                    },
                    HTTPStatus.BAD_GATEWAY,
                )
            return

        if self.path in {
            "/api/shopping/items",
            "/api/shopping/items/batch",
            "/api/shopping/reconcile",
            "/api/shopping/organize",
            "/api/shopping/share",
            "/api/shopping/household",
            "/api/shopping/clear-completed",
        }:
            self.proxy_shopping_write("POST")
            return

        voice_paths = {
            "/api/voice/session": "/session",
            "/api/voice/tool": "/tool",
            "/api/voice/control": "/control",
        }
        if self.path not in {"/api/window", "/api/wake", *voice_paths}:
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        body_limit = 128 * 1024 if self.path in voice_paths else 1024
        payload = self.read_json_payload(body_limit)
        if payload is None:
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
            if action != "trigger":
                self.note_page_activity()
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

    def do_PATCH(self) -> None:  # noqa: N802
        self.note_page_activity()
        self.proxy_shopping_write("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self.note_page_activity()
        self.proxy_shopping_write("DELETE")

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main() -> None:
    if not STATIC_ROOT.is_dir():
        raise SystemExit(f"Launcher static root does not exist: {STATIC_ROOT}")
    server = ThreadingHTTPServer((HOST, PORT), LauncherHandler)
    server.daemon_threads = True
    print(
        f"Touchscreen launcher bridge on http://{HOST}:{PORT} "
        f"(static root {STATIC_ROOT}, cache {CACHE_ROOT})",
        flush=True,
    )
    pillow_available(log=lambda message: print(message, flush=True))
    WATCHER.start()
    threading.Thread(target=warm_portraits_from_census, name="census-warm", daemon=True).start()
    threading.Thread(target=run_watchdog, name="launcher-watchdog", daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
