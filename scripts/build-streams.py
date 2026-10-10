#!/usr/bin/env python3
"""Package existing public originals. Video packets are copied, never encoded."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPO = 'zaki064/zaki-visual-portfolio'
BRANCH = 'stream-media-v3'
RAW = f'https://raw.githubusercontent.com/{REPO}/{BRANCH}'

def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def probe(path):
    return json.loads(run('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)))

def video_hash(path):
    return run('ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-')

assets = json.loads((ROOT / 'media-originals.json').read_text())
assets = [a for a in assets if re.fullmatch(r'zaki-[a-z]+-(?:\d+|web)\.(?:mp4|mov)', a['name'])]
assert len(assets) == 33, f'Expected 33 originals, got {len(assets)}'
assets.sort(key=lambda a: (a['name'] != 'zaki-showreel-web.mp4', a['name']))
temp = Path(tempfile.mkdtemp(prefix='zaki-stream-build-'))
media = temp / 'media'
if os.environ.get('ZAKI_LOCAL_TEST'):
    media.mkdir()
    assets = [a for a in assets if a['name'] == 'zaki-showreel-web.mp4']
else:
    existing = run('git', 'ls-remote', '--heads', 'origin', BRANCH, cwd=ROOT)
    if existing:
        run('git', 'fetch', '--depth=1', 'origin', BRANCH, cwd=ROOT)
        run('git', 'worktree', 'add', '--detach', str(media), 'FETCH_HEAD', cwd=ROOT)
        run('git', 'switch', '-c', BRANCH, cwd=media)
    else:
        run('git', 'worktree', 'add', '--detach', str(media), 'HEAD', cwd=ROOT)
        run('git', 'switch', '--orphan', BRANCH, cwd=media)
    run('git', 'config', 'user.name', 'ZAKI Portfolio Builder', cwd=ROOT)
    run('git', 'config', 'user.email', 'github-actions[bot]@users.noreply.github.com', cwd=ROOT)

audit = []
batch_bytes = 0
def download(asset):
    source = temp / asset['name']
    if os.environ.get('ZAKI_LOCAL_TEST'):
        shutil.copy2('/tmp/zaki-showreel-original.mp4', source)
    else:
        run('curl', '--fail', '--location', '--retry', '3', '--max-time', '300', '--silent', '--show-error', '--output', str(source), asset['browser_download_url'])
    assert source.stat().st_size == asset['size']
    if asset.get('digest'):
        assert 'sha256:' + hashlib.file_digest(source.open('rb'), 'sha256').hexdigest() == asset['digest']
    return source

# Four downloads in parallel, but only one packaging process at a time.
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    pending = {a['name']: pool.submit(download, a) for a in assets}
    for index, asset in enumerate(assets):
        source = pending[asset['name']].result()
        info = probe(source)
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        audio = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
        assert video['codec_name'] in ('h264', 'hevc'), f"Unsupported video codec {video['codec_name']}: {asset['name']}"
        slug = Path(asset['name']).stem
        output = media / slug
        output.mkdir(exist_ok=True)
        command = ['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy']
        # Copy AAC unchanged. PCM and other non-web audio become high-quality AAC.
        command += ['-c:a', 'copy'] if audio and audio['codec_name'] == 'aac' else ['-c:a', 'aac', '-b:a', '320k', '-ac', '2']
        if video['codec_name'] == 'hevc':
            command += ['-tag:v', 'hvc1']
        # Split at packet boundaries instead of waiting for long original GOPs.
        # No independent-segment tag: consecutive parts decode continuously;
        # this portfolio restarts at zero and does not expose arbitrary seeking.
        command += ['-f', 'hls', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'split_by_time', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', str(output / 's%04d.m4s'), str(output / 'index.m3u8')]
        subprocess.run(command, check=True)
        original_hash = video_hash(source)
        packaged_hash = video_hash(output / 'index.m3u8')
        assert original_hash == packaged_hash, f'Video packet mismatch: {slug}'
        playlist = (output / 'index.m3u8').read_text()
        segments = [line for line in playlist.splitlines() if line and not line.startswith('#')]
        sizes = [((output / name).stat().st_size, name) for name in segments]
        assert max(s for s, _ in sizes) < 95 * 1024 * 1024, f'Segment exceeds safe Git file size: {slug}'
        startup = ROOT / 'streams' / slug
        startup.mkdir(parents=True, exist_ok=True)
        # Metadata and the first fragment are served by Pages alongside the site.
        shutil.copy2(output / 'init.mp4', startup / 'init.mp4')
        shutil.copy2(output / segments[0], startup / segments[0])
        rewritten = []
        for line in playlist.splitlines():
            if line in segments and line != segments[0]:
                line = f'{RAW}/{slug}/{line}'
            rewritten.append(line)
        text = '\n'.join(rewritten).replace('URI="init.mp4"', 'URI="init.mp4?v=20261010.3"')
        text = text.replace('\n' + segments[0] + '\n', '\n' + segments[0] + '?v=20261010.3\n')
        (startup / 'index.m3u8').write_text(text + '\n')
        audit.append({'id': slug, 'original': asset['name'], 'originalBytes': asset['size'], 'videoCodec': video['codec_name'], 'width': video['width'], 'height': video['height'], 'fps': video['r_frame_rate'], 'duration': float(info['format']['duration']), 'videoPacketHash': original_hash, 'videoUnchanged': True, 'audioOriginal': audio['codec_name'] if audio else None, 'audioPlayback': 'aac' if audio else None, 'startupBytes': (output / 'init.mp4').stat().st_size + sizes[0][0], 'segments': len(segments), 'largestSegmentBytes': max(s for s, _ in sizes)})
        print(json.dumps(audit[-1]), flush=True)
        if not os.environ.get('ZAKI_LOCAL_TEST'):
            run('git', 'add', slug, cwd=media)
            if run('git', 'diff', '--cached', '--name-only', cwd=media):
                run('git', 'commit', '-m', f'Package original-quality stream: {slug}', cwd=media)
            batch_bytes += sum(s for s, _ in sizes)
            if batch_bytes > 550 * 1024 * 1024 or index == len(assets) - 1:
                run('git', 'push', 'origin', f'HEAD:refs/heads/{BRANCH}', cwd=media)
                batch_bytes = 0
        source.unlink()

report = {'version': '2026-10-10-stream-v3', 'videoReencoded': False, 'videoPacketHashesVerified': True, 'totalOriginalBytes': sum(a['originalBytes'] for a in audit), 'startupBytes': sum(a['startupBytes'] for a in audit), 'assets': audit}
(ROOT / 'stream-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print('ALL ORIGINAL VIDEO PACKET HASHES VERIFIED', flush=True)
if not os.environ.get('ZAKI_LOCAL_TEST'):
    run('git', 'add', 'streams', 'stream-audit.json', cwd=ROOT)
    run('git', 'commit', '-m', 'Publish verified lossless streams and optimized ZAKI player', cwd=ROOT)
    run('git', 'pull', '--rebase', 'origin', 'main', cwd=ROOT)
    run('git', 'push', 'origin', 'HEAD:refs/heads/main', cwd=ROOT)
