"""Tests for the Pi bridge. Run with: python3 -m unittest discover -s tests -p 'test_*.py'"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bridge", ROOT / "bridge" / "launcher_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeUpstream(BaseHTTPRequestHandler):
    """Stands in for both the Mac broker and BirdFrame."""

    def log_message(self, *args):  # noqa: D401 - silence test output
        pass

    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/weather":
            self.reply(200, "application/json", b'{"hours":[]}')
        elif self.path == "/api/clip/2026-10-06/Song%20Thrush":
            self.reply(200, "audio/ogg", b"OggS-fake")
        elif self.path == "/media/art":
            self.reply(200, "text/html", b"<html>")
        elif self.path == "/health":
            self.reply(200, "application/json", b'{"ok":true}')
        elif self.path == "/home/events":
            # One event, then the broker goes away, as it does when it restarts.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'event: snapshot\ndata: {"presence":null}\n\n')
        else:
            self.reply(404, "application/json", b'{"error":"missing"}')

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.reply(200, "application/json", json.dumps({"echo": self.path, "body": body}).encode())


def serve(handler, **attributes):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    for name, value in attributes.items():
        setattr(server, name, value)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class HelperTests(unittest.TestCase):
    def test_clip_urls_are_validated_and_reencoded(self):
        bridge.BIRDFRAME_URL = "http://birdframe.test"
        self.assertEqual(
            bridge.birdframe_clip_url("2026-10-06", "Song%20Thrush"),
            "http://birdframe.test/api/clip/2026-10-06/Song%20Thrush",
        )
        self.assertIsNone(bridge.birdframe_clip_url("2026-10-6", "Robin"))
        self.assertIsNone(bridge.birdframe_clip_url("2026-10-06", "..%2F..%2Fetc"))
        self.assertIsNone(bridge.birdframe_clip_url("2026-10-06", "%3Cscript%3E"))

    def test_wikimedia_thumbnails_are_widened_not_shrunk(self):
        self.assertEqual(
            bridge.larger_thumbnail("https://upload.wikimedia.org/a/b/330px-Robin.jpg"),
            "https://upload.wikimedia.org/a/b/640px-Robin.jpg",
        )
        wide = "https://upload.wikimedia.org/a/b/1280px-Robin.jpg"
        self.assertEqual(bridge.larger_thumbnail(wide), wide)
        plain = "https://upload.wikimedia.org/a/b/Robin.jpg"
        self.assertEqual(bridge.larger_thumbnail(plain), plain)
        self.assertEqual(bridge.photo_slug("Erithacus rubecula"), "erithacus-rubecula")

    def test_backlight_powers_down_and_up(self):
        with tempfile.TemporaryDirectory() as root:
            bridge.BACKLIGHT_ROOT = Path(root)
            missing = bridge.set_display_awake(False)
            self.assertFalse(missing["ok"], "no device found")
            self.assertIs(missing["supported"], False, "so the screen stops retrying")
            device = Path(root) / "11-0045"
            device.mkdir()
            (device / "brightness").write_text("200")
            (device / "max_brightness").write_text("255")
            self.assertTrue(bridge.set_display_awake(False)["ok"])
            self.assertEqual((device / "brightness").read_text(), "0")
            bridge.set_display_awake(True)
            self.assertEqual((device / "brightness").read_text(), "255")
            (device / "bl_power").write_text("0")
            bridge.set_display_awake(False)
            self.assertEqual((device / "bl_power").read_text(), "4")

    def test_photos_are_cached_and_misses_remembered(self):
        calls = []

        def fake_fetch(name):
            calls.append(name)
            return ("image/jpeg", b"jpeg-bytes") if name == "Turdus merula" else None

        original = bridge.fetch_bird_photo
        bridge.fetch_bird_photo = fake_fetch
        try:
            with tempfile.TemporaryDirectory() as root:
                bridge.PHOTO_CACHE_DIR = Path(root)
                bridge.PHOTO_RETRY_AT.clear()
                bridge.MEMORY_PHOTOS.clear()
                self.assertEqual(bridge.bird_photo("Turdus merula"), ("image/jpeg", b"jpeg-bytes"))
                self.assertTrue((Path(root) / "turdus-merula.jpg").exists())
                self.assertEqual(bridge.bird_photo("Turdus merula")[1], b"jpeg-bytes")
                self.assertIsNone(bridge.bird_photo("Avis imaginaria"))
                self.assertIsNone(bridge.bird_photo("Avis imaginaria"))
                self.assertEqual(calls, ["Turdus merula", "Avis imaginaria"])
        finally:
            bridge.fetch_bird_photo = original


    def test_network_errors_retry_sooner_than_missing_photos(self):
        def unreachable(name):
            raise urllib.error.URLError("offline")

        original = bridge.fetch_bird_photo
        bridge.fetch_bird_photo = unreachable
        try:
            with tempfile.TemporaryDirectory() as root:
                bridge.PHOTO_CACHE_DIR = Path(root)
                bridge.PHOTO_RETRY_AT.clear()
                bridge.MEMORY_PHOTOS.clear()
                self.assertIsNone(bridge.bird_photo("Turdus merula"))
                wait = bridge.PHOTO_RETRY_AT["turdus-merula"] - time.monotonic()
                self.assertLessEqual(wait, bridge.PHOTO_NETWORK_RETRY_SECONDS)
        finally:
            bridge.fetch_bird_photo = original


class RequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.static = tempfile.TemporaryDirectory()
        (Path(cls.static.name) / "index.html").write_text("<!doctype html><title>Kitchen</title>")
        cls.upstream = serve(FakeUpstream)
        upstream_url = f"http://127.0.0.1:{cls.upstream.server_address[1]}"
        bridge.VOICE_BROKER_URL = upstream_url
        bridge.BIRDFRAME_URL = upstream_url
        bridge.STATIC_ROOT = Path(cls.static.name)
        bridge.LVA_PERIPHERAL_PORT = 9  # nothing listens on the discard port

        class Handler(bridge.LauncherHandler):
            def __init__(self, *args, **kwargs):
                super(bridge.LauncherHandler, self).__init__(*args, directory=cls.static.name, **kwargs)

            def log_message(self, *args):
                pass

        cls.server = serve(Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.upstream.shutdown()
        cls.static.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as response:
                return response.status, response.headers.get_content_type(), response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers.get_content_type(), error.read()

    def post(self, path, payload):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_proxies_broker_and_birdframe(self):
        self.assertEqual(self.get("/api/weather")[2], b'{"hours":[]}')
        status, content_type, body = self.get("/api/birdframe/clip/2026-10-06/Song%20Thrush")
        self.assertEqual((status, content_type, body), (200, "audio/ogg", b"OggS-fake"))
        self.assertEqual(self.get("/api/birdframe/clip/2026-10-06/..%2Fx")[0], 400)
        self.assertEqual(self.get("/api/media/art")[0], 502, "non-images are refused")
        status, _, body = self.get("/api/status")
        self.assertEqual(json.loads(body), {"brokerReady": True, "birdframeReady": False, "voiceReady": False})

    def test_writes_go_only_to_allowlisted_broker_routes(self):
        status, body = self.post("/api/media/control", {"action": "next"})
        self.assertEqual((status, body["echo"]), (200, "/media/control"))
        self.assertEqual(self.post("/api/voice/session", {})[0], 404, "V1 voice routes are gone")
        self.assertEqual(self.post("/api/display", {"awake": "yes"})[0], 400)

    def test_event_streams_end_when_the_broker_goes_away(self):
        # The browser only reconnects once the stream has really ended.
        with urllib.request.urlopen(self.base + "/api/home/events", timeout=5) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            body = response.read()
        self.assertIn(b"event: snapshot", body)

    def test_serves_the_screen_for_unknown_paths(self):
        status, content_type, body = self.get("/somewhere?x=1")
        self.assertEqual((status, content_type), (200, "text/html"))
        self.assertIn(b"Kitchen", body)
        self.assertEqual(self.get("/api/camera.jpg")[0], 404)


if __name__ == "__main__":
    unittest.main()
