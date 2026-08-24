"""Generate deterministic Exchange launcher icons from the master logo."""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw


MOBILE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = MOBILE_ROOT.parent
MASTER_SVG = REPO_ROOT / "web/public/icons/logo-1.svg"
FALLBACK_LOGO = MOBILE_ROOT / "src/assets/brand/app-logo.png"
BACKGROUND = (8, 10, 13, 255)


def load_master_logo() -> Image.Image:
    if MASTER_SVG.is_file():
        text = MASTER_SVG.read_text(encoding="utf-8")
        match = re.search(r"base64,([^\"]+)", text)
        if match:
            return Image.open(io.BytesIO(base64.b64decode(match.group(1)))).convert("RGBA")
    return Image.open(FALLBACK_LOGO).convert("RGBA")


def composite_icon(logo: Image.Image, size: int, logo_ratio: float, *, round_icon: bool = False) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    for radius_ratio, alpha in ((0.46, 18), (0.36, 24), (0.26, 30)):
        radius = int(size * radius_ratio)
        center = size // 2
        draw.ellipse(
            (center - radius, center - radius, center + radius, center + radius),
            fill=(205, 151, 32, alpha),
        )
    target = max(1, int(size * logo_ratio))
    resized = logo.resize((target, target), Image.Resampling.LANCZOS)
    offset = ((size - target) // 2, (size - target) // 2)
    canvas.alpha_composite(resized, offset)
    if round_icon:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        canvas.putalpha(mask)
    return canvas


def generate_android(logo: Image.Image) -> None:
    res = MOBILE_ROOT / "android/app/src/main/res"
    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for directory, size in densities.items():
        target = res / directory
        target.mkdir(parents=True, exist_ok=True)
        composite_icon(logo, size, 0.82).save(target / "ic_launcher.png", optimize=True)
        composite_icon(logo, size, 0.78, round_icon=True).save(
            target / "ic_launcher_round.png", optimize=True
        )
        # Adaptive icons use a 108dp canvas; keep the crest inside the safe zone.
        foreground_size = int(size * 108 / 48)
        foreground = Image.new("RGBA", (foreground_size, foreground_size), (0, 0, 0, 0))
        crest_size = int(foreground_size * 0.60)
        crest = logo.resize((crest_size, crest_size), Image.Resampling.LANCZOS)
        offset = (foreground_size - crest_size) // 2
        foreground.alpha_composite(crest, (offset, offset))
        foreground.save(target / "ic_launcher_foreground.png", optimize=True)


def generate_ios(logo: Image.Image) -> None:
    icon_set = MOBILE_ROOT / "ios/ExchangeMobile/Images.xcassets/AppIcon.appiconset"
    contents = json.loads((icon_set / "Contents.json").read_text(encoding="utf-8"))
    for item in contents["images"]:
        filename = item.get("filename")
        if not filename:
            continue
        points = float(item["size"].split("x", 1)[0])
        scale = int(item["scale"].removesuffix("x"))
        size = int(round(points * scale))
        # App Store icons must be opaque; the branded background is intentional.
        composite_icon(logo, size, 0.82).convert("RGB").save(
            icon_set / filename,
            optimize=True,
        )


def main() -> None:
    logo = load_master_logo()
    generate_android(logo)
    generate_ios(logo)
    print("Exchange Android and iOS icons generated.")


if __name__ == "__main__":
    main()
