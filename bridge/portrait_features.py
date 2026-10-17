#!/usr/bin/env python3
"""The dominant tint and the focal point of a cached bird portrait.

The poster frame crops each portrait hard into a block of colour, so it
needs the photo's dominant colour and a hint of where the bird is. Both
are computed once with Pillow when the portrait is cached; without Pillow
(or with an unreadable image) there are simply no features.

Run as a script to backfill a cache directory (``--recompute`` redoes
portraits that already have a tint):

    python3 bridge/portrait_features.py /var/lib/launcher/portraits
"""

from __future__ import annotations

import colorsys
import io
import json
import math
import sys
from pathlib import Path
from typing import Any

HUE_BUCKETS = 24
DARK_VALUE = 0.22  # HSV value below which a pixel is "dark" rather than a hue
LIGHT_VALUE = 0.88  # ... and above which, when also unsaturated, it is "light"
LIGHT_SATURATION = 0.12
BORDER_FRACTION = 0.12  # the frame around the edge that is taken to be background
VALUE_WEIGHT = 0.35  # how much brightness counts beside hue and saturation when a pixel differs from the background
FOCAL_GRID = 8

DARK = "dark"
LIGHT = "light"


def portrait_features(image: bytes) -> dict[str, Any] | None:
    """{"tint": [r, g, b], "focal": {"x": 0..1, "y": 0..1}} or None when Pillow is missing or the image is unreadable."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(image)) as opened:
            rgb = opened.convert("RGB")
        return {"tint": dominant_tint(rgb), "focal": focal_point(rgb, Image)}
    except Exception:  # noqa: BLE001 - any broken image is just a portrait without features
        return None


def bucket_of(h: float, s: float, v: float) -> str | int:
    """``dark``, ``light`` or one of 24 hue buckets."""
    if v < DARK_VALUE:
        return DARK
    if v > LIGHT_VALUE and s < LIGHT_SATURATION:
        return LIGHT
    return int(h * HUE_BUCKETS) % HUE_BUCKETS


def dominant_tint(rgb: Any) -> list[int]:
    """The colour of the bird, not of the bokeh behind it.

    The border of a portrait is almost always background, so its mean colour
    is the background guess. Every pixel is weighted by how far it sits from
    that colour in chroma (hue and saturation, with brightness counting less,
    so a brighter patch of the same bokeh weighs little while a bird of
    another colour weighs a lot). Pixels fall into dark, light and 24 hue
    buckets by weight; the heaviest bucket, smoothed with its hue
    neighbours, is the tint. A uniform image is its own tint.
    """
    small = rgb.copy()
    small.thumbnail((128, 128))
    width, height = small.size
    raw = small.tobytes()
    pixels = len(raw) // 3
    if not pixels:
        return [0, 0, 0]
    border = max(2, int(min(width, height) * BORDER_FRACTION))
    features: list[tuple[float, float, float, str | int, int, int, int]] = []
    border_sum = [0.0, 0.0, 0.0]
    border_rgb = [0, 0, 0]
    border_count = 0
    for index in range(pixels):
        r, g, b = raw[index * 3], raw[index * 3 + 1], raw[index * 3 + 2]
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        angle = h * 2 * math.pi
        a, c = s * math.cos(angle), s * math.sin(angle)
        features.append((a, c, v, bucket_of(h, s, v), r, g, b))
        x, y = index % width, index // width
        if x < border or y < border or x >= width - border or y >= height - border:
            border_sum[0] += a
            border_sum[1] += c
            border_sum[2] += v
            border_rgb[0] += r
            border_rgb[1] += g
            border_rgb[2] += b
            border_count += 1
    if not border_count:
        border_count = pixels
        border_sum = [sum(f[0] for f in features), sum(f[1] for f in features), sum(f[2] for f in features)]
        border_rgb = [sum(f[4] for f in features), sum(f[5] for f in features), sum(f[6] for f in features)]
    background = [total / border_count for total in border_sum]
    weights: dict[str | int, list[float]] = {}
    for a, c, v, bucket, r, g, b in features:
        weight = (a - background[0]) ** 2 + (c - background[1]) ** 2 + VALUE_WEIGHT * (v - background[2]) ** 2
        total = weights.setdefault(bucket, [0.0, 0.0, 0.0, 0.0])
        total[0] += weight
        total[1] += weight * r
        total[2] += weight * g
        total[3] += weight * b

    def smoothed(bucket: str | int) -> float:
        if isinstance(bucket, str):
            return weights[bucket][0]
        neighbours = ((bucket - 1) % HUE_BUCKETS, (bucket + 1) % HUE_BUCKETS)
        return weights[bucket][0] + 0.5 * sum(weights.get(near, [0.0])[0] for near in neighbours)

    heaviest = max(weights, key=smoothed)
    members = [heaviest] if isinstance(heaviest, str) else [(heaviest + step) % HUE_BUCKETS for step in (-1, 0, 1)]
    acc = [0.0, 0.0, 0.0, 0.0]
    for bucket in members:
        for channel in range(4):
            acc[channel] += weights.get(bucket, [0.0, 0.0, 0.0, 0.0])[channel]
    if acc[0] <= 1e-9:
        return [int(round(channel / border_count)) for channel in border_rgb]
    return [int(round(acc[channel] / acc[0])) for channel in (1, 2, 3)]


def focal_point(rgb: Any, image_module: Any) -> dict[str, float]:
    """Where the image differs most from its own average colour.

    An 8x8 grid of mean colours, each cell weighted by its squared distance
    from the overall mean; the focal point is the weighted centroid of the
    cell centres. A uniform image has nothing to point at, so it is centred.
    """
    square = rgb.resize((64, 64))
    raw = square.resize((FOCAL_GRID, FOCAL_GRID), image_module.Resampling.BOX).tobytes()
    cells = [raw[offset : offset + 3] for offset in range(0, len(raw), 3)]
    total = len(cells)
    mean = [sum(cell[channel] for cell in cells) / total for channel in range(3)]
    weight_sum = 0.0
    x_sum = 0.0
    y_sum = 0.0
    for position, cell in enumerate(cells):
        weight = sum((cell[channel] - mean[channel]) ** 2 for channel in range(3))
        if weight <= 0:
            continue
        column, row = position % FOCAL_GRID, position // FOCAL_GRID
        weight_sum += weight
        x_sum += weight * (column + 0.5) / FOCAL_GRID
        y_sum += weight * (row + 0.5) / FOCAL_GRID
    if weight_sum <= 0:
        return {"x": 0.5, "y": 0.5}
    return {"x": round(x_sum / weight_sum, 3), "y": round(y_sum / weight_sum, 3)}


def backfill(root: Path, recompute: bool = False) -> list[str]:
    """Add features to every portrait meta in ``root`` that lacks a tint (or to all of them with ``recompute``); one report line per meta."""
    lines: list[str] = []
    for meta_path in sorted(root.glob("*.json")):
        line = f"{meta_path.name}: skipped"
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
        except (OSError, ValueError):
            lines.append(line)
            continue
        file_name = meta.get("file") if isinstance(meta, dict) else None
        image_path = root / str(file_name) if file_name else None
        if image_path is not None and (recompute or "tint" not in meta) and image_path.is_file():
            features = portrait_features(image_path.read_bytes())
            if features:
                meta.update(features)
                meta.pop("features_checked", None)
                meta_path.write_text(json.dumps(meta), "utf-8")
                tint = ",".join(str(channel) for channel in features["tint"])
                focal = f'{features["focal"]["x"]},{features["focal"]["y"]}'
                line = f"{meta_path.name}: tint {tint} focal {focal}"
        lines.append(line)
    return lines


def main(argv: list[str]) -> int:
    recompute = "--recompute" in argv[1:]
    args = [arg for arg in argv[1:] if arg != "--recompute"]
    if len(args) != 1:
        print("usage: portrait_features.py [--recompute] <portrait cache dir>", file=sys.stderr)
        return 2
    root = Path(args[0])
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2
    for line in backfill(root, recompute=recompute):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
