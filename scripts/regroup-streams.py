#!/usr/bin/env python3
"""Reduce HLS requests by joining consecutive fMP4 fragments; no encoding."""
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BRANCH = 'stream-media-v3'
PREFIX = 'bundled-v1'
RAW = f'https://raw.githubusercontent.com/zaki064/zaki-visual-portfolio/{BRANCH}/{PREFIX}'
VERSION = '20261011.2'

def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def video_hash(path):
    return run('ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0',
               '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-')

def bundle(source, output):
    playlist = (source / 'index.m3u8').read_text()
    pairs = re.findall(r'#EXTINF:([\d.]+),[^\n]*\n([^#\n]+)', playlist)
    assert pairs
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / 'init.mp4', output / 'init.mp4')
    # Retain the small first fragment. Join the following four half-second
    # fragments into one request without modifying any MP4 box or payload.
    groups = [pairs[:1]] + [pairs[i:i+4] for i in range(1, len(pairs), 4)]
    old_digest, new_digest = hashlib.sha256(), hashlib.sha256()
    entries, sizes = [], []
    for index, group in enumerate(groups):
        name = f'b{index:04d}.m4s'
        with (output / name).open('wb') as dest:
            for duration, original in group:
                data = (source / original).read_bytes()
                old_digest.update(data)
                dest.write(data)
        data = (output / name).read_bytes()
        new_digest.update(data)
        sizes.append(len(data))
        assert len(data) < 95 * 1024 * 1024
        entries.append((sum(float(d) for d, _ in group), name))
    assert old_digest.digest() == new_digest.digest(), 'Fragment bytes changed'
    longest = max(d for d, _ in entries)
    header = ['#EXTM3U', '#EXT-X-VERSION:7',
              f'#EXT-X-TARGETDURATION:{math.ceil(longest)}',
              '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
              '#EXT-X-MAP:URI="init.mp4"']
    lines = header + [line for d, name in entries for line in (f'#EXTINF:{d:.6f},', name)] + ['#EXT-X-ENDLIST']
    (output / 'index.m3u8').write_text('\n'.join(lines) + '\n')
    before, after = video_hash(source / 'index.m3u8'), video_hash(output / 'index.m3u8')
    assert before == after, 'Encoded video packets changed'
    return {'oldRequests': len(pairs), 'newRequests': len(groups),
            'fragmentBytesIdentical': True, 'videoPacketHash': after,
            'duration': sum(d for d, _ in entries), 'totalBytes': sum(sizes),
            'largestSegmentBytes': max(sizes)}, entries, header

def main():
    run('git', 'config', 'user.name', 'ZAKI Portfolio Builder', cwd=ROOT)
    run('git', 'config', 'user.email', 'github-actions[bot]@users.noreply.github.com', cwd=ROOT)
    run('git', 'fetch', '--depth=1', 'origin', BRANCH, cwd=ROOT)
    media = Path(tempfile.mkdtemp(prefix='zaki-bundled-')) / 'media'
    run('git', 'worktree', 'add', '--detach', str(media), 'FETCH_HEAD', cwd=ROOT)
    sources = sorted(p.parent for p in media.glob('zaki-*/index.m3u8'))
    assert len(sources) == 37, f'Expected 33 originals and 4 compatibility streams, found {len(sources)}'
    reports = []
    push_bytes = 0
    for source in sources:
        slug = source.name
        output = media / PREFIX / slug
        report, entries, header = bundle(source, output)
        report['id'] = slug
        reports.append(report)
        startup = ROOT / 'streams' / slug
        startup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(output / 'init.mp4', startup / 'init.mp4')
        shutil.copy2(output / 'b0000.m4s', startup / 's0000.m4s')
        web_header = [s.replace('URI="init.mp4"', f'URI="init.mp4?v={VERSION}"') for s in header]
        lines = web_header[:]
        for i, (duration, name) in enumerate(entries):
            lines += [f'#EXTINF:{duration:.6f},',
                      f's0000.m4s?v={VERSION}' if i == 0 else f'{RAW}/{slug}/{name}']
        lines.append('#EXT-X-ENDLIST')
        (startup / 'index.m3u8').write_text('\n'.join(lines) + '\n')
        print(json.dumps(report), flush=True)
        run('git', 'add', f'{PREFIX}/{slug}', cwd=media)
        run('git', 'commit', '-m', f'Bundle unchanged video fragments: {slug}', cwd=media)
        push_bytes += report['totalBytes']
        if push_bytes > 450 * 1024 * 1024:
            run('git', 'push', 'origin', f'HEAD:refs/heads/{BRANCH}', cwd=media)
            push_bytes = 0
    run('git', 'push', 'origin', f'HEAD:refs/heads/{BRANCH}', cwd=media)
    summary = {'version': VERSION, 'videoReencoded': False, 'allFragmentBytesIdentical': True,
               'oldRequests': sum(r['oldRequests'] for r in reports),
               'newRequests': sum(r['newRequests'] for r in reports), 'assets': reports}
    (ROOT / 'buffering-audit.json').write_text(json.dumps(summary, indent=2))
    run('git', 'add', 'streams', 'buffering-audit.json', cwd=ROOT)
    run('git', 'commit', '-m', 'Publish byte-identical bundled video playlists', cwd=ROOT)
    run('git', 'pull', '--rebase', 'origin', 'main', cwd=ROOT)
    run('git', 'push', 'origin', 'HEAD:refs/heads/main', cwd=ROOT)
    print(f"Verified unchanged bytes; fragment requests {summary['oldRequests']} -> {summary['newRequests']}", flush=True)

if __name__ == '__main__':
    main()
