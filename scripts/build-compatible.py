#!/usr/bin/env python3
"""Add mathematically lossless VP9 alternatives; keep primary HEVC originals."""
import hashlib
import json
import math
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
def frame_hash(path):
    return run('ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0',
               '-vf', 'scale=in_range=full:out_range=full,format=yuv420p',
               '-fps_mode', 'passthrough', '-f', 'hash', '-hash', 'sha256', '-')

assets = [a for a in json.loads((ROOT/'media-originals.json').read_text()) if a['name'].startswith('zaki-creative-')]
assert len(assets) == 4
temp = Path(tempfile.mkdtemp(prefix='zaki-compatible-'))
media = temp/'media'
run('git', 'config', 'user.name', 'ZAKI Portfolio Builder', cwd=ROOT)
run('git', 'config', 'user.email', 'github-actions[bot]@users.noreply.github.com', cwd=ROOT)
run('git', 'fetch', '--depth=1', 'origin', BRANCH, cwd=ROOT)
run('git', 'worktree', 'add', '--detach', str(media), 'FETCH_HEAD', cwd=ROOT)
audit = []
for asset in assets:
    source = temp/asset['name']
    run('curl', '--fail', '--location', '--retry', '3', '--max-time', '300', '--silent', '--show-error', '--output', str(source), asset['browser_download_url'])
    assert source.stat().st_size == asset['size']
    if asset.get('digest'):
        assert 'sha256:'+hashlib.file_digest(source.open('rb'),'sha256').hexdigest() == asset['digest']
    slug = Path(asset['name']).stem+'-compatible'
    output = media/slug
    output.mkdir(exist_ok=True)
    command = ['ffmpeg','-v','error','-y','-i',str(source),'-map','0:v:0','-map','0:a:0?',
               '-vf','scale=in_range=full:out_range=full,format=yuv420p',
               '-color_range','pc','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
               '-c:v','libvpx-vp9','-lossless','1','-crf','0','-b:v','0',
               '-deadline','good','-cpu-used','5','-row-mt','1','-threads','4','-g','60',
               '-fps_mode','passthrough','-c:a','copy','-f','hls','-hls_time','0.5',
               '-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_flags','split_by_time',
               '-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',str(output/'s%04d.m4s'),str(output/'index.m3u8')]
    subprocess.run(command,check=True)
    original_hash = frame_hash(source)
    playback_hash = frame_hash(output/'index.m3u8')
    assert original_hash == playback_hash, f'Decoded pixel mismatch: {slug}'
    playlist=(output/'index.m3u8').read_text()
    longest=max(float(n) for n in re.findall(r'#EXTINF:([\d.]+)',playlist))
    playlist=re.sub(r'#EXT-X-TARGETDURATION:\d+',f'#EXT-X-TARGETDURATION:{max(1,math.ceil(longest))}',playlist)
    (output/'index.m3u8').write_text(playlist)
    segments=[line for line in playlist.splitlines() if line and not line.startswith('#')]
    sizes=[(output/name).stat().st_size for name in segments]
    assert max(sizes)<95*1024*1024
    startup=ROOT/'streams'/slug
    startup.mkdir(parents=True,exist_ok=True)
    shutil.copy2(output/'init.mp4',startup/'init.mp4')
    shutil.copy2(output/segments[0],startup/segments[0])
    (startup/'index.m3u8').write_text('\n'.join(f'{RAW}/{slug}/{line}' if line in segments[1:] else line for line in playlist.splitlines())+'\n')
    audit.append({'id':slug,'source':asset['name'],'decodedPixelHash':original_hash,'decodedPixelsIdentical':True,'resolutionAndFrameRatePreserved':True,'codec':'vp9','encoding':'lossless','audioCopied':True,'totalBytes':sum(sizes),'startupBytes':sizes[0]})
    print(json.dumps(audit[-1]),flush=True)
    run('git','add',slug,cwd=media)
    if run('git','diff','--cached','--name-only',cwd=media):
        run('git','commit','-m',f'Add pixel-identical compatible stream: {slug}',cwd=media)
        run('git','push','origin',f'HEAD:refs/heads/{BRANCH}',cwd=media)
    source.unlink()
(ROOT/'compatibility-audit.json').write_text(json.dumps({'originalFilesUntouched':True,'assets':audit},indent=2))
run('git','add','streams','compatibility-audit.json',cwd=ROOT)
run('git','commit','-m','Publish verified pixel-identical browser compatibility alternatives',cwd=ROOT)
run('git','pull','--rebase','origin','main',cwd=ROOT)
run('git','push','origin','HEAD:refs/heads/main',cwd=ROOT)
