"""Generate deterministic Exchange launcher icons from the master logo."""

from __future__ import annotations

import base64
import argparse
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageColor


MOBILE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = MOBILE_ROOT.parent
# The system applies the launcher mask. Fill the entire canvas so iOS does
# not show an inset icon with dark corners inside its rounded square.
BACKGROUND = (30, 41, 59, 255)


def load_master_logo() -> Image.Image:
    # Draw a neutral code-native mark; no client artwork is bundled by default.
    image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((84, 143, 366, 183), radius=20, fill='white')
    draw.polygon([(325, 93), (429, 163), (325, 233)], fill='white')
    draw.rounded_rectangle((146, 329, 428, 369), radius=20, fill='white')
    draw.polygon([(187, 279), (83, 349), (187, 419)], fill='white')
    return image


def composite_icon(logo: Image.Image, size: int, logo_ratio: float, *, round_icon: bool = False) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BACKGROUND)
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
    global REPO_ROOT, MOBILE_ROOT, BACKGROUND
    parser = argparse.ArgumentParser(description='Render neutral or externally supplied application icons')
    parser.add_argument('--root', type=Path, default=REPO_ROOT)
    parser.add_argument('--logo', type=Path)
    parser.add_argument('--background', default='#1E293B')
    args = parser.parse_args()
    REPO_ROOT = args.root.resolve()
    MOBILE_ROOT = REPO_ROOT / 'mobile'
    BACKGROUND = ImageColor.getrgb(args.background) + (255,)
    logo = Image.open(args.logo).convert('RGBA') if args.logo else load_master_logo()
    generate_android(logo)
    generate_ios(logo)
    bundled = MOBILE_ROOT / 'src/assets/brand/app-logo.png'
    bundled.parent.mkdir(parents=True, exist_ok=True)
    composite_icon(logo, 512, .82).save(bundled, optimize=True)
    colors = MOBILE_ROOT / 'android/app/src/main/res/values/colors.xml'
    colors.write_text('<resources>\n    <color name="launcher_background">'+args.background+'</color>\n</resources>\n', encoding='utf-8')
    public = REPO_ROOT / 'web/public'
    icons = public / 'icons'
    icons.mkdir(parents=True, exist_ok=True)
    for filename, size in [('app-logo-256.png',256),('app-favicon-32.png',32),('app-apple-touch-icon.png',180)]:
        composite_icon(logo,size,.82).save(icons/filename,optimize=True)
    composite_icon(logo,64,.82).save(public/'favicon.ico',sizes=[(16,16),(32,32),(48,48),(64,64)])
    data=io.BytesIO();composite_icon(logo,256,.82).save(data,format='PNG',optimize=True)
    encoded=base64.b64encode(data.getvalue()).decode('ascii')
    (icons/'logo-1.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><image width="256" height="256" href="data:image/png;base64,'+encoded+'"/></svg>\n',encoding='utf-8')
    print("Neutral or configured Android, iOS and web icons generated.")


if __name__ == "__main__":
    main()
