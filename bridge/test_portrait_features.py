#!/usr/bin/env python3
"""Portrait features: the dominant tint and the focal point of a cached portrait."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import portrait_features as features_module
from portrait_features import backfill, focal_point, pillow_available, portrait_features

try:
    from PIL import Image, ImageDraw

    HAVE_PILLOW = True
except ImportError:  # pragma: no cover - exercised only where Pillow is absent
    HAVE_PILLOW = False


def png(image: "Image.Image") -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def grey_with_red_square() -> bytes:
    """Cool grey 128x128 with a red 48x48 square centred on (96, 96).

    A faintly cool grey, as a real photo's bokeh is.
    """
    image = Image.new("RGB", (128, 128), (118, 122, 128))
    ImageDraw.Draw(image).rectangle((72, 72, 119, 119), fill=(220, 40, 40))
    return png(image)


def big_orange_bird_on_grey() -> bytes:
    """A subject that fills most of the frame, with only a grey border of background."""
    image = Image.new("RGB", (120, 120), (150, 155, 165))
    ImageDraw.Draw(image).rectangle((20, 20, 99, 99), fill=(190, 110, 60))
    return png(image)


def green_with_dark_bird() -> bytes:
    """Leaf green 100x100 with a dark region covering a fifth of the frame."""
    image = Image.new("RGB", (100, 100), (90, 130, 60))
    ImageDraw.Draw(image).rectangle((30, 40, 69, 89), fill=(20, 20, 20))
    return png(image)


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class PortraitFeatureTests(unittest.TestCase):
    def test_a_red_subject_on_grey_sets_the_tint_and_the_focal_point(self) -> None:
        features = portrait_features(grey_with_red_square())
        self.assertIsNotNone(features)
        assert features is not None
        r, g, b = features["tint"]
        self.assertGreater(r, 150)
        self.assertLess(g, 90)
        self.assertLess(b, 90)
        self.assertTrue(all(isinstance(channel, int) for channel in features["tint"]))
        self.assertGreater(features["focal"]["x"], 0.6)
        self.assertGreater(features["focal"]["y"], 0.6)
        self.assertLessEqual(features["focal"]["x"], 1.0)
        self.assertLessEqual(features["focal"]["y"], 1.0)

    def test_a_subject_filling_the_frame_still_wins_over_its_border(self) -> None:
        features = portrait_features(big_orange_bird_on_grey())
        assert features is not None
        r, g, b = features["tint"]
        self.assertGreater(r, 160)
        self.assertGreater(g, 90)
        self.assertLess(b, 90)

    def test_dark_plumage_beats_a_green_background(self) -> None:
        features = portrait_features(green_with_dark_bird())
        assert features is not None
        self.assertTrue(all(channel < 60 for channel in features["tint"]), features["tint"])

    def test_a_uniform_image_focuses_on_the_centre(self) -> None:
        features = portrait_features(png(Image.new("RGB", (100, 60), (40, 90, 200))))
        assert features is not None
        self.assertEqual(features["focal"], {"x": 0.5, "y": 0.5})
        self.assertEqual(features["tint"], [40, 90, 200])

    def test_garbage_bytes_give_no_features(self) -> None:
        self.assertIsNone(portrait_features(b"not an image at all"))
        self.assertIsNone(portrait_features(b""))

    def test_the_focal_point_reads_the_resampling_constant_from_an_old_pillow_too(self) -> None:
        rgb = Image.open(io.BytesIO(grey_with_red_square())).convert("RGB")
        old_style = types.SimpleNamespace(BOX=Image.Resampling.BOX)  # Pillow < 9 had Image.BOX and no Resampling
        self.assertEqual(focal_point(rgb, old_style), focal_point(rgb, Image))

    def test_pillow_is_reported_available(self) -> None:
        self.assertTrue(pillow_available())

    def test_backfill_fills_meta_that_lacks_a_tint_and_leaves_the_rest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "bird.jpg").write_bytes(grey_with_red_square())
            (root / "bird.json").write_text(json.dumps({"file": "bird.jpg", "title": "Bird"}), "utf-8")
            (root / "done.jpg").write_bytes(grey_with_red_square())
            (root / "done.json").write_text(json.dumps({"file": "done.jpg", "tint": [1, 2, 3]}), "utf-8")
            (root / "gone.json").write_text(json.dumps({"file": "gone.jpg"}), "utf-8")
            (root / "missing.json").write_text(json.dumps({"missing": True}), "utf-8")
            lines = backfill(root)
            bird = json.loads((root / "bird.json").read_text("utf-8"))
            self.assertEqual(bird["title"], "Bird")
            self.assertGreater(bird["tint"][0], 150)
            self.assertIn("focal", bird)
            self.assertEqual(json.loads((root / "done.json").read_text("utf-8"))["tint"], [1, 2, 3])
            self.assertEqual(len(lines), 4)
            self.assertTrue(lines[0].startswith("bird.json: tint "))
            self.assertEqual(lines[1], "done.json: skipped")
            self.assertEqual(lines[2], "gone.json: skipped")
            self.assertEqual(lines[3], "missing.json: skipped")
            lines = backfill(root, recompute=True)
            self.assertTrue(lines[1].startswith("done.json: tint "))
            self.assertGreater(json.loads((root / "done.json").read_text("utf-8"))["tint"][0], 150)
            self.assertEqual(lines[2:], ["gone.json: skipped", "missing.json: skipped"])


class WithoutPillowTests(unittest.TestCase):
    """Whatever the machine has, these run as if Pillow could not be imported."""

    def setUp(self) -> None:
        patcher = mock.patch.dict(sys.modules, {"PIL": None, "PIL.Image": None})
        patcher.start()
        self.addCleanup(patcher.stop)
        warned = mock.patch.object(features_module, "_pillow_warned", False)
        warned.start()
        self.addCleanup(warned.stop)

    def test_missing_pillow_gives_no_features(self) -> None:
        self.assertIsNone(portrait_features(b"\x89PNG\r\n\x1a\n"))

    def test_missing_pillow_is_reported_and_logged_once(self) -> None:
        logged: list[str] = []
        self.assertFalse(pillow_available(log=logged.append))
        self.assertFalse(pillow_available(log=logged.append))
        self.assertEqual(len(logged), 1, logged)
        self.assertIn("python3-pil", logged[0])

    def test_backfill_leaves_every_meta_alone(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "bird.jpg").write_bytes(b"\x89PNG\r\n\x1a\n")
            original = json.dumps({"file": "bird.jpg", "title": "Bird"})
            (root / "bird.json").write_text(original, "utf-8")
            self.assertEqual(backfill(root), ["bird.json: skipped"])
            self.assertEqual((root / "bird.json").read_text("utf-8"), original)


if __name__ == "__main__":
    unittest.main()
