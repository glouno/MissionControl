#!/usr/bin/env python3
"""Create/verify explicit release inventories without filesystem extraction."""
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile

MAX_FILES = 10000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024


def checked_inventory(spec):
    files = spec['files']
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise ValueError('Invalid release inventory size')
    seen = set()
    total = 0
    for entry in files:
        path = entry['path']
        parts = PurePosixPath(path).parts
        if (not path or path.startswith('/') or '\\' in path or
                any(p in ('', '.', '..') for p in path.split('/')) or
                str(PurePosixPath(path)) != path or path in seen):
            raise ValueError('Invalid or duplicate release path')
        size = entry['bytes']
        if not isinstance(size, int) or size < 0 or size > MAX_FILE_BYTES:
            raise ValueError('Invalid release file bound')
        if len(entry['sha256']) != 64 or any(c not in '0123456789abcdef' for c in entry['sha256']):
            raise ValueError('Invalid release hash')
        total += size
        seen.add(path)
    if total > MAX_TOTAL_BYTES:
        raise ValueError('Release exceeds total bound')
    if spec.get('prefix', '') not in ('', 'package/'):
        raise ValueError('Invalid release prefix')
    return files


def create(path, spec):
    files = checked_inventory(spec)
    root = Path(spec['root']).absolute()
    if root.resolve() != root or not root.is_dir():
        raise ValueError('Release root is redirected')
    with open(path, 'xb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=spec['epoch']) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                for entry in sorted(files, key=lambda f: f['path']):
                    source = root / entry['path']
                    if source.resolve() != source:
                        raise ValueError('Release source is redirected')
                    with open(source, 'rb') as data:
                        metadata = os.fstat(data.fileno())
                        if not source.is_file() or metadata.st_size != entry['bytes']:
                            raise ValueError('Release source differs from inventory')
                        digest = hashlib.file_digest(data, 'sha256').hexdigest()
                        if digest != entry['sha256']:
                            raise ValueError('Release source hash differs')
                        data.seek(0)
                        header = tarfile.TarInfo(spec.get('prefix', '') + entry['path'])
                        header.size = entry['bytes']
                        header.mode = 0o755 if entry['path'] == 'dist/cli.js' else 0o644
                        header.mtime = spec['epoch']
                        # Default UID/GID zero and empty owner names exclude host identity.
                        archive.addfile(header, data)


def verify(path, spec):
    files = checked_inventory(spec)
    expected = {spec.get('prefix', '') + f['path']: f for f in files}
    seen = set()
    with tarfile.open(path, mode='r|gz') as archive:
        for member in archive:
            entry = expected.get(member.name)
            if member.name in seen or entry is None:
                raise ValueError('Unexpected or duplicate archive entry')
            if not member.isfile() or member.issparse() or member.linkname or member.size != entry['bytes']:
                raise ValueError('Archive entry type/size differs')
            if member.mode & 0o7000:
                raise ValueError('Archive contains privileged mode')
            if member.uid != 0 or member.gid != 0 or member.uname or member.gname or member.pax_headers:
                raise ValueError('Archive contains unreviewed ownership/extended metadata')
            if not spec.get('allowMetadata', False):
                mode = 0o755 if entry['path'] == 'dist/cli.js' else 0o644
                if (member.uid != 0 or member.gid != 0 or member.uname or member.gname or
                        member.mode != mode or member.mtime != spec['epoch'] or member.pax_headers):
                    raise ValueError('Archive metadata is not normalized')
            payload = archive.extractfile(member)
            if payload is None or hashlib.file_digest(payload, 'sha256').hexdigest() != entry['sha256']:
                raise ValueError('Archive content hash differs')
            seen.add(member.name)
    if seen != set(expected):
        raise ValueError('Archive inventory is incomplete')


def main():
    action, path = sys.argv[1:]
    spec = json.load(sys.stdin)
    if action == 'create':
        create(path, spec)
    elif action == 'verify':
        verify(path, spec)
    else:
        raise ValueError('Unknown archive operation')
    print(json.dumps({'verified': True, 'files': len(spec['files'])}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not echo private paths, archive owner names or raw member values.
        sys.exit('Release archive validation failed')
