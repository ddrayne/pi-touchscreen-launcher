#!/usr/bin/env python3
"""Portrait features: the dominant tint and the focal point of a cached portrait."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from portrait_features import backfill, portrait_features

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


if __name__ == "__main__":
    unittest.main()
