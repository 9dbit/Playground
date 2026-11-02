#!/usr/bin/env python3
"""One-time CP14 source materialization, restricted to the owner's feature branch.
This script edits only the reviewed allowlist, verifies every before/after SHA256,
and never contacts a database or production service. Remove before merge.
"""
import hashlib
import json
import os
from pathlib import Path

ALLOWED = {
    'engine/admin-operations.js', 'engine/deep-routes.js', 'engine/security.js',
    'package.json', 'public/control.js', 'public/engine.js', 'public/parity.css',
    'server.js', 'tests/admin-operations.test.js',
}
BRANCH = 'fix/cp14-backend-p1-p2-20261103'
if os.environ.get('GITHUB_REPOSITORY') != '9dbit/Playground' or os.environ.get('GITHUB_REF') != 'refs/heads/' + BRANCH:
    raise SystemExit('Refusing a different repository or branch')
plan = json.loads(Path('maintenance/cp14-edit-plan.json').read_text())
if plan['repository'] != '9dbit/Playground' or plan['branch'] != BRANCH or plan['format'] != 1:
    raise SystemExit('Unexpected plan identity')
if {x['path'] for x in plan['files']} != ALLOWED or len(plan['files']) != len(ALLOWED):
    raise SystemExit('Unexpected file set')
prepared = []
for item in plan['files']:
    p = Path(item['path'])
    if p.is_symlink() or not p.is_file():
        raise SystemExit('Missing regular source file: ' + str(p))
    original = p.read_bytes()
    if hashlib.sha256(original).hexdigest() != item['before']:
        raise SystemExit('Source changed; refuse stale patch: ' + str(p))
    lines = original.decode('utf-8').splitlines(True)
    previous_end = -1
    for edit in item['edits']:
        if not (isinstance(edit['start'], int) and isinstance(edit['end'], int) and 0 <= edit['start'] <= edit['end'] <= len(lines) and edit['start'] >= previous_end):
            raise SystemExit('Overlapping or invalid edit')
        previous_end = edit['end']
    for edit in reversed(item['edits']):
        lines[edit['start']:edit['end']] = edit['text'].splitlines(True)
    result = ''.join(lines).encode('utf-8')
    if hashlib.sha256(result).hexdigest() != item['after']:
        raise SystemExit('Result checksum mismatch: ' + str(p))
    prepared.append((p, result))
# All files are validated before any file is written.
for p, result in prepared:
    p.write_bytes(result)
    print('Verified source:', p, hashlib.sha256(result).hexdigest())
