#!/usr/bin/env python3
"""One required verification entry point for owned Linux and owner-run Mac lanes."""
import argparse
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lane', choices=['linux', 'macos'], default='linux')
    parser.add_argument('--logs', required=True, type=pathlib.Path)
    args = parser.parse_args()
    logs = args.logs.resolve()
    if logs.is_relative_to(ROOT):
        parser.error('Verification logs must stay outside the source checkout')
    logs.mkdir(parents=True, exist_ok=True)
    version = subprocess.check_output(['node', '--version'], text=True).strip()
    if version != 'v24.21.0':
        parser.error('The reviewed Node version is 24.21.0')
    commands = [
        ('typecheck', ['npm', 'run', 'typecheck']),
        ('core', ['npm', 'test']),
        ('status', [sys.executable, '-B', 'scripts/test_status.py']),
        ('privacy', ['npm', 'run', 'privacy']),
        ('package', ['node', 'scripts/check-package.mjs']),
    ]
    if args.lane == 'linux':
        commands.extend([
            ('dependency-audit', ['npm', 'audit', '--omit=dev']),
            ('history', ['node', 'scripts/history-audit.mjs']),
            ('matrix', ['cargo', '+1.96.0', 'test', '--locked', '--manifest-path', 'connectors/matrix/Cargo.toml']),
        ])
    report = {'lane': args.lane, 'node': version,
              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'checks': [], 'passed': False}
    for name, command in commands:
        started = time.monotonic()
        with (logs / (name + '.log')).open('wb') as output:
            try:
                result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=1800)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = 124
        report['checks'].append({'name': name, 'exitCode': code, 'seconds': round(time.monotonic()-started, 2)})
        (logs / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f'{name}: {"passed" if code == 0 else "FAILED"}', flush=True)
        if code:
            return 1
    report['passed'] = True
    (logs / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
