"""Export the current source without Git history, local runtime data or secrets."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def export_source(root: Path, target: Path) -> dict:
    root, target = root.resolve(), target.resolve()
    if target.is_relative_to(root) or target.exists():
        raise ValueError('Choose a new directory outside the source checkout')
    files = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root
    ).decode('utf-8').split('\0')
    manifest = {}
    skipped = []
    for relative in sorted(set(filter(None, files))):
        path = Path(relative)
        source = root / path
        if not source.is_file():
            continue
        if (any(part in {'.git', '.venv', 'node_modules', 'Pods', 'build', 'dist',
                         'tmp', 'output', 'docs', '.branding', '__pycache__',
                         '.pytest_cache', '.idea', '.vscode', 'uploads', 'downloads'}
                or part.startswith('.next') for part in path.parts)
                or (path.name.startswith('.env') and not path.name.endswith('.example'))
                or path.suffix.lower() in {'.p12', '.pfx', '.pem', '.key', '.jks',
                    '.keystore', '.mobileprovision', '.cer', '.apk', '.ipa', '.aab',
                    '.db', '.sqlite', '.sqlite3', '.log', '.tsbuildinfo'}
                or source.is_symlink() or not source.resolve().is_relative_to(root)):
            skipped.append(relative)
            continue
        dest = target / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        manifest[relative] = hashlib.sha256(dest.read_bytes()).hexdigest()
    if not manifest:
        raise ValueError('No source files found')
    (target / 'SOURCE_MANIFEST.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    return {'target': str(target), 'files': len(manifest), 'excluded': skipped}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(export_source(Path(__file__).resolve().parents[1], args.target),
                     ensure_ascii=False))
