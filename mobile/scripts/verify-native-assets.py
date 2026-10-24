"""Verify reviewed web assets are present in downloaded native development artifacts.

No archives are extracted or executed. This proves packaging only, not native launch,
secure transport, signing or store acceptance. Run from the matching source checkout.
"""
import argparse
from pathlib import Path
from zipfile import ZipFile


def verify(source, archive, prefix):
    checked = 0
    with ZipFile(archive) as bundle:
        for path in sorted(source.rglob('*')):
            if not path.is_file():
                continue
            name = prefix + path.relative_to(source).as_posix()
            entries = [entry for entry in bundle.infolist() if entry.filename == name]
            if len(entries) != 1:
                raise ValueError(f'Expected exactly one packaged asset: {name}')
            entry = entries[0]
            if entry.file_size > 2_000_000:
                raise ValueError(f'Unexpected asset size: {name}')
            actual = bundle.read(entry).replace(b'\r\n', b'\n')
            expected = path.read_bytes().replace(b'\r\n', b'\n')
            if actual != expected:
                raise ValueError(f'Packaged asset differs from reviewed source: {name}')
            checked += 1
    if checked == 0:
        raise ValueError('No source assets were found')
    return checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact_directory', type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / 'www'
    bundles = [
        ('Android', 'atlas-android-debug/app-debug.apk', 'assets/public/'),
        ('iOS simulator', 'atlas-ios-simulator/atlas-ios-simulator.zip', 'App.app/public/'),
    ]
    for label, relative, prefix in bundles:
        count = verify(source, args.artifact_directory / relative, prefix)
        print(f'{label}: all {count} reviewed web assets match (LF-normalized)')
    print('Packaging verified; device, transport and store acceptance remain separate gates.')


if __name__ == '__main__':
    main()
