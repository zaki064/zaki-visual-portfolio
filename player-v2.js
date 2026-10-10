/* ZAKI: original-quality HLS, one playing decoder, bounded warm cache. */
window.ZakiVideoV2 = function (reduced) {
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const connection = navigator.connection;
  const limit = fine.matches ? 3 : 2;
  const globalSound = document.querySelector('[data-global-sound]');
  const notice = document.querySelector('[data-audio-notice]');
  const enable = document.querySelector('[data-enable-audio]');
  let mode = 'sound', unlocked = false, active = null, last = null, destroyed = false;
  let clock = 0, warmTimer = 0, libraryPromise;
  const cleanups = [];
  const records = [...document.querySelectorAll('video[data-managed-video]')].map(video => ({
    video, player: video.closest('.video-player'), reel: video.hasAttribute('data-autoplay-reel'),
    focused: false, hovered: false, manual: false, visible: false, pausedByUser: false,
    token: 0, intent: 0, hls: null, loading: null, used: 0, warm: false, retries: 0,
    status: null, sourceReady: false, native: false, full: false, generation: 0
  }));
  const listen = (element, event, fn, options) => {
    if (!element) return;
    element.addEventListener(event, fn, options);
    cleanups.push(() => element.removeEventListener(event, fn, options));
  };
  const wanted = r => !destroyed && !document.hidden && r.visible && !r.pausedByUser &&
    (r.manual || (!reduced.matches && (r.reel ? r.focused : r.hovered)));
  const soundUI = () => {
    const on = mode === 'sound' && unlocked;
    globalSound?.setAttribute('aria-pressed', String(on));
    globalSound?.setAttribute('aria-label', on ? '关闭所有视频声音' : '开启视频声音');
    const label = globalSound?.querySelector('[data-global-sound-label]');
    if (label) label.textContent = on ? '声音已开启' : '开启声音';
    if (notice) notice.hidden = mode !== 'sound' || unlocked;
  };
  const ui = r => {
    const playing = !r.video.paused;
    const audible = playing && !r.video.muted && r.video.volume > 0;
    const play = r.player.querySelector('[data-video-action="play"]');
    const label = r.player.querySelector('[data-video-play-label]');
    if (label) label.textContent = r.player.hasAttribute('data-stream-error') ? '重试' : playing ? '暂停' : '播放';
    play?.setAttribute('aria-label', (playing ? '暂停' : '播放') + r.video.getAttribute('aria-label'));
    r.player.querySelector('[data-video-action="sound"]')?.setAttribute('aria-pressed', String(audible));
    const sound = r.player.querySelector('[data-video-sound-label]');
    if (sound) sound.textContent = audible ? '关闭声音' : '开启声音';
    for (const [name, hidden] of [['play', playing], ['pause', !playing], ['muted', audible], ['sound', !audible]]) {
      r.player.querySelector(`[data-video-icon="${name}"]`)?.toggleAttribute('hidden', hidden);
    }
    soundUI();
  };
  const status = (r, text = '') => {
    r.status.textContent = text;
    r.status.hidden = !text;
  };
  const rewind = r => {
    if (r.video.readyState) {
      try { if (r.video.currentTime > 0.01) r.video.currentTime = 0; } catch (_) {}
    }
  };
  const pause = (r, reset = true) => {
    r.token++;
    clearTimeout(r.intent);
    r.intent = 0;
    r.video.pause();
    r.hls?.stopLoad();
    if (reset) rewind(r);
    r.player.removeAttribute('data-playing');
    r.player.removeAttribute('data-loading');
    status(r);
    if (active === r) active = null;
    ui(r);
  };
  const dispose = r => {
    r.generation++;
    pause(r);
    r.hls?.destroy();
    r.hls = null;
    r.video.removeAttribute('src');
    r.video.load();
    r.loading = null;
    r.sourceReady = false;
    r.native = false;
  };
  const boundCache = keep => {
    const loaded = records.filter(r => r.hls || r.native || r.loading).sort((a, b) => b.used - a.used);
    for (const r of loaded.slice(limit)) if (r !== active && r !== keep) dispose(r);
  };
  const library = () => {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/hls.light.min.js';
      script.onload = () => resolve(window.Hls);
      script.onerror = () => { libraryPromise = null; script.remove(); reject(new Error('播放组件暂未加载，请重试')); };
      document.head.append(script);
    });
    return libraryPromise;
  };
  const fail = (r, message) => {
    r.player.removeAttribute('data-loading');
    r.player.setAttribute('data-stream-error', '');
    status(r, message || '连接较慢，请点击重试。原片仍可打开。');
    ui(r);
  };
  const prepare = async r => {
    if (r.sourceReady) return;
    if (r.loading) return r.loading;
    r.used = ++clock;
    const generation = r.generation;
    let source = r.video.dataset.stream;
    const compatible = r.video.dataset.streamCompatible;
    if (compatible) {
      const Source = window.ManagedMediaSource || window.MediaSource;
      const appleNative = /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && r.video.canPlayType('application/vnd.apple.mpegurl');
      const hevc = Source?.isTypeSupported('video/mp4; codecs="hvc1.1.6.L123.B0"');
      if (!appleNative && !hevc) source = compatible;
    }
    r.loading = (async () => {
      const native = /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && r.video.canPlayType('application/vnd.apple.mpegurl');
      if (native) {
        r.native = true;
        r.video.preload = 'metadata';
        r.video.src = source;
        r.sourceReady = true;
        return;
      }
      const Hls = await library();
      if (generation !== r.generation || destroyed) throw new Error('预加载已取消');
      if (!Hls.isSupported()) {
        if (!r.video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('此浏览器暂不支持分段播放，请打开原片');
        r.native = true;
        r.video.src = source;
        r.sourceReady = true;
        return;
      }
      r.hls?.destroy();
      const hls = r.hls = new Hls({
        autoStartLoad: false, enableWorker: true, progressive: true, startPosition: 0,
        maxBufferLength: 6, maxMaxBufferLength: 10, maxBufferSize: 32 * 1024 * 1024,
        backBufferLength: 1, maxFragLookUpTolerance: 0.1,
        manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 8000, maxLoadTimeMs: 12000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 },
          errorRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 } } },
        fragLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 700, maxRetryDelayMs: 2500 },
          errorRetry: { maxNumRetry: 2, retryDelayMs: 700, maxRetryDelayMs: 2500 } } }
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && r.retries++ < 1) hls.recoverMediaError();
        else fail(r, data.type === Hls.ErrorTypes.MEDIA_ERROR ? '设备暂不支持此原片编码，可点击原片查看。' : '网络连接中断，请点击重试。');
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        // Warm only one fragment. Never download a whole gallery in the background.
        if (!wanted(r)) { hls.stopLoad(); r.warm = false; }
      });
      hls.attachMedia(r.video);
      hls.loadSource(source);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('播放清单加载超时，请重试')), 20000);
        hls.once(Hls.Events.MANIFEST_PARSED, () => { clearTimeout(timeout); resolve(); });
        hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) { clearTimeout(timeout); reject(new Error('播放清单加载失败，请重试')); } });
      });
      r.sourceReady = true;
    })().finally(() => { if (generation === r.generation) r.loading = null; });
    boundCache(r);
    return r.loading;
  };
  const warm = async r => {
    if (destroyed || connection?.saveData || document.hidden || r === active || r.loading || r.sourceReady) return;
    // Do not compete with an active video that is still starting or buffering.
    if (active && active.video.readyState < 3) return;
    try {
      await prepare(r);
      if (destroyed) return;
      r.warm = true;
      r.hls?.startLoad(0);
      if (r.native) r.video.preload = 'metadata';
      boundCache(r);
    } catch (_) { /* A speculative warm-up must not show an error. */ }
  };
  const warmNearest = () => {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      const candidates = records.filter(r => r !== active && !r.sourceReady && !r.loading).map(r => ({r, rect:r.player.getBoundingClientRect()}));
      const next = candidates.filter(({rect}) => rect.bottom > 0 && rect.top < innerHeight + 300)
        .sort((a,b) => Math.abs(a.rect.top - innerHeight / 2) - Math.abs(b.rect.top - innerHeight / 2))[0];
      if (next) warm(next.r);
    }, 220);
  };
  const play = async r => {
    if (!wanted(r)) return;
    if (r.player.hasAttribute('data-stream-error')) { dispose(r); r.retries = 0; }
    records.forEach(other => { if (other !== r && (!other.video.paused || other === active)) pause(other); });
    active = last = r;
    const token = ++r.token;
    r.used = ++clock;
    r.player.removeAttribute('data-stream-error');
    r.player.setAttribute('data-loading', '');
    status(r);
    const valid = () => token === r.token && active === r && wanted(r);
    try {
      await prepare(r);
      if (!valid()) return;
      r.hls?.startLoad(r.video.currentTime || 0);
      r.video.preload = 'auto';
      r.video.muted = mode === 'muted';
      r.video.volume = 1;
      try { await r.video.play(); }
      catch (error) {
        if (!valid()) return;
        if (error.name !== 'NotAllowedError') throw error;
        unlocked = false;
        r.video.muted = true;
        await r.video.play();
        soundUI();
      }
      if (!valid()) {
        // An earlier play promise can resolve after leave + re-enter.
        // It must not pause the newer request for this same video.
        if (active !== r || !wanted(r)) { r.video.pause(); r.hls?.stopLoad(); }
        return;
      }
      ui(r);
    } catch (error) {
      if (valid()) fail(r, /[\u3400-\u9fff]/.test(error.message) ? error.message : '播放暂时中断，请移入画面重试，或点击原片查看。');
    }
  };
  const leave = r => {
    if (r.full) return;
    r.hovered = r.manual = r.pausedByUser = false;
    pause(r);
  };
  const setSound = (next, target) => {
    mode = next;
    if (next === 'sound') unlocked = true;
    for (const r of records) { r.video.muted = next !== 'sound'; ui(r); }
    const r = target || active || (last?.visible && last);
    if (r && next === 'sound') { r.manual = true; r.pausedByUser = false; play(r); }
    soundUI();
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const r = records.find(r => r.player === entry.target);
      r.visible = entry.isIntersecting;
      if (!r.visible && !r.full) { r.focused = false; leave(r); }
    }
    warmNearest();
  }, {threshold:0});
  for (const r of records) {
    r.video.muted = true;
    r.video.playsInline = true;
    r.video.setAttribute('disableRemotePlayback', '');
    r.status = document.createElement('span');
    r.status.className = 'stream-status'; r.status.hidden = true; r.status.setAttribute('role', 'status');
    r.player.append(r.status);
    const original = document.createElement('a');
    original.href = r.video.dataset.srcFull || r.video.dataset.src;
    original.className = 'original-link'; original.textContent = '原片'; original.target = '_blank'; original.rel = 'noopener';
    original.setAttribute('aria-label', '打开原始画质文件：' + r.video.getAttribute('aria-label'));
    r.player.querySelector('.video-controls')?.append(original);
    observer.observe(r.player);
    // Listen on the stable picture wrapper, not the element being scaled.
    // This prevents cover fades and spring transforms from cancelling hover.
    const hotspot = r.player.closest('.collection-picture, .archive-media') || r.player;
    const hover = e => {
      if (r.reel || !fine.matches || e.pointerType === 'touch' || reduced.matches) return;
      if (r.hovered) return;
      r.hovered = true; r.pausedByUser = false;
      r.intent = setTimeout(() => play(r), 90);
    };
    listen(hotspot, 'pointerenter', hover);
    listen(hotspot, 'pointermove', hover);
    listen(hotspot, 'pointerleave', () => { if (!r.reel) leave(r); });
    listen(r.player, 'pointerup', e => {
      if (e.pointerType !== 'touch' || e.target.closest('button,a')) return;
      unlocked = true; r.manual = true; r.visible = true; r.pausedByUser = false; play(r);
    });
    listen(r.player.querySelector('[data-video-action="play"]'), 'click', () => {
      unlocked = true;
      if (!r.video.paused && !r.player.hasAttribute('data-stream-error')) { r.pausedByUser = true; pause(r, false); }
      else {
        if (r.player.hasAttribute('data-stream-error')) { dispose(r); r.retries = 0; }
        r.manual = true; r.visible = true; r.pausedByUser = false; play(r);
      }
    });
    listen(r.player.querySelector('[data-video-action="sound"]'), 'click', () => setSound(!r.video.muted && !r.video.paused ? 'muted' : 'sound', r));
    listen(r.player.querySelector('[data-video-action="fullscreen"]'), 'click', () => {
      unlocked = true; r.full = r.manual = r.visible = true; r.pausedByUser = false;
      if (r.player.requestFullscreen) r.player.requestFullscreen().catch(() => { r.full = false; });
      else r.video.webkitEnterFullscreen?.();
      play(r);
    });
    listen(r.video, 'playing', () => {
      if (!wanted(r) || active !== r) { pause(r); return; }
      if (!r.video.muted && mode === 'sound') unlocked = true;
      r.player.setAttribute('data-playing', ''); r.player.removeAttribute('data-loading'); status(r); ui(r);
    });
    listen(r.video, 'waiting', () => { if (wanted(r)) r.player.setAttribute('data-loading', ''); });
    listen(r.video, 'pause', () => { r.player.removeAttribute('data-playing'); ui(r); });
    listen(r.video, 'volumechange', () => ui(r));
    listen(r.video, 'error', () => { if (r.video.currentSrc && active === r) fail(r, '设备或网络暂时无法播放，点击重试或原片。'); });
    ui(r);
  }
  listen(globalSound, 'click', () => setSound(mode === 'sound' && unlocked ? 'muted' : 'sound'));
  listen(enable, 'click', () => setSound('sound'));
  listen(document, 'click', e => {
    if (e.target.closest('[data-video-action],[data-global-sound],[data-enable-audio]')) return;
    if (mode === 'sound' && !unlocked) { unlocked = true; if (active) play(active); soundUI(); }
  });
  listen(document, 'fullscreenchange', () => {
    if (!document.fullscreenElement) records.filter(r => r.full).forEach(r => { r.full = false; leave(r); });
  });
  listen(document, 'visibilitychange', () => {
    if (document.hidden) records.forEach(r => pause(r));
    else { const r = records.find(r => r.reel && r.focused); if (r) play(r); }
  });
  listen(window, 'scroll', warmNearest, {passive:true});
  listen(reduced, 'change', () => { if (reduced.matches) records.forEach(r => leave(r)); });
  soundUI();
  return {
    measure(rect, navBottom) {
      if (!rect) return;
      const progress = (innerHeight - rect.top) / Math.max(1, innerHeight - navBottom + rect.height);
      for (const r of records.filter(r => r.reel)) {
        const next = rect.bottom > navBottom && rect.top < innerHeight && progress >= (r.focused ? 0.20 : 0.27) && progress <= (r.focused ? 0.80 : 0.73);
        if (next && !r.focused) { r.focused = r.visible = true; play(r); }
        else if (!next && r.focused) { r.focused = false; leave(r); }
      }
    },
    cleanup() { destroyed = true; clearTimeout(warmTimer); observer.disconnect(); cleanups.forEach(fn => fn()); records.forEach(dispose); }
  };
};
