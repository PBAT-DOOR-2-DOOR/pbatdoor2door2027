'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
  };
  const TITLE = 'Wetin Tinubu Don Do Sef';
  const POSTER = '/radio/assets/poster.svg';
  const OFF = 3600e3;
  const DAY = 86400e3;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let prog = {
    title: TITLE,
    station: 'Radio Nigeria Network · Kapital FM 92.9',
    airDays: [1, 2, 3, 4, 5],
    airTime: '08:45',
    durationMin: 15,
    streamUrl: 'https://cast4.my-control-panel.com/proxy/radioni1/Stream',
  };
  let episodes = [];
  let playing = null; // null | 'live' | episode id
  let activeEp = null;

  const minsOf = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : 525; };
  const clock = (t) => { const m = minsOf(t), h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  function status(now) {
    const days = prog.airDays || [], dur = (prog.durationMin || 15) * 60e3, lagos = now + OFF, midnight = lagos - (((lagos % DAY) + DAY) % DAY);
    for (let d = -1; d <= 7; d++) {
      const dayStart = midnight + d * DAY;
      if (!days.includes(new Date(dayStart).getUTCDay())) continue;
      const start = dayStart + minsOf(prog.airTime) * 60e3 - OFF, end = start + dur;
      if (end > now) return { onAir: start <= now, start, end };
    }
    return { onAir: false, start: null, end: null };
  }
  const dayLabel = (start, now) => { const diff = Math.floor((start + OFF) / DAY) - Math.floor((now + OFF) / DAY);
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : DAYS[new Date(start + OFF).getUTCDay()]; };
  const countdown = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return d ? `${d} d ${h} h` : h ? `${h} h ${String(m).padStart(2, '0')} m` : m ? `${m} m ${String(x).padStart(2, '0')} s` : `${x} s`; };

  const liveAudio = $('#live-audio');
  const epVideo = $('#ep-video');
  const epAudio = $('#ep-audio');
  const vol = $('#vol');
  const msg = $('#msg');
  const liveBtn = $('#live-circle');
  const listenBtn = $('#listen');
  const epPanel = $('#ep-player');

  if (new URLSearchParams(location.search).get('from') === 'zoni') $('#back').hidden = false;

  try {
    const v = localStorage.getItem('radio-vol');
    if (v !== null && +v >= 0 && +v <= 1) liveAudio.volume = +v;
  } catch {}
  vol.value = liveAudio.volume;
  vol.disabled = true;

  const say = (t) => { msg.textContent = t || ''; };

  function stopAll(note = '') {
    liveAudio.pause();
    liveAudio.removeAttribute('src');
    liveAudio.load();
    epVideo.pause();
    epVideo.removeAttribute('src');
    epVideo.load();
    epAudio.pause();
    epAudio.removeAttribute('src');
    epAudio.load();
    epVideo.hidden = true;
    epAudio.hidden = true;
    epPanel.hidden = true;
    playing = null;
    activeEp = null;
    say(note);
    paint();
  }

  function stopEpisode() {
    epVideo.pause();
    epVideo.removeAttribute('src');
    epVideo.load();
    epAudio.pause();
    epAudio.removeAttribute('src');
    epAudio.load();
    epVideo.hidden = true;
    epAudio.hidden = true;
    epPanel.hidden = true;
    if (playing !== 'live') playing = null;
    activeEp = null;
    paint();
  }

  async function startLive() {
    stopEpisode();
    if (playing === 'live') { stopAll(); return; }
    playing = 'live';
    say('Connecting…');
    paint();
    const url = `${prog.streamUrl}${prog.streamUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    liveAudio.src = url;
    try {
      await liveAudio.play();
      say('');
    } catch {
      stopAll('Stream unavailable, try again.');
    }
  }

  async function startEpisode(ep) {
    liveAudio.pause();
    liveAudio.removeAttribute('src');
    liveAudio.load();
    playing = ep.id;
    activeEp = ep;
    paint();
    const src = episodeSrc(ep);
    const isVideo = /\.(mp4|m4v|webm)(\?|$)/i.test(src);
    const player = isVideo ? epVideo : epAudio;
    epVideo.hidden = !isVideo;
    epAudio.hidden = isVideo;
    epVideo.removeAttribute('src');
    epAudio.removeAttribute('src');
    player.src = src;
    $('#ep-now').innerHTML = `<b>${esc(ep.title || TITLE)}</b>`;
    epPanel.hidden = false;
    try {
      await player.play();
    } catch {
      stopAll("This episode won't play right now, try again.");
    }
  }

  liveAudio.addEventListener('error', () => { if (playing === 'live') stopAll('Stream unavailable, try again.'); });
  liveAudio.addEventListener('waiting', () => { if (playing === 'live') say('Buffering…'); });
  liveAudio.addEventListener('playing', () => { if (playing === 'live') say(''); });

  const onEpEnd = () => stopEpisode();
  const onEpErr = () => { if (activeEp) stopAll("This episode won't play right now, try again."); };
  epVideo.addEventListener('ended', onEpEnd);
  epVideo.addEventListener('error', onEpErr);
  epAudio.addEventListener('ended', onEpEnd);
  epAudio.addEventListener('error', onEpErr);

  vol.addEventListener('input', (e) => {
    liveAudio.volume = +e.target.value;
    try { localStorage.setItem('radio-vol', String(liveAudio.volume)); } catch {}
  });

  listenBtn.addEventListener('click', () => startLive());
  liveBtn.addEventListener('click', () => startLive());
  $('#stop-ep').addEventListener('click', () => stopEpisode());

  function paint() {
    const live = playing === 'live';
    liveBtn.classList.toggle('on', live);
    liveBtn.innerHTML = live ? ICON.stop : ICON.play;
    liveBtn.setAttribute('aria-label', live ? 'Stop the live stream' : 'Play the live stream');
    listenBtn.classList.toggle('on', live);
    listenBtn.textContent = live ? 'Stop live' : 'Listen live';
    vol.disabled = !live;
    $('#onair-badge').hidden = !live;
    paintStatus();
    paintEpisodes();
  }

  function paintStatus() {
    const now = Date.now(), st = status(now);
    const el = $('#status');
    if (st.onAir) {
      el.innerHTML = `<span class="onair"><i></i>ON AIR NOW</span><span class="fine">until ${clock(new Date(st.end + OFF).toISOString().slice(11, 16))}</span>`;
    } else if (st.start) {
      el.innerHTML = `<span>Next episode: <b>${dayLabel(st.start, now)}, ${clock(prog.airTime)}</b> · in <span class="count">${countdown(st.start - now)}</span></span><span class="fine">Station live · programme off air</span>`;
    } else {
      el.innerHTML = '<span class="fine">Station live · programme off air</span>';
    }
  }

  const episodeSrc = (e) => {
    const p = String(e.path || e.url || '');
    if (/^(https?:)?\/\//.test(p) || p.startsWith('/')) return p;
    return `/radio/${p.replace(/^\.?\//, '')}`;
  };
  const when = (d) => {
    const t = Date.parse(`${d}T12:00:00Z`);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : esc(d);
  };
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(+s || 0));
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  const fmtBytes = (b) => {
    b = +b || 0;
    if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
    return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
  };
  const mediaKind = (src) => (/\.(mp4|m4v|webm)(\?|$)/i.test(src) ? 'MP4' : /\.(mp3|mpeg)(\?|$)/i.test(src) ? 'MP3' : 'Audio');

  function paintEpisodes() {
    const grid = $('#ep-grid');
    if (!episodes.length) {
      grid.innerHTML = '<li class="empty">Episodes appear here when recordings are in the radio folder or listed in episodes.json.</li>';
      return;
    }
    grid.innerHTML = episodes.map((e) => {
      const src = episodeSrc(e);
      const on = playing === e.id;
      const poster = /\.(mp4|m4v|webm)(\?|$)/i.test(src) ? '' : POSTER;
      return `<li>
        <button type="button" class="ep-card${on ? ' playing' : ''}" data-ep="${esc(e.id)}" aria-label="Play ${esc(e.title || TITLE)}">
          <div class="thumb-wrap">
            ${poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : `<video src="${esc(src)}" preload="metadata" muted playsinline aria-hidden="true"></video>`}
            <span class="thumb-play" aria-hidden="true"><span>${on ? ICON.stop : ICON.play}</span></span>
            <span class="dur">${fmtDur(e.seconds)}</span>
          </div>
          <div class="ep-body">
            <h3>${esc(e.title || TITLE)}</h3>
            <p>${esc(e.description || 'Past episode from the breakfast show.')}</p>
            <div class="ep-meta">
              <span>${when(e.date)}</span>
              <span>${mediaKind(src)}</span>
              ${e.bytes ? `<span>${fmtBytes(e.bytes)}</span>` : ''}
            </div>
          </div>
        </button>
      </li>`;
    }).join('');

    grid.querySelectorAll('.ep-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ep = episodes.find((x) => x.id === btn.dataset.ep);
        if (!ep) return;
        if (playing === ep.id) stopAll();
        else startEpisode(ep);
      });
    });
  }

  async function loadManifest() {
    const list = [];
    try {
      const r = await fetch('/radio/episodes.json', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d && d.programme) prog = { ...prog, ...d.programme };
        if (Array.isArray(d.episodes)) {
          d.episodes.forEach((e) => {
            if (e && e.id && (e.path || e.url)) list.push(e);
          });
        }
      }
    } catch { /* offline or not written yet */ }

    const seen = new Set(list.map((e) => episodeSrc(e)));
    const extras = await loadLooseMedia(seen);
    episodes = [...list, ...extras].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));

    $('#title').textContent = prog.title || TITLE;
    $('#sub').textContent = `${prog.station} · ${clock(prog.airTime)}`;
    paint();
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash) {
      const ep = episodes.find((e) => e.id === hash);
      if (ep) document.getElementById(hash)?.scrollIntoView({ block: 'center' });
    }
  }

  /** Optional loose MP4/MP3 files alongside episodes.json (same radio dir). */
  async function loadLooseMedia(seen) {
    const out = [];
    for (const name of ['media-index.json']) {
      try {
        const r = await fetch(`/radio/${name}`, { cache: 'no-store' });
        if (!r.ok) continue;
        const files = await r.json();
        if (!Array.isArray(files)) continue;
        files.forEach((f) => {
          const path = String(f.path || f.file || '');
          const src = episodeSrc({ path });
          if (!path || seen.has(src)) return;
          seen.add(src);
          out.push({
            id: f.id || path.replace(/[^\w.-]+/g, '-'),
            date: f.date || '',
            title: f.title || path.split('/').pop(),
            description: f.description || '',
            path,
            seconds: f.seconds || 0,
            bytes: f.bytes || 0,
          });
        });
      } catch { /* no index */ }
    }
    return out;
  }

  paint();
  loadManifest();
  setInterval(paintStatus, 1000);
})();
