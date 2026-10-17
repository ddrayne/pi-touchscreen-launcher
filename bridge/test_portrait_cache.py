#!/usr/bin/env python3
"""The portrait cache backfills a tint and a focal point lazily, and knows a missing Pillow from a broken image."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import launcher_bridge
import portrait_features as features_module
from launcher_bridge import PortraitCache

try:
    from PIL import Image, ImageDraw

    HAVE_PILLOW = True
except ImportError:  # pragma: no cover - exercised only where Pillow is absent
    HAVE_PILLOW = False


def red_square_png() -> bytes:
    image = Image.new("RGB", (128, 128), (118, 122, 128))
    ImageDraw.Draw(image).rectangle((72, 72, 119, 119), fill=(220, 40, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class CacheHarness:
    """A portrait cache in a temporary directory holding one portrait that predates features."""

    def __init__(self, image: bytes) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = PortraitCache(self.root)
        self.meta_path, _ = self.cache._paths("Turdus merula")
        (self.root / "bird.jpg").write_bytes(image)
        self.original = json.dumps({"file": "bird.jpg", "title": "Blackbird", "artist": "A. Photographer"})
        self.meta_path.write_text(self.original, "utf-8")

    def lookup(self) -> dict | None:
        return self.cache.lookup("Turdus merula")

    def stored(self) -> dict:
        return json.loads(self.meta_path.read_text("utf-8"))

    def close(self) -> None:
        self.tmp.cleanup()


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class WithPillowTests(unittest.TestCase):
    def test_a_readable_portrait_gains_a_tint_and_a_focal_point(self) -> None:
        harness = CacheHarness(red_square_png())
        self.addCleanup(harness.close)
        meta = harness.lookup()
        assert meta is not None
        self.assertEqual(meta["title"], "Blackbird")
        self.assertGreater(meta["tint"][0], 150)
        self.assertGreater(meta["focal"]["x"], 0.6)
        self.assertNotIn("features_checked", meta)
        stored = harness.stored()
        self.assertEqual(stored["tint"], meta["tint"])
        self.assertEqual(stored["focal"], meta["focal"])
        self.assertNotIn("features_checked", stored)

    def test_a_broken_image_is_marked_checked_without_a_tint_and_not_retried(self) -> None:
        harness = CacheHarness(b"not an image at all")
        self.addCleanup(harness.close)
        meta = harness.lookup()
        assert meta is not None
        self.assertNotIn("tint", meta)
        self.assertNotIn("focal", meta)
        self.assertIs(meta["features_checked"], True)
        stored = harness.stored()
        self.assertNotIn("tint", stored)
        self.assertIs(stored["features_checked"], True)
        self.assertEqual(stored["artist"], "A. Photographer")
        with mock.patch.object(launcher_bridge, "portrait_features", side_effect=AssertionError("retried")):
            again = harness.lookup()
        self.assertEqual(again, stored)


class WithoutPillowTests(unittest.TestCase):
    """Whatever the machine has, these run as if Pillow could not be imported."""

    def setUp(self) -> None:
        patcher = mock.patch.dict(sys.modules, {"PIL": None, "PIL.Image": None})
        patcher.start()
        self.addCleanup(patcher.stop)
        warned = mock.patch.object(features_module, "_pillow_warned", False)
        warned.start()
        self.addCleanup(warned.stop)

    def test_the_meta_is_returned_untouched_so_a_later_run_can_backfill(self) -> None:
        harness = CacheHarness(b"\x89PNG\r\n\x1a\n")
        self.addCleanup(harness.close)
        with contextlib.redirect_stdout(io.StringIO()):
            meta = harness.lookup()
        self.assertEqual(meta, json.loads(harness.original))
        self.assertNotIn("features_checked", meta)
        self.assertNotIn("tint", meta)
        self.assertEqual(harness.meta_path.read_text("utf-8"), harness.original)

    def test_the_missing_pillow_is_logged_once_across_lookups(self) -> None:
        harness = CacheHarness(b"\x89PNG\r\n\x1a\n")
        self.addCleanup(harness.close)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            harness.lookup()
            harness.lookup()
            harness.lookup()
        lines = [line for line in out.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("python3-pil", lines[0])


if __name__ == "__main__":
    unittest.main()
