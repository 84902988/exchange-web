"""Isolation and archive-boundary tests; no credentials or network required."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class BrandingDeliveryTests(unittest.TestCase):
    def test_profile_is_isolated_and_updates_native_names_and_icons(self):
        apply = module('apply_branding').apply_profile
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = base / 'export'
            files = [
                'mobile/app.json', 'mobile/src/config/branding.json',
                'mobile/android/app/src/main/res/values/strings.xml',
                'mobile/ios/ExchangeMobile/Info.plist',
                'mobile/ios/ExchangeMobile/Info-Debug.plist',
                'mobile/ios/ExchangeMobile/LaunchScreen.storyboard',
                'mobile/ios/ExchangeMobile/Images.xcassets/AppIcon.appiconset/Contents.json',
                'mobile/scripts/generate_brand_app_icons.py', 'web/config/branding.json',
            ]
            originals = {name: (ROOT / name).read_bytes() for name in files}
            for name, data in originals.items():
                file = target / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
            profile = base / 'branding.json'
            profile.write_text(json.dumps({'displayName': 'Example & Trading'}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'isolated export'):
                apply(profile, ROOT)
            apply(profile, target)
            self.assertEqual(json.loads((target / 'mobile/app.json').read_text())['displayName'], 'Example & Trading')
            self.assertIn('Example &amp; Trading', (target / files[2]).read_text())
            self.assertIn('text="Example &amp; Trading"', (target / files[5]).read_text())
            from PIL import Image
            with Image.open(target / 'mobile/ios/ExchangeMobile/Images.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png') as icon:
                self.assertEqual((icon.size, icon.mode), ((1024, 1024), 'RGB'))
            for name, data in originals.items():
                self.assertEqual((ROOT / name).read_bytes(), data)
            profile.write_text(json.dumps({'displayName': 'Blocked', 'assetOverrides': {'../escape.png': 'missing.png'}}))
            with self.assertRaisesRegex(ValueError, 'outside public media'):
                apply(profile, target)
            self.assertFalse((base / 'escape.png').exists())
            self.assertEqual(json.loads((target / 'mobile/app.json').read_text())['displayName'], 'Example & Trading')

    def test_export_excludes_tracked_secrets_and_includes_new_source(self):
        export = module('export_public_source').export_source
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'repo'
            root.mkdir()
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            for name in ['main.py', '.env', 'release.p12']:
                (root / name).write_text('sample')
            subprocess.run(['git', 'add', '--', 'main.py', '.env', 'release.p12'], cwd=root, check=True)
            (root / 'new.py').write_text('new source')
            (root / '.env.example').write_text('SENDER=')
            target = base / 'export'
            result = export(root, target)
            self.assertEqual(result['files'], 3)
            self.assertEqual(set(result['excluded']), {'.env', 'release.p12'})
            self.assertFalse((target / '.git').exists())
            self.assertTrue((target / 'new.py').exists())
            self.assertTrue((target / '.env.example').exists())
            with self.assertRaisesRegex(ValueError, 'new directory'):
                export(root, target)


if __name__ == '__main__':
    unittest.main()
