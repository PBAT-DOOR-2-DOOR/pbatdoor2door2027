// PBAT DOOR TO DOOR: Like & share (/share). Today's posts, videos and news, in one list.
import { mountNav, mountFooter } from '/app.js';
import { fillSite } from '/site-info.js';

fillSite();
mountNav();
mountFooter();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OPENED_KEY = 'pbat-share-opened';
const OPENED_MAX = 1000;
const PLATFORM_NAME = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  web: 'News',
};

const statusEl = document.querySelector('#share-status');
const listEl = document.querySelector('#share-list');
const chips = [...document.querySelectorAll('.share-chip')];
const hideBox = document.querySelector('#hide-opened');

let items = [];
let failed = false;
let ready = false;
let current = 'all';

function readOpened() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPENED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((url) => typeof url === 'string') : [];
  } catch {
    return [];
  }
}

function remember(url) {
  try {
    const next = readOpened().filter((item) => item !== url);
    next.push(url);
    localStorage.setItem(OPENED_KEY, JSON.stringify(next.slice(-OPENED_MAX)));
  } catch { /* private mode and full storage still let the card update on screen */ }
}

function openedSet() {
  return new Set(readOpened());
}

function passesHide(item, opened) {
  return !(hideBox.checked && opened.has(item.url));
}

function countFor(plat) {
  const opened = openedSet();
  return items.filter((item) => passesHide(item, opened) && (plat === 'all' || item.platform === plat)).length;
}

function updateCounts() {
  for (const chip of chips) {
    const label = chip.dataset.label || chip.textContent;
    chip.textContent = ready ? `${label} ${countFor(chip.dataset.plat || 'all')}` : label;
  }
}

function kindOf(action) {
  if (action === 'follow') return 'Account';
  if (action === 'read') return 'News';
  return 'Post';
}

function actionLabel(item) {
  if (item.action === 'read') return 'Read article';
  if (item.platform === 'youtube' && item.action === 'follow') return 'Subscribe on YouTube';
  const name = PLATFORM_NAME[item.platform] || item.platform;
  return item.action === 'follow' ? `Follow on ${name}` : `Like on ${name}`;
}

function posted(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function handleText(handle) {
  const text = String(handle || '').trim();
  if (!text) return '';
  return text.startsWith('@') ? text : `@${text}`;
}

function setStatus(text, note) {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-note', Boolean(text) && note);
}

function cardHtml(item, opened) {
  const when = posted(item.addedAt);
  const handle = handleText(item.handle);
  const badge = item.platform === 'web' ? '' : `<span class="share-badge">${esc(PLATFORM_NAME[item.platform] || item.platform)}</span>`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${item.name} ${item.url}`)}`;
  return `<article class="share-card${opened ? ' is-opened' : ''}">
    <div class="share-kicker">
      <span class="share-kind">${esc(kindOf(item.action))}</span>
      ${badge}
      ${opened ? '<span class="share-opened">Opened</span>' : ''}
      ${when ? `<time datetime="${esc(item.addedAt)}">${esc(when)}</time>` : ''}
    </div>
    ${item.name ? `<h2>${esc(item.name)}</h2>` : ''}
    ${handle ? `<p class="share-handle">${esc(handle)}</p>` : ''}
    ${item.reason ? `<p class="share-reason">${esc(item.reason)}</p>` : ''}
    ${item.note ? `<p class="share-note">${esc(item.note)}</p>` : ''}
    <div class="share-actions">
      <a class="btn small" href="${esc(item.url)}" target="_blank" rel="noopener" data-open>${esc(actionLabel(item))}</a>
      <a class="btn small ghost" href="${esc(wa)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <button type="button" class="btn small ghost" data-copy="${esc(item.url)}">Copy link</button>
    </div>
  </article>`;
}

function markOpened(card) {
  card.classList.add('is-opened');
  if (card.querySelector('.share-opened')) return;
  const kicker = card.querySelector('.share-kicker');
  if (!kicker) return;
  const mark = document.createElement('span');
  mark.className = 'share-opened';
  mark.textContent = 'Opened';
  const time = kicker.querySelector('time');
  if (time) kicker.insertBefore(mark, time);
  else kicker.append(mark);
}

function render() {
  updateCounts();
  if (!ready) return;
  if (failed) {
    listEl.replaceChildren();
    setStatus("Couldn't load the posts. Check your connection and refresh.", true);
    return;
  }
  if (items.length === 0) {
    listEl.replaceChildren();
    setStatus('No posts yet. Check back soon.', true);
    return;
  }
  const opened = openedSet();
  const shown = items.filter((item) => passesHide(item, opened) && (current === 'all' || item.platform === current));
  if (shown.length === 0) {
    listEl.replaceChildren();
    setStatus('Nothing left here. Try another platform, or check back later.', true);
    return;
  }
  setStatus('', false);
  listEl.innerHTML = shown.map((item) => cardHtml(item, opened.has(item.url))).join('');
}

for (const chip of chips) {
  chip.addEventListener('click', () => {
    current = chip.dataset.plat || 'all';
    for (const other of chips) other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
    render();
  });
}
hideBox.addEventListener('change', render);

const copyTimers = new WeakMap();
listEl.addEventListener('click', (event) => {
  const copyBtn = event.target.closest('[data-copy]');
  if (copyBtn) {
    const url = copyBtn.dataset.copy || '';
    const previous = copyTimers.get(copyBtn);
    if (previous) clearTimeout(previous);
    const show = (text) => {
      copyBtn.textContent = text;
      copyTimers.set(copyBtn, setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000));
    };
    const write = navigator.clipboard?.writeText;
    if (!write) { show('Copy failed'); return; }
    Promise.resolve(write.call(navigator.clipboard, url)).then(() => show('Copied'), () => show('Copy failed'));
    return;
  }
  const open = event.target.closest('[data-open]');
  if (!open) return;
  const url = open.getAttribute('href') || '';
  if (url) remember(url);
  const card = open.closest('.share-card');
  if (card) markOpened(card);
});

try {
  const response = await fetch('/api/pbat-feed');
  if (!response.ok) throw new Error('Feed request failed');
  const data = await response.json();
  items = Array.isArray(data.items) ? data.items : [];
} catch {
  failed = true;
  items = [];
}
ready = true;
render();
