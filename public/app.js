'use strict';

// ------------------------------------------------------------ helpers

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

// Player settings, kept on this device. Anyone who had muted a big screen before settings existed stays muted.
const SETTINGS_DEFAULT = { sound: true, volume: .7, ticks: true, vibrate: true, calm: false, music: true, musicVol: .5 };
const settings = Object.assign({}, SETTINGS_DEFAULT,
  store.get('outlier.settings') || (store.get('outlier.tvMute', false) ? { sound: false } : {}));
function setSetting(key, value) {
  settings[key] = value;
  store.set('outlier.settings', settings);
  document.documentElement.classList.toggle('calm', !!settings.calm);
  sfx.level();
  music.sync();
}
document.documentElement.classList.toggle('calm', !!settings.calm);
// "Reduce animations" in Settings, or the phone's own reduced-motion setting.
const calm = () => !!settings.calm || matchMedia('(prefers-reduced-motion: reduce)').matches;
function buzz(pattern) {
  if (!settings.vibrate) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not supported */ }
}

async function api(path, body) {
  const session = store.get('outlier.session', '');
  const headers = session ? { 'X-Session': session } : {};
  const res = await fetch(path, body
    ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Markers start where they were; this lets CSS walk them to the new score.
function walk() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('[data-to]').forEach(el => {
      if (el.closest('.wait')) return;   // held back until the score has finished building
      el.style[el.classList.contains('fill') ? 'width' : 'left'] = el.dataset.to + '%';
    });
  }));
}

let lastScreen = '';
function show(html) {
  const sig = html.replace(/\d+/g, '').slice(0, 900);
  const fresh = sig !== lastScreen;
  lastScreen = sig;
  app.innerHTML = html;
  if (fresh && !calm()) {
    app.classList.remove('enter');
    void app.offsetWidth;   // restart the animation
    app.classList.add('enter');
  }
  if (fresh) window.scrollTo(0, 0);
  walk();
}

// A short title card before a game starts ("Daily seven · Everything", "7 prompts · 30 seconds each"),
// so jumping into the first question isn't so abrupt. Tap to skip; it is skipped when motion is reduced.
function intro(title, sub, then) {
  if (calm()) return then();
  stopTimer();
  show(`<section class="intro" id="intro">
      <div class="intro-dots">${crowdHTML(3)}</div>
      <p class="eyebrow">Get ready</p>
      <h1>${esc(title)}</h1>
      <p class="muted">${esc(sub)}</p>
      <div class="intro-bar"><i></i></div>
    </section>`);
  let done = false;
  const go = () => { if (done) return; done = true; then(); };
  $('#intro').onclick = go;
  setTimeout(go, 1600);
}

// A small line-icon set, drawn with currentColor so icons follow the text colour.
const ICON = {
  thumb: '<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M7 10l4-7a2.5 2.5 0 0 1 3 3l-1 4h5.5a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 17 21H7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.9 2.9-6 6.5-6s6.5 2.1 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.3c2.2.7 3.5 2.6 3.5 5.7"/>',
  trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3"/>',
  ball: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5l4 2.9-1.5 4.7h-5L8 10.4z"/><path d="M12 3v4.5M16 10.4l4.3-1.4M14.5 15.1l2.7 3.7M9.5 15.1l-2.7 3.7M8 10.4 3.7 9"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  film: '<rect x="3" y="10" width="18" height="11" rx="2"/><path d="m3.4 9.6 15.5-5 .9 2.9-15.5 5"/><path d="M8.2 8.1l1.9 2.7M13.2 6.5l1.9 2.7"/>',
  gamepad: '<rect x="2" y="7" width="20" height="11" rx="5.5"/><path d="M7 10.5v4M5 12.5h4"/><circle cx="15.5" cy="11.5" r=".6"/><circle cx="18" cy="13.5" r=".6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  landmark: '<path d="M3 21h18M4 10h16M12 3l9 5H3z"/><path d="M6 10v8M10 10v8M14 10v8M18 10v8"/>',
  flask: '<path d="M9 3h6M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3"/><path d="M7 15h10"/>',
  utensils: '<path d="M7 3v18M4 3v5a3 3 0 0 0 6 0V3"/><path d="M18 21V3c-2.2 1.2-3.5 4-3.5 8.5H18"/>',
  book: '<path d="M12 6.5C10.4 5 8 4.5 4 4.5v14c4 0 6.4.5 8 2 1.6-1.5 4-2 8-2v-14c-4 0-6.4.5-8 2z"/><path d="M12 6.5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 13.2 7.6 4.6M15.8 6.2 8.2 10.8"/>',
  flame: '<path d="M12 21.5c3.9 0 6.5-2.7 6.5-6.3 0-3.7-2.6-5.6-3.6-9.7-1.8 1.4-2.8 3.4-2.9 5.4-1-.9-1.8-2.2-2-3.9-2.1 2.1-3.5 4.9-3.5 8.2 0 3.6 2.6 6.3 5.5 6.3z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  crown: '<path d="M3 8l4.5 4.5L12 5l4.5 7.5L21 8l-2 11H5z"/>',
  tv: '<rect x="2.5" y="4.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 17.5V21"/>',
  vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5z"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
  gem: '<path d="M6.5 4h11l3.5 5-9 11L3 9z"/><path d="M3 9h18M9.5 4 8 9l4 11 4-11-1.5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>',
  wave: '<path d="M3 12h2l2-5 3 10 3-14 3 12 2-3h3"/>',
};
const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;
const PCOL = ['#ff6b6b', '#ff9f43', '#feca57', '#7bd88f', '#2ed3b7', '#4cc9f0', '#5b8cff', '#9b7bff', '#d77bff', '#ff7bd0', '#b8c4d6', '#c9a27a'];
const PCOL_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Sky', 'Blue', 'Violet', 'Purple', 'Pink', 'Silver', 'Sand'];
// ---- Characters: a little face in the player's colour, built from four parts (head, eyes, mouth, hat), saved as
// four digits like "2140". Anyone who hasn't picked one gets a character worked out from their name.
const LOOK_N = [12, 12, 12, 14, 10];   // grows below as the category items are added to the hat and face rows
const BASE_N = [...LOOK_N];   // the parts everyone has from the start
const LOOK_LABELS = ['Head', 'Eyes', 'Mouth', 'Hat', 'Face'];
const INK = '#14152b';
const inkLine = d => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
const PC = 'style="stroke:var(--pc)"';   // a line in the player's colour (antennae and such)
const PINK = '#ff9fb8', BROWN = '#5a3b22';
const LOOK_PARTS = [
  // heads, drawn in the player's colour
  ['<circle cx="20" cy="24" r="13"/>',
    '<rect x="7.5" y="11.5" width="25" height="25" rx="7"/>',
    '<path d="M7 24a13 13 0 0 1 26 0v13l-4.33-3-4.33 3-4.34-3-4.33 3-4.34-3L7 37z"/>',
    '<ellipse cx="20" cy="24" rx="11.5" ry="14"/>',
    '<path d="M8.5 19 9.5 7l8 6zM31.5 19l-1-12-8 6z"/><circle cx="20" cy="24" r="13"/>',
    '<circle cx="10.5" cy="13.5" r="4.5"/><circle cx="29.5" cy="13.5" r="4.5"/><circle cx="20" cy="24" r="13"/>',
    `<g data-top><path d="M14.5 13 12 5.5M25.5 13 28 5.5" ${PC} stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="12" cy="5" r="2.4"/><circle cx="28" cy="5" r="2.4"/></g><ellipse cx="20" cy="24.5" rx="14" ry="12.5"/>`,
    `<g data-top><rect x="11" y="1" width="6" height="16" rx="3"/><rect x="23" y="1" width="6" height="16" rx="3"/><rect x="12.8" y="3.5" width="2.4" height="9" rx="1.2" fill="${PINK}"/><rect x="24.8" y="3.5" width="2.4" height="9" rx="1.2" fill="${PINK}"/></g><circle cx="20" cy="24.5" r="12.5"/>`,
    `<g data-top><path d="M20 11.5V5.5" ${PC} stroke-width="2"/><circle cx="20" cy="4.5" r="2.3" fill="#ff6b6b"/></g><g data-side><rect x="4.5" y="19" width="3.5" height="8" rx="1.5"/><rect x="32" y="19" width="3.5" height="8" rx="1.5"/></g><rect x="7" y="11" width="26" height="25.5" rx="4"/>`,
    '<g data-top><path d="M9.5 17 11.5 6l4.5 6.5L20 3.5l4 9L28.5 6l2 11z"/></g><circle cx="20" cy="24" r="13"/>',
    `<circle cx="9" cy="12.5" r="6.5"/><circle cx="31" cy="12.5" r="6.5"/><circle cx="9" cy="12.5" r="3.5" fill="${PINK}"/><circle cx="31" cy="12.5" r="3.5" fill="${PINK}"/><circle cx="20" cy="25" r="12.5"/>`,
    '<path d="M20 10.5c6 0 8.5 2.5 11 5.5s3.5 8 2.5 12-4.5 9-13.5 9-12.5-4-13.5-8.5 0-9 2.5-12.5 5-5.5 11-5.5z"/>'],
  // eyes
  [`<circle cx="15" cy="22" r="2" fill="${INK}"/><circle cx="25" cy="22" r="2" fill="${INK}"/>`,
    `<circle cx="15" cy="22" r="3.3" fill="${INK}"/><circle cx="25" cy="22" r="3.3" fill="${INK}"/><circle cx="16" cy="21" r="1.1" fill="#fff"/><circle cx="26" cy="21" r="1.1" fill="#fff"/>`,
    inkLine('M12.5 23q2.5-3.5 5 0M22.5 23q2.5-3.5 5 0'),
    inkLine('M12.5 22.5h5M22.5 22.5h5'),
    `<circle cx="15" cy="22" r="2" fill="${INK}"/>${inkLine('M22.5 23q2.5-3.5 5 0')}`,
    `<rect x="10" y="19.5" width="8.5" height="5" rx="2" fill="${INK}"/><rect x="21.5" y="19.5" width="8.5" height="5" rx="2" fill="${INK}"/>${inkLine('M18.5 21h3')}`,
    `<circle cx="15" cy="22.5" r="2" fill="${INK}"/><circle cx="25" cy="22.5" r="2" fill="${INK}"/>${inkLine('M12 18.5l5 2M28 18.5l-5 2')}`,
    `<circle cx="20" cy="21.5" r="5.2" fill="#fff"/><circle cx="20" cy="22" r="2.7" fill="${INK}"/><circle cx="21" cy="21" r=".9" fill="#fff"/>`,
    '<path d="M15 25l-2.7-2.6a1.7 1.7 0 0 1 2.7-2.1 1.7 1.7 0 0 1 2.7 2.1zM25 25l-2.7-2.6a1.7 1.7 0 0 1 2.7-2.1 1.7 1.7 0 0 1 2.7 2.1z" fill="#ff4d6d"/>',
    inkLine('M13 20l4 4M17 20l-4 4M23 20l4 4M27 20l-4 4'),
    `<ellipse cx="15" cy="22" rx="3.2" ry="3.4" fill="#fff"/><ellipse cx="25" cy="22" rx="3.2" ry="3.4" fill="#fff"/><circle cx="16.4" cy="22.4" r="1.7" fill="${INK}"/><circle cx="26.4" cy="22.4" r="1.7" fill="${INK}"/>`,
    `<path d="M15 18.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1zM25 18.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="${INK}"/>`],
  // mouths
  [inkLine('M16 28.5q4 4 8 0'),
    `<path d="M15 28h10a5 5 0 0 1-10 0z" fill="${INK}"/>`,
    `<circle cx="20" cy="30" r="2.2" fill="${INK}"/>`,
    inkLine('M17 30h6'),
    `${inkLine('M16 28.5q4 4 8 0')}<path d="M18.5 30.3h3v1.6a1.5 1.5 0 0 1-3 0z" fill="#ff7b9c"/>`,
    inkLine('M16 28.5q2 2.2 4 0q2 2.2 4 0'),
    `${inkLine('M15.5 28q4.5 3.8 9 0')}<path d="M16.9 29l1.1 2.4 1-1.8zM23.1 29l-1.1 2.4-1-1.8z" fill="#fff"/>`,
    inkLine('M16 31q4-4 8 0'),
    inkLine('M16.5 29.6q4 1.6 7.5-1.6'),
    inkLine('M15.5 29.5l1.5-1.2 1.5 1.2 1.5-1.2 1.5 1.2 1.5-1.2 1.5 1.2'),
    `${inkLine('M16 28q4 2.6 8 0')}<rect x="18.3" y="28.8" width="3.4" height="3" rx=".6" fill="#fff" stroke="${INK}" stroke-width=".8"/>`,
    `<path d="M14 27.5h12a6 6 0 0 1-12 0z" fill="${INK}"/><path d="M17 31.8a3 2 0 0 1 6 0 5.5 5.5 0 0 1-6 0z" fill="#ff7b9c"/>`],
  // hats
  ['',
    '<path d="M14.5 13 20 1.5 25.5 13z" fill="#5b8cff"/><path d="M16.3 9.2h7.4" stroke="#ffd166" stroke-width="1.6"/><circle cx="20" cy="1.8" r="1.8" fill="#ffd166"/>',
    `<path d="M11 14V5.5l4.5 4L20 3l4.5 6.5L29 5.5V14z" fill="#ffd166" stroke="${INK}" stroke-width=".8" stroke-linejoin="round"/>`,
    '<path d="M8.5 16a11.5 9 0 0 1 23 0z" fill="#33417a" stroke="#fff" stroke-width=".8"/><path d="M20 7v9" stroke="#fff" stroke-width="1.2"/><rect x="22" y="14" width="13" height="3.2" rx="1.6" fill="#232d57" stroke="#fff" stroke-width=".8"/>',
    '<path d="M8 17a12 12 0 0 1 24 0z" fill="#2ed3b7"/><rect x="7.5" y="15" width="25" height="4" rx="2" fill="#20a891"/><circle cx="20" cy="4.5" r="2.8" fill="#fff"/>',
    `<path d="M8 25a12 13 0 0 1 24 0" fill="none" stroke="${INK}" stroke-width="2.4"/><rect x="5" y="21" width="5" height="9" rx="2.2" fill="#ff9f43"/><rect x="30" y="21" width="5" height="9" rx="2.2" fill="#ff9f43"/>`,
    '<ellipse cx="20" cy="5" rx="8" ry="2.6" fill="none" stroke="#ffd166" stroke-width="2"/>',
    '<path d="M27 11l-5-4v8zM27 11l5-4v8z" fill="#ff7bd0"/><circle cx="27" cy="11" r="1.8" fill="#d14fa5"/>',
    '<g fill="#3a3f63" stroke="#9aa3c7" stroke-width=".7"><rect x="13" y="1" width="14" height="11.5" rx="1.5"/><rect x="9" y="11.5" width="22" height="3" rx="1.5"/></g><rect x="13.4" y="8.3" width="13.2" height="2.2" fill="#ff6b6b"/>',
    '<path d="M9.5 14 22 0l8.5 14z" fill="#7b5bff"/><ellipse cx="20" cy="14" rx="13" ry="2.6" fill="#5a3fd6"/><path d="M19 6.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="#ffd166"/><circle cx="23.5" cy="10" r=".9" fill="#ffd166"/>',
    `<path d="M9.5 14C5.5 12.5 4 8 4.5 3.5c1.5 4 4.5 5.8 7.5 6.5zM30.5 14c4-1.5 5.5-6 5-10.5-1.5 4-4.5 5.8-7.5 6.5z" fill="#fff4dc" stroke="${INK}" stroke-width=".6"/><path d="M8 17a12 11 0 0 1 24 0z" fill="#b8c4d6"/><rect x="7.5" y="15" width="25" height="3" rx="1.5" fill="#8f9bb0"/>`,
    '<g fill="#ff7bd0"><circle cx="29" cy="7" r="2.6"/><circle cx="32.2" cy="9.4" r="2.6"/><circle cx="31" cy="13" r="2.6"/><circle cx="27" cy="13" r="2.6"/><circle cx="25.8" cy="9.4" r="2.6"/></g><circle cx="29" cy="10.3" r="1.9" fill="#ffd166"/>',
    '<path d="M12 15.5v-4.5a4.5 4.5 0 0 1 2-8.3A5 5 0 0 1 20 1a5 5 0 0 1 6 1.7 4.5 4.5 0 0 1 2 8.3v4.5z" fill="#fff" stroke="#c9cfdc" stroke-width=".8"/>',
    `<path d="M9 16a11 10 0 0 1 22 0z" fill="#feca57"/><path d="M14 8.5a11 10 0 0 1 12 0" fill="none" stroke="#ff6b6b" stroke-width="1.6"/><path d="M20 6.2V3.6" stroke="${INK}" stroke-width="1.4"/><path d="M13.5 3h13" stroke="#5b8cff" stroke-width="2.2" stroke-linecap="round"/><circle cx="20" cy="3" r="1.3" fill="${INK}"/>`],
  // face extras: [drawn under the eyes and mouth, drawn over them]
  [['', ''],
    [`<ellipse cx="11.5" cy="27" rx="2.7" ry="1.7" fill="#ff7b9c" opacity=".75"/><ellipse cx="28.5" cy="27" rx="2.7" ry="1.7" fill="#ff7b9c" opacity=".75"/>`, ''],
    [`<g fill="${BROWN}" opacity=".55"><circle cx="10.5" cy="26" r=".8"/><circle cx="12.6" cy="27.4" r=".8"/><circle cx="10.8" cy="28.6" r=".8"/><circle cx="29.5" cy="26" r=".8"/><circle cx="27.4" cy="27.4" r=".8"/><circle cx="29.2" cy="28.6" r=".8"/></g>`, ''],
    ['', `<path d="M20 27c-2.3-2.2-6.5-2.4-8.6.6 2.6.4 4.8 2.2 8.6.4 3.8 1.8 6 0 8.6-.4-2.1-3-6.3-2.8-8.6-.6z" fill="${BROWN}"/>`],
    ['', `<g fill="none" stroke="${INK}" stroke-width="1.3"><circle cx="15" cy="22" r="4.2"/><circle cx="25" cy="22" r="4.2"/><path d="M19.2 22h1.6M10.8 21.5 7.5 20M29.2 21.5l3.3-1.5"/></g>`],
    ['', `<path d="M8 15.5 32 24" stroke="${INK}" stroke-width="1.2"/><ellipse cx="25" cy="22.2" rx="4.2" ry="3.8" fill="${INK}"/>`],
    ['', '<rect x="24" y="25.2" width="7.5" height="3.2" rx="1.4" transform="rotate(-25 27.7 26.8)" fill="#f2c39b"/><path d="M26.6 26.2l.4.8m.9-1.3.4.8" stroke="#c99a72" stroke-width=".7"/>'],
    ['', '<circle cx="20" cy="26" r="2.3" fill="#ff4d4d"/><circle cx="19.3" cy="25.3" r=".6" fill="#fff" opacity=".8"/>'],
    ['', '<path d="M31.5 13c1.7 2.4 2.5 3.8 2.5 4.8a2.5 2.5 0 0 1-5 0c0-1 .8-2.4 2.5-4.8z" fill="#7fd3ff"/>'],
    [`<path d="M8 27c1 7 6 11.5 12 11.5S31 34 32 27c-3 3-7 3.2-9 1.6h-6C15 30.2 11 30 8 27z" fill="${BROWN}"/>`, '']]];
// ---- category items: three for each main category, earned by playing it (CAT_GOALS). They go on the end of the hat
// and face rows, so a look is still five characters and party rooms need nothing new.
const GOLD = 'fill="#ffd166" stroke="#c98f1c" stroke-width=".6"';
const twinkle = (x, y, r = 1.4) => `<path d="M${x} ${y - r}l${r * .4} ${r * .6} ${r * .6} ${r * .4}-${r * .6} ${r * .4}-${r * .4} ${r * .6}-${r * .4}-${r * .6}-${r * .6}-${r * .4} ${r * .6}-${r * .4}z" fill="#fff"/>`;
const leaf = (x, y, a) => `<ellipse cx="${x}" cy="${y}" rx="1.4" ry="2.7" transform="rotate(${a} ${x} ${y})"/>`;
const puff = (list, fill, line) => `<g fill="${fill}" stroke="${line}" stroke-width="1.3">${list.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g><g fill="${fill}">${list.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`;
const CAT_ITEMS = [
  // [category, tier, part (3 = hat, 4 = face), name, drawing; a face is [under the eyes and mouth, over them]]
  ['sport', 1, 4, 'Face paint', ['<g fill="#fff"><rect x="8.5" y="25" width="5.5" height="1.5" rx=".75"/><rect x="26" y="25" width="5.5" height="1.5" rx=".75"/></g><g fill="#ff4d6d"><rect x="8.5" y="27.2" width="5.5" height="1.5" rx=".75"/><rect x="26" y="27.2" width="5.5" height="1.5" rx=".75"/></g>', '']],
  ['sport', 2, 3, 'Sweatband', '<rect x="7" y="14.3" width="26" height="4.4" rx="2.2" fill="#fff"/><rect x="7" y="15.7" width="26" height="1.6" fill="#ff4d6d"/>'],
  ['sport', 3, 3, "Champion's cup", `<g ${GOLD}><path d="M14 2.5h12V6a6 6 0 0 1-12 0z"/><rect x="18.8" y="11.6" width="2.4" height="1.8"/><rect x="15.5" y="13" width="9" height="2.2" rx=".7"/></g><path d="M14 4h-2.2a2.6 2.6 0 0 0 2.9 3.8M26 4h2.2a2.6 2.6 0 0 1-2.9 3.8" fill="none" stroke="#c98f1c" stroke-width="1.2"/>${twinkle(17, 5.5)}`],
  ['music', 1, 4, 'Microphone', ['', '<rect x="25.2" y="30.5" width="2.8" height="8.5" rx="1.2" transform="rotate(-35 26.6 34.7)" fill="#3a3f63"/><circle cx="24" cy="29.8" r="2.9" fill="#c9d3e6" stroke="#14152b" stroke-width=".7"/><path d="M22.2 29h3.6M22.4 30.6h3.2" stroke="#8f9bb0" stroke-width=".5"/>']],
  ['music', 2, 3, 'Mohawk', '<path d="M13 14 12 6.5l3.5 3.5L17 2.5l2.5 6.5L21.5 1l1.5 7.5L26.5 4l-.3 6L29 7.5l-2 6.5z" fill="#ff7bd0" stroke="#d14fa5" stroke-width=".7" stroke-linejoin="round"/>'],
  ['music', 3, 3, 'Disco ball', `<path d="M20 0v1" stroke="#9aa3c7" stroke-width=".8"/><circle cx="20" cy="6.8" r="6" fill="#c9d3e6" stroke="#8f9bb0" stroke-width=".7"/><path d="M14.4 6.8h11.2M15.3 3.7h9.4M15.3 9.9h9.4M20 .8v12M17 1.6q-1.9 5.2 0 10.4M23 1.6q1.9 5.2 0 10.4" stroke="#8f9bb0" stroke-width=".5" fill="none"/><rect x="21" y="3.9" width="2" height="2" fill="#fff" opacity=".8"/>${twinkle(31, 4, 1.6).replace('#fff', '#ffd166')}${twinkle(9, 9, 1.2).replace('#fff', '#ff7bd0')}`],
  ['film', 1, 4, '3D glasses', ['', '<rect x="10" y="19" width="9" height="6.2" rx="1" fill="#ff4d6d" opacity=".85"/><rect x="21" y="19" width="9" height="6.2" rx="1" fill="#4cc9f0" opacity=".85"/><path d="M10 19h20v6.2H10zM19 21.5h2M10 20.5l-3-1M30 20.5l3-1" fill="none" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>']],
  ['film', 2, 3, 'Popcorn bucket', '<path d="M13 15 11.5 5.5h17L27 15z" fill="#fff"/><path d="M14.3 5.5l.8 9.5h2.4l-.3-9.5zM18.8 5.5V15h2.4V5.5zM23.5 5.5l-.3 9.5h2.4l.8-9.5z" fill="#ff4d6d"/><g fill="#fff4cc" stroke="#e8c66a" stroke-width=".5"><circle cx="13.5" cy="4.8" r="2"/><circle cx="17" cy="3.4" r="2.2"/><circle cx="20.5" cy="2.7" r="2.2"/><circle cx="24" cy="3.5" r="2.2"/><circle cx="27" cy="4.9" r="1.9"/></g>'],
  ['film', 3, 3, 'Gold star', `<path d="M20 .5l2.4 4.9 5.4.8-3.9 3.8.9 5.4L20 12.9l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" fill="#ffd166" stroke="#c98f1c" stroke-width=".7" stroke-linejoin="round"/>${twinkle(30.5, 4)}${twinkle(9.5, 6, 1.1)}`],
  ['gaming', 1, 4, 'Pixel shades', ['', '<g fill="#14152b" shape-rendering="crispEdges"><rect x="9" y="19.5" width="22" height="1.8"/><rect x="10.5" y="21" width="8" height="3"/><rect x="21.5" y="21" width="8" height="3"/><rect x="11.5" y="24" width="6" height="1.3"/><rect x="22.5" y="24" width="6" height="1.3"/></g><g fill="#fff" shape-rendering="crispEdges"><rect x="12" y="21.6" width="1.4" height="1.4"/><rect x="23" y="21.6" width="1.4" height="1.4"/></g>']],
  ['gaming', 2, 3, 'Gaming headset', '<path d="M8 25a12 13 0 0 1 24 0" fill="none" stroke="#14152b" stroke-width="2.4"/><rect x="4.8" y="20" width="5.6" height="10" rx="2.4" fill="#7bd88f" stroke="#14152b" stroke-width=".7"/><rect x="29.6" y="20" width="5.6" height="10" rx="2.4" fill="#7bd88f" stroke="#14152b" stroke-width=".7"/><path d="M7.6 29.5q1 4.6 7.4 4.2" fill="none" stroke="#14152b" stroke-width="1.2"/><circle cx="15.4" cy="33.6" r="1.5" fill="#14152b"/>'],
  ['gaming', 3, 3, 'Pixel crown', '<path d="M11 15V6h2v2h2V5h2v3h2V2.5h2V8h2V5h2v3h2V6h2v9z" fill="#ffd166" stroke="#c98f1c" stroke-width=".6" shape-rendering="crispEdges"/><g shape-rendering="crispEdges"><rect x="14" y="11" width="2" height="2" fill="#ff4d6d"/><rect x="19" y="11" width="2" height="2" fill="#4cc9f0"/><rect x="24" y="11" width="2" height="2" fill="#7bd88f"/></g>'],
  ['geography', 1, 4, 'Binoculars', ['', '<g fill="#3a3f63" stroke="#14152b" stroke-width=".7"><rect x="10.4" y="17.4" width="9.2" height="9.2" rx="2.6"/><rect x="20.4" y="17.4" width="9.2" height="9.2" rx="2.6"/></g><circle cx="15" cy="22" r="2.9" fill="#4cc9f0"/><circle cx="25" cy="22" r="2.9" fill="#4cc9f0"/><circle cx="14" cy="21" r=".9" fill="#fff"/><circle cx="24" cy="21" r=".9" fill="#fff"/>']],
  ['geography', 2, 3, 'Pith helmet', '<path d="M9.5 15a10.5 9.5 0 0 1 21 0z" fill="#e9d8a6" stroke="#b89d5e" stroke-width=".7"/><rect x="9.9" y="12.2" width="20.2" height="1.9" fill="#8c6f3a"/><ellipse cx="20" cy="15.3" rx="14.5" ry="2.4" fill="#d9c48a" stroke="#b89d5e" stroke-width=".7"/><circle cx="20" cy="5.5" r="1.2" fill="#b89d5e"/>'],
  ['geography', 3, 3, 'Globe', '<rect x="19" y="9.2" width="2" height="2.4" fill="#c9a27a"/><path d="M15.5 11.8h9" stroke="#c9a27a" stroke-width="1.8" stroke-linecap="round"/><circle cx="20" cy="4.9" r="4.6" fill="#4cc9f0"/><path d="M17.2 2.4c1.4-.6 2.6.2 3 1.3-.6.9.3 2-.9 2.6-1.2-.3-2.1-1.1-2.3-2.2-.5-.5-.3-1.2.2-1.7zM21.8 5.4c1-.3 2.3.3 2.5 1.3-.4 1.1-1.5 1.6-2.3 1.2-.4-.8-.5-1.7-.2-2.5z" fill="#7bd88f"/><path d="M14.6 4.9a5.4 5.4 0 0 0 10.8 0" fill="none" stroke="#c9a27a" stroke-width="1"/>'],
  ['history', 1, 4, 'Monocle', ['', '<circle cx="25" cy="22" r="4.5" fill="#fff" fill-opacity=".18" stroke="#ffd166" stroke-width="1.4"/><path d="M28.8 24.6c1.4 3 1 6.2-1.4 9.4" fill="none" stroke="#ffd166" stroke-width=".8"/>']],
  ['history', 2, 3, 'Tricorn hat', '<path d="M6 15.5c3-1 4-6 14-8.5 10 2.5 11 7.5 14 8.5-5 1.6-9 .6-14-1.2-5 1.8-9 2.8-14 1.2z" fill="#2b2d4a" stroke="#ffd166" stroke-width=".9" stroke-linejoin="round"/><circle cx="20" cy="9.6" r="1.3" fill="#ffd166"/>'],
  ['history', 3, 3, 'Laurel wreath', `<g fill="#ffd166" stroke="#c98f1c" stroke-width=".4">${[[8.6, 16.8, -70], [10.2, 13.6, -52], [12.8, 11.2, -36], [16.2, 9.8, -18], [31.4, 16.8, 70], [29.8, 13.6, 52], [27.2, 11.2, 36], [23.8, 9.8, 18]].map(([x, y, a]) => leaf(x, y, a)).join('')}</g><circle cx="20" cy="9.6" r="1.4" fill="#ff4d6d"/>`],
  ['science', 1, 4, 'Safety goggles', ['', '<path d="M7 21.5h3M30 21.5h3" stroke="#2ed3b7" stroke-width="2.4"/><g fill="#dff7ff" fill-opacity=".5" stroke="#2ed3b7" stroke-width="1.4"><rect x="9.5" y="17.5" width="10" height="9" rx="4"/><rect x="20.5" y="17.5" width="10" height="9" rx="4"/></g><path d="M11.5 19.5l2-1M22.5 19.5l2-1" stroke="#fff" stroke-width=".9" stroke-linecap="round"/>']],
  ['science', 2, 3, 'Sprout', '<path d="M20 12.5V5.5" stroke="#4a9d5b" stroke-width="1.4" fill="none"/><path d="M20 7.5c-1-3.5-4.5-4.5-7.5-3.5 1 3.2 4.3 4.6 7.5 3.5zM20 6c1-3.5 4.5-4.6 7.5-3.8-1 3.3-4.3 4.8-7.5 3.8z" fill="#7bd88f" stroke="#4a9d5b" stroke-width=".6"/>'],
  ['science', 3, 3, 'Mad scientist hair', puff([[20, 11, 5], [7.8, 19, 3.2], [8, 13.6, 3.4], [12, 9, 3.6], [17, 6.6, 3.8], [23, 6.6, 3.8], [28, 9, 3.6], [32, 13.6, 3.4], [32.2, 19, 3.2]], '#f1f3f8', '#c9cfdc')],
  ['food', 1, 4, 'Milk moustache', ['', '<path d="M14.5 27.2c1.5-1.8 3.8-1.6 5.5-.4 1.7-1.2 4-1.4 5.5.4-.8 1.4-2.3 1.6-3.2 1.1-.8.9-1.6 1-2.3.4-.7.6-1.5.5-2.3-.4-.9.5-2.4.3-3.2-1.1z" fill="#fff"/><path d="M17.2 28.3c.5.9.7 1.4.7 1.8a.7.7 0 0 1-1.4 0c0-.4.2-.9.7-1.8z" fill="#fff"/>']],
  ['food', 2, 3, 'Fried egg', '<path d="M9.5 13.5c-1-3 1.5-5 4-4.5 1-2.5 4.5-3 6.5-1.5 2-1.8 5.5-1 6.5 1.3 2.8-.3 5 2 4 4.7-1.5 1.5-6 2-10.5 2s-9-.5-10.5-2z" fill="#fff" stroke="#dfe3ec" stroke-width=".6"/><circle cx="20.5" cy="10.8" r="3.4" fill="#ffb627"/><circle cx="19.4" cy="9.7" r=".9" fill="#fff" opacity=".7"/>'],
  ['food', 3, 3, 'Cupcake', '<path d="M13 15 11.5 8.5h17L27 15z" fill="#c9a27a"/><path d="M14.5 8.5l.8 6.5M18 8.5l.4 6.5M22 8.5l-.4 6.5M25.5 8.5l-.8 6.5" stroke="#a37e55" stroke-width=".7"/><path d="M10.5 9c-1-2.5 1-4.5 3.5-4 .5-2.5 3.5-3.5 6-2 2.5-1.5 5.5-.5 6 2 2.5-.5 4.5 1.5 3.5 4z" fill="#ff9fc8"/><g stroke-width="1" stroke-linecap="round"><path d="M14.5 6.5l1 .6" stroke="#4cc9f0"/><path d="M18.5 4.8l.9-.7" stroke="#feca57"/><path d="M23 5.5l1 .5" stroke="#7bd88f"/><path d="M26.5 7.2l.6-.9" stroke="#fff"/></g><circle cx="20" cy="1.7" r="1.7" fill="#ff4d4d"/>'],
  ['words', 1, 4, 'Reading glasses', ['', '<g fill="#fff" fill-opacity=".15" stroke="#c9a27a" stroke-width="1.3"><path d="M10.5 22.5h8.5a4.25 3.6 0 0 1-8.5 0zM21 22.5h8.5a4.25 3.6 0 0 1-8.5 0z"/></g><path d="M19 23q1-.8 2 0M10.5 22.5 7.5 21M29.5 22.5l3-1.5" fill="none" stroke="#c9a27a" stroke-width="1.3"/>']],
  ['words', 2, 3, 'Graduation cap', '<path d="M12.5 10V15h15v-5" fill="#2b2d4a"/><path d="M20 2 5.5 7.5 20 13l14.5-5.5z" fill="#2b2d4a" stroke="#14152b" stroke-width=".6"/><path d="M20 7.5l9.5 1.5v6" stroke="#ffd166" stroke-width=".9" fill="none"/><circle cx="29.5" cy="15.6" r="1.1" fill="#ffd166"/>'],
  ['words', 3, 3, 'Book stack', '<rect x="11" y="10.6" width="18" height="3.6" rx=".6" fill="#5b8cff"/><rect x="12.5" y="7" width="15" height="3.6" rx=".6" fill="#ff6b6b" transform="rotate(-4 20 8.8)"/><rect x="12" y="3.4" width="16" height="3.6" rx=".6" fill="#7bd88f"/><path d="M12 12.4h16M14 8.8h12M13 5.2h14" stroke="#fff" stroke-width=".6" opacity=".7"/>'],
  ['misc', 1, 4, 'Disguise', ['', '<g fill="none" stroke="#14152b" stroke-width="1.3"><circle cx="15" cy="22" r="3.8"/><circle cx="25" cy="22" r="3.8"/><path d="M18.8 22h2.4"/></g><path d="M12 17.3q3-2 6 0M22 17.3q3-2 6 0" stroke="#14152b" stroke-width="1.6" fill="none" stroke-linecap="round"/><ellipse cx="20" cy="26" rx="2.6" ry="2.2" fill="#f2c39b" stroke="#c99a72" stroke-width=".6"/><path d="M14.5 29.2c2-1.7 4-1.5 5.5-.5 1.5-1 3.5-1.2 5.5.5-2 .9-3.8 1-5.5.3-1.7.7-3.5.6-5.5-.3z" fill="#14152b"/>']],
  ['misc', 2, 3, 'Jester hat', '<path d="M8.5 15 6 4.5l8 6L20 2l6 8.5 8-6L31.5 15z" fill="#9b7bff"/><path d="M14 10.5 20 2l6 8.5-6 4.5z" fill="#feca57"/><rect x="8" y="13.4" width="24" height="2.6" rx="1.3" fill="#feca57"/><g fill="#ffd166" stroke="#c98f1c" stroke-width=".5"><circle cx="6" cy="4.5" r="1.8"/><circle cx="20" cy="2" r="1.8"/><circle cx="34" cy="4.5" r="1.8"/></g>'],
  ['misc', 3, 3, 'Rainbow', `<g fill="none" stroke-width="2"><path d="M7 14.5a13 12 0 0 1 26 0" stroke="#ff6b6b"/><path d="M9 14.5a11 10 0 0 1 22 0" stroke="#feca57"/><path d="M11 14.5a9 8 0 0 1 18 0" stroke="#7bd88f"/><path d="M13 14.5a7 6 0 0 1 14 0" stroke="#5b8cff"/></g>${puff([[6.5, 15, 2.4], [9.4, 15.6, 2], [33.5, 15, 2.4], [30.6, 15.6, 2]], '#fff', '#dfe3ec')}`],
].map(([cat, tier, part, name, svg]) => ({ cat, tier, part, name, svg }));
CAT_ITEMS.forEach(it => { it.idx = LOOK_PARTS[it.part].length; LOOK_PARTS[it.part].push(it.svg); LOOK_N[it.part] = LOOK_PARTS[it.part].length; });
// How each hat sits, so parts fit together: 'cover' sits on the crown (tall ears, antennae and spikes tuck under it),
// 'side' goes over the ears (the robot's bolts make way), 'band' and 'float' leave the head as it is.
const HAT_FIT = ['float', 'cover', 'cover', 'cover', 'cover', 'side', 'float', 'float', 'cover', 'cover', 'cover', 'float', 'cover', 'cover'];
CAT_ITEMS.forEach(it => { if (it.part === 3) HAT_FIT[it.idx] = { Sweatband: 'band', 'Laurel wreath': 'band', 'Gaming headset': 'side' }[it.name] || 'cover'; });
// The top of each head (hats are drawn for a crown at y = 11), so a hat sits on the head rather than floating or sinking
const HEAD_TOP = [11, 11.5, 11, 10, 11, 11, 12, 12, 11, 11, 12.5, 10.5];
// Headphones and headsets are drawn for each head: the band hugs just outside that head's outline (rounded-square
// heads get a squared band) and the cups sit on its sides. [left x, right x, band top y, cup centre y, corner radius]
const PHONES_FIT = [[6.4, 33.6, 9.8, 24], [6.3, 33.7, 10.2, 24, 8], [6.4, 33.6, 9.8, 24], [7.6, 32.4, 8.8, 24],
  [6.4, 33.6, 9.8, 24], [6.4, 33.6, 9.8, 24], [5.2, 34.8, 10.8, 24.5], [6.7, 33.3, 10.8, 24.5],
  [5.7, 34.3, 9.7, 24, 5.3], [6.4, 33.6, 9.8, 24], [6.7, 33.3, 11.3, 25], [5.6, 34.4, 9.2, 24]];
function phones(hd, cup, rim, mic, band2 = '#c9d3e6') {
  const [l, r, top, cy, rad] = PHONES_FIT[hd] || PHONES_FIT[0], end = cy + 1;
  const band = rad ? `M${l} ${end}V${top + rad}a${rad} ${rad} 0 0 1 ${rad}-${rad}H${r - rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}V${end}`
    : `M${l} ${end}A${(r - l) / 2} ${end - top} 0 0 1 ${r} ${end}`;
  const w = mic ? 5.6 : 5, h = mic ? 10 : 9, cl = l + 1 - w / 2, cr = r - 1 - w / 2, y = cy + 1.5 - h / 2;
  const cupAt = x => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.3" fill="${cup}"${rim ? ` stroke="${rim}" stroke-width=".7"` : ''}/>`;
  const boom = mic ? `<path d="M${l + 1} ${y + h - .5}q1 4.4 7.4 4" fill="none" stroke="${INK}" stroke-width="1.2"/><circle cx="${l + 8.6}" cy="${y + h + 3.5}" r="1.5" fill="${INK}"/>` : '';
  return `<g fill="none" stroke-linejoin="round"><path d="${band}" stroke="${INK}" stroke-width="3"/><path d="${band}" stroke="${band2}" stroke-width="1.3"/></g>${cupAt(cl)}${cupAt(cr)}${boom}`;
}
const PHONES = { 5: hd => phones(hd, '#ff9f43') };
CAT_ITEMS.forEach(it => { if (it.name === 'Gaming headset') PHONES[it.idx] = hd => phones(hd, '#7bd88f', INK, true); });
const CAT_LABEL = { sport: 'Sport', music: 'Music', film: 'Film & TV', gaming: 'Gaming', geography: 'Geography', history: 'History',
  science: 'Science & Nature', food: 'Food & Drink', words: 'Books & Words', misc: 'Pot luck' };
const CAT_GOALS = [
  { key: 'right', n: 10, short: '10 right answers', text: l => `10 right answers in ${l}` },
  { key: 'outliers', n: 3, short: '3 Outliers', text: l => `3 Outliers in ${l}` },
  { key: 'best', n: 400, short: 'Score 400+ in a seven-prompt game', text: l => `Score 400+ in a seven-prompt ${l} game` }];
const EMOTE_GOAL = { key: 'right', n: 25, short: '25 right answers', text: l => `25 right answers in ${l}` };
const SUB_GOAL = { key: 'right', n: 15, short: '15 right answers', text: l => `15 right answers in ${l}` };
const goalOf = it => it.sub ? SUB_GOAL : it.emote ? EMOTE_GOAL : CAT_GOALS[it.tier - 1];
const itemKey = it => it.sub ? 'sub:' + it.sub : it.cat + (it.emote ? 'e' : it.tier);
const itemGoal = it => goalOf(it).text(it.sub ? SUB_LABEL[it.sub] : CAT_LABEL[it.cat]);
// everything a category unlocks, easiest first: face item, hat, emote, top hat
let UNLOCKABLES = [];   // filled in below, once the emotes exist
const emoteLocked = id => { const it = UNLOCKABLES.find(x => x.emote === id); return !!(it && !store.get('outlier.unlocks', []).includes(itemKey(it))); };
const itemAt = (part, v) => CAT_ITEMS.find(i => i.part === part && i.idx === v);
const itemLocked = (part, v) => { const it = itemAt(part, v); return it && !store.get('outlier.unlocks', []).includes(itemKey(it)) ? it : null; };
// From the stats: which items are earned now. Returns the ones that are new since last time.
function syncUnlocks(st) {
  if (!st || !st.unlocks) return [];
  const had = store.get('outlier.unlocks', []);
  const now = UNLOCKABLES.filter(it => { const c = it.sub ? (st.unlocks.subs || {})[it.sub] : st.unlocks[it.cat], g = goalOf(it); return c && c[g.key] >= g.n; });
  store.set('outlier.unlocks', now.map(itemKey));
  store.set('outlier.unlockStats', st.unlocks);
  return now.filter(it => !had.includes(itemKey(it)));
}
// A look string with one part swapped
const lookWith = (look, part, v) => { const l = [...look]; l[part] = v.toString(36); return l.join(''); };
// A look is five characters, one per part (0-9 then a-z), e.g. "2b05c". Old four-part looks get no face extra.
function lookFor(name, look) {
  if (/^[0-9a-z]{4,5}$/.test(look || '')) {
    const l = (look + '0').slice(0, 5);
    if ([...l].every((c, i) => parseInt(c, 36) < LOOK_N[i])) return l;
  }
  let h = 7;
  for (const ch of (name || '?').trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BASE_N.map((n, i) => (Math.floor(h / [1, 13, 173, 2251, 31517][i]) % n).toString(36)).join('');
}
// Moods for the party podium: a winner throws their arms up with happy eyes and a big grin; a loser sobs.
const TEAR = x => `<path d="M${x} 24.5c1.2 1.8 1.8 2.8 1.8 3.6a1.8 1.8 0 0 1-3.6 0c0-.8.6-1.8 1.8-3.6z" fill="#7fd3ff"/>`;
const MOODS = {
  cheer: {
    behind: '',   // arms up: drawn below, once arm() exists
    eyes: inkLine('M12.5 23q2.5-3.5 5 0M22.5 23q2.5-3.5 5 0'),
    mouth: `<path d="M14 27.5h12a6 6 0 0 1-12 0z" fill="${INK}"/><path d="M17 31.8a3 2 0 0 1 6 0 5.5 5.5 0 0 1-6 0z" fill="#ff7b9c"/>`,
  },
  cry: {
    behind: '',
    eyes: inkLine('M12.5 21.5q2.5 2.5 5 0M22.5 21.5q2.5 2.5 5 0M12 18.5l5-1.5M28 18.5l-5-1.5')
      + `<g class="tear">${TEAR(15)}</g><g class="tear t2">${TEAR(25)}</g>`,
    mouth: inkLine('M15.5 31.5q4.5-4.5 9 0'),
  },
};
// ---- podium emotes: what you do on the steps when you finish first, second (or third of four or more). Everyone
// has "Arms up"; each main category has one more, earned with 25 right answers in it.
// Arms are a shade darker than the head so they stand out against it (and against the same-coloured background tint)
const ARM_COL = 'color-mix(in srgb, var(--pc) 72%, #14152b)';
const ARMS = inner => `<g style="stroke:${ARM_COL};fill:${ARM_COL}" stroke-width="3.4" stroke-linecap="round">${inner}</g>`;
// An arm from the shoulder (x1, y1) to the hand (x2, y2), with a soft bend at the elbow (outwards and down, the way
// arms hang), turning about the shoulder when it moves. `hand` swaps the round hand for something else (a glove).
function arm(x1, y1, x2, y2, cls = '', bend = .26, hand = '') {
  const dx = x2 - x1, dy = y2 - y1, out = x1 < 20 ? -1 : 1;
  const [px, py] = [[-dy, dx], [dy, -dx]].sort((a, b) => (b[0] * out + b[1]) - (a[0] * out + a[1]))[0];
  const cx = ((x1 + x2) / 2 + px * bend).toFixed(1), cy = ((y1 + y2) / 2 + py * bend).toFixed(1);
  return `<g class="arm ${cls}" style="transform-origin:${x1}px ${y1}px"><path d="M${x1} ${y1}Q${cx} ${cy} ${x2} ${y2}" fill="none"/>`
    + `${hand || `<circle cx="${x2}" cy="${y2}" r="2.5" stroke="none"/>`}</g>`;
}
const HAPPY = inkLine('M12.5 23q2.5-3.5 5 0M22.5 23q2.5-3.5 5 0'), BLISS = inkLine('M12.5 22.5q2.5 1.8 5 0M22.5 22.5q2.5 1.8 5 0');
const GRIN = MOODS.cheer.mouth;
MOODS.cheer.behind = ARMS(arm(10, 30, 3.4, 16.4, 'l') + arm(30, 30, 36.6, 16.4, 'r'));
const heart = (x, y, cls) => `<path class="${cls}" d="M${x} ${y + 1.6}l-2-1.9a1.2 1.2 0 0 1 2-1.5 1.2 1.2 0 0 1 2 1.5z" fill="#ff4d6d"/>`;
const flash = (x, y, d) => `<g class="flash" style="--d:${d}s"><circle cx="${x}" cy="${y}" r="1.7" fill="#fff"/><path d="M${x} ${y - 4}l.9 3.1 3.1.9-3.1.9-.9 3.1-.9-3.1-3.1-.9 3.1-.9z" fill="#fff"/></g>`;
const pixels = (rows, x0, y0, sz) => rows.flatMap((r, y) => [...r].map((c, x) => c === '#' ? `<rect x="${x0 + x * sz}" y="${y0 + y * sz}" width="${sz}" height="${sz}"/>` : '')).join('');
const PIX_G = ['.###', '#...', '#.##', '#..#', '.###'];
const bits = [[-7, -6, '#ff6b6b', 0], [-3, -9, '#feca57', .15], [2, -8, '#4cc9f0', .3], [-8, -1, '#7bd88f', .1], [4, -4, '#ff7bd0', .25], [-5, -11, '#9b7bff', .4]];
const EMOTES = [
  { id: 'cheer', name: 'Arms up' },
  { id: 'trophy', cat: 'sport', name: 'Trophy lift', eyes: HAPPY, mouth: GRIN,
    behind: ARMS(arm(9, 29, 13.6, -4.6, '', .1) + arm(31, 29, 26.4, -4.6, '', .1)),
    front: `<g ${GOLD}><path d="M15 -10h10v3.2a5 5 0 0 1-10 0z"/><rect x="18.9" y="-2" width="2.2" height="2"/><rect x="16.5" y="-.3" width="7" height="1.8" rx=".6"/></g><path d="M15 -8.6h-1.6a2.2 2.2 0 0 0 2.3 3.2M25 -8.6h1.6a2.2 2.2 0 0 1-2.3 3.2" fill="none" stroke="#c98f1c" stroke-width="1"/>${twinkle(17.5, -7)}` },
  { id: 'guitar', cat: 'music', name: 'Guitar solo', eyes: BLISS, mouth: `<ellipse cx="20" cy="30" rx="2.6" ry="2.2" fill="${INK}"/>`, behind: '',
    front: `<g transform="rotate(-28 20 33)"><rect x="19" y="31.8" width="16" height="2.4" rx=".8" fill="#8c5a2b"/><rect x="34" y="31" width="3.6" height="4" rx="1" fill="#5a3b22"/><path d="M8 33c0-3 2.5-4.4 5-3.6 1.4.5 2.4.4 3.4-.2 2.2-1.2 4.6.6 4.6 3.8s-2.4 5-4.6 3.8c-1-.6-2-.7-3.4-.2C10.5 37.4 8 36 8 33z" fill="#ff6b6b" stroke="${INK}" stroke-width=".7"/><circle cx="15" cy="33" r="1.3" fill="${INK}"/><path d="M15 33h20" stroke="#fff" stroke-width=".3" opacity=".7"/></g>`
      + ARMS(arm(32, 32, 30.6, 27.4) + arm(9, 30, 15.4, 35.2, 'strum'))
      + `<g fill="#fff" stroke="#fff"><g class="note"><path d="M31 4V-1l4-1v5" fill="none" stroke-width=".9"/><circle cx="30" cy="4" r="1.3" stroke="none"/><circle cx="34" cy="3" r="1.3" stroke="none"/></g><g class="note n2"><path d="M7 6V1" fill="none" stroke-width=".9"/><path d="M7 1q2.5 1 2.5 3" fill="none" stroke-width=".9"/><circle cx="6" cy="6" r="1.3" stroke="none"/></g></g>` },
  { id: 'carpet', cat: 'film', name: 'Red carpet', eyes: LOOK_PARTS[1][5], mouth: inkLine('M16.5 29.6q4 1.6 7.5-1.6'),
    behind: ARMS(arm(30, 30, 37, 16, 'wave')), front: flash(4, 7, 0) + flash(36, 3, .5) + flash(3, 31, 1) + flash(37, 33, 1.3) },
  { id: 'gg', cat: 'gaming', name: 'GG', eyes: LOOK_PARTS[1][11], mouth: GRIN,
    behind: ARMS(arm(9, 30, 3.5, 17.5, 'pump l') + arm(31, 30, 36.5, 17.5, 'pump r')),
    front: `<g class="gg" fill="#7bd88f" stroke="${INK}" stroke-width=".4" shape-rendering="crispEdges">${pixels(PIX_G, 12.4, -10, 1.7)}${pixels(PIX_G, 20.9, -10, 1.7)}</g><g fill="#ffd166" shape-rendering="crispEdges"><rect x="7" y="-6" width="1.6" height="1.6"/><rect x="32" y="-8" width="1.6" height="1.6"/><rect x="34" y="-2" width="1.2" height="1.2"/></g>` },
  { id: 'flag', cat: 'geography', name: 'Flag plant', eyes: LOOK_PARTS[1][0], mouth: inkLine('M16 28.5q4 3 8 0'),
    behind: ARMS(arm(9, 30, 3.5, 19)),
    front: `<path d="M34 -7v45" stroke="#8c6f3a" stroke-width="1.4" stroke-linecap="round"/><path class="flag" d="M34.6 -6.5c2.2 1.2 4 -.8 6.6.4v6.4c-2.6-1.2-4.4.8-6.6-.4z" fill="#ff6b6b"/><circle cx="37.9" cy="-3.3" r="1.3" fill="#fff"/>${ARMS(arm(31, 31, 34.2, 21))}` },
  { id: 'royal', cat: 'history', name: 'Royal wave', eyes: BLISS, mouth: inkLine('M17.5 29q2.5 1.6 5 0'),
    behind: ARMS(arm(31, 30, 36, 16, 'royal') + arm(9, 30, 5.2, 26)),
    front: `<path d="M5.6 33 3 12.5" stroke="#ffd166" stroke-width="1.4" stroke-linecap="round"/><circle cx="2.9" cy="11.2" r="2.3" fill="#ffd166" stroke="#c98f1c" stroke-width=".5"/><circle cx="2.9" cy="11.2" r=".8" fill="#ff4d6d"/>` },
  { id: 'eureka', cat: 'science', name: 'Eureka!', eyes: LOOK_PARTS[1][1], mouth: `<path d="M16 28h8a4 4 0 0 1-8 0z" fill="${INK}"/>`,
    behind: ARMS(arm(31, 30, 34, 14) + '<path d="M34 14v-3.6" stroke-width="1.6"/>'),
    front: `<g class="bulb"><circle cx="20" cy="-5" r="6.5" fill="#ffd166" opacity=".25"/><path d="M20 -10a4.2 4.2 0 0 0-2.4 7.6V-1h4.8v-1.4A4.2 4.2 0 0 0 20 -10z" fill="#ffe08a" stroke="#c98f1c" stroke-width=".6"/><path d="M12.5 -9l1.5 1.2M27.5 -9 26 -7.8M20 -13.5v-1.5M13 -3h-1.5M27 -3h1.5" stroke="#ffd166" stroke-width=".9" stroke-linecap="round"/></g><rect x="17.8" y="-1" width="4.4" height="1.8" rx=".4" fill="#9aa3c7"/>` },
  { id: 'kiss', cat: 'food', name: "Chef's kiss", eyes: BLISS, mouth: `<circle cx="20.5" cy="29.5" r="1.5" fill="none" stroke="${INK}" stroke-width="1.5"/>`, behind: '',
    front: ARMS(arm(31, 33, 23.5, 29.8, 'kiss')) + heart(30, 20, 'heart') + heart(34, 15, 'heart h2') + twinkle(27, 14, 1.2) },
  { id: 'tada', cat: 'words', name: 'Ta-da!', eyes: LOOK_PARTS[1][4], mouth: GRIN,
    behind: ARMS(arm(9, 30, 2.5, 22, 'jazz l') + arm(31, 30, 37.5, 22, 'jazz r')),
    front: `<g class="bubble"><path d="M21 -11h17a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11l-3 3v-3h-3a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" fill="#fff"/><text x="29.5" y="-4.4" text-anchor="middle" font-size="5" font-weight="900" fill="${INK}" font-family="system-ui, sans-serif">TA-DA!</text></g>` },
  { id: 'popper', cat: 'misc', name: 'Party popper', eyes: LOOK_PARTS[1][4], mouth: GRIN,
    behind: ARMS(arm(9, 30, 7.2, 20) + arm(31, 30, 36.5, 17.5, 'r')),
    front: `<g class="popper"><path d="M7.8 21 -1 13.4 3.4 9z" fill="#9b7bff" stroke="${INK}" stroke-width=".5" stroke-linejoin="round"/><path d="M1.2 11.3l5 7M.1 12.6l6.5 6.6" stroke="#feca57" stroke-width=".8"/></g>`
      + bits.map(([dx, dy, c, d], i) => `<rect class="bit" style="--dx:${dx}px;--dy:${dy}px;--d:${d}s" x="${i % 2 ? 1 : 0}" y="${10 + (i % 3)}" width="1.7" height="1" fill="${c}"/>`).join('') },
];
// Sub-category celebrations, with a bit of the football pitch about them. Each comes with 15 right answers in its sub-category.
const SUB_LABEL = { football: 'Football', darts: 'Darts', f1: 'Formula 1', combat: 'Boxing', cue: 'Snooker', cricket: 'Cricket', wwe: 'WWE' };
const SUB_ICON = { football: 'ball', darts: 'crosshair', f1: 'flame', combat: 'shield', cue: 'gem', cricket: 'star', wwe: 'crown' };
const glove = (x, y) => `<circle cx="${x}" cy="${y}" r="3.9" fill="#ff4d4d" stroke="${INK}" stroke-width=".6"/><path d="M${x - 2.2} ${y + 1.6}q2.2 1.2 4.4 0" stroke="#fff" stroke-width=".7" fill="none" opacity=".8"/>`;
const drops = [[-3, -9, 0], [2, -11, .12], [6, -8, .25], [-1, -13, .35], [8, -12, .5], [4, -15, .62]];
EMOTES.push(
  { id: 'oneeighty', cat: 'sport', sub: 'darts', name: 'Bullseye!', eyes: LOOK_PARTS[1][4], mouth: GRIN,
    behind: ARMS(arm(9, 30, 5.5, 20, 'pump')),
    front: `<g transform="translate(5 3)"><circle r="5.6" fill="#14152b"/><circle r="4.4" fill="#f1e3c4"/><circle r="3" fill="#2a7a45"/><circle r="1.8" fill="#f1e3c4"/><circle r=".8" fill="#ff4d4d"/></g>`
      + `<g class="dart"><path d="M6.5 3h5.2" stroke="#c9d3e6" stroke-width="1"/><path d="M11.4 3l2.6-1.8v3.6z" fill="#ff6b6b"/><path d="M5 3h1.8" stroke="${INK}" stroke-width=".7"/></g>`
      + ARMS(arm(31, 30, 36.5, 18.5, 'throw'))
      + `<g class="ton"><rect x="8" y="-11" width="26" height="7" rx="2" fill="#ffd166" stroke="#c98f1c" stroke-width=".6"/><text x="21" y="-6" text-anchor="middle" font-size="4.3" font-weight="900" fill="${INK}" font-family="system-ui, sans-serif">BULLSEYE</text></g>` },
  { id: 'aeroplane', cat: 'sport', sub: 'football', name: 'Aeroplane', eyes: HAPPY, mouth: `<ellipse cx="20" cy="29.8" rx="3.2" ry="2.6" fill="${INK}"/>`,
    behind: ARMS(arm(9, 30, -2.5, 27, 'wing l', .12) + arm(31, 30, 42.5, 27, 'wing r', .12)),
    front: `<g class="trail" stroke="#fff" stroke-width=".8" stroke-linecap="round" opacity=".6"><path d="M-6 34h6M-4 37h5M40 34h6M39 37h5"/></g>` },
  { id: 'champagne', cat: 'sport', sub: 'f1', name: 'Champagne spray', eyes: HAPPY, mouth: GRIN,
    behind: ARMS(arm(9, 30, 4.5, 19, 'pump')),
    front: `<g class="bottle" style="transform-origin:31px 30px">${ARMS(arm(31, 30, 33, 18))}<g transform="rotate(28 33.5 15)"><rect x="31.5" y="8" width="4" height="10" rx="1.6" fill="#2f6b3a" stroke="${INK}" stroke-width=".5"/><rect x="32.5" y="4.5" width="2" height="4" fill="#2f6b3a"/><rect x="32.3" y="3.8" width="2.4" height="1.6" rx=".4" fill="#ffd166"/><rect x="31.5" y="11.5" width="4" height="3" fill="#f1e3c4"/></g></g>`
      + drops.map(([dx, dy, d], i) => `<circle class="drop" style="--dx:${dx}px;--dy:${dy}px;--d:${d}s" cx="${36.5 + (i % 2)}" cy="${2 + (i % 3)}" r="${i % 2 ? .9 : 1.2}" fill="#fff4c2"/>`).join('') },
  { id: 'gloves', cat: 'sport', sub: 'combat', name: 'Gloves up', eyes: LOOK_PARTS[1][6], mouth: inkLine('M17 30h6'), behind: '',
    front: ARMS(arm(9, 31, 13.5, 27, 'jab l', .3, glove(13.5, 27)) + arm(31, 31, 26.5, 27, 'jab r', .3, glove(26.5, 27))) },
  { id: 'cuetwirl', cat: 'sport', sub: 'cue', name: 'Cue twirl', eyes: BLISS, mouth: inkLine('M16.5 29q3.5 2.6 7 0'),
    behind: ARMS(arm(9, 30, 4, 19, 'pump')),
    front: `<g class="cue" style="transform-origin:34.5px 20px"><path d="M34.5 -3 34.5 43" stroke="#c9a27a" stroke-width="1.3" stroke-linecap="round"/><path d="M34.5 30v13" stroke="#5a3b22" stroke-width="1.9" stroke-linecap="round"/><path d="M34.5 -3.6v1.4" stroke="#4cc9f0" stroke-width="1.4"/></g>${ARMS(arm(31, 30, 34.5, 20))}` },
  { id: 'century', cat: 'sport', sub: 'cricket', name: 'Raise the bat', eyes: HAPPY, mouth: GRIN,
    behind: ARMS(arm(9, 30, 4, 20, 'pump')),
    front: `<g class="batarm" style="transform-origin:31px 30px"><g transform="rotate(14 34 14)"><rect x="32.4" y="-9" width="4.2" height="16" rx="1.6" fill="#f1e3c4" stroke="#c9a27a" stroke-width=".6"/><rect x="33.6" y="6.5" width="1.8" height="7.5" rx=".8" fill="#5a3b22"/></g>${ARMS(arm(31, 30, 34.5, 15))}</g>`
      + `<g class="ton"><rect x="9" y="-10" width="14" height="6.6" rx="2" fill="#fff" stroke="#c9cfdc" stroke-width=".6"/><text x="16" y="-5" text-anchor="middle" font-size="5.2" font-weight="900" fill="${INK}" font-family="system-ui, sans-serif">100</text></g>` },
  { id: 'belt', cat: 'sport', sub: 'wwe', name: 'Title belt', eyes: LOOK_PARTS[1][6], mouth: GRIN,
    behind: ARMS(arm(9, 29, 9.5, -2.5, '', .1) + arm(31, 29, 30.5, -2.5, '', .1)),
    front: `<g class="belt"><rect x="5" y="-6" width="30" height="5.6" rx="2.4" fill="#1f2033"/><ellipse cx="20" cy="-3.2" rx="7" ry="5" fill="#ffd166" stroke="#c98f1c" stroke-width=".7"/><ellipse cx="20" cy="-3.2" rx="4" ry="2.8" fill="#ffe08a" stroke="#c98f1c" stroke-width=".5"/><circle cx="20" cy="-3.2" r="1.2" fill="#ff4d6d"/><circle cx="9" cy="-3.2" r="1.3" fill="#ffd166"/><circle cx="31" cy="-3.2" r="1.3" fill="#ffd166"/></g>` });
EMOTES.forEach(e => { if (e.cat) MOODS['e-' + e.id] = { cls: `mood-emote emo-${e.sub || e.cat}`, behind: e.behind, eyes: e.eyes, mouth: e.mouth, front: e.front }; });
const emoteMood = id => id && MOODS['e-' + id] ? 'e-' + id : 'cheer';
UNLOCKABLES = Object.keys(CAT_LABEL).flatMap(cat => { const t = CAT_ITEMS.filter(it => it.cat === cat);
  return [t[0], t[1], ...EMOTES.filter(e => e.cat === cat && !e.sub).map(e => ({ cat, emote: e.id, name: e.name })), t[2]]; })
  .concat(EMOTES.filter(e => e.sub).map(e => ({ cat: e.cat, sub: e.sub, emote: e.id, name: e.name })));
const avatar = (name, color, look, mood) => {
  const [hd, ey, mo, ht, fc] = [...lookFor(name, look)].map(c => parseInt(c, 36));
  const [under, over] = LOOK_PARTS[4][fc];
  const m = MOODS[mood], fit = HAT_FIT[ht] || 'cover', dy = (HEAD_TOP[hd] || 11) - 11;
  let head = LOOK_PARTS[0][hd];
  if (fit === 'cover') head = head.replace(/<g data-top>.*?<\/g>/g, '');
  if (fit === 'side') head = head.replace(/<g data-side>.*?<\/g>/g, '');
  const hat = PHONES[ht] ? PHONES[ht](hd) : LOOK_PARTS[3][ht] && dy && fit !== 'float' ?`<g transform="translate(0 ${dy})">${LOOK_PARTS[3][ht]}</g>` : LOOK_PARTS[3][ht];
  return `<span class="av ch${m ? ` ${m.cls || 'mood-' + mood}` : ''}" style="--pc:${PCOL[color] || PCOL[0]}" role="img" aria-label="${esc(name || '')}"><svg viewBox="0 0 40 40" aria-hidden="true">`
    + `${m ? m.behind : ''}<g style="fill:var(--pc)">${head}</g>${under}${m ? m.eyes : LOOK_PARTS[1][ey]}${m ? m.mouth : LOOK_PARTS[2][mo]}${over}${hat}${m && m.front || ''}</svg></span>`;
};
const colorOf = (s, n) => (s.players.find(p => p.n === n) || {}).color;
const lookOf = (s, n) => (s.players.find(p => p.n === n) || {}).look;
const CAT_ICON = { all: 'sparkles', sport: 'trophy', football: 'ball', music: 'music', film: 'film', gaming: 'gamepad',
  geography: 'globe', history: 'landmark', science: 'flask', food: 'utensils', words: 'book', misc: 'shuffle' };
const topbar = (title, right = '', back = 'back', icon = 'left') =>
  `<header class="top"><button class="iconbtn" id="${back}" aria-label="${back === 'leave' ? 'Leave' : 'Back'}">${ic(icon)}</button>
    <h1>${title}</h1><span class="top-r">${right}</span></header>`;

let timer = null;
function stopTimer() { clearInterval(timer); timer = null; music.energy = 0; }
function runTimer(ms, total, onEnd, ticks = true) {
  stopTimer();
  music.energy = 1;
  const end = performance.now() + ms;
  let shown = Math.ceil(ms / 1000);
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    const n = Math.ceil(left / 1000);
    if (n !== shown) { shown = n; if (ticks && !tv && settings.ticks && n > 0 && n <= 5) sfx.play('tick', n); }
    const bar = $('#tbar'), secs = $('#tsecs');
    const urgent = left > 0 && left <= 5000;
    if (bar) { bar.style.width = (100 * left / total) + '%'; bar.classList.toggle('low', left < 6000); bar.parentElement.classList.toggle('urgent', urgent); }
    if (secs) { secs.textContent = Math.ceil(left / 1000); secs.classList.toggle('urgent', urgent); }
    if (left <= 0) { stopTimer(); onEnd(); }
  };
  timer = setInterval(tick, 100);
  tick();
}

async function shareText(text, url) {
  const all = url ? `${text}\n${url}` : text;
  try {
    if (navigator.share) { await navigator.share(url ? { text, url } : { text }); return; }
    if (navigator.clipboard) { await navigator.clipboard.writeText(all); toast('Copied'); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const ta = Object.assign(document.createElement('textarea'), { value: all });
  document.body.append(ta); ta.select();
  toast(document.execCommand('copy') ? 'Copied' : text);
  ta.remove();
}

// ------------------------------------------------------------ scoring visuals

const TIERS = ['', 'With the crowd', 'Common', 'Uncommon', 'Rare', 'Outlier!'];
const SQUARES = ['⬛', '🟫', '🟧', '🟨', '🟩', '🟪'];
// Rarity from points, topping out at Rare. Outlier (5) only ever comes from the answer itself being an Outlier,
// never from a high score, so a doubled 60 (120 points) is still Rare.
const tier = pts => pts >= 75 ? 4 : pts >= 50 ? 3 : pts >= 25 ? 2 : pts > 0 ? 1 : 0;
const tierOf = r => r.outlier || (!r.doubled && r.points >= 150) ? 5 : tier(r.points);   // old saved results have no outlier flag

const ZONES = [[0, 'One of the herd'], [.12, 'Slightly odd'], [.3, 'Free thinker'], [.5, 'Maverick'], [.7, 'Lone wolf'], [.9, 'True Outlier']];
const zoneName = (score, max) => ZONES.filter(z => score / max >= z[0]).pop()[1];

// 100 people; the lit ones gave the same answer as you. Each dot has a random rank so the crowd thins evenly.
function crowdHTML(lit) {
  const ranks = [...Array(100).keys()].sort(() => Math.random() - .5);
  return `<div class="crowd">${ranks.map(r => `<i data-rank="${r}" style="--d:${r * 8}"${r < lit ? ' class="on"' : ''}></i>`).join('')}</div>`;
}

// lanes: [{name, from, to, me}] - one marker per player walking away from the crowd.
function trailHTML(lanes, max) {
  const pct = v => Math.min(100, 100 * v / max).toFixed(1);
  const ticks = ZONES.slice(1).map(z => `<span class="tick" style="left:${z[0] * 100}%"></span>`).join('');
  return `<div class="trail">${lanes.map(l => `
    <div class="lane${l.me ? ' me' : ''}">
      ${lanes.length > 1 ? `<span class="lname">${esc(l.name)}</span>` : '<span></span>'}
      <div class="track">${ticks}
        <div class="fill" data-to="${pct(l.to)}" style="width:${pct(l.from)}%"></div>
        <div class="mark" data-to="${pct(l.to)}" style="left:${pct(l.from)}%${l.color != null ? `;--pc:${PCOL[l.color] || PCOL[0]}` : ''}">${esc(l.name[0].toUpperCase())}</div>
      </div>
      <span class="lscore">${l.to}</span>
    </div>`).join('')}
    <div class="ends"><span>The crowd</span><span>Outlier</span></div>
  </div>`;
}

// The result starts at +0 with the whole crowd lit; buildUp() then counts it up.
function resultHTML(res) {
  const line = res.valid ? `You said <b>${esc(res.canonical)}</b>`
    : res.given ? `<span class="strike">${esc(res.given)}</span> isn't on the list yet. We've noted it for review.`
      : 'You skipped this one.';
  return `<div class="result" id="result">
    <div class="pts" id="pts">+0</div>
    <div class="tier" id="tier">&nbsp;</div>
    <p>${line}</p>
  </div>
  <div class="thin">${crowdHTML(res.valid ? 100 : 0)}<p class="caption" id="caption">&nbsp;</p></div>`;
}

// Suspense: the score climbs continuously, slowing as it nears its final value, while the lit crowd
// thins out to the people who gave the same answer. Everything marked .wait appears once it stops.
let skipBuild = null, raceSkip = null;
// How many of the 100 dots are still lit at a given score. 0 points: the whole crowd. 10 (the answer everyone
// gives): 60 left. Each extra point thins it further, down to 3 at 99, and an Outlier (150) leaves just you.
function crowdFor(score) {
  if (score <= 0) return 100;
  if (score < 10) return Math.round(100 - 4 * score);
  if (score <= 99) return Math.round(3 + 57 * Math.pow((99 - score) / 89, 1.5));
  return Math.max(1, Math.round(3 - 2 * Math.min(1, (score - 99) / 51)));
}

function buildUp(res) {
  const lit = res.valid ? crowdFor(res.points) : 0;
  const pts = $('#pts'), tierEl = $('#tier'), box = $('#result');
  const dots = [...app.querySelectorAll('.crowd i')], crowdEl = dots.length ? dots[0].parentElement : null;
  const capEl = $('#caption');
  let lastT = -1;
  const paint = (score, crowd, final) => {
    pts.textContent = '+' + score;
    dots.forEach(d => d.classList.toggle('on', +d.dataset.rank < crowd));
    // The people still lit take the colour of the rarity you have reached, and the crowd thins as you climb.
    const t = res.valid ? (final && res.outlier ? 5 : Math.min(4, Math.max(1, tier(score)))) : 0;
    if (crowdEl && t !== lastT) { lastT = t; crowdEl.dataset.t = t; }
    if (res.valid && !final && capEl) capEl.innerHTML = `<b>${100 - crowd}</b> of 100 left behind`;
  };
  const finish = () => {
    skipBuild = null;
    if (!pts.isConnected) return;
    const t = res.outlier ? 5 : Math.min(4, tier(res.points));
    paint(res.points, lit, true);
    box.className = `result t${t} done`;
    if (res.valid) tierEl.innerHTML = `<span class="tierbadge t${t}"><i></i>${TIERS[t]}</span>`;
    else tierEl.textContent = res.given ? 'Not on the list' : 'Skipped';
    // A buzz for the good ones: short for Rare and Ball knowledge, a double for an Outlier.
    if (res.valid && t >= 3) buzz(t === 5 ? [70, 50, 140] : 35);
    if (!res.valid) sfx.play('nope');
    else if (t === 5) { sfx.play('hit'); sfx.play('crash'); sfx.play('fanfare', undefined, .15); }
    else if (t === 4) sfx.play('hit');
    else if (t === 3) sfx.play('ding');
    else sfx.play('pop');
    $('#caption').innerHTML = !res.valid ? 'No distance gained this round.'
      : res.share < 1 ? `Under <b>1%</b> of players said ${esc(res.canonical)}`
        : `<b>${Math.round(res.share)}%</b> of players said ${esc(res.canonical)}`;
    app.querySelectorAll('.wait').forEach(el => el.classList.remove('wait'));
    walk();
  };
  if (!res.valid || calm()) return finish();
  const duration = 1500 + Math.min(res.points, 100) * 35 + Math.max(0, res.points - 100) * 10, start = performance.now();
  let stopped = false;
  const hush = sfx.scoped(() => sfx.play('tally', duration / 1000));
  skipBuild = () => { stopped = true; hush(); finish(); };
  const frame = now => {
    if (stopped || !pts.isConnected) { hush(); return; }
    const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 3);
    const score = Math.round(res.points * eased);
    paint(score, crowdFor(score));
    tierEl.textContent = TIERS[Math.min(4, tier(score))] || ' ';
    if (t < 1) requestAnimationFrame(frame); else finish();
  };
  requestAnimationFrame(frame);
}
app.addEventListener('click', () => { if (skipBuild) skipBuild(); if (raceSkip) raceSkip(); });   // tap to skip the build-up

// ---- thumbs up / down on a prompt after playing it, so we can see which questions people enjoy
function voteHTML(promptId) {
  if (!promptId) return '';
  const v = (store.get('outlier.votes', {}) || {})[promptId.split('--')[0]] || 0;
  return `<div class="vote" data-pid="${esc(promptId)}"><span>Good question?</span>
    <button type="button" data-vote="1" class="${v === 1 ? 'on' : ''}" aria-label="Thumbs up" aria-pressed="${v === 1}">${ic('thumb')}</button>
    <button type="button" data-vote="-1" class="down${v === -1 ? ' on' : ''}" aria-label="Thumbs down" aria-pressed="${v === -1}">${ic('thumb')}</button></div>`;
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-vote]');
  if (!b) return;
  const box = b.closest('.vote'), pid = box.dataset.pid.split('--')[0];
  const votes = store.get('outlier.votes', {}) || {};
  const vote = votes[pid] === +b.dataset.vote ? 0 : +b.dataset.vote;   // tapping your current choice takes it back
  if (vote) votes[pid] = vote; else delete votes[pid];
  const keys = Object.keys(votes);
  if (keys.length > 600) keys.slice(0, keys.length - 600).forEach(k => delete votes[k]);   // keep local storage small
  store.set('outlier.votes', votes);
  box.querySelectorAll('[data-vote]').forEach(x => { const on = +x.dataset.vote === vote; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  if (vote) toast(vote > 0 ? 'Thanks! Glad you liked it' : "Thanks, we'll take a look");
  api('/api/vote', { promptId: pid, cid: playerId(), vote }).catch(() => {});
});

function outlierHTML(list, mine) {
  if (list.some(o => o.name === mine)) return '<p class="muted center">You found the Outlier.</p>';
  return `<p class="muted center">${list.length > 1 ? 'The Outliers were' : 'The Outlier was'} ${list.map(o => `<b>${esc(o.name)}</b>`).join(' and ')}</p>`;
}

// ---- every answer to a prompt, searchable and filterable by rarity. Only opened from the end-of-game screens.
const ansTier = b => b.outlier ? 5 : Math.max(1, Math.min(4, tier(b.points)));
const fold = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// One row of an end screen's prompt list; tapping it opens that prompt's answers.
function ansRowHTML(r, pid, extra = '') {
  const said = r.valid ? esc(r.canonical) : (r.given ? `<span class="strike">${esc(r.given)}</span>` : '<span class="skipped">Skipped</span>');
  const body = `<span class="main"><b>${said}</b><small>${esc(r.prompt)}</small></span><span class="num">+${r.points}${extra}</span>`;
  return pid ? `<li class="ans-row"><button type="button" class="ans-open" data-ans="${esc(pid)}" data-mine="${esc(r.valid ? r.canonical : '')}">${body}${ic('right', 'chev')}</button></li>`
    : `<li>${body}</li>`;
}
const ANS_HINT = `<p class="fine ans-hint">${ic('search')}<span>Tap a prompt to search every possible answer</span></p>`;
const ANS_FAIL = '<p class="muted center">Couldn\'t load the answers. Try again in a moment.</p>';

function answersSheet(pid, mine) {
  let data = null, rare = 0, q = '';
  const list = () => {
    const rows = data.board.map((b, i) => ({ ...b, i: i + 1, t: ansTier(b), f: fold(b.name) }));
    const n = t => rows.filter(b => b.t === t).length;
    return `<p class="ans-q">${esc(data.prompt)}</p>
      ${mine ? `<p class="muted ans-you">You said <b>${esc(mine)}</b></p>` : ''}
      <input type="search" id="ansFind" class="ans-find" placeholder="Search ${data.total} answers" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <div class="chips ans-tiers" id="ansTiers"><button class="chip on" data-rare="0">All</button>${[1, 2, 3, 4, 5].filter(n).map(t =>
        `<button class="chip t${t}" data-rare="${t}"><i></i>${TIERS[t].replace('!', '')}<small>${n(t)}</small></button>`).join('')}</div>
      <ol class="rows ans-list">${rows.map(b => `<li class="t${b.t}${b.name === mine ? ' me' : ''}" data-t="${b.t}" data-f="${esc(b.f)}">
        <span class="rank">${b.i}</span><span class="main"><b>${esc(b.name)}</b></span>
        <span class="share">${Number(b.share) < .1 ? '&lt;0.1' : Number(b.share).toFixed(1)}%</span><span class="ans-pts">${b.points}</span></li>`).join('')}</ol>
      <p class="muted center" id="ansNone" hidden>No answers match.</p>`;
  };
  const filter = () => {
    const box = $('.ans-list'); if (!box) return;
    const words = fold(q).split(' ').filter(Boolean);
    let shown = 0;
    box.querySelectorAll('li').forEach(li => {
      const ok = (!rare || +li.dataset.t === rare) && words.every(w => li.dataset.f.includes(w));
      li.hidden = !ok; shown += ok;
    });
    $('#ansNone').hidden = shown > 0;
  };
  openSheet('Every answer', () => '<p class="muted center">Loading the answers…</p>', e => {
    const c = e.target.closest('[data-rare]');
    if (!c) return;
    rare = +c.dataset.rare;
    $('#ansTiers').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    filter();
  });
  api(`/api/answers?promptId=${encodeURIComponent(pid)}`).then(d => { data = d; }, () => {}).then(() => {
    const b = $('.sheet-bg:last-of-type .sheet-b'); if (!b) return;
    b.innerHTML = data ? list() : ANS_FAIL;
    const f = $('#ansFind');
    if (f) f.oninput = () => { q = f.value; filter(); };
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ans]');
  if (b) answersSheet(b.dataset.ans, b.dataset.mine);
});

function questionHTML(text, kind = {}) {
  if (kind.input === 'darts') return `<section class="question">
    <div class="bar"><div class="timer grow"><i id="tbar"></i></div><span class="secs" id="tsecs"></span></div>
    <h2>${esc(text)}</h2>
    ${dartPadHTML()}
    <button class="link center" id="skip" type="button">Skip this one (scores 0)</button>
  </section>`;
  return `<section class="question">
    <div class="bar"><div class="timer grow"><i id="tbar"></i></div><span class="secs" id="tsecs"></span></div>
    <h2>${esc(text)}</h2>
    <form id="answer" class="stack" autocomplete="off">
      <input type="text" id="input" maxlength="60" placeholder="Your answer" enterkeyhint="send"
        autocapitalize="off" autocorrect="off" spellcheck="false">
      <p id="miss" class="miss" role="alert" hidden></p>
      <button class="btn primary">Lock in</button>
    </form>
    <div id="didyou" class="card stack center" hidden>
      <p>Did you mean <b></b>?</p>
      <button class="btn primary" id="yes" type="button">Yes, lock it in</button>
      <button class="btn" id="change" type="button">No, change my answer</button>
    </div>
    <button class="link center" id="skip" type="button">Skip this one (scores 0)</button>
    <p class="muted center">The fewer people who gave your answer, the further you travel.</p>
  </section>`;
}

// Wires up the answer form. A near-miss spelling gets a "Did you mean ...?" step before it is locked in.
// send(text) makes the final submission. Returns the function to call when the clock runs out.
function wireAnswer(promptId, send) {
  const form = $('#answer'), input = $('#input'), box = $('#didyou'), button = $('#answer button'), miss = $('#miss');
  input.addEventListener('input', () => { miss.hidden = true; });
  let sent = false, checking = false, suggestion = null;
  const lock = text => {
    if (sent) return;
    sent = true;
    button.disabled = true;
    sfx.play(String(text || '').trim() ? 'lock' : 'whoosh');
    Promise.resolve(send(text)).catch(e => { toast(e.message); sent = false; button.disabled = false; });
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || sent || checking) return;
    checking = true;
    let check = {};
    try { check = await api('/api/check', { promptId, answer: text }); } catch { /* fall through and submit as typed */ }
    checking = false;
    if (sent) return;
    if (check.suggest === null) {   // not on the list: say so and let them try again while the clock runs
      miss.textContent = `"${text}" isn't on the list. Try another answer.`;
      sfx.play('nope');
      miss.hidden = false;
      input.select();
      return;
    }
    miss.hidden = true;
    if (!check.suggest || check.exact) return lock(text);
    suggestion = check.suggest;
    $('b', box).textContent = suggestion;
    form.hidden = true;
    box.hidden = false;
  };
  $('#skip').onclick = () => lock('');
  $('#yes').onclick = () => lock(suggestion);
  $('#change').onclick = () => {
    suggestion = null;
    box.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  };
  return () => lock(suggestion || input.value);
}

// ------------------------------------------------------------ darts checkouts: the dart keypad
// "Check out 140 in 3 darts" is answered on a keypad instead of the text box. The player picks darts 1 and 2
// (multiplier, then number); as soon as both are in, dart 3 is filled with the double that finishes, if there is one,
// and the route is sent. Mirrors checkouts.py on the server, which has the final say.

const dartVal = d => d === 'BULL' ? 50 : d === '25' ? 25 : { S: 1, D: 2, T: 3 }[d[0]] * +d.slice(1);
const dartFinish = left => left === 50 ? 'BULL' : left >= 2 && left <= 40 && left % 2 === 0 ? 'D' + left / 2 : null;
const dartRank = d => ({ T: 3, D: 2, S: 1 })[d[0]] || 0;
// Darts 1 and 2 by score, highest first (a tie goes T, D, S, then 25/Bull), then the double: the server's canonical form.
const dartRoute = (a, b, c) => [a, b].sort((x, y) => dartVal(y) - dartVal(x) || dartRank(y) - dartRank(x)).concat(c).join('-');
function dartToken(t) {
  t = t.toLowerCase();
  if (/^(bull|bullseye|bulls|db|d25|50)$/.test(t)) return 'BULL';
  if (/^(25|s25|sb|ob|outer)$/.test(t)) return '25';
  const m = /^([sdt])(\d{1,2})$/.exec(t);
  return m && +m[2] >= 1 && +m[2] <= 20 ? m[1].toUpperCase() + +m[2] : null;
}

function dartPadHTML() {
  return `<div class="dpad" id="dpad">
    <div class="dp-slots">${[1, 2, 3].map(i => `<button type="button" class="dp-slot" data-slot="${i - 1}" aria-label="Dart ${i}"><small>Dart ${i}</small><b></b></button>`).join('')}</div>
    <p class="dp-left" id="dpLeft" aria-live="polite"></p>
    <div class="dp-mult" role="group" aria-label="Single, double or treble">${['S', 'D', 'T'].map(m => `<button type="button" data-m="${m}" aria-label="${{ S: 'Single', D: 'Double', T: 'Treble' }[m]}">${m}</button>`).join('')}</div>
    <div class="dp-nums">${Array.from({ length: 20 }, (_, i) => `<button type="button" data-n="${i + 1}">${i + 1}</button>`).join('')}
      <button type="button" class="dp-25" data-seg="25">25</button><button type="button" class="dp-bull" data-seg="BULL">Bull</button></div>
    <p class="dp-msg" id="dpMsg" role="alert"></p>
  </div>`;
}

// Wires the keypad in #dpad. send(route) submits "T20-T16-D16"; it may return a promise. opts.canSend() says whether
// the player may send right now (Fumble: only on their turn; a finished route waits, and flush() sends it).
// opts.darts restores darts 1 and 2 after a redraw; opts.onChange(darts) hears every change.
function dartPad(target, send, opts = {}) {
  const root = $('#dpad');
  let darts = [null, null, null], active = 0, mult = 'T', busy = false, typed = '', note = '', bad = false;
  if (opts.darts) {   // a redraw: darts 1 and 2 come back, and a finished route is ready again
    darts = [opts.darts[0] || null, opts.darts[1] || null, null];
    active = darts[0] ? 1 : 0;
    if (darts[0] && darts[1]) darts[2] = dartFinish(target - dartVal(darts[0]) - dartVal(darts[1]));
  }
  const msg = (text, isBad = false) => { note = text; bad = isBad; draw(); };
  const draw = () => {
    root.querySelectorAll('.dp-slot').forEach((el, i) => {
      $('b', el).textContent = darts[i] ? (darts[i] === 'BULL' ? 'Bull' : darts[i]) : '–';
      el.classList.toggle('on', i === active && !darts[2]);
      el.classList.toggle('fin', i === 2 && !!darts[2]);
    });
    root.querySelectorAll('[data-m]').forEach(el => el.setAttribute('aria-pressed', el.dataset.m === mult));
    let left = target;
    const steps = [target];
    for (const d of darts) if (d) { left -= dartVal(d); steps.push(left); }
    $('#dpLeft').textContent = steps.length > 1 ? `${steps.join(' → ')}${darts[2] ? '' : ' left'}` : `${target} left`;
    const m = $('#dpMsg');
    m.textContent = typed ? `Typing: ${typed}` : note;
    m.classList.toggle('bad', bad && !typed);
  };
  const shake = el => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
  const changed = () => opts.onChange && opts.onChange(darts.slice(0, 2));
  const finish = () => {
    const left = target - dartVal(darts[0]) - dartVal(darts[1]);
    const d3 = dartFinish(left);
    if (!d3) {
      active = 1;   // the next tap replaces dart 2
      sfx.play('nope');
      shake(root.querySelector('[data-slot="1"]'));
      msg(left < 0 ? `Bust: that's ${-left} too many` : left === 0 ? 'Dart 3 has to be the double' : `${left} left – can't finish`, true);
      return;
    }
    darts[2] = d3;
    msg('');
    flush();
  };
  const flush = () => {
    if (!darts[2] || busy) return;
    if (opts.canSend && !opts.canSend()) return msg('Ready – it goes when it’s your turn');
    busy = true;
    Promise.resolve(send(dartRoute(...darts))).finally(() => { busy = false; });
  };
  const place = seg => {
    if (busy) return;
    if (darts[2]) { darts[2] = null; active = 1; }   // a ready route waiting for a turn can still be changed
    darts[active] = seg;
    note = ''; bad = false;
    changed();
    if (darts[0] && darts[1]) return finish();
    active = darts[0] ? 1 : 0;
    draw();
  };
  root.onclick = e => {
    const b = e.target.closest('button');
    if (!b || busy) return;
    if (b.dataset.m) { mult = b.dataset.m; return draw(); }
    if (b.dataset.n) return place(mult + b.dataset.n);
    if (b.dataset.seg) return place(b.dataset.seg);   // 25 and Bull ignore the multiplier
    if (b.dataset.slot) {   // tapping a dart takes it back
      const i = +b.dataset.slot;
      if (i === 2) { if (darts[2]) { darts[2] = null; active = 1; } }
      else { darts[i] = null; darts[2] = null; active = i; changed(); }
      note = ''; bad = false;
      draw();
    }
  };
  // Keyboard: "t20 t16" then Enter (s/d/t before each number; 25 and bull on their own). Bare numbers don't count.
  const onKey = e => {
    if (!root.isConnected) return document.removeEventListener('keydown', onKey);
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest('input, textarea, select'))) return;
    if (e.key === 'Enter') {
      if (!typed.trim()) return;
      e.preventDefault();
      const toks = typed.trim().split(/[\s,\-+/]+/).filter(Boolean);
      typed = '';
      const segs = toks.map(dartToken);
      if (toks.length < 2 || toks.length > 3) return msg('Type darts 1 and 2, like t20 t16', true);
      if (segs.includes(null)) return msg(toks.some(t => /^\d+$/.test(t)) ? 'Put s, d or t before each number (t20, d16, s5)' : 'Not a dart: use s, d or t and 1–20, or 25 or bull', true);
      const d3 = dartFinish(target - dartVal(segs[0]) - dartVal(segs[1]));
      if (segs[2] && segs[2] !== d3) return msg(d3 ? `That doesn't finish: dart 3 would be ${d3 === 'BULL' ? 'the Bull' : d3}` : 'Dart 3 has to finish on a double', true);
      darts = [segs[0], segs[1], null];
      note = ''; bad = false;
      changed();
      return finish();
    }
    if (e.key === 'Escape') { typed = ''; return draw(); }
    if (e.key === 'Backspace') { if (typed) { e.preventDefault(); typed = typed.slice(0, -1); draw(); } return; }
    if (e.key.length === 1 && /[a-z0-9 ,\-+/]/i.test(e.key) && (typed || e.key !== ' ')) {
      e.preventDefault();
      typed = (typed + e.key).slice(0, 24);
      draw();
    }
  };
  document.addEventListener('keydown', onKey);
  draw();
  return {
    reset() { darts = [null, null, null]; active = 0; typed = ''; note = ''; bad = false; changed(); draw(); },
    fail(text) { darts = [null, null, null]; active = 0; changed(); sfx.play('nope'); shake(root); msg(text, true); },
    flush,
  };
}

// The solo and party question screen's version of wireAnswer for a darts prompt. Returns the timeout handler.
function wireDarts(prompt, send) {
  let sent = false;
  const lock = text => {
    if (sent) return;
    sent = true;
    sfx.play(text ? 'lock' : 'whoosh');
    return Promise.resolve(send(text)).catch(e => { toast(e.message); sent = false; pad.reset(); });
  };
  const pad = dartPad(prompt.target, lock);
  const skip = $('#skip');
  if (skip) skip.onclick = () => lock('');
  return () => lock('');
}

// ------------------------------------------------------------ category picker

let CATS = [];
// The player's choice: { sels: { categoryId: [tags] } }. [] means all of that category; no sels means Everything.
// Football sits inside Sport but is picked on its own, so { football: [...], sport: ['darts'] } is Football plus Darts.
let pick = store.get('outlier.pick', { sels: {} });
const catOf = id => CATS.find(c => c.id === id) || CATS[0];

// A parent category (Sport) holds its own sports in its first filter group, plus sub-categories (Football)
// that are ticked by id and bring their own filters (Era, Competition) for their questions only.
const kidsOf = c => CATS.filter(x => x.parent === c.id);
const leadOf = c => kidsOf(c).length ? c.filters[0] : null;

function passes(groups, tags, chosenTags) {
  return groups.every(g => {
    const chosen = g.tags.filter(t => chosenTags.includes(t.id));
    if (!chosen.length) return true;
    const have = g.tags.filter(t => tags.includes(t.id)).length;
    const hit = chosen.filter(t => tags.includes(t.id)).length;
    return hit > 0 && (g.label !== 'Era' || hit === have);
  });
}

// In the party lobby with Fumble picked, only prompts with enough answers for Fumble count (the server's "big").
const fumbleLobby = () => !!party && party.mode === 'potato' && !!$('#mode');
const cnt = x => fumbleLobby() && x.big !== undefined ? x.big : x.count;

// How many prompts one category pick gives. Mirrors pool() in server.py.
function countOne(p) {
  const c = catOf(p.cat);
  if (!c.tagsets) return cnt(c);
  const kids = kidsOf(c), lead = leadOf(c);
  const subs = kids.length ? p.tags.filter(t => kids.some(k => k.id === t) || lead.tags.some(x => x.id === t)) : [];
  return c.tagsets.filter(tags => {
    if (fumbleLobby() && tags.includes('~small')) return false;   // too few answers for Fumble
    if (!tags.every(t => !t.startsWith('~only:') || p.tags.includes(t.slice(6)))) return false;   // decade versions need their decade
    let home = c, picked = !!c.parent;   // picked: the sub-category (Darts) itself was chosen
    const kid = (tags.find(t => t.startsWith('~cat:')) || '').slice(5);
    if (kid) {
      if (subs.length && !subs.includes(kid)) return false;
      home = catOf(kid);
      picked = subs.includes(kid);
    } else if (subs.length && !subs.some(t => lead.tags.some(x => x.id === t))) return false;
    const mine = kids.length ? p.tags.filter(t => home.filters.some(g => g.tags.some(x => x.id === t))) : p.tags;
    return (mine.length || (picked && home.open) || !tags.includes('~deep')) && passes(home.filters, tags, p.tags);
  }).length;
}

const selsOf = p => Object.entries((p && p.sels) || {});
function poolCount(p) {
  const sels = selsOf(p);
  return sels.length ? sels.reduce((n, [cat, tags]) => n + countOne({ cat, tags }), 0) : cnt(catOf('all'));
}

function labelOne(cat, tags) {
  const c = catOf(cat);
  // A group with every option ticked reads as the whole category, so "Sport" not "Sport · Tennis · Boxing · ...".
  const named = c.filters.filter(g => !g.tags.filter(t => cnt(t)).every(t => tags.includes(t.id)))
    .flatMap(g => g.tags).filter(t => tags.includes(t.id)).map(t => t.label);
  return [c.label, ...named].join(' · ');
}
function pickLabel(p) {
  const sels = selsOf(p);
  return sels.length ? sels.map(([cat, tags]) => labelOne(cat, tags)).join(' + ') : 'Everything';
}

// What the server is sent: one category as cat + tags, several as cat "mix" with one "cat:tag.tag" item each.
function apiPick(p) {
  const sels = selsOf(p);
  if (!sels.length) return { cat: 'all', tags: [] };
  if (sels.length === 1) return { cat: sels[0][0], tags: sels[0][1] };
  return { cat: 'mix', tags: sels.map(([cat, tags]) => `${cat}:${tags.join('.')}`) };
}
const apiQuery = p => { const a = apiPick(p); return `cat=${encodeURIComponent(a.cat)}&tags=${encodeURIComponent(a.tags.join(','))}`; };

// Picks saved by older versions ({ cat, tags }) become the new shape.
function upgradePick(p) {
  if (!p) return { sels: {} };
  if (p.sels) {
    const sels = Object.fromEntries(selsOf(p).filter(([cat]) => CATS.some(c => c.id === cat)));
    // Darts and Darts checkouts used to be Sport options; Darts is now a sub-category with Trivia and Checkouts.
    const sp = sels.sport;
    if (sp && CATS.some(c => c.id === 'darts') && (sp.includes('darts') || sp.includes('checkouts'))) {
      sels.darts = sp.includes('darts') ? [] : ['checkouts'];
      sels.sport = sp.filter(t => t !== 'darts' && t !== 'checkouts');
      if (!sels.sport.length) delete sels.sport;
    }
    return { sels };
  }
  if (!p.cat || p.cat === 'all' || !CATS.some(c => c.id === p.cat)) return { sels: {} };
  const c = catOf(p.cat), kids = kidsOf(c), tags = p.tags || [];
  if (!kids.length) return { sels: { [c.id]: tags } };
  const sels = {}, lead = leadOf(c);
  kids.filter(k => tags.includes(k.id)).forEach(k => {
    sels[k.id] = tags.filter(t => k.filters.some(g => g.tags.some(x => x.id === t)));
  });
  const own = tags.filter(t => lead.tags.some(x => x.id === t));
  if (own.length || !Object.keys(sels).length) sels[c.id] = own;
  return { sels };
}

// The category a Daily seven uses: the one picked category, or Everything for a mix.
function dailyCat(p) {
  const cats = [...new Set(selsOf(p).map(([cat]) => catOf(cat).parent || cat))];
  return cats.length === 1 ? cats[0] : 'all';
}

// ------------------------------------------------------------ pop-up sheets

const chipHTML = (on, data, label, off, extra = '') =>
  `<button class="chip${on ? ' on' : ''}" ${data} ${off ? 'disabled' : ''} aria-pressed="${on}">${on ? ic('check') : ''}${esc(label)}${extra}</button>`;

// A bottom sheet. body() redraws its contents; it closes itself on the X, the backdrop or Escape.
function openSheet(title, body, wire) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-h"><h2>${esc(title)}</h2><button class="iconbtn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="sheet-b"></div></div>`;
  document.body.append(bg);
  document.body.classList.add('sheet-open');
  const close = () => {
    bg.remove();
    if (!document.querySelector('.sheet-bg')) document.body.classList.remove('sheet-open');
    document.removeEventListener('keydown', esc_);
  };
  const esc_ = e => { if (e.key === 'Escape' && bg === [...document.querySelectorAll('.sheet-bg')].pop()) close(); };
  document.addEventListener('keydown', esc_);
  const draw = () => { $('.sheet-b', bg).innerHTML = body(); };
  bg.addEventListener('click', e => {
    if (e.target === bg || e.target.closest('[data-close]')) return close();
    wire(e, { draw, close });
  });
  draw();
  requestAnimationFrame(() => bg.classList.add('in'));
  return close;
}

// One category's options (Food & Drink's topics, Football's eras and competitions).
// Every option starts ticked (Select all); untick the ones you don't want. done(tags) or done(null) to remove.
function categorySheet(cat, current, done) {
  const c = catOf(cat);
  const groups = c.filters.map(g => {
    const chosen = g.tags.filter(t => (current || []).includes(t.id)).map(t => t.id);
    // A new pick starts empty; an existing one shows what it covers (all of a group when none of it was narrowed).
    if (!current) return new Set();
    return new Set(chosen.length ? chosen : g.tags.filter(t => cnt(t)).map(t => t.id));
  });
  const full = k => c.filters[k].tags.filter(t => cnt(t)).every(t => groups[k].has(t.id));
  const allOn = () => groups.every((_, k) => full(k));
  // A group with nothing ticked means any of it, so just Premier League is Premier League in every era.
  const tags = () => groups.flatMap((g, k) => full(k) || !g.size ? [] : [...g]);
  const ok = () => groups.some(g => g.size);   // something ticked, or Select all
  openSheet(c.label, () => {
    const n = ok() ? countOne({ cat, tags: tags() }) : 0;
    return `<button class="selall${allOn() ? ' on' : ''}" data-all><span class="box">${allOn() ? ic('check') : ''}</span><span><b>Select all</b><small>Everything in ${esc(c.label)}</small></span></button>
      ${c.filters.map((g, k) => `<div class="group"><h4>${esc(g.label)}${groups[k].size ? '' : ' <small>any</small>'}</h4><div class="chips">${g.tags.map(t =>
        chipHTML(groups[k].has(t.id), `data-k="${k}" data-t="${t.id}"`, t.label, !cnt(t))).join('')}</div></div>`).join('')}
      <div class="sheet-f">
        ${current ? '<button class="btn" data-remove>Remove</button>' : ''}
        <button class="btn primary" data-ok ${ok() ? '' : 'disabled'}>${ok() ? `Confirm · ${n} prompts` : 'Tick some, or Select all'}</button>
      </div>`;
  }, (e, s) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.all !== undefined) {
      const on = !allOn();
      groups.forEach((g, k) => { g.clear(); if (on) c.filters[k].tags.filter(t => cnt(t)).forEach(t => g.add(t.id)); });
    } else if (b.dataset.t) {
      const g = groups[+b.dataset.k];
      g.has(b.dataset.t) ? g.delete(b.dataset.t) : g.add(b.dataset.t);
    } else if (b.dataset.remove !== undefined) { s.close(); return done(null); }
    else if (b.dataset.ok !== undefined) { s.close(); return done(tags()); }
    s.draw();
  });
}

// Sport: every sport as a tickable option. Football (a category of its own) opens its own sheet first.
function parentSheet(cat, done) {
  const c = catOf(cat), kids = kidsOf(c), lead = leadOf(c);
  const live = [...kids.filter(k => cnt(k)).map(k => k.id), ...lead.tags.filter(t => cnt(t)).map(t => t.id)];
  const had = live.some(id => id in pick.sels) || cat in pick.sels;
  const ticked = new Set(), kidTags = {};
  if (pick.sels[cat] && !pick.sels[cat].length) live.forEach(id => ticked.add(id));   // all of Sport
  else {
    (pick.sels[cat] || []).forEach(t => ticked.add(t));
    kids.forEach(k => { if (k.id in pick.sels) { ticked.add(k.id); kidTags[k.id] = pick.sels[k.id]; } });
  }
  const allOn = () => live.every(id => ticked.has(id)) && kids.every(k => !(kidTags[k.id] || []).length);
  const result = () => {
    if (allOn()) return { [cat]: [] };
    const out = {};
    const own = lead.tags.filter(t => ticked.has(t.id)).map(t => t.id);
    if (own.length) out[cat] = own;
    kids.forEach(k => { if (ticked.has(k.id)) out[k.id] = kidTags[k.id] || []; });
    return out;
  };
  const count = () => Object.entries(result()).reduce((n, [x, tags]) => n + countOne({ cat: x, tags }), 0);
  openSheet(c.label, () => {
    const n = ticked.size ? count() : 0;
    return `<button class="selall${allOn() ? ' on' : ''}" data-all><span class="box">${allOn() ? ic('check') : ''}</span><span><b>Select all</b><small>Every ${esc(c.label.toLowerCase())} question</small></span></button>
      <div class="group"><h4>${esc(lead.label)}</h4><div class="chips">
        ${kids.map(k => chipHTML(ticked.has(k.id), `data-kid="${k.id}"`, k.label, !cnt(k),
          `<span class="more">${(kidTags[k.id] || []).length ? 'custom' : ''}${ic('right')}</span>`)).join('')}
        ${lead.tags.map(t => chipHTML(ticked.has(t.id), `data-t="${t.id}"`, t.label, !cnt(t))).join('')}
      </div></div>
      <p class="fine">${ic('right')}<span>Tap ${kids.map(k => esc(k.label)).join(', ').replace(/, ([^,]*)$/, ' or $1')} to choose what's in it.</span></p>
      <div class="sheet-f">
        ${had ? '<button class="btn" data-remove>Remove</button>' : ''}
        <button class="btn primary" data-ok ${ticked.size ? '' : 'disabled'}>${ticked.size ? `Confirm · ${n} prompts` : 'Tick some, or Select all'}</button>
      </div>`;
  }, (e, s) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.all !== undefined) {
      const on = !allOn();
      ticked.clear();
      kids.forEach(k => { kidTags[k.id] = []; });
      if (on) live.forEach(id => ticked.add(id));
    } else if (b.dataset.kid) {
      const k = b.dataset.kid;
      return categorySheet(k, ticked.has(k) ? (kidTags[k] || []) : null, tags => {
        if (tags === null) ticked.delete(k); else { ticked.add(k); kidTags[k] = tags; }
        s.draw();
      });
    } else if (b.dataset.t) ticked.has(b.dataset.t) ? ticked.delete(b.dataset.t) : ticked.add(b.dataset.t);
    else if (b.dataset.remove !== undefined) { s.close(); return done(null); }
    else if (b.dataset.ok !== undefined) { s.close(); return done(result()); }
    s.draw();
  });
}

function mountPicker(el, onChange, heading = 'Choose a category') {
  const sel = id => id in pick.sels || kidsOf(catOf(id)).some(k => k.id in pick.sels);
  const tile = (x, wide) => {
    const on = x.id === 'all' ? !selsOf(pick).length : sel(x.id);
    const own = pick.sels[x.id];
    const sub = x.id !== 'all' && on ? (own && !own.length && !kidsOf(x).some(k => k.id in pick.sels) ? 'All of it' : 'Custom') : `${cnt(x)} prompts`;
    return `<button class="tile${wide ? ' wide' : ''}${on ? ' on' : ''}" data-cat="${x.id}" aria-pressed="${on}">
      <span class="tile-ic">${on && x.id !== 'all' ? ic('check') : ic(CAT_ICON[x.id] || 'sparkles')}</span><span class="tile-l">${esc(x.label)}</span><span class="tile-n">${wide ? `${cnt(x)} prompts · a mix from every category` : sub}</span></button>`;
  };
  const save = () => { store.set('outlier.pick', pick); draw(); onChange && onChange(); };
  const draw = () => {
    const sels = selsOf(pick), n = poolCount(pick);
    const everything = CATS.find(x => x.id === 'all');
    el.innerHTML = `<div class="picker">
      ${tile(everything, true)}
      <h2 class="sec-h">${esc(heading)}</h2>
      <div class="tiles">${CATS.filter(x => !x.parent && x.id !== 'all').map(x => tile(x)).join('')}</div>
      <div class="mix">
        <div class="narrow-h"><h3>Your mix</h3><span class="mix-r">${sels.length ? `<button class="clearall" data-clear>${ic('x')}Clear all</button>` : ''}<span class="count">${n} prompt${n === 1 ? '' : 's'}</span></span></div>
        ${sels.length ? `<div class="chips">${sels.map(([cat, tags]) =>
          `<span class="mixchip">${esc(labelOne(cat, tags))}<button data-drop="${cat}" aria-label="Remove ${esc(catOf(cat).label)}">${ic('x')}</button></span>`).join('')}</div>
          <p class="fine">Tap more categories to add them to the mix.</p>`
          : '<p class="fine">Everything, from every category. Tap categories above to build your own mix.</p>'}
      </div>
    </div>`;
  };
  el.onclick = e => {
    const drop = e.target.closest('[data-drop]');
    if (drop) { delete pick.sels[drop.dataset.drop]; return save(); }
    if (e.target.closest('[data-clear]')) { pick = { sels: {} }; return save(); }
    const b = e.target.closest('.tile');
    if (!b) return;
    const id = b.dataset.cat;
    if (id === 'all') { pick = { sels: {} }; return save(); }
    const c = catOf(id);
    if (kidsOf(c).length) return parentSheet(id, out => {
      [id, ...kidsOf(c).map(k => k.id)].forEach(x => delete pick.sels[x]);
      if (out) Object.assign(pick.sels, out);
      save();
    });
    categorySheet(id, pick.sels[id] || null, tags => {
      if (tags === null) delete pick.sels[id]; else pick.sels[id] = tags;
      save();
    });
  };
  draw();
}

// ------------------------------------------------------------ home

function home() {
  stopTimer();
  const mode = (id, icon, title, sub, primary) => `<button class="mode${primary ? ' primary' : ''}" id="${id}">
    <span class="mode-ic">${ic(icon)}</span><span class="mode-t"><b>${title}</b><small>${sub}</small></span>${ic('right', 'chev')}</button>`;
  show(`<div class="hero">
      <button class="iconbtn hero-set" id="settings" aria-label="Settings">${ic('gear')}</button>
      <div class="logo">Outl<b>i</b>er</div>
      <p>Give the answer nobody else did.</p>
      ${crowdHTML(3)}
    </div>
    ${dailyCardHTML()}
    <div class="modes">
      ${limited() ? mode('solo', 'calendar', 'More dailies', "Another category's daily, or any category with Plus")
        : mode('solo', 'play', 'Quick game', 'Pick categories or a mix, or play a friend’s challenge')}
      ${mode('party', 'users', 'Party game', 'Everyone plays together on their own phone')}
      <div class="mini-modes">
        <button class="mini" id="board"><span class="mini-ic">${ic('trophy')}</span><b>Leaderboard</b><small>Today, week, all time</small></button>
        <button class="mini" id="you"><span class="mini-ic">${avatar(store.get('outlier.name', '') || 'You', store.get('outlier.color', 0), store.get('outlier.look'))}</span><b>You</b><small>Stats, badges &amp; look</small></button>
      </div>
    </div>
    ${accountLine()}
    <details class="card how">
      <summary><h3>How it works</h3>${ic('right', 'chev')}</summary>
      <ol class="steps">
        <li><b>1</b><span>Get a prompt, like <i>Name a Pixar film</i>, and 30 seconds to answer.</span></li>
        <li><b>2</b><span>Any correct answer scores, from 10 for the one everyone says up to 99 for the rarest. The fewer people who say it, the more it is worth.</span></li>
        <li><b>3</b><span>Find the <b>Outlier</b>, the single rarest answer on the list (two on very long lists), for a big 150.</span></li>
      </ol>
      <p class="fine">Every answer played shifts how common it is. In party games, players who give the same answer share half the points.</p>
    </details>
    ${LEGAL}`);
  $('#solo').onclick = soloMenu;
  $('#party').onclick = () => partyMenu();
  $('#you').onclick = youPage;
  $('#board').onclick = () => boardMenu();
  $('#settings').onclick = () => settingsScreen();
  $('#dailyHome').onclick = () => startDaily('all');
  remindWire();
  accountWire();
}

// ------------------------------------------------------------ settings

function settingsScreen() {
  stopTimer();
  const row = (id, on, icon, title, sub) => `<div class="card setrow"><span class="mini-ic">${ic(icon)}</span>
    <span class="main"><b>${title}</b><small>${sub}</small></span>
    <button class="switch${on ? ' on' : ''}" id="${id}" role="switch" aria-checked="${on}" aria-label="${title}"><i></i></button></div>`;
  const remind = remindRowHTML();
  show(`${topbar('Settings')}
    <section class="sec"><h2 class="sec-h">Sound</h2>
      ${row('setSound', settings.sound, 'vol', 'Sound effects', 'Countdowns, lock-ins, reveals and fanfares')}
      <div class="card setrow vol" id="volRow"><span class="mini-ic">${ic('wave')}</span>
        <label class="main" for="setVol"><b>Volume</b><input type="range" id="setVol" min="0" max="100" step="5" value="${Math.round(settings.volume * 100)}"></label>
        <button class="btn small" id="setTest" type="button">Test</button></div>
      ${row('setTicks', settings.ticks, 'clock', 'Countdown ticks', 'A tick for each of the last five seconds')}
      ${row('setMusic', settings.music, 'music', 'Music', 'A gentle looping track that livens up during questions')}
      <div class="card setrow vol" id="mvolRow"><span class="mini-ic">${ic('wave')}</span>
        <label class="main" for="setMvol"><b>Music volume</b><input type="range" id="setMvol" min="0" max="100" step="5" value="${Math.round(settings.musicVol * 100)}"></label>
        <span></span></div>
      <p class="fine">On iPhone, sound and music follow the silent switch. In a party with a big screen connected, only the TV plays them.</p>
    </section>
    <section class="sec"><h2 class="sec-h">Feel</h2>
      ${'vibrate' in navigator ? row('setVib', settings.vibrate, 'zap', 'Vibration', 'A buzz for rare answers, your turn and your streak') : ''}
      ${row('setCalm', settings.calm, 'sparkles', 'Reduce animations', 'Skip the build-ups, count-ups and screen transitions')}
    </section>
    ${remind ? `<section class="sec"><h2 class="sec-h">Reminders</h2>${remind}</section>` : ''}
    <section class="sec"><h2 class="sec-h">You</h2>
      <button class="archrow" id="setLook">${ic('user')}<span><b>Your character</b> · name, colour and look</span>${ic('right')}</button>
      <button class="archrow" id="setStats">${ic('trophy')}<span><b>Stats &amp; badges</b></span>${ic('right')}</button>
    </section>
    <button class="link center" id="setReset" type="button">Reset to defaults</button>
    ${LEGAL}`);
  const paint = () => {
    [['setSound', 'sound'], ['setTicks', 'ticks'], ['setMusic', 'music'], ['setVib', 'vibrate'], ['setCalm', 'calm']].forEach(([id, k]) => {
      const b = $('#' + id);
      if (b) { b.classList.toggle('on', !!settings[k]); b.setAttribute('aria-checked', !!settings[k]); }
    });
    $('#volRow').classList.toggle('off', !settings.sound);
    $('#setTicks').disabled = !settings.sound;
    $('#setVol').value = Math.round(settings.volume * 100);
    $('#mvolRow').classList.toggle('off', !settings.music);
    $('#setMvol').value = Math.round(settings.musicVol * 100);
  };
  const flip = (id, key, after) => { const b = $('#' + id); if (b) b.onclick = () => { setSetting(key, !settings[key]); paint(); if (after) after(); }; };
  flip('setSound', 'sound', () => { if (settings.sound) { sfx.start(); sfx.play('pop'); } });
  flip('setTicks', 'ticks', () => { if (settings.ticks) sfx.play('tick', 4); });
  flip('setVib', 'vibrate', () => buzz(40));
  flip('setMusic', 'music', () => { if (settings.music) sfx.start(); });
  $('#setMvol').oninput = e => setSetting('musicVol', e.target.value / 100);
  flip('setCalm', 'calm');
  let testAt = 0;
  $('#setVol').oninput = e => {
    setSetting('volume', e.target.value / 100);
    if (performance.now() - testAt > 180) { testAt = performance.now(); sfx.play('tick', 9); }   // hear it while dragging
  };
  $('#setTest').onclick = () => {
    if (!settings.sound) return toast('Turn sound effects on first');
    sfx.start();
    sfx.play('ding');
  };
  $('#setLook').onclick = () => characterMenu(settingsScreen);
  $('#setStats').onclick = youPage;
  $('#setReset').onclick = () => { Object.keys(SETTINGS_DEFAULT).forEach(k => setSetting(k, SETTINGS_DEFAULT[k])); paint(); toast('Settings reset'); };
  $('#back').onclick = home;
  remindWire();
  paint();
}

// The first thing on the main menu: today's Daily seven · Everything, with where you are in it and your streak.
// When the streak is alive but today isn't played, it says how long is left before it goes out.
function dailyCardHTML() {
  const s = store.get('outlier.daily.all'), today = todayStr(), st = streakNow();
  const mine = s && s.date === today;
  const done = mine && s.done, started = mine && !s.done && (s.results || []).length;
  let status = 'Same seven prompts for everyone today';
  if (done) status = `Done today · ${s.total} paces · tap to see your day`;
  else if (started) status = `${s.results.length} of 7 played · tap to carry on`;
  let risk = '';
  if (st.n && !st.doneToday) {
    const now = new Date(), mid = new Date(now); mid.setHours(24, 0, 0, 0);
    const hrs = Math.floor((mid - now) / 3600000), mins = Math.max(1, Math.round((mid - now) / 60000));
    const left = hrs >= 1 ? `${hrs} ${hrs === 1 ? 'hour' : 'hours'}` : `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
    risk = `<span class="dc-risk${hrs < 6 ? ' late' : ''}">${ic('flame')}Your ${st.n}-day streak ends in ${left}</span>`;
  } else if (done && st.n) {
    risk = `<span class="dc-risk ok">${ic('flame')}${st.n}-day streak${st.best > st.n ? ` · best ${st.best}` : ''} · back tomorrow</span>`;
  }
  const card = `<button class="daily-card${done ? ' done' : ''}" id="dailyHome">
    <span class="dc-ic">${ic(done ? 'check' : 'calendar')}</span>
    <span class="dc-t"><small>Today's daily</small><b>Daily seven</b><span class="dc-sub">${status}</span>${risk}</span>
    ${st.n ? `<span class="dc-streak" aria-label="${st.n}-day streak">${ic('flame')}${st.n}</span>` : ''}${ic('right', 'chev')}</button>`;
  const rs = remindState();   // only once there's a streak worth keeping
  return st.n && ['on', 'off', 'ios'].includes(rs)
    ? `<div class="dc-wrap${done ? ' done' : ''}">${card}<button class="dc-bell${rs === 'on' ? ' on' : ''}" id="remindBell" aria-pressed="${rs === 'on'}" aria-label="Remind me before my streak ends" title="Remind me before my streak ends">${ic('bell')}</button></div>`
    : card;
}

// ------------------------------------------------------------ account

let me = null, signinOn = false, plan = { plus: true, paywall: false, claim: null, payments: false, price: '', subscribed: false };   // me = { email } when signed in; signinOn = the server can email sign-in links

async function loadMe(again = true) {
  try { const r = await api('/api/me'); me = r.user; signinOn = !!r.signin; plan = { plus: r.plus !== false, paywall: !!r.paywall, claim: r.claim || null, payments: !!r.payments, price: r.price || '', subscribed: !!r.subscribed }; serverToday = r.today || ''; if (me) { if (r.streak) adoptStreak(r.streak); else if (streakNow().n) api('/api/streak', { carry: store.get('outlier.streak', {}) }).then(adoptStreak).catch(() => {}); } } catch { me = null; }
  if (!me && store.get('outlier.session', '')) {   // a stale saved token: drop it and let the sign-in cookie (if any) speak
    store.del('outlier.session');
    if (again) return loadMe(false);
  }
}

function accountLine() {
  if (!me && !signinOn) return '';   // hidden until the server has email sending set up
  return me
    ? `<p class="acct muted center">Signed in as <b>${esc(me.email)}</b>${plan.paywall && plan.plus ? ' · <b>Plus</b>' : ''}${plan.subscribed ? ' · <button class="link" id="manage">Manage</button>' : ''} · <button class="link" id="signout">Sign out</button></p>`
    : `<p class="acct muted center"><button class="link" id="signin">Sign in</button> to keep your history</p>`;
}

function accountWire() {
  if ($('#signin')) $('#signin').onclick = () => signInScreen();
  if ($('#manage')) $('#manage').onclick = () => payRedirect('/api/portal');
  if ($('#signout')) $('#signout').onclick = async () => {
    try { await api('/api/auth/logout', {}); } catch { /* the session is dropped here either way */ }
    store.del('outlier.session'); me = null; toast('Signed out'); home();
  };
}

function signInScreen(sent = null) {
  stopTimer();
  show(`${topbar('Sign in')}
    ${sent ? `<div class="card center stack"><h2>Check your email</h2>
        <p class="muted">We sent a 6-digit code to <b>${esc(sent.email)}</b>. Type it here to sign in on this browser. It expires in 15 minutes.</p>
        <input type="text" id="code" class="code" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" maxlength="7" aria-label="Sign-in code">
        <button class="btn primary" id="codego">Sign in</button>
        <p class="fine center">The email also has a link. If it opens in your mail app instead of this browser, use the code instead.</p>
        ${sent.devLink ? `<a class="btn" href="${esc(sent.devLink)}">Open the sign-in link (test mode: code ${esc(sent.devCode || '')})</a>` : ''}</div>
      <button class="btn" id="again">Use a different email</button>`
      : `<div class="card stack signin"><div class="center"><span class="mode-ic">${ic('user')}</span><h2>Sign in to Outlier</h2>
        <p class="muted">Keep your play history and unlock account features.</p></div>
        <section class="field"><label for="email">Your email</label>
        <input type="email" id="email" placeholder="you@example.com" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false"></section>
      <button class="btn primary" id="send">Email me a sign-in code</button></div>
      <p class="fine">${ic('shield')}<span>No password. Signing in just keeps your play history and unlocks account features. We only use your email to sign you in.</span></p>`}`);
  $('#back').onclick = home;
  if (sent) {
    $('#again').onclick = () => signInScreen();
    const check = async () => {
      const code = $('#code').value.replace(/\D/g, '');
      if (code.length !== 6) return toast('Type the 6-digit code from the email');
      $('#codego').disabled = true;
      try {
        const r = await api('/api/auth/code', { email: sent.email, code });
        store.set('outlier.session', r.session);
        await loadMe();
        toast('Signed in');
        home();
      } catch (e) { toast(e.message); $('#codego').disabled = false; }
    };
    $('#codego').onclick = check;
    $('#code').oninput = () => { if ($('#code').value.replace(/\D/g, '').length === 6) check(); };
    $('#code').onkeydown = e => { if (e.key === 'Enter') check(); };
    $('#code').focus();
    return;
  }
  const go = async () => {
    const email = $('#email').value.trim();
    if (!email) return toast('Type your email first');
    $('#send').disabled = true;
    try {
      const r = await api('/api/auth/request', { email });
      if (r.pass) {   // the secret pass code: straight in, with Plus
        store.set('outlier.session', r.session);
        await loadMe();
        toast('Plus unlocked');
        return home();
      }
      signInScreen({ ...r, email });
    }
    catch (e) { toast(e.message); $('#send').disabled = false; }
  };
  $('#send').onclick = go;
  $('#email').onkeydown = e => { if (e.key === 'Enter') go(); };
}

async function finishLogin(token) {
  history.replaceState(null, '', location.pathname);
  try {
    const r = await api('/api/auth/verify', { token });
    store.set('outlier.session', r.session);
    await loadMe();
    toast('Signed in');
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------ solo

const LEGAL = `<p class="fine legal"><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>`;
const limited = () => plan.paywall && !plan.plus;   // free plan, with the paywall switched on

function wireSeed() {
  $('#seedGo').onclick = () => {
    const raw = $('#seedIn').value.trim();
    let seed = raw, from = '', pts = '';
    try {
      const u = new URL(raw), c = u.pathname.startsWith('/c/') && readChallenge(u.pathname);
      if (c) ({ seed, from, pts } = c);
      else { seed = u.searchParams.get('play') || ''; from = u.searchParams.get('from') || ''; pts = u.searchParams.get('pts') || ''; }
    } catch { /* a bare seed */ }
    if (!seed) return toast('Paste a seed or challenge link');
    from ? challengeIntro(seed, from, pts) : startGame({ seed });
  };
}

const SEEDBOX = () => `<details class="seedbox"><summary>${ic('link')}<span>Got a challenge link or seed from a friend?</span>${ic('right', 'chev')}</summary>
      <div class="row"><input type="text" id="seedIn" placeholder="Paste the link or seed" autocomplete="off"><button class="btn" id="seedGo">Play</button></div>
    </details>`;

// The free plan: Everything daily (no account), one other category daily (free account). Quick games and sub-categories are Plus.
function freeSolo() {
  stopTimer();
  const today = new Date().toLocaleDateString('en-CA');
  const state = id => { const s = store.get('outlier.daily.' + id); return s && s.date === today && s.done ? `Played today: ${s.total} paces` : ''; };
  const tiles = CATS.filter(x => !x.parent && x.id !== 'all').map(x => {
    const mine = plan.claim === x.id, shut = !!(plan.claim && !mine);
    const sub = state(x.id) || (mine ? 'Your free pick today' : shut ? 'Plus' : !me ? 'Free account' : 'Daily seven');
    return `<button class="tile${mine ? ' on' : ''}${shut ? ' shut' : ''}" data-cat="${x.id}"><span class="tile-ic">${ic(shut ? 'lock' : CAT_ICON[x.id] || 'sparkles')}</span><span class="tile-l">${esc(x.label)}</span><span class="tile-n">${esc(sub)}</span></button>`;
  }).join('');
  show(`${topbar('More dailies')}
    <button class="mode primary" id="dailyAll"><span class="mode-ic">${ic('calendar')}</span><span class="mode-t"><b>Daily seven · Everything</b><small>${state('all') || 'Same seven prompts for everyone today'}</small></span>${ic('right', 'chev')}</button>
    <section class="sec"><h2 class="sec-h">Your other daily</h2>
      <p class="fine">${ic('calendar')}<span>${me ? 'Choose one more category to play today.' : 'Sign in (it is free) to play one more category each day.'}</span></p>
      <div class="tiles">${tiles}</div></section>
    ${ARCHROW()}
    <button class="mode" id="quick"><span class="mode-ic">${ic('lock')}</span><span class="mode-t"><b>Quick game</b><small>Pick any category or mix. Outlier Plus</small></span>${ic('right', 'chev')}</button>
    ${SEEDBOX()}`);
  $('#back').onclick = home;
  $('#dailyAll').onclick = () => startDaily('all');
  $('#quick').onclick = () => upsellScreen('Quick games and choosing your own categories are part of Outlier Plus');
  app.querySelector('.tiles').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) startDaily(b.dataset.cat); };
  $('#archRow').onclick = archiveScreen;
  wireSeed();
}

async function payRedirect(path) {
  try { location.href = (await api(path, {})).url; } catch (e) { toast(e.message); }
}

function upsellScreen(msg) {
  stopTimer();
  const li = (icon, t, d) => `<li><span class="award-ic">${ic(icon)}</span><span class="award-t"><b>${t}</b><small>${d}</small></span></li>`;
  show(`${topbar('Outlier Plus')}
    <div class="card center stack"><h2>${esc(msg || 'More of Outlier')}</h2>
      <p class="muted">${plan.payments ? `Outlier Plus is ${esc(plan.price)}. Cancel any time.` : 'Outlier Plus is coming soon.'} Free play stays free: the Daily Everything every day, one more category each day, and every friend's challenge link.</p></div>
    <section class="card"><h3>With Plus</h3><ul class="awards">
      ${li('play', 'Quick games', 'Any category, sub-category or mix, any time')}
      ${li('calendar', 'Every daily', 'Any category every day, not just one')}
      ${li('check', 'Daily archive', 'Play any past Daily seven you missed')}
      ${li('users', 'Bigger party rooms', 'Host up to 12 players instead of 4, and pick the categories')}
    </ul></section>
    ${!plan.payments ? '' : me ? `<button class="btn primary" id="subscribe">Get Outlier Plus</button>` : ''}
    ${me ? '' : '<button class="btn primary" id="signin">Sign in' + (plan.payments ? ' to subscribe' : '') + '</button>'}
    <button class="btn" id="ok">Back</button>
    ${LEGAL}`);
  if ($('#subscribe')) $('#subscribe').onclick = () => { $('#subscribe').disabled = true; payRedirect('/api/checkout'); };
  $('#back').onclick = $('#ok').onclick = () => limited() ? freeSolo() : home();
  if ($('#signin')) $('#signin').onclick = () => signInScreen();
}

function soloMenu() {
  stopTimer();
  if (limited()) return freeSolo();
  const recent = store.get('outlier.recent', []).map(upgradePick);
  show(`${topbar('Quick game')}
    ${recent.length ? `<section class="sec"><h2 class="sec-h">Jump back in</h2><div class="recent">${recent.map((r, i) =>
      `<button class="recentbtn" data-i="${i}">${ic(CAT_ICON[selsOf(r).length === 1 ? (catOf(selsOf(r)[0][0]).parent || selsOf(r)[0][0]) : 'all'] || 'sparkles')}<span>${esc(pickLabel(r))}</span></button>`).join('')}</div></section>` : ''}
    <section class="sec"><div id="picker"></div></section>
    ${ARCHROW()}
    ${SEEDBOX()}
    <div class="cta row2">
      <button class="btn primary big" id="free"></button>
      <button class="btn big" id="daily"></button>
    </div>`);
  const refresh = () => {
    const c = catOf(dailyCat(pick)), saved = store.get('outlier.daily.' + c.id);
    const today = new Date().toLocaleDateString('en-CA');
    const done = saved && saved.date === today && saved.done;
    const n = poolCount(pick);   // the categories themselves are listed in Your mix, so keep this line short
    $('#free').innerHTML = `${ic('play')}<span><b>Play</b><small>${n} ${selsOf(pick).length ? "in your mix" : "prompts"}</small></span>`;
    $('#daily').innerHTML = `${ic(done ? 'check' : 'calendar')}<span><b>Daily</b><small>${esc(c.label)}${done ? ` · ${saved.total}` : ''}</small></span>`;
    $('#daily').title = done ? `Daily seven · ${c.label}: played today (${saved.total} paces)` : `Daily seven · ${c.label}: same seven prompts for everyone today`;
    $('#free').disabled = !poolCount(pick);
  };
  mountPicker($('#picker'), refresh);
  refresh();
  $('#back').onclick = home;
  $('#daily').onclick = () => startDaily();   // not startDaily directly: the click event would be taken as the category
  $('#free').onclick = () => startGame();
  $('#archRow').onclick = archiveScreen;
  app.querySelectorAll('.recentbtn').forEach(b => b.onclick = () => {
    pick = JSON.parse(JSON.stringify(recent[+b.dataset.i]));
    store.set('outlier.pick', pick);
    startGame();
  });
  wireSeed();
}

async function startDaily(cat = dailyCat(pick)) {
  let day;
  try { day = await api('/api/daily?cat=' + encodeURIComponent(cat)); }
  catch (e) {
    if (e.status === 401) { toast(e.message); return signInScreen(); }
    if (e.status === 402) return upsellScreen(e.message);
    return toast(e.message);
  }
  if (me && limited() && cat !== 'all') plan.claim = cat;
  const key = 'outlier.daily.' + day.cat;
  let saved = store.get(key);
  if (!saved || saved.date !== day.date) saved = { date: day.date, number: day.number, label: day.label, results: [], done: false };
  const run = { day, key, saved };
  if (saved.done) return dailySummary(run);
  if (saved.results.length) return dailyQuestion(run);
  intro(`Daily seven · ${day.label}`, `#${day.number} · ${day.prompts.length} prompts · ${Math.round(day.roundMs / 1000)} seconds each`, () => dailyQuestion(run));
}

const sum = results => results.reduce((n, r) => n + r.points, 0);

function ask(prompt, roundMs, header, onResult) {
  show(header + questionHTML(prompt.text, prompt));
  const submit = async text => {
    stopTimer();
    onResult(await api('/api/answer', { promptId: prompt.id, answer: text, cid: playerId() }));
  };
  const darts = prompt.input === 'darts';
  const onTimeout = darts ? wireDarts(prompt, submit) : wireAnswer(prompt.id, submit);
  const ms = prompt.roundMs || roundMs;   // some question types have their own time (INPUT_SECS in server.py)
  sfx.play('stingSoft');
  runTimer(ms, ms, () => { sfx.play('buzzer'); onTimeout(); });
  if (!darts) $('#input').focus();
}

function dailyQuestion(run) {
  const { day, saved } = run, i = saved.results.length;
  const title = run.archive ? `Daily #${day.number} · archive` : `${esc(day.label)} #${day.number}`;
  const header = `<header class="bar"><button class="link" id="quit">✕ Quit</button>
    <span>${title} · ${i + 1}/${day.prompts.length}</span><span class="pill">${sum(saved.results)}</span></header>`;
  ask(day.prompts[i], day.roundMs, header, res => {
    const before = sum(saved.results);
    saved.results.push({ prompt: res.prompt, promptId: res.promptId, given: res.given, canonical: res.canonical, valid: res.valid, points: res.points, share: res.share, outlier: res.outlier });
    saved.done = saved.results.length >= day.prompts.length;
    saved.total = sum(saved.results);
    store.set(run.key, saved);
    if (saved.done && !run.archive) run.streakUp = bumpStreak(saved.date);   // a past day never moves the streak
    const max = day.prompts.length * 100;
    show(`<header class="bar"><span></span><span>${title} · ${i + 1}/${day.prompts.length}</span><span></span></header>
      <p class="muted center">${esc(res.prompt)}</p>
      ${resultHTML(res)}
      <div class="after wait">
        <div class="card">${trailHTML([{ name: 'You', from: before, to: saved.total, me: true }], max)}
          <p class="zone">${zoneName(saved.total, max)}<span class="muted">${saved.total} paces from the crowd</span></p></div>
        ${outlierHTML(res.board.filter(b => b.outlier), res.canonical)}
        ${voteHTML(res.promptId)}
        <button class="btn primary" id="next">${saved.done ? 'See your day' : 'Next prompt'}</button>
      </div>`);
    buildUp(res);
    $('#next').onclick = () => !saved.done ? dailyQuestion(run)
      : run.streakUp ? streakScreen(run.streakUp, () => { run.streakUp = null; dailySummary(run); }) : dailySummary(run);
  });
  $('#quit').onclick = run.archive ? archiveScreen : soloMenu;
}

const dayBefore = date => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
let serverToday = '';
const todayStr = () => serverToday || new Date().toISOString().slice(0, 10);

// The streak counts days in a row with at least one daily finished. It is "alive" if the last one was today or yesterday.
function streakNow() {
  const s = store.get('outlier.streak', { n: 0, last: '', best: 0 }) || {};
  const today = todayStr(), alive = s.last === today || s.last === dayBefore(today);
  return { n: alive ? (s.n || 0) : 0, best: Math.max(s.best || 0, s.n || 0), doneToday: s.last === today, last: s.last || '' };
}

function bumpStreak(date) {
  const s = store.get('outlier.streak', { n: 0, last: '', best: 0 }) || {};
  let up = null;
  if (s.last !== date) {
    const was = s.last === dayBefore(date) ? (s.n || 0) : 0, n = was + 1, best = Math.max(s.best || 0, s.n || 0);
    store.set('outlier.streak', { n, last: date, best: Math.max(best, n) });
    up = { from: was, to: n, record: n > best && best > 0 };
  }
  if (me) api('/api/streak', { played: true, carry: store.get('outlier.streak', {}) }).then(adoptStreak).catch(() => {});
  pushState();
  return up;   // { from, to, record } when today moved the streak on, otherwise null
}

// The streak screen after a daily that moved your streak on: an ember that catches light, and the count rolling over.
const STREAK_WORDS = { 1: 'Streak started!', 3: 'Hat-trick!', 7: 'A full week!', 14: 'Two weeks straight!', 30: 'A whole month!', 50: 'Fifty days!', 100: 'One hundred days!', 365: 'A full year!' };
function streakScreen(up, then) {
  stopTimer();
  const head = STREAK_WORDS[up.to] || `${up.to} days in a row!`;
  const sub = up.to === 1 ? 'Play a daily tomorrow to make it two.'
    : up.record ? `A new personal best. Come back tomorrow for ${up.to + 1}.` : `Come back tomorrow to make it ${up.to + 1}.`;
  const sparks = Array.from({ length: 12 }, (_, i) => `<i style="--x:${Math.round(Math.sin(i * 2.4) * 70)}px;--d:${(i % 6) * .12 + .9}s;--s:${4 + (i % 3) * 2}px"></i>`).join('');
  show(`<section class="sk" role="dialog" aria-label="Streak">
      <div class="sk-fire" id="skFire">
        <div class="sk-glow"></div>
        <div class="sk-sparks">${sparks}</div>
        <svg class="sk-flame" viewBox="0 0 120 150" aria-hidden="true">
          <defs>
            <linearGradient id="skOuter" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff3d2e"/><stop offset=".55" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ffc53d"/></linearGradient>
            <linearGradient id="skInner" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffb12e"/><stop offset=".6" stop-color="#ffe066"/><stop offset="1" stop-color="#fff8d6"/></linearGradient>
          </defs>
          <g class="sk-outer"><path fill="url(#skOuter)" d="M60 4C65 32 93 47 97 85c4 37-15 60-37 60S20 124 23 91c2-23 16-31 18-52 10 10 13 19 13 28 9-15 9-37 6-63z"/></g>
          <g class="sk-inner"><path fill="url(#skInner)" d="M60 62c4 20 21 31 21 52 0 18-10 27-21 27s-21-9-21-25c0-14 10-21 12-33 5 7 7 12 7 17 4-10 4-23 2-38z"/></g>
        </svg>
        <div class="sk-num" aria-live="polite"><span class="sk-old">${up.from}</span><span class="sk-new">${up.to}</span></div>
      </div>
      <h2 class="sk-head">${esc(head)}</h2>
      <p class="sk-sub"><b>${up.to}-day streak</b>${up.from ? ` <span class="muted">· up from ${up.from}</span>` : ''}</p>
      <p class="muted">${esc(sub)}</p>
      <button class="btn primary" id="skGo">See your day</button>
    </section>`);
  const fire = $('#skFire');
  const light = () => { if (!fire.isConnected) return; fire.classList.add('lit'); buzz([30, 40, 60]); sfx.play('whoosh'); sfx.play('fanfare', undefined, .25); };
  if (calm()) light(); else setTimeout(light, 750);
  $('#skGo').onclick = then;
}

// A signed-in player's streak lives on their account, so it follows them between devices.
function adoptStreak(srv) {
  if (!srv || !srv.last) return;
  const s = store.get('outlier.streak', { n: 0, last: '', best: 0 }) || {};
  if (srv.last > (s.last || '') || (srv.last === s.last && srv.n >= (s.n || 0))) store.set('outlier.streak', { n: srv.n, last: srv.last, best: Math.max(srv.best || 0, s.best || 0) });
}

function dailySummary(run) {
  const { saved } = run, max = saved.results.length * 100;
  const squares = saved.results.map(r => SQUARES[tierOf(r)]).join('');
  const label = saved.label || run.day.label;
  if (run.archive) return archiveSummary(run, squares, max);
  show(`<header class="bar"><button class="link" id="back">‹ Back</button><span>${esc(label)} #${saved.number}</span><span></span></header>
    <div class="total">${saved.total}<small> / ${max * 1.5} paces</small></div>
    <div class="squares">${squares}</div>
    <p class="beatline" id="beat"></p>
    ${streakNow().n ? `<p class="streakline">${ic('flame')}<b>${streakNow().n}-day streak</b>${streakNow().n > 1 ? ' · keep it going tomorrow' : ' · come back tomorrow to build it'}</p>` : ''}
    ${remindRowHTML()}
    <div class="card">${trailHTML([{ name: 'You', from: 0, to: saved.total, me: true }], max)}
      <p class="zone">You ended up: ${zoneName(saved.total, max)}</p></div>
    <div class="sidecol"><div><ul class="rows card">${saved.results.map((r, i) => ansRowHTML(r, r.promptId || ((run.day && run.day.prompts[i]) || {}).id)).join('')}</ul>${ANS_HINT}</div>
    <div id="lb"></div><div id="myLeagues"></div></div>
    <div class="card seed">
      <label for="who">Your name on today's leaderboard</label>
      <input type="text" id="who" maxlength="16" placeholder="Your name" value="${esc(store.get('outlier.name', ''))}" autocomplete="off">
      <button class="btn" id="setname">Save name</button>
    </div>
    <div class="stack">
      <button class="btn primary" id="share">Share result</button>
      <button class="btn" id="free">Play a quick game</button>
      <button class="btn slim" id="pastDaily">${ic('calendar')}<span>Play a past daily</span>${limited() ? PLUSTAG : ''}</button>
    </div>
    <p class="muted center">New prompts tomorrow.</p>`);
  $('#pastDaily').onclick = archiveScreen;
  const draw = b => {
    if ($('#lb')) $('#lb').innerHTML = leaderboardHTML(b, 'Today');
    if ($('#beat')) $('#beat').innerHTML = beatLine(b);
  };
  postDaily(run, store.get('outlier.name', '') || 'Player').then(b => { draw(b); checkBadges(); dailyLeagues(); });
  $('#setname').onclick = async () => {
    const name = $('#who').value.trim().slice(0, 16);
    if (!name) return toast('Type a name first');
    store.set('outlier.name', name);
    draw(await postDaily(run, name));
    toast('Saved');
  };
  $('#back').onclick = soloMenu;
  $('#free').onclick = () => startGame();
  remindWire();
  $('#share').onclick = () => shareText(`Outlier · ${label} #${saved.number}\n${saved.total}/${max * 1.5} paces from the crowd\n${squares}`);
}

// ------------------------------------------------------------ the daily archive (Outlier Plus)
// Every past Daily seven · Everything, replayable. Archive games never move the streak or touch a leaderboard;
// results live in this browser under outlier.archive.<date>.
const PLUSTAG = '<span class="plustag">Plus</span>';
const ARCHROW = () => `<button class="archrow" id="archRow">${ic('calendar')}<span>Missed a day? <b>Daily archive</b></span>${limited() ? PLUSTAG : ''}${ic('right', 'chev')}</button>`;

async function archiveScreen() {
  stopTimer();
  show(`${topbar('Daily archive')}
    <p class="fine">${ic('calendar')}<span>Every past Daily seven · Everything. Archive games don't count for your streak or the leaderboard.</span></p>
    <div id="archList"><p class="muted center">Loading…</p></div>`);
  $('#back').onclick = soloMenu;
  let list;
  try { list = await api('/api/archive'); }
  catch (e) { if ($('#archList')) $('#archList').innerHTML = `<p class="muted center">Couldn't load the archive. ${esc(e.message)}</p>`; return; }
  if (!$('#archList')) return;
  const when = d => new Date(d + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('#archList').innerHTML = !list.days.length ? '<section class="card center"><p class="muted">No past dailies yet. Come back tomorrow!</p></section>'
    : `<ul class="card archlist">${list.days.map(d => {
      const s = store.get('outlier.archive.' + d.day);
      const right = s && s.done ? `<span class="num">${s.total}</span>` : `<span class="arch-play">${s && s.results && s.results.length ? 'Resume' : 'Play'}</span>`;
      return `<li><button class="arch-day${s && s.done ? ' done' : ''}" data-d="${d.day}"><span class="arch-n">#${d.number}</span>
        <span class="main"><b>${esc(when(d.day))}</b>${s && s.done ? '<small>Played</small>' : ''}</span>${limited() ? PLUSTAG : right}</button></li>`; }).join('')}</ul>`;
  $('#archList').onclick = e => {
    const b = e.target.closest('[data-d]');
    if (b) limited() ? upsellScreen('Past dailies are part of Outlier Plus') : startArchive(b.dataset.d);
  };
}

async function startArchive(date) {
  let day;
  try { day = await api(`/api/daily?cat=all&date=${encodeURIComponent(date)}`); }
  catch (e) { return e.status === 402 ? upsellScreen(e.message) : toast(e.message); }
  const key = 'outlier.archive.' + day.date;
  let saved = store.get(key);
  if (!saved || !Array.isArray(saved.results)) saved = { date: day.date, number: day.number, label: day.label, results: [], done: false, total: 0 };
  const run = { day, key, saved, archive: true };
  if (saved.done) return dailySummary(run);
  if (saved.results.length) return dailyQuestion(run);
  intro(`Daily seven #${day.number}`, `Archive · ${day.prompts.length} prompts · ${Math.round(day.roundMs / 1000)} seconds each`, () => dailyQuestion(run));
}

function archiveSummary(run, squares, max) {
  const { saved } = run;
  show(`<header class="bar"><button class="link" id="back">‹ Archive</button><span>Daily #${saved.number} · archive</span><span></span></header>
    <div class="total">${saved.total}<small> / ${max * 1.5} paces</small></div>
    <div class="squares">${squares}</div>
    <div class="card">${trailHTML([{ name: 'You', from: 0, to: saved.total, me: true }], max)}
      <p class="zone">You ended up: ${zoneName(saved.total, max)}</p></div>
    <div class="sidecol"><div><ul class="rows card">${saved.results.map((r, i) => ansRowHTML(r, r.promptId || ((run.day && run.day.prompts[i]) || {}).id)).join('')}</ul>${ANS_HINT}</div></div>
    <p class="fine center">${ic('trophy')}<span>Archive games don't count for the leaderboard.</span></p>
    <div class="stack">
      <button class="btn primary" id="share">Share result</button>
      <button class="btn" id="more">Back to the archive</button>
    </div>`);
  $('#back').onclick = $('#more').onclick = archiveScreen;
  $('#share').onclick = () => shareText(`Outlier · Daily seven #${saved.number} (archive)\n${saved.total}/${max * 1.5} paces from the crowd\n${squares}`);
}

// ------------------------------------------------------------ seven-prompt games
// Every game has a seed (its prompts' codes). Sharing the seed lets a friend play the same seven
// prompts; the link carries your name and per-prompt points so they can see what they have to beat.

// The last few category picks, newest first, so regulars can start in one tap.
function rememberPick(p) {
  const key = r => JSON.stringify(selsOf(upgradePick(r)).map(([c, t]) => [c, [...t].sort()]).sort());
  const list = store.get('outlier.recent', []).filter(r => key(r) !== key(p));
  store.set('outlier.recent', [JSON.parse(JSON.stringify(p)), ...list].slice(0, 3));
}

async function startGame(opts = {}) {
  if (!opts.seed) rememberPick(pick);
  const seen = store.get('outlier.seen', []);
  let game;
  try {
    game = await api(opts.seed ? `/api/game?seed=${encodeURIComponent(opts.seed)}`
      : `/api/game?${apiQuery(pick)}&exclude=${encodeURIComponent(seen.join(','))}`);
  } catch (e) { return toast(e.message); }
  const ids = game.prompts.map(p => p.id);
  store.set('outlier.seen', [...seen.filter(id => !ids.includes(id)), ...ids].slice(-300));
  if (opts.rival) game.label = `${opts.rival.name}'s challenge`;
  const run = { game, rival: opts.rival || null, results: [] };
  intro(opts.rival ? game.label : `Quick game · ${game.label}`,
    `${game.prompts.length} prompts · ${Math.round(game.roundMs / 1000)} seconds each${opts.rival ? ` · beat ${opts.rival.name}` : ''}`, () => gameQuestion(run));
}

function gameQuestion(run) {
  const { game, results, rival } = run, i = results.length, n = game.prompts.length;
  const theirs = rival ? rival.points.slice(0, i).reduce((a, b) => a + b, 0) : 0;
  const header = `<header class="bar"><button class="link" id="quit">✕ Quit</button>
    <span>${esc(game.label)} · ${i + 1}/${n}</span><span class="pill">${sum(results)}${rival ? ` v ${theirs}` : ''}</span></header>`;
  ask(game.prompts[i], game.roundMs, header, res => {
    const before = sum(results);
    results.push({ prompt: res.prompt, promptId: res.promptId, given: res.given, canonical: res.canonical, valid: res.valid, points: res.points, outlier: res.outlier });
    const total = sum(results), done = results.length >= n, max = n * 100;
    const lanes = [{ name: 'You', from: before, to: total, me: true }];
    if (rival) lanes.push({ name: rival.name, from: theirs, to: theirs + (rival.points[i] || 0) });
    show(`<header class="bar"><span></span><span>${esc(game.label)} · ${i + 1}/${n}</span><span></span></header>
      <p class="muted center">${esc(res.prompt)}</p>
      ${resultHTML(res)}
      <div class="after wait">
        ${rival ? `<p class="center vs">${esc(rival.name)} scored <b>+${rival.points[i] || 0}</b> here</p>` : ''}
        <div class="card">${trailHTML(lanes, max)}</div>
        ${outlierHTML(res.board.filter(b => b.outlier), res.canonical)}
        ${voteHTML(res.promptId)}
        <button class="btn primary" id="next">${done ? 'See your score' : 'Next prompt'}</button>
      </div>`);
    buildUp(res);
    $('#next').onclick = () => done ? gameSummary(run) : gameQuestion(run);
  });
  $('#quit').onclick = soloMenu;
}

// ---- the main menu leaderboard: the Daily seven · Everything, open to anyone. Today, this week (total of each day's
// score, Monday to Sunday) or all time (each player's best single day).
const BOARD_TABS = [['today', 'Today'], ['week', 'This week'], ['all', 'All time']];
const BOARD_NOTES = {
  today: 'Same seven prompts for everyone. A new board starts at midnight.',
  week: "Every Daily seven you play this week adds to your total. Resets on Monday.",
  all: 'Your best ever Daily seven score counts.' };
const longDate = (d, o) => new Date(d + 'T12:00').toLocaleDateString('en-GB', o);
// The note under a name: days played this week, or the day of an all-time best
const boardExtra = period => r => period === 'week' ? `${r.days} ${r.days === 1 ? 'day' : 'days'}` : period === 'all' && r.day ? longDate(r.day, { day: 'numeric', month: 'short' }) : '';
const boardWhen = b => b.period === 'today' ? `#${b.number} · ${longDate(b.date, { weekday: 'long', day: 'numeric', month: 'long' })}`
  : b.period === 'week' ? `${longDate(b.from, { weekday: 'short', day: 'numeric', month: 'short' })} to ${longDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}`
  : `Since ${longDate(b.from, { day: 'numeric', month: 'long', year: 'numeric' })}`;
const tabsHTML = period => `<div class="seg lb-tabs" id="lbTabs">${BOARD_TABS.map(([k, l]) => `<button class="chip${k === period ? ' on' : ''}" data-p="${k}" aria-pressed="${k === period}">${l}</button>`).join('')}</div>`;
// Everyone (the public board) or Your leagues; the leaderboard button reopens whichever was last
const viewHTML = v => `<div class="seg lb-view" id="lbView">${[['all', 'Everyone'], ['leagues', 'Leagues'], ['chal', 'Challenges']].map(([k, l]) =>
  `<button class="chip${k === v ? ' on' : ''}" data-v="${k}" aria-pressed="${k === v}">${l}</button>`).join('')}</div>`;
function wireView(v) {
  $('#lbView').onclick = e => {
    const b = e.target.closest('[data-v]');
    if (!b || b.dataset.v === v) return;
    store.set('outlier.boardView', b.dataset.v);
    b.dataset.v === 'leagues' ? leaguesMenu() : b.dataset.v === 'chal' ? challengesMenu() : boardMenu();
  };
}

async function boardMenu(period = store.get('outlier.boardTab', 'today')) {
  stopTimer();
  if (store.get('outlier.boardView') === 'leagues') return leaguesMenu();
  if (store.get('outlier.boardView') === 'chal') return challengesMenu();
  if (!BOARD_TABS.some(t => t[0] === period)) period = 'today';
  store.set('outlier.boardTab', period);
  show(`${topbar('Leaderboard')}
    ${viewHTML('all')}
    <section class="card lb-head"><span class="mode-ic">${ic('trophy')}</span><div><b>Daily seven · Everything</b><small id="lbWhen">${period === 'today' ? 'Today' : period === 'week' ? 'This week' : 'All time'}</small></div></section>
    ${tabsHTML(period)}
    <div id="lbBody"><p class="muted center">Loading…</p></div>
    <div class="stack"><button class="btn primary" id="lbPlay">${ic('calendar')}<span>Play today's Daily seven</span></button></div>
    <p class="fine center">${BOARD_NOTES[period]}</p>`);
  $('#back').onclick = home;
  wireView('all');
  $('#lbPlay').onclick = () => startDaily('all');
  $('#lbTabs').onclick = e => { const b = e.target.closest('[data-p]'); if (b && b.dataset.p !== period) boardMenu(b.dataset.p); };
  try {
    const b = await api(`/api/dailyboard?cid=${playerId()}&period=${period}`);
    if (!$('#lbBody') || store.get('outlier.boardTab') !== period) return;
    $('#lbWhen').textContent = boardWhen(b);
    $('#lbBody').innerHTML = b.count ? leaderboardHTML(b, period === 'today' ? "Today's" : period === 'week' ? "This week's" : 'All-time', boardExtra(period))
      : `<section class="card center"><p class="muted">${period === 'today' ? 'No scores yet today. Be the first on the board!' : 'No scores yet. Play the Daily seven to get on the board!'}</p></section>`;
    if (period === 'today' && b.top.some(r => r.me)) $('#lbPlay').querySelector('span').textContent = 'See today\'s Daily seven';
  } catch (e) {
    if ($('#lbBody')) $('#lbBody').innerHTML = `<p class="muted center">Couldn't load the leaderboard. ${esc(e.message)}</p>`;
  }
}

// ---- challenge leaderboard: everyone who plays the same seven prompts is ranked together
function playerId() {
  let id = store.get('outlier.cid', '');
  if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join(''); store.set('outlier.cid', id); }
  return id;
}

function leaderboardHTML(b, title = '', extra = () => '', tail = '') {
  if (!b || (!b.count && !tail)) return '';
  return `<section class="card"><h3>${title ? title + ' ' : ''}leaderboard <small>${b.count} ${b.count === 1 ? 'player' : 'players'}</small></h3>
    <ol class="rows lb">${b.top.map((r, i) => { const sub = [r.me ? 'You' : '', extra(r)].filter(Boolean).join(' · ');
      return `<li class="${r.me ? 'me' : ''}${(r.rank || i + 1) <= 3 ? ` top${r.rank || i + 1}` : ''}"><span class="num rank">${r.rank || i + 1}</span>
      <span class="main"><b>${esc(r.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="num">${r.total}</span></li>`; }).join('')}${tail}</ol></section>`;
}

// "You beat 80% of today's players", from your rank on a leaderboard
function beatLine(b) {
  if (!b || !b.rank || b.count < 2) return '';
  const pct = Math.round((b.count - b.rank) / (b.count - 1) * 100);
  return b.rank === 1 ? `${ic('trophy')}<span><b>Top of the board!</b> You beat all ${b.count - 1} other ${b.count === 2 ? 'player' : 'players'} today</span>`
    : `${ic('trophy')}<span>You beat <b>${pct}%</b> of today's players <small>(#${b.rank} of ${b.count})</small></span>`;
}

// ---- friends leagues: the Daily seven · Everything board for just your group, from the same scores as the public one
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const memberCount = n => `${n} ${n === 1 ? 'member' : 'members'}`;
const playedDaily = () => { const s = store.get('outlier.daily.all'); return !!(s && s.date === todayStr() && s.done); };
const leagueRowsHTML = list => `<ul class="archlist lg-list">${list.map(l => `<li><button class="arch-day" data-c="${esc(l.code)}">
  <span class="lg-ic">${ic(l.owner ? 'crown' : 'users')}</span><span class="main"><b>${esc(l.name)}</b><small>${memberCount(l.members)}</small></span>
  ${l.rank ? `<span class="num">${ordinal(l.rank)}<small>of ${l.members}</small></span>` : '<span class="lg-not">Not played</span>'}${ic('right', 'chev')}</button></li>`).join('')}</ul>`;

async function leaguesMenu() {
  stopTimer();
  show(`${topbar('Leaderboard')}
    ${viewHTML('leagues')}
    <div id="lgList"><p class="muted center">Loading…</p></div>
    <div class="stack">
      <button class="btn slim" id="lgNew">${ic('plus')}<span>Create a league</span></button>
      <button class="btn slim" id="lgCode">${ic('link')}<span>Join with a code</span></button>
    </div>
    <p class="fine center">Free for everyone. Up to 50 friends per league, and you can be in 10.</p>`);
  $('#back').onclick = home;
  wireView('leagues');
  $('#lgNew').onclick = leagueCreateSheet;
  $('#lgCode').onclick = () => leagueCodeSheet();
  let list;
  try { list = await api(`/api/league/mine?cid=${playerId()}`); }
  catch (e) { if ($('#lgList')) $('#lgList').innerHTML = `<p class="muted center">Couldn't load your leagues. ${esc(e.message)}</p>`; return; }
  if (!$('#lgList')) return;
  if (!list.length) {
    $('#lgList').innerHTML = `<section class="card lb-head"><span class="mode-ic">${ic('users')}</span><div><b>Beat your friends, not just the crowd</b>
      <small>Make a league, send the link, and get a private leaderboard for the Daily seven: today, this week and all time.</small></div></section>`;
    $('#lgNew').classList.add('primary');
    return;
  }
  $('#lgList').innerHTML = `<section class="card lg-card">${leagueRowsHTML(list)}</section>`;
  $('#lgList').onclick = e => { const b = e.target.closest('[data-c]'); if (b) leaguePage(b.dataset.c); };
}

// A small form in a sheet; submit(values) returns once it's done (or throws, which toasts)
function leagueSheet(title, fields, label, submit) {
  const close = openSheet(title, () => `<form id="lgForm" class="stack">${fields.map(f => `<div class="field"><label for="${f.id}">${f.label}</label>
    <input type="text" id="${f.id}" maxlength="${f.max}" placeholder="${esc(f.ph)}" value="${esc(f.value || '')}" autocomplete="off"${f.code ? ' class="code" autocapitalize="characters"' : ''}></div>`).join('')}
    <button class="btn primary">${label}</button></form>`, () => {});
  const form = $('#lgForm');
  (fields.find(f => !f.value) ? $('#' + fields.find(f => !f.value).id) : form.querySelector('input')).focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const vals = Object.fromEntries(fields.map(f => [f.id, $('#' + f.id).value.trim()]));
    const empty = fields.find(f => !vals[f.id]);
    if (empty) { $('#' + empty.id).focus(); return toast(empty.need); }
    form.querySelector('button').disabled = true;
    try { await submit(vals); close(); } catch (err) { toast(err.message); form.querySelector('button').disabled = false; }
  };
}
const youField = () => ({ id: 'lgYou', label: 'Your name in the league', max: 16, ph: 'What should your friends call you?', value: store.get('outlier.name', ''), need: 'Enter your name' });

function leagueCreateSheet() {
  leagueSheet('Create a league', [{ id: 'lgName', label: 'League name', max: 30, ph: 'The Pub Quiz Lot', need: 'Give your league a name' }, youField()],
    'Create league', async v => {
      store.set('outlier.name', v.lgYou);
      const r = await api('/api/league/create', { cid: playerId(), name: v.lgName, you: v.lgYou });
      leaguePage(r.code, 'today', true);
    });
}

function leagueCodeSheet() {
  leagueSheet('Join a league', [{ id: 'lgJoinCode', label: 'League code', max: 6, ph: 'CODE', code: true, need: 'Enter the 6-character code' }, youField()],
    'Join league', async v => {
      store.set('outlier.name', v.lgYou);
      const r = await api('/api/league/join', { code: v.lgJoinCode, cid: playerId(), you: v.lgYou });
      toast(`You're in ${r.name}`);
      leaguePage(r.code, 'today');
    });
}

const leagueInvite = (code, name) => shareText(`Join my Outlier league '${name}' — same 7 prompts every day, see who's furthest from the crowd`,
  `${location.origin}/?league=${code}`);

// The ?league=CODE invite: join (with your name) or, if you're already in, straight to the board
function leagueJoinScreen(info) {
  stopTimer();
  const full = info.size >= info.max;
  show(`${topbar('Join a league')}
    <section class="card choice lead">
      <div class="choice-h"><span class="mode-ic">${ic('users')}</span><div><b>Join ‘${esc(info.name)}’?</b><small>${memberCount(info.size)} · a private leaderboard for the Daily seven</small></div></div>
      ${full ? '<p class="muted">This league is full.</p>' : `<div class="field"><label for="lgYou">Your name in the league</label>
        <input type="text" id="lgYou" maxlength="16" placeholder="What should your friends call you?" value="${esc(store.get('outlier.name', ''))}" autocomplete="nickname"></div>
      <button class="btn primary" id="lgJoin">Join league</button>`}
      <button class="btn slim" id="lgNo">Not now</button>
    </section>
    <p class="fine center">Same seven prompts for everyone, every day. Leagues are free.</p>`);
  $('#back').onclick = home;
  $('#lgNo').onclick = home;
  if (full) return;
  $('#lgJoin').onclick = async () => {
    const you = $('#lgYou').value.trim();
    if (!you) { $('#lgYou').focus(); return toast('Enter your name'); }
    store.set('outlier.name', you);
    try { await api('/api/league/join', { code: info.code, cid: playerId(), you }); leaguePage(info.code, 'today'); }
    catch (e) { toast(e.message); }
  };
}

async function leaguePage(code, period = store.get('outlier.leagueTab', 'today'), fresh = false) {
  stopTimer();
  if (!BOARD_TABS.some(t => t[0] === period)) period = 'today';
  store.set('outlier.leagueTab', period);
  let b;
  try { b = await api(`/api/league/board?code=${encodeURIComponent(code)}&cid=${playerId()}&period=${period}`); }
  catch (e) { toast(e.message); return e.status === 404 ? leaguesMenu() : null; }
  if (!b.member) return leagueJoinScreen(b);
  const played = (b.members.find(m => m.me) || {}).played || playedDaily();
  const wait = b.period === 'today' ? b.members.filter(m => !m.played) : [];
  const tail = wait.map(m => `<li class="off${m.me ? ' me' : ''}"><span class="num rank">–</span><span class="main"><b>${esc(m.name)}</b>
    <small>${m.me ? 'You · ' : ''}Not played yet today</small></span><span class="num">–</span></li>`).join('');
  const board = leaderboardHTML(b, period === 'today' ? "Today's" : period === 'week' ? "This week's" : 'All-time', boardExtra(period), tail)
    || `<section class="card center"><p class="muted">No scores yet. Play the Daily seven to get on the board!</p></section>`;
  show(`${topbar('League')}
    <section class="card lb-head"><span class="mode-ic">${ic(b.owner ? 'crown' : 'users')}</span><div class="lg-head"><b>${esc(b.name)}</b>
      <small>${memberCount(b.size)} · code <b class="lg-code">${esc(b.code)}</b> · ${boardWhen(b)}</small></div>
      ${b.owner ? '<button class="link lg-ren" id="lgRename">Rename</button>' : ''}</section>
    ${fresh ? `<p class="fine">${ic('share')}<span>Your league is ready. Send your friends the link so they can join.</span></p>` : ''}
    ${tabsHTML(period)}
    ${board}
    <div class="stack">
      ${played ? '' : `<button class="btn primary" id="lgPlay">${ic('calendar')}<span>Play today's Daily seven</span></button>`}
      <button class="btn${played ? ' primary' : ''}" id="lgInvite">Invite friends</button>
      <button class="btn slim lg-leave" id="lgLeave"><span>Leave league</span></button>
    </div>
    <p class="fine center">${BOARD_NOTES[period]}</p>`);
  $('#back').onclick = () => { store.set('outlier.boardView', 'leagues'); leaguesMenu(); };
  $('#lbTabs').onclick = e => { const t = e.target.closest('[data-p]'); if (t && t.dataset.p !== period) leaguePage(b.code, t.dataset.p); };
  $('#lgInvite').onclick = () => leagueInvite(b.code, b.name);
  if ($('#lgPlay')) $('#lgPlay').onclick = () => startDaily('all');
  if ($('#lgRename')) $('#lgRename').onclick = () => leagueSheet('Rename league', [{ id: 'lgName', label: 'League name', max: 30, ph: 'The Pub Quiz Lot', value: b.name, need: 'Give your league a name' }],
    'Save', async v => { await api('/api/league/rename', { code: b.code, cid: playerId(), name: v.lgName }); leaguePage(b.code, period); });
  $('#lgLeave').onclick = async e => {
    const btn = e.currentTarget;
    if (!btn.dataset.sure) {   // a second tap confirms
      btn.dataset.sure = '1';
      btn.classList.add('sure');
      btn.querySelector('span').textContent = b.size === 1 ? 'Tap again: the league will be deleted' : 'Tap again to leave';
      return;
    }
    try { await api('/api/league/leave', { code: b.code, cid: playerId() }); toast(`You left ${b.name}`); store.set('outlier.boardView', 'leagues'); leaguesMenu(); }
    catch (err) { toast(err.message); }
  };
}

// On the daily results: where you stand in each of your leagues today (or a nudge to start one)
async function dailyLeagues() {
  let list;
  try { list = await api(`/api/league/mine?cid=${playerId()}`); } catch { return; }
  const el = $('#myLeagues');
  if (!el) return;
  el.innerHTML = list.length ? `<section class="card lg-card"><h3>Your leagues <small>today</small></h3>${leagueRowsHTML(list)}</section>`
    : `<button class="archrow" data-new>${ic('users')}<span>Beat your friends, not just the crowd: <b>start a league</b></span>${ic('right', 'chev')}</button>`;
  el.onclick = e => {
    const b = e.target.closest('[data-c]');
    if (b) return leaguePage(b.dataset.c, 'today');
    if (e.target.closest('[data-new]')) { store.set('outlier.boardView', 'leagues'); leaguesMenu(); }
  };
}

async function postDaily(run, name) {
  try {
    return await api('/api/score', { seed: run.day.seed, cid: playerId(), name, points: run.saved.results.map(r => r.points) });
  } catch { return null; }
}

async function postScore(run, name) {
  try {
    return await api('/api/score', { seed: run.game.seed, cid: playerId(), name, points: run.results.map(r => r.points) });
  } catch { return null; }   // the leaderboard is a bonus; never block the game on it
}

// ---- challenges you've sent or played, kept on this device so their leaderboards can be checked later
function rememberChallenge(run, extra = {}) {
  const list = store.get('outlier.challenges', []), old = list.find(c => c.seed === run.game.seed) || {};
  const rec = { ...old, seed: run.game.seed, from: run.rival ? run.rival.name : (old.from || ''), at: old.at || Date.now(),
    pts: run.results.map(r => r.points), ...extra };
  store.set('outlier.challenges', [rec, ...list.filter(c => c.seed !== rec.seed)].slice(0, 30));
}
const challengeTitle = c => c.from ? `${c.from}'s challenge` : 'Your challenge';
const shortDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

async function challengesMenu() {
  stopTimer();
  const list = store.get('outlier.challenges', []);
  show(`${topbar('Leaderboard')}
    ${viewHTML('chal')}
    <div id="chList">${list.length ? '<p class="muted center">Loading…</p>' : `<section class="card lb-head"><span class="mode-ic">${ic('share')}</span><div><b>See how your friends did</b>
      <small>Finish a quick game, tap Send challenge, and everyone who plays your link lands on its own leaderboard. Challenges friends send you show up here too.</small></div></section>`}</div>
    <div class="stack"><button class="btn${list.length ? '' : ' primary'}" id="chPlay"><span>Play a quick game</span></button></div>
    <p class="fine center">Challenges you've played or sent from this device.</p>`);
  $('#back').onclick = home;
  wireView('chal');
  $('#chPlay').onclick = soloMenu;
  if (!list.length) return;
  let got = [];
  try { got = await api(`/api/boards?seeds=${list.map(c => c.seed).join(',')}&cid=${playerId()}`); }
  catch (e) { if ($('#chList')) $('#chList').innerHTML = `<p class="muted center">Couldn't load your challenges. ${esc(e.message)}</p>`; return; }
  if (!$('#chList')) return;
  const by = Object.fromEntries(got.map(b => [b.seed, b]));
  $('#chList').innerHTML = `<section class="card lg-card"><ul class="archlist lg-list">${list.map(c => { const b = by[c.seed] || { count: 0 };
    const sub = [shortDate(c.at), `${b.count} ${b.count === 1 ? 'player' : 'players'}`, b.lead && !b.lead.me ? `${b.lead.name} leads` : ''].filter(Boolean).join(' · ');
    return `<li><button class="arch-day" data-s="${esc(c.seed)}"><span class="lg-ic">${ic(c.from ? 'users' : 'crown')}</span>
      <span class="main"><b>${esc(challengeTitle(c))}</b><small>${esc(sub)}</small></span>
      ${b.rank ? `<span class="num">${ordinal(b.rank)}<small>of ${b.count}</small></span>` : '<span class="lg-not">Not played</span>'}${ic('right', 'chev')}</button></li>`; }).join('')}</ul></section>`;
  $('#chList').onclick = e => { const b = e.target.closest('[data-s]'); if (b) challengeBoard(b.dataset.s); };
}

// One challenge's full leaderboard: everyone who has played that link
async function challengeBoard(seed) {
  stopTimer();
  const c = store.get('outlier.challenges', []).find(x => x.seed === seed) || { seed, from: '' };
  show(`${topbar('Challenge')}<p class="muted center">Loading…</p>`);
  $('#back').onclick = challengesMenu;
  let b;
  try { b = await api(`/api/board?seed=${encodeURIComponent(seed)}&cid=${playerId()}&size=50`); }
  catch (e) { toast(e.message); return challengesMenu(); }
  const mine = c.pts && c.pts.length ? c.pts.reduce((x, y) => x + y, 0) : null;
  show(`${topbar('Challenge')}
    <section class="card lb-head"><span class="mode-ic">${ic('trophy')}</span><div class="lg-head"><b>${esc(challengeTitle(c))}</b>
      <small>${c.at ? `${shortDate(c.at)} · ` : ''}${b.count} ${b.count === 1 ? 'player' : 'players'}${b.rank ? ` · you're ${ordinal(b.rank)}` : ''}</small></div></section>
    ${leaderboardHTML(b) || `<section class="card center"><p class="muted">No one's played this one yet.</p></section>`}
    <div class="stack">
      ${b.rank ? (mine !== null ? '<button class="btn primary" id="chSend">Send it to more friends</button>' : '')
        : `<button class="btn primary" id="chGo">Play the challenge<small>Same 7 prompts, 30 seconds each</small></button>`}
      <button class="btn slim" id="chRefresh"><span>Refresh</span></button>
    </div>
    <p class="fine center">Everyone who plays this link is ranked here.</p>`);
  $('#back').onclick = () => { store.set('outlier.boardView', 'chal'); challengesMenu(); };
  $('#chRefresh').onclick = () => challengeBoard(seed);
  if ($('#chGo')) $('#chGo').onclick = () => startGame({ seed, rival: c.from ? { name: c.from, points: [] } : null });
  if ($('#chSend')) $('#chSend').onclick = () => {
    const name = store.get('outlier.name', '') || 'A friend';
    const run = { game: { seed }, results: c.pts.map(points => ({ points })) };
    shareText(`I scored ${mine} on Outlier\nCan you beat me?`, challengeLink(run, name));
  };
}

// A challenge link: /c/<name>/<seed><two base-36 characters of points per prompt>
function challengeLink(run, name) {
  const who = encodeURIComponent(name.replace(/\s+/g, '_'));
  return `${location.origin}/c/${who}/${run.game.seed}${run.results.map(r => Math.min(150, r.points).toString(36).padStart(2, '0')).join('')}`;
}

function readChallenge(path) {
  const [, , who = '', token = ''] = path.split('/');
  const name = decodeURIComponent(who).replace(/_/g, ' ');
  if (token.length && token.length % 6 === 0) {   // seed (4 characters a prompt) then points (2 a prompt)
    const k = token.length / 6, pts = token.slice(4 * k);
    return { seed: token.slice(0, 4 * k), from: name, pts: pts.match(/../g).map(x => Math.min(150, parseInt(x, 36) || 0)).join('.') };
  }
  const k = Math.floor(token.length / 5);   // older links: one rarity-tier digit a prompt
  if (!k) return null;
  const pts = [...token.slice(4 * k)].map(d => [0, 10, 25, 50, 75, 100][+d] || 0).join('.');
  return { seed: token.slice(0, 4 * k), from: name, pts };
}

function gameSummary(run) {
  const { results, rival, game } = run, total = sum(results), max = results.length * 100;
  const squares = results.map(r => SQUARES[tierOf(r)]).join('');
  const theirs = rival ? rival.points.reduce((a, b) => a + b, 0) : 0;
  const verdict = !rival ? '' : total > theirs ? `You beat ${esc(rival.name)} by ${total - theirs}!`
    : total < theirs ? `${esc(rival.name)} wins by ${theirs - total}.` : `Dead heat with ${esc(rival.name)}!`;
  const lanes = [{ name: 'You', from: 0, to: total, me: true }];
  if (rival) lanes.push({ name: rival.name, from: 0, to: theirs });
  show(`<header class="bar"><button class="link" id="back">‹ Back</button><span>${esc(game.label)}</span><span></span></header>
    <div class="total">${total}<small> / ${max * 1.5} paces</small></div>
    ${rival ? `<p class="center verdict">${verdict}</p>` : ''}
    <div class="squares">${squares}</div>
    <div class="card">${trailHTML(lanes, max)}
      <p class="zone">You ended up: ${zoneName(total, max)}</p></div>
    <div class="sidecol"><div><ul class="rows card">${results.map((r, i) => ansRowHTML(r, r.promptId || (game.prompts[i] || {}).id,
      rival ? `<small>${esc(rival.name)} +${rival.points[i] || 0}</small>` : '')).join('')}</ul>${ANS_HINT}</div>
    <div id="lb"></div></div>
    <div class="card seed">
      <label for="who">Challenge a friend on these 7 prompts</label>
      <input type="text" id="who" maxlength="16" placeholder="Your name" value="${esc(store.get('outlier.name', ''))}" autocomplete="off">
      <button class="btn primary" id="share">Send challenge</button>
      <p class="gamecode">Game code <code>${esc(game.seed)}</code></p>
      ${run.rival || store.get('outlier.challenges', []).some(c => c.seed === game.seed) ? `<button class="btn slim" id="chSee">${ic('trophy')}<span>Challenge leaderboard</span></button>` : ''}
    </div>
    <div class="stack"><button class="btn" id="again">New game</button></div>`);
  $('#back').onclick = soloMenu;
  $('#again').onclick = () => startGame();
  if ($('#chSee')) $('#chSee').onclick = () => challengeBoard(game.seed);
  if (!run.posted) {   // post once; later renders (and name changes) just update the same row
    run.posted = true;
    postScore(run, store.get('outlier.name', '') || 'Player').then(b => { run.board = b; if ($('#lb')) $('#lb').innerHTML = leaderboardHTML(b); });
    if (run.rival) rememberChallenge(run);
    checkBadges();
  } else if ($('#lb')) $('#lb').innerHTML = leaderboardHTML(run.board);
  $('#share').onclick = async () => {
    const name = $('#who').value.trim().slice(0, 16) || 'A friend';
    store.set('outlier.name', name);
    postScore(run, name).then(b => { run.board = b; if ($('#lb')) $('#lb').innerHTML = leaderboardHTML(b); });
    rememberChallenge(run);
    if (!$('#chNote')) $('#share').insertAdjacentHTML('afterend', `<p class="fine" id="chNote">${ic('trophy')}<span>Check how everyone does under <b>Leaderboard › Challenges</b></span></p>`);
    shareText(`I scored ${total} on Outlier ${squares}\nCan you beat me?`, challengeLink(run, name));
  };
}

// A challenge link: ?play=<seed>&from=<name>&pts=12.40.100...
function challengeIntro(seed, from, pts) {
  stopTimer();
  const known = store.get('outlier.challenges', []).find(c => c.seed === seed);   // played it already: straight to the standings
  if (known && known.pts) return challengeBoard(seed);
  const points = (pts || '').split('.').map(n => Math.max(0, Math.min(150, parseInt(n, 10) || 0)));
  const rival = from ? { name: from.slice(0, 16), points } : null;
  const total = rival ? points.reduce((a, b) => a + b, 0) : 0;
  show(`<div class="hero">
      <div class="logo">Outl<b>i</b>er</div>
      <p>${rival ? `<b>${esc(rival.name)}</b> scored <b>${total}</b> paces on 7 prompts.<br>Can you get further from the crowd?`
        : 'Someone sent you a quick game to play.'}</p>
      ${crowdHTML(3)}
    </div>
    <div class="stack">
      <button class="btn primary" id="go">Play the challenge<small>Same 7 prompts, 30 seconds each</small></button>
      <button class="btn" id="home">Not now</button>
    </div>`);
  $('#go').onclick = () => startGame({ seed, rival });
  $('#home').onclick = home;
  api(`/api/board?seed=${encodeURIComponent(seed)}&cid=${playerId()}`).then(b => {
    if (!b.count || !$('#go')) return;
    $('.hero').insertAdjacentHTML('afterend', leaderboardHTML({ ...b, top: b.top.slice(0, 5) }));
  }).catch(() => {});
}

// ------------------------------------------------------------ party

let party = null;

function partyMenu(code = '') {
  stopTimer();
  show(`${topbar('Party game', `<button class="iconbtn" id="tvBtn" aria-label="Use this device as the big screen" title="Big screen">${ic('tv')}</button>`)}
    <section class="field"><label for="name">Your name</label>
      <input type="text" id="name" maxlength="16" placeholder="What should everyone call you?" value="${esc(store.get('outlier.name', ''))}" autocomplete="nickname"></section>
    <section class="card choice${code ? '' : ' lead'}">
      <div class="choice-h"><span class="mode-ic">${ic('crown')}</span><div><b>Host a game</b><small>Get a room code${limited() ? '' : ', pick the category'}, start when everyone's in</small></div></div>
      <button class="btn${code ? '' : ' primary'}" id="create">Create a room</button>
      ${limited() ? `<p class="fine">${ic('users')}<span>Free rooms hold 4 players. Outlier Plus hosts up to 12.</span></p>` : ''}
    </section>
    <section class="card choice${code ? ' lead' : ''}">
      <div class="choice-h"><span class="mode-ic">${ic('users')}</span><div><b>Join a game</b><small>Enter the 4-letter code from the host's screen</small></div></div>
      <form id="join" class="row">
        <input type="text" id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" autocomplete="off" aria-label="Room code">
        <button class="btn${code ? ' primary' : ''}">Join</button>
      </form>
    </section>
    <section class="card choice tvbox" id="tvBox" hidden>
      <div class="choice-h"><span class="mode-ic">${ic('tv')}</span><div><b>Big screen</b><small>Show the game on this TV or laptop</small></div></div>
      <form id="tvJoin" class="row">
        <input type="text" id="tvCode" class="code" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off" aria-label="Room code for the big screen">
        <button class="btn">Show</button>
      </form>
    </section>`);
  const go = async (path, body) => {
    const name = $('#name').value.trim();
    if (!name) { $('#name').focus(); return toast('Enter a name first'); }
    store.set('outlier.name', name);
    try { const r = await api(path, { ...body, name, cid: playerId() }); enterParty(r.code, r.pid); } catch (e) { toast(e.message); }
  };
  $('#back').onclick = home;
  $('#tvBtn').onclick = () => { const box = $('#tvBox'); box.hidden = !box.hidden; if (!box.hidden) { box.scrollIntoView({ block: 'nearest' }); $('#tvCode').focus(); } };
  $('#create').onclick = () => go('/api/room/create', {});
  $('#join').onsubmit = e => { e.preventDefault(); go('/api/room/join', { code: $('#code').value.trim() }); };
  $('#tvJoin').onsubmit = e => { e.preventDefault(); sfx.start(); joinScreen($('#tvCode').value); };   // a click: sound can start now
}

function enterParty(code, pid) {
  store.set('outlier.party', { code, pid });
  party = { code, pid, key: null, busy: false, rounds: 5, secs: 30, mode: 'classic', lives: 3, turn: 10, fx: tvRevealFx };
  party.poll = setInterval(pollParty, 1000);
  pollParty();
  const look = store.get('outlier.look'), color = store.get('outlier.color'), emote = store.get('outlier.emote', '');
  if (look || emote) api('/api/room/look', { code, pid, look: look || '', emote }).catch(() => {});
  if (Number.isInteger(color)) api('/api/room/color', { code, pid, color }).catch(() => {});   // ignored if someone has it
}

function leaveParty(msg) {
  if (party) clearInterval(party.poll);
  party = null;
  music.sync();
  store.del('outlier.party');
  history.replaceState(null, '', location.pathname);
  home();
  if (msg) toast(msg);
}

// Every party request is numbered. A reply is only drawn if nothing sent after it has been drawn already, so a slow
// poll that set off before the round moved on can't put an old screen back up.
let partySeq = 0;

async function pollParty() {
  if (!party || party.busy) return;
  party.busy = true;
  try {
    const seq = ++partySeq;
    const state = await api(`/api/room/state?code=${party.code}&pid=${party.pid}`);
    if (party) renderParty(state, seq);
    const every = state.phase === 'potato' ? 500 : 1000;
    if (party && party.every !== every) { clearInterval(party.poll); party.poll = setInterval(pollParty, every); party.every = every; }
  } catch (e) {
    if (e.status === 404) return leaveParty('That room has closed');
  } finally { if (party) party.busy = false; }
}

async function partyPost(path, extra) {
  try {
    const seq = ++partySeq;
    const state = await api(path, { code: party.code, pid: party.pid, ...extra });
    if (party) renderParty(state, seq);
  } catch (e) { toast(e.message); }
}

function playersHTML(s) {
  const teams = s.phase === 'lobby' ? s.teamsOn : s.teams && s.mode !== 'potato';
  const swap = teams && s.phase === 'lobby' && s.you === s.host;
  const list = teams ? [...s.players].sort((a, b) => (a.team || 0) - (b.team || 0)) : s.players;
  return list.map(p => `<li class="${p.n === s.you ? 'me' : ''}${p.online ? '' : ' off'}${swap ? ' swap' : ''}"${swap ? ` data-swap="${p.n}" title="Tap to swap team"` : ''}>
    ${avatar(p.name, p.color, p.look)}
    <span class="main"><b>${esc(p.name)}</b>${p.n === s.you ? '<small>You</small>' : ''}</span>
    ${teams ? teamTag(p.team) : ''}
    ${p.n === s.host ? '<span class="tag">Host</span>' : ''}
    ${!p.online ? '<span class="tag">Away</span>'
      : s.phase === 'question' ? `<span class="tag">${p.answered ? 'Locked in' : 'Thinking'}</span>`
      : s.phase === 'pick' ? `<span class="tag">${p.picked ? 'Ready' : 'Deciding'}</span>`
      : s.phase !== 'final' && s.phase !== 'lobby' && s.doubles && p.doubleLeft ? '<span class="tag dbl">×2 left</span>' : ''}
  </li>`).join('');
}

// The live ticker: one avatar per player across the top of the question. Each one pops into colour the moment that
// player locks in, and the line below says who just did, so the room feels the pressure without seeing any answers.
function tickerHTML(s) {
  const live = s.players.filter(p => p.online || p.answered);
  const done = live.filter(p => p.answered).length;
  return `<div class="ticker" id="ticker" aria-live="polite">
    <div class="tick-avs">${live.map(p => `<span class="tick-av${p.answered ? ' in' : ''}${p.n === s.you ? ' me' : ''}" data-n="${p.n}" title="${esc(p.name)}">${avatar(p.name, p.color, p.look)}</span>`).join('')}</div>
    <p class="tick-line"><b>${done}</b> of ${live.length} locked in<span class="tick-news" id="tickNews"></span></p>
  </div>`;
}

function updateTicker(s) {
  const el = $('#ticker');
  if (!el) return;
  const was = party.locked || new Set();
  const now = new Set(s.players.filter(p => p.answered).map(p => p.n));
  const fresh = s.players.filter(p => now.has(p.n) && !was.has(p.n) && p.n !== s.you);
  party.locked = now;
  const news = $('#tickNews') ? $('#tickNews').textContent : '';
  el.outerHTML = tickerHTML(s).replace('class="ticker"', 'class="ticker settled"');   // no entrance animation on refresh
  const line = $('#tickNews');
  if (fresh.length) {
    line.textContent = ` · ${fresh.map(p => p.name).join(' & ')} just locked in`;
    fresh.forEach(p => { const a = $(`.tick-av[data-n="${p.n}"]`); if (a) a.classList.add('pop'); });
    buzz(15);
  } else line.textContent = news;
}

function renderParty(s, seq = Infinity) {
  if (seq !== Infinity) {
    if (seq < (party.applied || 0)) return;
    party.applied = seq;
  }
  const host = s.you === s.host;
  if (party.screens !== !!s.screens) { party.screens = !!s.screens; music.sync(); }   // a big screen in the room does the sounds; phones stay quiet
  const answered = s.phase === 'question' && s.yourAnswer != null;
  const key = [s.phase, s.round, host, answered, s.phase === 'pick' && s.picked, s.phase === 'final' && (s.asks || []).join('.'),
    s.phase === 'potato' && s.breakMs > 0].join('|');   // Fumble turns update in place (updatePotato)
  if (key !== party.key) {
    party.key = key;
    stopTimer();
    (party.revealTimers || []).forEach(clearTimeout);   // a reveal still playing must never draw over the new screen
    party.revealTimers = [];
    ({ lobby: partyLobby, pick: partyPick, question: partyQuestion, reveal: partyReveal, final: partyFinal, potato: partyPotato })[s.phase](s, host, answered);
    const leave = $('#leave');
    if (leave) leave.onclick = () => leaveParty();
  }
  if (s.phase === 'question') updateTicker(s); else party.locked = null;
  if (s.phase === 'potato') updatePotato(s);
  party.last = s;
  teamsUI(s);
  const sw = $('#colors');
  if (sw) sw.innerHTML = colorsHTML(s);
  if ($('#chMe')) {
    const me = s.players.find(p => p.n === s.you) || {};
    $('#chMe').innerHTML = avatar(me.name, me.color, me.look);
  }
  const list = $('#players');
  if (list) {
    list.innerHTML = playersHTML(s);
    const count = list.closest('.card') && list.closest('.card').querySelector('h3 small');
    if (count) count.textContent = s.players.length;
  }
  const hint = $('#tvHint');
  if (hint && hint.dataset.on !== String(!!s.screens)) { hint.dataset.on = !!s.screens; hint.innerHTML = tvHintHTML(s); }
  if (s.phase === 'lobby' && host && s.screens) sendSetup();
}

const tvHintHTML = s => s.screens
  ? `${ic('tv')}<span><b>Big screen connected.</b> The answers are revealed on the TV.</span>`
  : `${ic('tv')}<span>Got a TV? Open <b>${esc(location.host)}</b> on it, open <b>Party game</b>, tap the TV icon at the top and enter <b>${esc(s.code)}</b>.
      <a href="/?tv=${esc(s.code)}" target="_blank" rel="noopener">Open the big screen in a new tab</a></span>`;

// The host's lobby choices go to the server only while a big screen is watching, so the TV can show what's coming.
function sendSetup() {
  const body = partySettings(), key = JSON.stringify(body);
  if (key === party.setupSent) return;
  party.setupSent = key;
  api('/api/room/setup', { code: party.code, pid: party.pid, ...body }).catch(() => { if (party) party.setupSent = null; });
}

// Your character: a creator screen like an MMO's. A big preview on a spotlit stage, and one row per part with arrows
// to step through the options by name. Saved on this device and brought into every party room you join.
const LOOK_NAMES = [
  ['Round', 'Square', 'Ghost', 'Egg', 'Cat', 'Bear', 'Alien', 'Bunny', 'Robot', 'Monster', 'Mouse', 'Blob'],
  ['Dots', 'Shiny', 'Happy', 'Sleepy', 'Wink', 'Shades', 'Grumpy', 'Cyclops', 'Hearts', 'Dizzy', 'Side-eye', 'Sparkle'],
  ['Smile', 'Grin', 'Surprised', 'Flat', 'Cheeky', 'Kitty', 'Fangs', 'Frown', 'Smirk', 'Wobbly', 'Buck tooth', 'Laugh'],
  ['None', 'Party hat', 'Crown', 'Cap', 'Beanie', 'Headphones', 'Halo', 'Bow', 'Top hat', 'Wizard hat', 'Viking helmet', 'Flower', "Chef's hat", 'Propeller cap'],
  ['None', 'Rosy cheeks', 'Freckles', 'Moustache', 'Glasses', 'Eyepatch', 'Plaster', 'Clown nose', 'Sweat drop', 'Beard']];
CAT_ITEMS.forEach(it => { LOOK_NAMES[it.part][it.idx] = it.name; });

function characterMenu(back = home) {
  stopTimer();
  const rows = [['Colour', PCOL.length], ...LOOK_LABELS.map((l, i) => [l, LOOK_N[i]])];
  const state = () => {
    const name = store.get('outlier.name', '') || 'You';
    return { name, look: lookFor(name, store.get('outlier.look')), color: store.get('outlier.color', 0) };
  };
  const tries = {};   // locked items being tried on: shown on the preview, never saved
  let emoTry = null, emoTimer = null;   // the same for a locked emote
  const emoNow = () => emoTry || (EMOTES.some(e => e.id === store.get('outlier.emote')) ? store.get('outlier.emote') : 'cheer');
  const valueOf = (st, k) => k === 0 ? st.color : k in tries ? tries[k] : parseInt(st.look[k - 1], 36);
  const preview = st => Object.entries(tries).reduce((l, [k, v]) => lookWith(l, k - 1, v), st.look);
  const nameOf = (k, v) => k === 0 ? PCOL_NAMES[v] : LOOK_NAMES[k - 1][v];
  show(`${topbar('Your character')}
    <section class="cc">
      <div class="cc-stage">
        <div class="cc-spot"></div>
        <div class="cc-hero" id="ccHero"></div>
        <div class="cc-plinth"></div>
        <input type="text" id="ccName" class="cc-name" maxlength="16" placeholder="Your name" value="${esc(store.get('outlier.name', ''))}" autocomplete="nickname" aria-label="Your name">
      </div>
      <div class="cc-panel">
        <ul class="cc-rows">${rows.map(([label], k) => `<li class="cc-row" data-k="${k}">
          <button class="cc-arr" data-k="${k}" data-d="-1" aria-label="Previous ${label.toLowerCase()}">${ic('left')}</button>
          <span class="cc-mid"><small>${label}</small><b id="ccV${k}"></b><i id="ccN${k}"></i></span>
          <button class="cc-arr" data-k="${k}" data-d="1" aria-label="Next ${label.toLowerCase()}">${ic('right')}</button></li>`).join('')}
          <li class="cc-row" data-k="e"><button class="cc-arr" data-k="e" data-d="-1" aria-label="Previous podium emote">${ic('left')}</button>
          <span class="cc-mid"><small>Podium emote</small><b id="ccVe"></b><i id="ccNe"></i></span>
          <button class="cc-arr" data-k="e" data-d="1" aria-label="Next podium emote">${ic('right')}</button></li></ul>
        <div class="cc-actions">
          <button class="btn slim" id="ccRandom">${ic('shuffle')}<span>Randomise</span></button>
          <button class="btn primary slim" id="ccDone">${ic('check')}<span>Done</span></button>
        </div>
      </div>
    </section>
    <section class="card unl"><h3>Category unlocks <small id="unlCount"></small></h3>
      <p class="fine">Play a category to earn its items and its podium emote: right answers, Outliers, then a big score in a seven-prompt game of just that category.</p>
      <ul class="unl-list" id="unlList"></ul></section>`);
  const drawUnlocks = () => {
    const st = state(), look = preview(st), have = store.get('outlier.unlocks', []), stats = store.get('outlier.unlockStats', {}) || {};
    $('#unlCount').textContent = `${have.length} of ${UNLOCKABLES.length}`;
    $('#unlList').innerHTML = [...Object.keys(CAT_LABEL), ...Object.keys(SUB_LABEL).map(s => 'sub:' + s)].map(cat => {
      const sb = cat.startsWith('sub:') ? cat.slice(4) : null;
      const items = UNLOCKABLES.filter(it => (it.sub ? 'sub:' + it.sub : !sb && it.cat) === cat), next = items.find(it => !have.includes(itemKey(it)));
      const c = (sb ? (stats.subs || {})[sb] : stats[cat]) || {}, g = next && goalOf(next);
      const sub = !next ? (items.length > 1 ? `All ${items.length} unlocked` : 'Unlocked') : `Next: ${g.short}<b class="unl-prog">${g.key === 'best' ? `best ${c.best || 0}` : `${Math.min(c[g.key] || 0, g.n)}/${g.n}`}</b>`;
      return `<li><span class="award-ic">${ic(sb ? SUB_ICON[sb] : CAT_ICON[cat] || 'sparkles')}</span>
        <span class="main"><b>${sb ? `${SUB_LABEL[sb]} celebration` : CAT_LABEL[cat]}</b><small>${sub}</small></span>
        <span class="unl-items">${items.map(it => { const got = have.includes(itemKey(it)), on = it.emote ? emoNow() === it.emote : parseInt(look[it.part], 36) === it.idx;
          return `<button class="unl-it${got ? ' got' : ''}${on ? ' on' : ''}${it.emote ? ' emo' : ''}" ${it.emote ? `data-e="${it.emote}"` : `data-p="${it.part}" data-i="${it.idx}"`} aria-label="${esc(it.name)}${it.emote ? ' (podium emote)' : ''}${got ? '' : ' (locked)'}" title="${esc(it.name)}${got ? '' : ': ' + esc(itemGoal(it))}">
            ${it.emote ? avatar(st.name, st.color, BASE_LOOK, 'e-' + it.emote) : avatar(st.name, st.color, lookWith(BASE_LOOK, it.part, it.idx))}${got ? '' : `<span class="unl-lock">${ic('lock')}</span>`}</button>`; }).join('')}</span></li>`;
    }).join('');
  };
  const draw = (bump) => {
    const st = state(), look = preview(st);
    $('#ccHero').innerHTML = avatar(st.name, st.color, look);
    if (bump) { const h = $('#ccHero'); h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop'); }
    rows.forEach(([, n], k) => {
      const v = valueOf(st, k), lock = k && itemLocked(k - 1, v);
      $(`#ccV${k}`).innerHTML = `${esc(nameOf(k, v))}${lock ? ic('lock', 'cc-lock') : ''}`;
      $(`#ccN${k}`).textContent = lock ? `Locked · ${itemGoal(lock)}` : `${v + 1} of ${n}`;
      $(`.cc-row[data-k="${k}"]`).classList.toggle('locked', !!lock);
    });
    const emo = emoNow(), elock = emoteLocked(emo), en = EMOTES.findIndex(e => e.id === emo);
    $('#ccVe').innerHTML = `${esc(EMOTES[en].name)}${elock ? ic('lock', 'cc-lock') : ''}`;
    $('#ccNe').textContent = elock ? `Locked · ${itemGoal(UNLOCKABLES.find(u => u.emote === emo))}` : `${en + 1} of ${EMOTES.length} · tap to see it`;
    $('.cc-row[data-k="e"]').classList.toggle('locked', elock);
    $('#ccHero').classList.toggle('trying', Object.keys(tries).length > 0 || !!emoTry);
    $('.cc-row[data-k="0"] .cc-mid b').style.color = PCOL[st.color];
    drawUnlocks();
  };
  const set = (k, v) => {   // k is a row (0 = colour); a locked item is only tried on
    const st = state();
    if (k === 0) store.set('outlier.color', v);
    else if (itemLocked(k - 1, v)) tries[k] = v;
    else { delete tries[k]; store.set('outlier.look', lookWith(st.look, k - 1, v)); }
    draw(true);
  };
  const step = (k, d) => { const n = rows[k][1]; set(k, (valueOf(state(), k) + d + n) % n); };
  const playEmote = () => {   // the hero does the emote for a few seconds
    const st = state();
    clearTimeout(emoTimer);
    $('#ccHero').innerHTML = avatar(st.name, st.color, preview(st), emoteMood(emoNow()));
    emoTimer = setTimeout(() => { if ($('#ccHero')) $('#ccHero').innerHTML = avatar(state().name, state().color, preview(state())); }, 3600);
  };
  const setEmote = id => {
    if (emoteLocked(id)) emoTry = id;
    else { emoTry = null; store.set('outlier.emote', id); }
    draw();
    playEmote();
  };
  const stepEmote = d => { const i = EMOTES.findIndex(e => e.id === emoNow()); setEmote(EMOTES[(i + d + EMOTES.length) % EMOTES.length].id); };
  $('#unlList').onclick = e => {
    const b = e.target.closest('.unl-it');
    if (!b) return;
    if (b.dataset.e) {
      if (emoteLocked(b.dataset.e)) toast(`Locked: ${itemGoal(UNLOCKABLES.find(u => u.emote === b.dataset.e))}`);
      return setEmote(emoNow() === b.dataset.e && !emoTry ? 'cheer' : b.dataset.e);
    }
    const part = +b.dataset.p, v = +b.dataset.i, k = part + 1, it = itemAt(part, v);
    if (valueOf(state(), k) === v) set(k, 0);   // tap again to take it off
    else { set(k, v); if (itemLocked(part, v)) toast(`Locked: ${itemGoal(it)}`); }
  };
  $('.cc-rows').onclick = e => {
    const b = e.target.closest('.cc-arr');
    if (b) return b.dataset.k === 'e' ? stepEmote(+b.dataset.d) : step(+b.dataset.k, +b.dataset.d);
    if (e.target.closest('.cc-row[data-k="e"]')) playEmote();
  };
  $('.cc-rows').onkeydown = e => {   // left and right arrow keys step the focused row
    const row = e.target.closest('.cc-row');
    if (row && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); const d = e.key === 'ArrowLeft' ? -1 : 1; row.dataset.k === 'e' ? stepEmote(d) : step(+row.dataset.k, d); }
  };
  $('#ccName').oninput = e => {
    const v = e.target.value.trim();
    if (!store.get('outlier.look')) store.set('outlier.look', state().look);   // keep the face you see while typing
    if (v) store.set('outlier.name', v); else store.del('outlier.name');
    draw();
  };
  $('#ccRandom').onclick = () => {
    Object.keys(tries).forEach(k => delete tries[k]);
    store.set('outlier.look', LOOK_N.map((n, i) => { const ok = [...Array(n).keys()].filter(v => !itemLocked(i, v)); return ok[Math.floor(Math.random() * ok.length)].toString(36); }).join(''));
    store.set('outlier.color', Math.floor(Math.random() * PCOL.length));
    draw(true);
  };
  $('#ccDone').onclick = $('#back').onclick = () => back();
  draw();
  api(statsQuery()).then(st => { syncUnlocks(st); if ($('#unlList')) draw(); }).catch(() => {});
}
const BASE_LOOK = '00000';   // the plain character the unlock thumbnails are drawn on

function colorsHTML(s) {
  const mine = colorOf(s, s.you), taken = new Set(s.players.filter(p => p.n !== s.you).map(p => p.color));
  return PCOL.map((c, i) => `<button class="swatch${i === mine ? ' on' : ''}" data-c="${i}" ${taken.has(i) ? 'disabled' : ''}
    style="--pc:${c}" aria-label="${PCOL_NAMES[i]}${taken.has(i) ? ' (taken)' : ''}" aria-pressed="${i === mine}">${i === mine ? ic('check') : ''}</button>`).join('');
}

const partyBar = (s, mid) => topbar(mid, `<span class="pill">${esc(s.code)}</span>`, 'leave', 'x');

// ---- teams (Classic only): two even teams, offered with 4, 6, 8... players. A team scores its players' points
// added up, and two teammates giving the same answer both score 0.
const TEAM = ['Team A', 'Team B'];
const teamTag = t => `<span class="tag team t${t || 0}">${TEAM[t || 0]}</span>`;

// The host's Teams switch in the lobby, kept in step with the room on every poll.
function teamsUI(s) {
  const seg = $('#teams');
  if (!seg || s.phase !== 'lobby') return;
  seg.querySelectorAll('.chip').forEach(c => {
    const v = c.dataset.t === '1';
    c.classList.toggle('on', v === !!s.teamsOn);
    c.setAttribute('aria-pressed', v === !!s.teamsOn);
    if (v) c.disabled = !s.teamsOk;
  });
  const hint = $('#teamHint');
  const n = s.players.length;
  const html = !s.teamsOk ? `${ic('users')}<span>Teams need an even number of players, 4 or more. There ${n === 1 ? 'is 1 player' : `are ${n} players`} here.</span>`
    : s.teamsOn ? `${ic('users')}<span>Tap a player to swap their team. If two teammates give the same answer, both score 0. <a href="#" id="shuffle">Shuffle teams</a></span>`
    : `${ic('users')}<span>Play as two even teams. A team's score is everyone's points added up.</span>`;
  if (hint && hint.dataset.html !== html) { hint.dataset.html = html; hint.innerHTML = html; }
}

// Both teams' totals side by side, with a tug-of-war bar.
function teamBarHTML(s) {
  if (!s.teams || !s.teamScores) return '';
  const sc = s.teamScores, tot = Math.max(1, sc[0] + sc[1]);
  const names = t => s.players.filter(p => p.team === t).map(p => esc(p.name)).join(', ');
  return `<section class="card teams"><div class="tm-row">${[0, 1].map(t => `<div class="tm t${t}${sc[t] > sc[1 - t] ? ' lead' : ''}">
      <b>${TEAM[t]}</b><span class="tm-n">${sc[t]}</span><small>${names(t)}</small></div>`).join('')}</div>
    <div class="tm-bar"><i class="t0" style="width:${(sc[0] / tot * 100).toFixed(1)}%"></i><i class="t1" style="width:${(sc[1] / tot * 100).toFixed(1)}%"></i></div></section>`;
}

const teamWinner = s => s.teamScores[0] === s.teamScores[1] ? 'It’s a draw!' : `${TEAM[s.teamScores[0] > s.teamScores[1] ? 0 : 1]} wins!`;

function partyLobby(s, host) {
  const seg = (id, values, current, unit) => `<div class="seg" id="${id}">${values.map(n =>
    `<button class="chip${n === current ? ' on' : ''}" data-n="${n}" aria-pressed="${n === current}">${n}${unit}</button>`).join('')}</div>`;
  const players = `<section class="card"><h3>Players <small>${s.players.length}</small></h3><ul class="rows players" id="players"></ul></section>`;
  const colour = `<section class="card charcard"><h3><span id="chMe"></span>Your colour</h3>
      <div class="swatches" id="colors"></div>
      <p class="fine">${ic('user')}<span>Change your character from <b>You</b> on the main menu.</span></p></section>`;
  // The host sets things up top-down: the game mode first, then the categories, then who's in.
  show(`${partyBar(s, 'Lobby')}
    <section class="card codecard">
      <p class="eyebrow">Room code</p>
      <div class="roomcode">${esc(s.code)}</div>
      <button class="btn slim" id="invite">${ic('share')}<span>Share invite link</span></button>
      ${host ? '<p class="fine tvhint" id="tvHint"></p>' : ''}
    </section>
    ${host ? `<section class="card settings">
        <div class="setting"><span>Game mode</span><div class="seg" id="mode">
          <button class="chip${party.mode === 'classic' ? ' on' : ''}" data-mode="classic" aria-pressed="${party.mode === 'classic'}">Classic</button>
          <button class="chip${party.mode === 'potato' ? ' on' : ''}" data-mode="potato" aria-pressed="${party.mode === 'potato'}">Fumble</button></div></div>
        <div id="modeset">${modeSettings(seg)}</div>
      </section>
      <section class="sec">${limited() ? `<div class="picker">
        <button class="tile wide on" disabled><span class="tile-ic">${ic('sparkles')}</span><span class="tile-l">Everything</span><span class="tile-n">A mix from every category</span></button>
        <button class="mode" id="partyPlus"><span class="mode-ic">${ic('lock')}</span><span class="mode-t"><b>Choose categories</b><small>Pick any category or mix for your party. Outlier Plus</small></span></button>
      </div>` : '<div id="picker"></div>'}</section>
      ${players}
      ${colour}
      <div class="cta"><button class="btn primary big" id="start">${ic('play')}<span><b>Start game</b><small>Everyone in the room plays along</small></span></button></div>`
      : `${players}
      ${colour}
      <div class="waiting card"><span class="dots"><i></i><i></i><i></i></span><p>Waiting for the host to pick a category and start</p></div>`}`);
  $('#invite').onclick = () => shareText(`${location.origin}/?room=${s.code}`);
  $('#colors').onclick = e => { const b = e.target.closest('[data-c]'); if (b && !b.disabled) { store.set('outlier.color', +b.dataset.c); partyPost('/api/room/color', { color: +b.dataset.c }); } };

  if (!host) return;
  if (limited()) {   // free hosts play Everything (the server enforces this too)
    $('#partyPlus').onclick = () => toast('Choosing party categories is part of Outlier Plus');
  } else mountPicker($('#picker'), () => { $('#start').disabled = !poolCount(pick); });
  const chips = (id, field) => $(id).onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    party[field] = +b.dataset.n;
    $(id).querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  };
  const wireMode = () => {
    if ($('#rounds')) { chips('#rounds', 'rounds'); chips('#secs', 'secs'); }
    else { chips('#lives', 'lives'); chips('#turn', 'turn'); }
  };
  $('#mode').onclick = e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    party.mode = b.dataset.mode;
    $('#mode').querySelectorAll('.chip').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    $('#modeset').innerHTML = modeSettings(seg);
    wireMode();
    if (party.last) teamsUI(party.last);
    if ($('#picker')) mountPicker($('#picker'), () => { $('#start').disabled = !poolCount(pick); });   // Fumble hides short prompts
    $('#start').disabled = !limited() && !poolCount(pick);
  };
  wireMode();
  $('#modeset').addEventListener('click', e => {
    const t = e.target.closest('#teams .chip');
    if (t && !t.disabled) partyPost('/api/room/team', { on: t.dataset.t === '1' });
    if (e.target.closest('#shuffle')) { e.preventDefault(); partyPost('/api/room/team', { shuffle: true }); }
  });
  $('#players').addEventListener('click', e => {
    const li = e.target.closest('[data-swap]');
    if (li) partyPost('/api/room/team', { n: +li.dataset.swap });
  });
  teamsUI(s);
  $('#start').disabled = !limited() && !poolCount(pick);
  $('#start').onclick = startParty;
}

const partySettings = () => ({ ...(limited() ? { cat: 'all', tags: [] } : apiPick(pick)), mode: party.mode,
  rounds: party.rounds, secs: party.mode === 'potato' ? party.turn : party.secs, lives: party.lives });
const startParty = () => partyPost('/api/room/start', partySettings());

// The settings under the game mode: rounds and answer time for Classic; lives and turn time for Fumble.
function modeSettings(seg) {
  if (party.mode === 'potato') return `
    <div class="setting"><span>Lives</span>${seg('lives', [1, 3, 5], party.lives, '')}</div>
    <div class="setting"><span>Time per turn</span>${seg('turn', [5, 10, 15], party.turn, 's')}</div>
    <p class="fine">${ic('flame')}<span><b>Fumble:</b> take turns naming an answer to the same prompt. Wrong answers and repeats don't count, so keep trying; if the clock runs out you lose a life and the next player gets a new prompt. Points earn extra lives: the first at 250, then each one takes 250 more than the last (500 more, then 750...). Last one standing wins.</span></p>`;
  return `
    <div class="setting"><span>Rounds</span>${seg('rounds', [3, 5, 7, 10], party.rounds, '')}</div>
    <div class="setting"><span>Time to answer</span>${seg('secs', [15, 30, 45, 60], party.secs, 's')}</div>
    <div class="setting"><span>Teams</span><div class="seg" id="teams">
      <button class="chip" data-t="0">Off</button><button class="chip" data-t="1">2 teams</button></div></div>
    <p class="fine" id="teamHint"></p>
    <p class="fine">${ic('zap')}<span>Play <b>Everything</b> to unlock double downs: before each round everyone sees the category and can double that round's score, once per game.</span></p>`;
}

// ---- Fumble: one prompt, players take turns; a valid new answer passes it on, running out of time costs a life.
const hearts = (n, out) => out ? '<span class="pt-out">Out</span>'
  : `<span class="pt-hearts" aria-label="${n} ${n === 1 ? 'life' : 'lives'}">${'<i></i>'.repeat(Math.min(n, 6))}${n > 6 ? `<b>×${n}</b>` : ''}</span>`;

function potatoTable(s) {
  const byN = Object.fromEntries(s.players.map(p => [p.n, p]));
  return `<ul class="pt-table">${s.order.map(n => byN[n]).filter(Boolean).map(p => {
    const toward = Math.max(0, Math.min(1, (p.score - (p.bonusAt - p.bonusStep)) / p.bonusStep));
    return `<li class="${p.n === s.current ? 'turn' : ''}${p.out ? ' gone' : ''}${p.n === s.you ? ' me' : ''}">
      ${avatar(p.name, p.color, p.look)}<span class="pt-name"><b>${esc(p.name)}</b>${hearts(p.lives, p.out)}</span>
      <span class="pt-pts" title="${p.bonusAt - p.score} points to an extra life"><span class="pt-ring" style="--k:${toward.toFixed(2)}"></span>${p.score}</span></li>`;
  }).join('')}</ul>`;
}

// The answers said so far this prompt. Only an answer that's new since the last draw slides in; the rest sit still
// (the list is redrawn on every poll, so animating them all made the whole list pulse).
const LOGCTX = () => tv || party;
function setLog(html) {   // only touch the list when something in it changed
  const el = $('#ptLog');
  if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function potatoLog(s, ctx) {
  const rows = s.log.filter(l => l.round === s.round && !l.timeout);
  if (!rows.length) return '<p class="muted center pt-empty">No answers yet. Get it started!</p>';
  const keyOf = l => `${l.round}|${l.n}|${l.answer}`, seen = ctx && ctx.logSeen;
  if (ctx) ctx.logSeen = new Set(rows.map(keyOf));
  return `<ul class="pt-log">${rows.map(l => `<li class="${l.outlier ? 'out' : ''}${seen && !seen.has(keyOf(l)) ? ' fresh' : ''}">
    <b>${esc(l.answer)}</b><small>${esc(l.name)}</small><span class="pt-p">+${l.points}${l.bonus ? ' <span class="pt-life">+1 life</span>' : ''}</span></li>`).join('')}</ul>`;
}

// The intermission after someone runs out of time: everyone's name pops up with their lives, and the one who
// fumbled watches a heart drop away (and an "Out" stamp land if it was their last).
function potatoBreak(s) {
  show(`${partyBar(s, 'Fumble')}${potatoBreakHTML(s)}`);
}

function potatoBreakHTML(s) {
  const b = s.boom, byN = Object.fromEntries(s.players.map(p => [p.n, p]));
  const rows = s.order.map(n => byN[n]).filter(Boolean);
  const head = b.draw ? 'It’s a draw!' : b.out ? `${esc(b.name)} is out!` : `${esc(b.name)} fumbled!`;
  return `
    <section class="pt-break">
      <p class="eyebrow">${b.draw ? `${ic('check')} All ${b.count} answers found` : `${ic('flame')} Time's up`}</p>
      <h2 class="pt-bh">${head}</h2>
      <ul class="pt-roll">${rows.map((p, i) => {
        const hit = p.n === b.n, d = `--d:${(i * 0.18).toFixed(2)}s`;
        const lives = hit ? `<span class="pt-hearts">${'<i></i>'.repeat(Math.min(p.lives, 6))}<i class="lose"></i></span>${p.out ? '<span class="pt-out late">Out</span>' : ''}`
          : hearts(p.lives, p.out);
        return `<li class="${hit ? 'hit' : ''}${p.out && !hit ? ' gone' : ''}" style="${d}">${avatar(p.name, p.color, p.look)}
          <span class="pt-name"><b>${esc(p.name)}</b>${lives}</span><span class="pt-pts">${p.score}</span></li>`;
      }).join('')}</ul>
      <p class="muted center pt-next">${b.end ? 'And that\'s the game…' : 'Next prompt coming up…'}</p>
    </section>`;
}

function partyPotato(s) {
  if (s.boom && s.boom.turn === s.turnId && s.breakMs > 0) { sfx.play(s.boom.draw ? 'ding' : 'boom', !!s.boom.out); return potatoBreak(s); }
  const me = s.players.find(p => p.n === s.you) || {};
  const kind = s.promptInput || {}, darts = kind.input === 'darts';
  const boom = s.boom && s.boom.turn === s.turnId && !s.boom.end
    ? `<div class="pt-boom">${s.boom.draw ? `${ic('check')}<span>Every answer was found last prompt, so it was a <b>draw</b></span>`
      : `${ic('flame')}<span><b>${esc(s.boom.name)}</b> ${s.boom.out ? 'ran out of time and is <b>out</b>!' : 'ran out of time and lost a life'}</span>`}</div>` : '';
  show(`${partyBar(s, `Fumble · Prompt ${s.round}`)}
    ${boom}
    <div class="pt-seats" id="ptSeats"></div>
    <p class="hint">${esc(s.hint)}</p>
    <h2 class="pt-prompt">${esc(s.prompt)}</h2>
    <p class="pt-left" id="ptLeft" aria-live="polite"></p>
    <div class="pt-turn" id="ptTurn">
      <div class="bar"><div class="timer grow"><i id="tbar"></i></div><span class="secs" id="tsecs"></span></div>
      <div id="ptWho"></div>
      ${me.out ? '' : darts ? dartPadHTML() : `<form id="ptForm" class="stack" autocomplete="off">
          <input type="text" id="input" maxlength="60" placeholder="Type your answer ready" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck="false">
          <p id="miss" class="miss" role="alert" hidden></p>
          <button class="btn primary" id="ptGo">Pass it on</button></form>`}
    </div>
    <div id="ptTable"></div>
    <section class="card"><h3>Said so far <small id="ptSaid"></small></h3><div id="ptLog"></div></section>`);
  party.ptTurn = null;
  party.seatKey = null;
  party.pad = null;
  if (party.draftRound !== s.round) { party.draft = ''; party.dartDraft = null; party.draftRound = s.round; }   // a new prompt starts blank
  if (darts && !me.out) {
    // The darts keypad: a route can be built ready before the turn comes round, and goes as soon as it does.
    // A route already said shakes, clears and lets them try again; the clock keeps running, as for typed answers.
    party.pad = dartPad(kind.target, async answer => {
      try {
        const r = await api('/api/room/potato', { code: party.code, pid: party.pid, answer });
        if (r.miss) party.pad && party.pad.fail(r.miss);
        else if (party.pad) { party.dartDraft = null; party.pad.reset(); }
        if (party) renderParty(r);
      } catch (err) { toast(err.message); }
    }, { canSend: () => !!party.ptMine, darts: party.dartDraft, onChange: d => { party.dartDraft = d; } });
  }
  const form = $('#ptForm');
  if (form) {
    const input = $('#input'), miss = $('#miss');
    input.value = party.draft || '';   // what they typed ready survives screen refreshes
    input.oninput = () => { miss.hidden = true; party.draft = input.value; };
    let busy = false;
    form.onsubmit = async e => {
      e.preventDefault();
      const answer = input.value.trim();
      if (!answer || busy || !party.ptMine) return;
      busy = true;
      try {
        const r = await api('/api/room/potato', { code: party.code, pid: party.pid, answer });
        if (r.miss) {
          sfx.play('nope');
          miss.textContent = r.miss; miss.hidden = false;
          form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
          input.select();
        } else { input.value = ''; party.draft = ''; }
        if (party) renderParty(r);
      } catch (err) { toast(err.message); }
      busy = false;
    };
  }
  updatePotato(s);
}

// How many answers on the list nobody has said yet this prompt.
function ptLeft(s) {
  const el = $('#ptLeft');
  if (el && typeof s.left === 'number') el.innerHTML = `<b>${s.left}</b> possible answer${s.left === 1 ? '' : 's'} remaining`;
}

// A correct answer flashes up on everyone's screen for a moment.
function potatoPop(s) {
  const l = s.log[0];
  const key = l && !l.timeout ? `${l.round}|${l.n}|${l.answer}` : '';
  const ctx = party || tv, first = ctx.ptPop === undefined;
  if (key === ctx.ptPop) return;
  ctx.ptPop = key;
  if (first || !key || l.round !== s.round) return;   // nothing new, or it belongs to an earlier prompt
  const p = s.players.find(x => x.n === l.n) || {};
  document.querySelectorAll('.pt-pop').forEach(x => x.remove());
  const el = document.createElement('div');
  el.className = 'pt-pop' + (l.outlier ? ' outlier' : '');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<b>${esc(l.answer)}</b><span>${avatar(p.name || l.name, p.color, p.look)}${esc(l.name)} · +${l.points}${l.outlier ? ' · Outlier!' : ''}${l.bonus ? ' · +1 life' : ''}</span>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1400);
}

// Within one prompt the screen is updated in place, so an answer someone is typing ready isn't wiped when the turn moves.
function updatePotato(s) {
  if (!$('#ptTurn')) return;
  const me = s.players.find(p => p.n === s.you) || {};
  const cur = s.players.find(p => p.n === s.current) || {};
  const mine = s.current === s.you && !me.out;
  $('#ptTable').innerHTML = potatoTable(s);
  const byN = Object.fromEntries(s.players.map(p => [p.n, p]));
  const seats = s.order.map(n => byN[n]).filter(Boolean);
  const seatKey = [s.current, ...seats.map(p => `${p.n}${p.out ? 'x' : ''}${p.color}${p.look}`)].join('|');
  if (seatKey !== party.seatKey) {   // redrawn only when it changes, so the bounce doesn't restart every poll
    party.seatKey = seatKey;
    $('#ptSeats').innerHTML = seats.map(p => `<span class="seat${p.n === s.current ? ' now' : ''}${p.out ? ' gone' : ''}${p.n === s.you ? ' me' : ''}">
      ${p.n === s.current ? '<i class="seat-arrow" aria-hidden="true"></i>' : ''}${avatar(p.name, p.color, p.look)}<small>${esc(p.name)}</small></span>`).join('');
  }
  setLog(potatoLog(s, LOGCTX()));
  $('#ptSaid').textContent = s.said;
  ptLeft(s);
  if (party.ptSaid !== undefined && s.said > party.ptSaid) sfx.play('ding');
  party.ptSaid = s.said;
  potatoPop(s);
  if (party.ptTurn === s.turnId) return;   // the rest only changes when the turn does
  party.ptTurn = s.turnId;
  party.ptMine = mine;
  $('#ptTurn').classList.toggle('mine', mine);
  $('#ptWho').innerHTML = mine ? '<p class="pt-you">Your turn!</p>'
    : `<p class="pt-wait">${me.out ? 'You are out. Watch the others battle it out. ' : ''}${avatar(cur.name, cur.color, cur.look)}<span><b>${esc(cur.name || '')}</b>'s turn</span></p>`;
  const go = $('#ptGo'), input = $('#input'), miss = $('#miss');
  if (go) {
    go.textContent = mine ? 'Pass it on' : 'Wait for your turn';
    go.disabled = !mine;
    if (miss && !mine) miss.hidden = true;
  }
  const startIn = s.startsInMs || 0;
  const run = () => runTimer(s.remainingMs, s.roundMs, () => {}, mine);
  if (startIn > 0) {
    stopTimer();
    $('#tsecs').textContent = 'Ready';
    if (go) go.disabled = true;
    const turn = s.turnId;
    setTimeout(() => {
      if (!party || party.ptTurn !== turn || !$('#ptTurn')) return;
      if (go) go.disabled = !mine;
      runTimer(s.remainingMs, s.roundMs, () => {}, mine);
      if (mine && party.pad) party.pad.flush();
    }, startIn);
  } else { run(); if (mine && party.pad) party.pad.flush(); }
  if (!mine) return;
  buzz(30);
  sfx.play('sting');
  if (input && document.activeElement !== input) input.focus();
}

// The podium at the end of a party game. `ranked` is [{ p, rank }] best first (equal ranks share a step).
// Firsts and seconds cheer on their steps; everyone below the podium sits in front of it crying, and so does
// third place in a three-player game (it's last). The steps rise in once per game, then stay put on redraws.
function podiumHTML(s, ranked, sub) {
  const total = ranked.length;
  const mood = r => r.rank === 1 || r.rank === 2 || (r.rank === 3 && total >= 4) ? 'cheer' : 'cry';
  const step = place => {
    const here = ranked.filter(r => r.rank === place);
    if (!here.length) return `<div class="pod p${place} empty"><div class="pod-step"><span>${place}</span></div></div>`;
    const m = mood(here[0]);
    return `<div class="pod p${place}">
      <div class="pod-top">${here.map(r => `<div class="pod-who${r.p.n === s.you ? ' me' : ''}">${avatar(r.p.name, r.p.color, r.p.look, m === 'cheer' ? emoteMood(r.p.emote) : m)}<b>${esc(r.p.name)}</b><small>${esc(sub(r.p))}</small></div>`).join('')}</div>
      <div class="pod-step"><span>${place}</span></div></div>`;
  };
  const floor = ranked.filter(r => r.rank > 3);
  const stamp = `${s.code}|${s.round}|${ranked.map(r => r.p.n).join('.')}`;
  const ctx = party || tv;
  const play = ctx && ctx.podium !== stamp;
  if (ctx) ctx.podium = stamp;
  return `<section class="podium${play ? ' play' : ''}" aria-label="Podium">
    <div class="confetti" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 5) * .22}s;--c:${PCOL[i % PCOL.length]}"></i>`).join('')}</div>
    <div class="pod-steps">${step(2)}${step(1)}${step(3)}</div>
    ${floor.length ? `<div class="pod-floor">${floor.map(r => `<div class="pod-who${r.p.n === s.you ? ' me' : ''}">${avatar(r.p.name, r.p.color, r.p.look, 'cry')}<b>${esc(r.p.name)}</b><small>${r.rank}th · ${esc(sub(r.p))}</small></div>`).join('')}</div>` : ''}
  </section>`;
}

const rankBy = (list, key) => list.map(p => ({ p, rank: 1 + list.filter(o => key(o) > key(p)).length }));

function potatoFinal(s, host) {
  const byN = Object.fromEntries(s.players.map(p => [p.n, p]));
  const order = s.standings.map(n => byN[n]).filter(Boolean), win = order[0];
  const asked = (s.asks || []).map(n => (byN[n] || {}).name).filter(Boolean);
  const iAsked = (s.asks || []).includes(s.you);
  const answers = s.log.filter(l => !l.timeout);
  const best = answers.reduce((a, l) => (!a || l.points > a.points ? l : a), null);
  postPartyResult(s, order.findIndex(p => p.n === s.you) + 1);
  show(`${partyBar(s, 'Fumble')}
    <div class="center"><p class="muted">Last one standing</p><h2>${esc(win ? win.name : '')}</h2>
      <p class="muted">${win ? `${win.lives} ${win.lives === 1 ? 'life' : 'lives'} left · ${win.score} points` : ''}</p></div>
    ${podiumHTML(s, order.map((p, i) => ({ p, rank: i + 1 })), p => `${p.score} pts`)}
    <ol class="rows card players">${order.map((p, i) => `<li class="${p.n === s.you ? 'me' : ''}"><span class="num rank">${i + 1}</span>
      ${avatar(p.name, p.color, p.look)}<span class="main"><b>${esc(p.name)}</b><small>${p.out ? 'Out' : 'Still standing'} · ${(k => `${k} answer${k === 1 ? '' : 's'}`)(answers.filter(l => l.n === p.n).length)}</small></span>
      <span class="num">${p.score}</span></li>`).join('')}</ol>
    ${best ? `<section class="card"><h3>Best answer</h3><p><b>${esc(best.answer)}</b> by ${esc(best.name)} · +${best.points}${best.outlier ? ' · Outlier!' : ''}</p></section>` : ''}
    ${asked.length ? `<p class="muted center">${asked.map(esc).join(', ')} ${asked.length === 1 ? 'wants' : 'want'} a rematch</p>` : ''}
    ${host ? `<div class="stack"><button class="btn primary" id="again">Rematch<small>Same players and settings, fresh prompts</small></button>
      <button class="btn" id="lobby">Change settings</button></div>`
      : `<button class="btn${iAsked ? '' : ' primary'}" id="ask" ${iAsked ? 'disabled' : ''}>${iAsked ? 'Rematch requested' : 'Ask for a rematch'}</button>
         <p class="muted center">The host starts the next game.</p>`}`);
  if ($('.podium.play')) sfx.podium();
  if (!host) { if ($('#ask')) $('#ask').onclick = () => partyPost('/api/room/ask'); return; }
  $('#again').onclick = () => partyPost('/api/room/rematch');
  $('#lobby').onclick = () => partyPost('/api/room/lobby');
}

// Before each prompt: the category only, and a once-per-game chance to double the round.
function partyPick(s) {
  const mid = `Round ${s.round}/${s.rounds}`;
  const choice = !s.doubleLeft && !s.doubling ? '<p class="muted center">You have used your double down. Get ready…</p>'
    : s.picked ? `<div class="card center"><h2>${s.doubling ? 'Doubling down ×2' : 'Playing it straight'}</h2><p class="muted">Waiting for the others…</p></div>`
      : `<div class="stack">
          <button class="btn primary dbl" id="dbl">Double down ×2<small>Your one double for this game</small></button>
          <button class="btn" id="straight">Play it straight</button>
        </div>`;
  show(`${partyBar(s, mid)}
    <div class="bar"><div class="timer grow"><i id="tbar"></i></div><span class="secs" id="tsecs"></span></div>
    <p class="muted center">Next prompt is from</p>
    <div class="hintbig">${esc(s.hint)}</div>
    ${choice}
    <div class="card"><h3>Players</h3><ul class="rows" id="players"></ul></div>`);
  runTimer(s.remainingMs, s.roundMs, () => {});
  if ($('#dbl')) {
    $('#dbl').onclick = () => partyPost('/api/room/double', { double: true });
    $('#straight').onclick = () => partyPost('/api/room/double', { double: false });
  }
}

function partyQuestion(s, host, answered) {
  const mid = `Round ${s.round}/${s.rounds}${s.doubling ? ' · ×2' : ''}`;
  if (answered) {
    show(`${partyBar(s, mid)}
      <div class="bar"><div class="timer grow"><i id="tbar"></i></div><span class="secs" id="tsecs"></span></div>
      ${tickerHTML(s)}
      <h2>${esc(s.prompt)}</h2>
      <div class="card center"><p class="muted">Locked in</p><h2>${esc(s.yourAnswer) || 'No answer'}</h2></div>`);
    return runTimer(s.remainingMs, s.roundMs, () => {});
  }
  const kind = s.promptInput || {};
  show(partyBar(s, mid) + tickerHTML(s) + `<p class="hint">${esc(s.hint)}${s.doubling ? ' · <b>Doubling ×2</b>' : ''}</p>` + questionHTML(s.prompt, kind));
  const post = text => partyPost('/api/room/answer', { answer: text });
  const onTimeout = kind.input === 'darts' ? wireDarts(kind, post) : wireAnswer(s.promptId, post);
  if (s.remainingMs > s.roundMs - 3000) sfx.play('stingSoft');   // not when coming back to a question already under way
  runTimer(s.remainingMs, s.roundMs, () => { sfx.play('buzzer'); onTimeout(); });
  if (kind.input !== 'darts') $('#input').focus();
}

const lanes = s => [...s.players].sort((a, b) => b.score - a.score);

// Before the scores: the room's answers are turned over one at a time, from the commonest to the rarest, with a pause
// before the last one ("And the rarest answer…") and an OUTLIER! stamp if it is one. Tap to skip. Plays once a round.
function revealGroups(s, r) {
  const groups = [];
  r.results.forEach(x => {
    const key = x.valid ? 'v:' + x.canonical : x.given ? 'x:' + x.n : 'none';
    let g = groups.find(g => g.key === key);
    if (!g) groups.push(g = { key, x, who: [] });
    g.who.push(x);
  });
  const rank = g => g.key === 'none' ? -2 : g.x.valid ? g.x.share : -1;   // blanks, then wrong answers, then commonest to rarest
  return groups.sort((a, b) => (rank(a) < 0 || rank(b) < 0) ? rank(a) - rank(b) : rank(b) - rank(a));
}

function revealCard(s, g, last) {
  const x = g.x, who = g.who.map(w => `<span class="rv-who">${avatar(w.name, colorOf(s, w.n), lookOf(s, w.n))}${esc(w.name)}${w.doubled ? ' <b class="dblx">×2</b>' : ''}</span>`).join('');
  const t = x.outlier ? 5 : x.valid ? Math.max(1, tier(x.points / (x.doubled ? 2 : 1) * (x.shared ? 2 : 1))) : 0;
  return `<li class="rv-card t${t}${last ? ' finale' : ''}${x.valid ? '' : ' miss'}">
    ${x.outlier ? '<span class="rv-stamp">Outlier!</span>' : ''}
    <div class="rv-ans">${x.valid ? esc(x.canonical) : g.key === 'none' ? 'No answer' : `<span class="strike">${esc(x.given)}</span>`}</div>
    <div class="rv-meta">${x.valid ? `${x.share < 1 ? 'Under 1%' : Math.round(x.share) + '%'} of players said it` : g.key === 'none' ? 'Ran out of time' : 'Not on the list'}${g.who.length > 1 && x.valid ? ' · shared, half points' : ''}</div>
    <div class="rv-whos">${who}</div>
  </li>`;
}

const revealShellHTML = (prompt, skip) => `
    <section class="rv" id="rv">
      <p class="eyebrow center">The answers are in</p>
      <h2 class="center">${esc(prompt)}</h2>
      <ul class="rv-list" id="rvList"></ul>
      <p class="rv-drum center" id="rvDrum" hidden>And the rarest answer…</p>
      ${skip ? '<p class="fine center">Tap to skip</p>' : ''}
    </section>`;

function dramaticReveal(s, then) {
  if (party.revealed === s.round || calm()) return then();
  party.revealed = s.round;
  show(`${partyBar(s, `Round ${s.round}/${s.rounds}`)}${revealShellHTML(s.reveal.prompt, true)}`);
  $('#rv').onclick = runReveal(party, s, then);
}

// Deals the answers into the reveal one at a time for a phone (ctx = party) or the big screen (ctx = tv).
// Returns a function that skips straight to the end.
function runReveal(ctx, s, then) {
  const groups = revealGroups(s, s.reveal);
  const list = $('#rvList'), drum = $('#rvDrum'), timers = ctx.revealTimers = [], key = ctx.key;
  let done = false;
  const finish = () => { if (done) return; done = true; timers.forEach(clearTimeout); if ((party || tv) === ctx && ctx.key === key && $('#rv')) then(); };
  let at = 700;
  groups.forEach((g, i) => {
    const last = i === groups.length - 1 && groups.length > 1 && g.x.valid;
    if (last) {
      timers.push(setTimeout(() => { drum.hidden = false; if (ctx.fx) ctx.fx.drum(); }, at));
      at += 1600;
    }
    timers.push(setTimeout(() => {
      drum.hidden = true;
      list.insertAdjacentHTML('beforeend', revealCard(s, g, last));
      if (ctx.fx) ctx.fx.card(g, last);
      if (ctx !== tv) list.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (last && ctx !== tv) buzz(g.x.outlier ? [70, 50, 140] : 40);
    }, at));
    at += last ? 2200 : 1300;
  });
  timers.push(setTimeout(finish, at + 600));
  return finish;
}

function partyReveal(s, host) {
  // With a big screen in the room the reveal plays on the TV, and phones go straight to their own result.
  if (party.revealed !== s.round && !s.screens) return dramaticReveal(s, () => partyRevealScores(s, host));
  partyRevealScores(s, host);
}

function partyRevealScores(s, host) {
  const r = s.reveal, mine = r.results.find(x => x.n === s.you);
  const last = s.round >= s.rounds;
  show(`${partyBar(s, `Round ${s.round}/${s.rounds} · ${esc(s.label)}`)}
    <p class="muted center">${esc(r.prompt)}</p>
    ${mine ? resultHTML(mine) : ''}
    ${raceHTML(s, r)}
    <div class="after${mine ? ' wait' : ''}">
    ${teamBarHTML(s)}
    <div class="card">${trailHTML(lanes(s).map(p => {
      const got = r.results.find(x => x.n === p.n);
      return { name: p.name, from: p.score - (got ? got.points : 0), to: p.score, me: p.n === s.you, color: p.color };
    }), (s.rounds + 1) * 100)}</div>
    ${outlierHTML(r.outliers, mine && mine.canonical)}
    <p class="muted center">Most common: <b>${esc(r.commonest.name)}</b></p>
    ${voteHTML(r.promptId)}
    ${host ? `<button class="btn primary" id="next">${last ? 'Final standings' : 'Next round'}</button>`
      : `<p class="muted center">Waiting for the host to continue.</p>`}
    </div>`);
  if (mine) buildUp(mine);
  raceUp();
  if (host) $('#next').onclick = e => { e.currentTarget.disabled = true; partyPost('/api/room/next', { round: s.round }); };
}

// ---- the score race: every player's round score climbs from 0 together. Higher scores take longer,
// so the best answer lands last, and each number pulses and takes the colour of the rarity it just reached.
function raceHTML(s, r) {
  return `<ul class="race card">${r.results.map(x => `<li class="racer${x.n === s.you ? ' me' : ''}" data-pts="${x.points}" data-out="${x.outlier ? 1 : 0}" data-t="0">
    ${avatar(x.name, colorOf(s, x.n), lookOf(s, x.n))}
    <span class="rmain"><b>${esc(x.name)}</b>
      <small class="rsub">${x.valid ? `${esc(x.canonical)} · ${x.share}% said it`
        : x.given ? `<span class="strike">${esc(x.given)}</span> · not on the list` : 'No answer'}</small>
      <span class="rbar"><i></i></span></span>
    <span class="rside"><span class="rnum">0</span><span class="rlabel">&nbsp;</span></span>
    <span class="rtags">${x.outlier ? '<span class="tag">Outlier</span>' : ''}${x.clash ? '<span class="tag">Teammate clash · 0</span>' : ''}${x.shared ? '<span class="tag">Shared ½</span>' : ''}${x.doubled ? '<span class="tag dbl">×2</span>' : ''}</span>
  </li>`).join('')}</ul>`;
}

function raceUp() {
  const rows = [...app.querySelectorAll('.racer')].map(el => ({
    el, to: +el.dataset.pts, out: el.dataset.out === '1', t: 0,
    num: $('.rnum', el), label: $('.rlabel', el), bar: $('.rbar i', el),
  }));
  if (!rows.length) return;
  const mark = (r, v, done) => {
    r.num.textContent = v;
    r.bar.style.width = Math.min(100, v / 1.5) + '%';   // full bar = an Outlier's 150
    const t = done && r.out ? 5 : tier(v);
    if (t !== r.t) {   // crossed a milestone: new colour, new label, and a pulse
      r.t = t;
      r.el.dataset.t = t;
      r.label.textContent = t ? TIERS[t] : ' ';
      r.el.classList.remove('pulse'); void r.el.offsetWidth; r.el.classList.add('pulse');
    }
  };
  const finish = () => {
    raceSkip = null;
    rows.forEach(r => { mark(r, r.to, true); r.el.classList.add('done'); });
  };
  if (calm()) return finish();
  const start = performance.now();
  const dur = r => 500 + Math.min(r.to, 100) * 24 + Math.max(0, r.to - 100) * 12;   // 100 points takes about 3 seconds; an Outlier a little longer
  let stopped = false;
  raceSkip = () => { stopped = true; finish(); };
  const frame = now => {
    if (stopped || !rows[0].el.isConnected) return;
    let live = false;
    rows.forEach(r => {
      if (r.el.classList.contains('done')) return;
      const k = Math.min(1, (now - start) / dur(r));
      mark(r, Math.round(r.to * (1 - Math.pow(1 - k, 1.7))), false);
      if (k >= 1) { mark(r, r.to, true); r.el.classList.add('done'); } else live = true;
    });
    if (live) requestAnimationFrame(frame); else raceSkip = null;
  };
  requestAnimationFrame(frame);
}

function awardsHTML(s) {
  if (!s.awards || !s.awards.length) return '';
  return `<section class="card"><h3>Awards</h3><ul class="awards">${s.awards.map(a => `<li>
    <span class="award-ic">${ic(a.icon)}</span>
    <span class="award-t"><b>${esc(a.title)}</b><small>${esc(a.detail)}</small></span>
    <span class="award-w">${a.winners.map(esc).join(' &amp; ')}</span></li>`).join('')}</ul></section>`;
}

function partyFinal(s, host) {
  if (s.mode === 'potato') return potatoFinal(s, host);
  const order = lanes(s), max = (s.rounds + 1) * 100, top = order[0];
  const tied = order.filter(p => p.score === top.score).length > 1;
  const asked = (s.asks || []).map(n => (s.players.find(p => p.n === n) || {}).name).filter(Boolean);
  const iAsked = (s.asks || []).includes(s.you);
  postPartyResult(s, (rankBy(order, p => p.score).find(r => r.p.n === s.you) || {}).rank);
  show(`${partyBar(s, 'Final standings')}
    ${s.teams && s.teamScores ? `<div class="center"><p class="muted">Team game</p><h2>${teamWinner(s)}</h2>
      <p class="muted">${s.teamScores[0]} – ${s.teamScores[1]}</p></div>${teamBarHTML(s)}
      <p class="muted center">Top player: <b>${esc(top.name)}</b> · ${top.score} paces</p>`
    : `<div class="center"><p class="muted">${tied ? 'Furthest from the crowd (tied)' : 'Furthest from the crowd'}</p>
      <h2>${esc(order.filter(p => p.score === top.score).map(p => p.name).join(' & '))}</h2>
      <p class="muted">${top.score} paces · ${zoneName(top.score, max)}</p></div>`}
    ${podiumHTML(s, rankBy(order, p => p.score), p => `${p.score} paces`)}
    <div class="card">${trailHTML(order.map(p => ({ name: p.name, from: 0, to: p.score, me: p.n === s.you, color: p.color })), max)}</div>
    <ol class="rows card players">${order.map((p, i) => `<li class="${p.n === s.you ? 'me' : ''}"><span class="num rank">${i + 1}</span>
      ${avatar(p.name, p.color, p.look)}
      <span class="main"><b>${esc(p.name)}</b><small>${zoneName(p.score, max)}</small></span><span class="num">${p.score}</span></li>`).join('')}</ol>
    ${awardsHTML(s)}
    ${(s.played || []).length ? `<section class="card"><h3>Your answers</h3><ul class="rows">${s.played.map(r => ansRowHTML({ ...r,
      canonical: r.valid ? r.answer : null, given: r.valid ? '' : r.answer }, r.promptId)).join('')}</ul></section>${ANS_HINT}` : ''}
    ${asked.length ? `<p class="muted center">${asked.map(esc).join(', ')} ${asked.length === 1 ? 'wants' : 'want'} a rematch</p>` : ''}
    ${host ? `<div class="stack"><button class="btn primary" id="again">Rematch<small>Same players and settings, fresh prompts</small></button>
      <button class="btn" id="lobby">Change category</button></div>`
      : `<button class="btn${iAsked ? '' : ' primary'}" id="ask" ${iAsked ? 'disabled' : ''}>${iAsked ? 'Rematch requested' : 'Ask for a rematch'}</button>
         <p class="muted center">The host starts the next game.</p>`}`);
  if ($('.podium.play')) sfx.podium();
  if (!host) { if ($('#ask')) $('#ask').onclick = () => partyPost('/api/room/ask'); return; }
  $('#again').onclick = () => partyPost('/api/room/rematch');
  $('#lobby').onclick = () => partyPost('/api/room/lobby');
}

// ------------------------------------------------------------ big screen
// A TV or laptop showing a party game to the room: big type, read from the sofa, and no controls but Leave. Phones
// still answer and the host's phone still runs the game. The screen has a view-only token of its own (it is never a
// player) and polls the room much like a phone does; the server forgets it after 30 seconds without a poll.

let tv = null;

// ---- sound. Phones and the big screen both play it (in a party with a big screen connected, only the TV does), and
// every sound is synthesised with Web Audio, so there are no files to load. Settings has the switch and the volume. Browsers keep audio off until the page gets a click or key press,
// so a TV opened from a ?tv= link shows a small "turn on sound" note until someone presses something.
const sfx = {
  ctx: null, master: null, noise: null, clockTimer: null, bus: null,
  get muted() { return !settings.sound; },
  gain() { return this.muted ? 0 : .75 * settings.volume; },
  level() { if (this.master) this.master.gain.setTargetAtTime(this.gain(), this.ctx.currentTime, .03); },
  log: [],   // in memory only, for debugging: names that played, and (names) that were skipped (muted, hidden, no audio yet)

  // Make or wake the audio context. From a click or key press it starts running; without one it waits, suspended.
  start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch { /* iPhone: follow the silent switch, don't stop music */ }
      try {
        const c = new AC(), comp = c.createDynamicsCompressor();
        comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = .005; comp.release.value = .2;
        comp.connect(c.destination);
        this.out = comp;
        this.master = c.createGain();
        this.master.gain.value = this.gain();
        this.master.connect(comp);
        const len = c.sampleRate * 2, d = (this.noise = c.createBuffer(1, len, c.sampleRate)).getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        c.onstatechange = () => { sfxBanner(); music.sync(); };
        this.ctx = c;
      } catch { return; }
    }
    if (this.ctx.state !== 'running') this.ctx.resume().then(sfxBanner, () => {});
  },
  live() { return !!(this.ctx && this.ctx.state === 'running' && !this.muted && !document.hidden && (tv || !(party && party.screens))); },
  play(name, arg, delay = 0) {
    const ok = this.live();
    this.log.push(ok ? name : `(${name})`);
    if (this.log.length > 400) this.log.shift();
    if (!ok) return;
    if (name !== 'tick') music.duck(delay);
    try { SFX[name](this.ctx.currentTime + .01 + delay, arg); } catch { /* a sound must never break the screen */ }
  },
  // Several at once (six phones locking in on the same poll): staggered and capped so they don't blast.
  many(name, n, gap = .06, cap = 5) { for (let i = 0; i < Math.min(n, cap); i++) this.play(name, undefined, i * gap); },
  // Plays fn's sounds through a volume knob of their own and returns a function that fades them out (a skipped count-up).
  scoped(fn) {
    if (!this.live()) return () => {};
    const g = this.ctx.createGain();
    g.connect(this.master);
    this.bus = g;
    try { fn(); } finally { this.bus = null; }
    return () => { try { g.gain.setTargetAtTime(0, this.ctx.currentTime, .02); } catch { /* gone */ } };
  },
  setMute(on) {   // the big screen's speaker button and M key: sound effects and music together
    settings.music = !on;
    setSetting('sound', !on);   // also hushes anything already scheduled
    if (!on) this.start();
    const b = $('#tvSnd');
    if (b) { b.innerHTML = ic(on ? 'mute' : 'vol'); b.setAttribute('aria-label', on ? 'Turn sound on' : 'Turn sound off'); }
    sfxBanner();
  },
  // Ticks for the last 10 seconds of a clock, from the TV's own deadline; one interval, cleared on every screen change.
  clock(ms, buzz) {
    this.stopClock();
    if (!(ms > 0)) return;
    const end = performance.now() + ms;
    let last = Math.ceil(ms / 1000);
    this.clockTimer = setInterval(() => {
      const left = end - performance.now();
      if (left <= 0) { this.stopClock(); if (buzz) this.play('buzzer'); return; }
      const n = Math.ceil(left / 1000);
      if (n !== last) { last = n; if (n <= 10) this.play('tick', n); }
    }, 50);
  },
  stopClock() { clearInterval(this.clockTimer); this.clockTimer = null; },
  // The end-of-game podium: a thud as each step rises, then a fanfare and a cheer with the confetti (see .podium.play in the CSS).
  podium() {
    [.1, .45, .8].forEach((d, i) => this.play('step', i, d));
    this.play('fanfare', undefined, 1.4);
    this.play('cheer', undefined, 1.4);
  },
};

function sfxBanner() {
  const need = !!(tv && sfx.ctx && sfx.ctx.state !== 'running' && !sfx.muted);
  let el = document.getElementById('tvSound');
  if (need && !el) {
    el = Object.assign(document.createElement('div'), { id: 'tvSound', className: 'tv-sound', innerHTML: `${ic('vol')}<span>Press OK / click to turn on sound</span>` });
    document.body.append(el);
  } else if (!need && el) el.remove();
}
// Browsers only allow sound after a tap or key press, so the first one wakes the audio up.
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if ((settings.sound || settings.music) && (!sfx.ctx || sfx.ctx.state !== 'running')) sfx.start(); }, true));
document.addEventListener('visibilitychange', () => music.sync());
document.addEventListener('keydown', e => {
  if (!tv || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'm' && e.key !== 'M')) return;
  sfx.setMute(!sfx.muted);
  toast(sfx.muted ? 'Sound off' : 'Sound on');
});

// Building blocks: a tone with a quick attack and an exponential fade (optionally gliding, optionally low-passed),
// and a burst of filtered noise.
function sfxTone(t, f, dur, { type = 'sine', vol = .3, to = 0, attack = .005, lp = 0 } = {}) {
  const c = sfx.ctx, o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(attack, dur * .9));
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  let out = o;
  if (lp) { const b = c.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = lp; out = out.connect(b); }
  out.connect(g).connect(sfx.bus || sfx.master);
  o.start(t); o.stop(t + dur + .05);
}
function sfxNoise(t, dur, { vol = .2, filter = 'bandpass', f = 1000, to = 0, q = 1, attack = .005 } = {}) {
  const c = sfx.ctx, src = c.createBufferSource(), b = c.createBiquadFilter(), g = c.createGain();
  src.buffer = sfx.noise; src.loop = true;
  b.type = filter; b.Q.value = q;
  b.frequency.setValueAtTime(f, t);
  if (to) b.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(attack, dur * .9));
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  src.connect(b).connect(g).connect(sfx.bus || sfx.master);
  src.start(t, Math.random() * 1.5); src.stop(t + dur + .05);
}

const C_MAJ = [523.25, 659.25, 783.99, 1046.5];
const SFX = {
  pop(t) { sfxTone(t, 480, .13, { to: 1200, vol: .26 }); sfxTone(t + .03, 1600, .07, { type: 'triangle', vol: .05 }); },
  sting(t) {
    [784, 1175, 1568].forEach((f, i) => sfxTone(t + i * .06, f, .55 - i * .1, { type: 'triangle', vol: .16 }));
    sfxNoise(t, .3, { filter: 'highpass', f: 6000, vol: .05 });
  },
  stingSoft(t) { sfxTone(t, 523.25, .35, { type: 'triangle', vol: .12 }); sfxTone(t + .1, 783.99, .5, { vol: .12 }); },
  tick(t, n) {   // n = seconds left: tick/tock, then higher and louder for the last three
    const hot = n <= 3;
    sfxTone(t, hot ? 1760 : n % 2 ? 1250 : 930, hot ? .1 : .06, { type: 'triangle', vol: hot ? .3 : .16, attack: .002 });
    sfxNoise(t, .02, { filter: 'highpass', f: 4000, vol: hot ? .08 : .04, attack: .001 });
  },
  buzzer(t) { [110, 116.5].forEach(f => sfxTone(t, f, .75, { type: 'sawtooth', vol: .2, attack: .01, lp: 1100 })); },
  lock(t) { sfxTone(t, 660, .1, { to: 1320, vol: .2 }); sfxNoise(t, .03, { filter: 'highpass', f: 3000, vol: .07, attack: .001 }); },
  swoosh(t) { sfxNoise(t, .34, { f: 450, to: 3600, q: 1.2, vol: .2, attack: .16 }); },
  thud(t) { sfxTone(t, 140, .3, { to: 48, vol: .38 }); sfxNoise(t, .08, { filter: 'lowpass', f: 400, vol: .12 }); },
  drumroll(t, dur = 1.6) {   // low hits that speed up and swell, over a building snare hiss
    for (let at = 0, gap = .11; at < dur - .03; at += gap, gap = Math.max(.045, gap * .93)) {
      const k = at / dur;
      sfxTone(t + at, 95, .09, { to: 60, vol: .1 + .25 * k });
      sfxNoise(t + at, .05, { f: 1800, q: .7, vol: .04 + .1 * k, attack: .002 });
    }
    sfxNoise(t, dur, { f: 1500, q: .5, vol: .09, attack: dur * .9 });
  },
  hit(t) {
    sfxTone(t, 160, .5, { to: 45, vol: .5 });
    sfxNoise(t, .25, { filter: 'lowpass', f: 2500, vol: .22 });
    [523.25, 783.99].forEach(f => sfxTone(t, f, .7, { type: 'triangle', vol: .09 }));
  },
  crash(t) { sfxNoise(t, 1.8, { filter: 'highpass', f: 5000, vol: .2, attack: .003 }); sfxNoise(t, .6, { f: 3000, q: .6, vol: .1 }); },
  fanfare(t) {
    C_MAJ.forEach((f, i) => sfxTone(t + i * .1, f, .26, { type: 'triangle', vol: .17 }));
    C_MAJ.forEach(f => sfxTone(t + .42, f, 1.2, { type: 'sawtooth', vol: .045, lp: 2200, attack: .03 }));
    sfxTone(t + .42, 261.63, 1.2, { type: 'triangle', vol: .12, attack: .03 });
  },
  tally(t, dur = 1.5) {   // ticks rising in pitch while the scores count up
    const n = Math.max(6, Math.round(dur / .07));
    for (let i = 0; i < n; i++) sfxTone(t + i * dur / n, 600 * Math.pow(2, 1.5 * i / n), .05, { type: 'triangle', vol: .1, attack: .002 });
    sfxTone(t + dur, 1700, .25, { type: 'triangle', vol: .1 });
  },
  step(t, i = 0) { sfxTone(t, 95 - i * 10, .35, { to: 40, vol: .45 }); sfxNoise(t, .12, { filter: 'lowpass', f: 300, vol: .18 }); },
  cheer(t) {
    sfxNoise(t, 2.8, { f: 1100, q: .4, vol: .15, attack: .7 });
    sfxNoise(t, 2.5, { f: 2600, q: .8, vol: .05, attack: .6 });
    for (let i = 0; i < 7; i++) {   // a few "whoo"s from the crowd
      const at = t + .2 + Math.random() * 1.6, f = 650 + Math.random() * 600;
      sfxTone(at, f, .32, { to: f * 1.7, vol: .045, attack: .04 });
    }
  },
  nope(t) { sfxTone(t, 330, .12, { type: 'triangle', vol: .16 }); sfxTone(t + .1, 233, .2, { type: 'triangle', vol: .16 }); },
  ding(t) { sfxTone(t, 1318.5, .7, { vol: .2, attack: .003 }); sfxTone(t, 2637, .35, { vol: .05, attack: .003 }); },
  whoosh(t) { sfxNoise(t, .36, { f: 300, to: 1800, q: 1, vol: .15, attack: .17 }); },
  boom(t, heavy) {   // a low drop and a burst; heavier when the player is out
    sfxTone(t, heavy ? 120 : 150, heavy ? 1.2 : .7, { to: 30, vol: .6 });
    sfxNoise(t, heavy ? 1 : .5, { filter: 'lowpass', f: heavy ? 1400 : 900, to: 100, vol: heavy ? .45 : .3 });
    if (heavy) sfxTone(t + .15, 60, 1, { to: 25, vol: .4 });
  },
};

// ---- background music: a light, bouncy eight-bar loop in C (C, Am, F, G, C, Em, F, G), synthesised like the sound
// effects and scheduled a moment ahead on the audio clock. Soft chords and an arpeggio on menus; a kick, hats and a
// bassline join while a clock is running; a little lead tune comes in every other time round. It dips whenever a sound
// effect plays, follows Settings (on/off, its own volume), stops when the page is hidden, and in a party with a big
// screen connected only the TV plays it.
const MIDI = n => 440 * Math.pow(2, (n - 69) / 12);
const SONG = [[48, [60, 64, 67, 72]], [45, [57, 60, 64, 69]], [41, [57, 60, 65, 69]], [43, [55, 59, 62, 67]],
  [48, [60, 64, 67, 72]], [40, [55, 59, 64, 67]], [41, [57, 60, 65, 69]], [43, [55, 59, 62, 65]]];
const ARP = [[0, 2, 1, 3, 2, 1, 3, 2], [0, 1, 2, 3, 1, 2, 3, 1]];
const TUNE = [[76, 0, 0, 79, 0, 77, 76, 0], [72, 0, 0, 76, 0, 0, 0, 0], [77, 0, 0, 76, 0, 74, 72, 0], [74, 0, 0, 0, 71, 0, 0, 0],
  [76, 0, 0, 79, 0, 81, 79, 0], [79, 0, 0, 76, 0, 0, 0, 0], [77, 0, 76, 0, 74, 0, 72, 0], [74, 0, 0, 0, 0, 0, 0, 0]];
const music = {
  gain: null, timer: null, stopT: null, step: 0, next: 0, energy: 0, BPM: 104,
  wanted() {
    return !!(settings.music && sfx.ctx && sfx.ctx.state === 'running' && !document.hidden && (tv || !(party && party.screens)));
  },
  target() { return this.wanted() ? .4 * settings.musicVol : 0; },
  level() { if (this.gain) this.gain.gain.setTargetAtTime(this.target(), sfx.ctx.currentTime, .6); },
  sync() {
    if (!sfx.ctx || !sfx.out) return;
    if (this.wanted()) {
      if (!this.gain) { this.gain = sfx.ctx.createGain(); this.gain.gain.value = 0; this.gain.connect(sfx.out); }
      clearTimeout(this.stopT); this.stopT = null;
      if (!this.timer) { this.next = 0; this.timer = setInterval(() => this.schedule(), 90); this.schedule(); }
    } else if (this.timer && !this.stopT) {
      this.stopT = setTimeout(() => { clearInterval(this.timer); this.timer = null; this.stopT = null; }, 2500);   // after the fade
    }
    this.level();
  },
  // Sound effects sit on top: the music drops back for a moment and comes up again.
  duck(delay = 0) {
    if (!this.gain || !this.timer) return;
    const t = sfx.ctx.currentTime + delay, g = this.gain.gain, base = this.target();
    g.cancelScheduledValues(t);
    g.setTargetAtTime(base * .4, t, .03);
    g.setTargetAtTime(base, t + .5, .35);
  },
  schedule() {
    const c = sfx.ctx, step = 60 / this.BPM / 4;
    if (this.next < c.currentTime) this.next = c.currentTime + .05;
    while (this.next < c.currentTime + .3) {
      sfx.bus = this.gain;
      try { this.notes(this.step, this.next); } catch { /* never break the page */ } finally { sfx.bus = null; }
      this.step = (this.step + 1) % 256;
      this.next += step;
    }
  },
  notes(n, t) {
    const bar = (n >> 4) % 8, i = n & 15, [root, chord] = SONG[bar], busy = this.energy > 0;
    if (i % 2 === 0) {   // the arpeggio, on every eighth
      sfxTone(t, MIDI(chord[ARP[bar % 2][i >> 1]]), .26, { type: 'triangle', vol: busy ? .085 : .07, lp: 2600, attack: .006 });
      const lead = TUNE[bar][i >> 1];
      if (lead && (n >> 7) % 2 === 1) sfxTone(t, MIDI(lead), .3, { type: 'square', vol: .028, lp: 1700, attack: .01 });
    }
    if (i === 0) chord.slice(0, 3).forEach(m => sfxTone(t, MIDI(m - 12), 2.1, { type: 'sine', vol: .035, attack: .25 }));   // a soft pad under each bar
    if (!busy) { if (i === 0 || i === 8) sfxTone(t, MIDI(root + 12), .5, { vol: .09 }); return; }
    if (i === 0 || i === 6 || i === 10) sfxTone(t, MIDI(root + 12), .24, { type: 'triangle', vol: .13, lp: 700 });
    if (i === 0 || i === 8) sfxTone(t, 115, .16, { to: 48, vol: .2 });
    if (i === 4 || i === 12) sfxNoise(t, .09, { f: 1700, q: .8, vol: .045, attack: .002 });
    if (i % 4 === 2) sfxNoise(t, .035, { filter: 'highpass', f: 7500, vol: .04, attack: .001 });
  },
};

// Hooks for runReveal, on the big screen and on phones in a party without one.
const tvRevealFx = {
  drum: () => sfx.play('drumroll'),
  card(g, last) {
    if (g.x.outlier) { sfx.play('hit'); sfx.play('crash'); sfx.play('fanfare', undefined, .15); }
    else if (last) sfx.play('hit');
    else sfx.play(g.x.valid ? 'swoosh' : 'thud');
  },
};

async function joinScreen(code) {
  code = String(code || '').trim().toUpperCase().slice(0, 4);
  if (code.length < 4) return toast('Enter the 4-letter room code');
  const saved = store.get('outlier.screen');
  if (saved && saved.code === code) return enterScreen(code, saved.sid);   // a refreshed TV keeps its token
  try {
    const r = await api('/api/room/screen', { code });
    enterScreen(r.code, r.sid);
  } catch (e) {
    toast(e.message);
    if (!$('#tvJoin')) { history.replaceState(null, '', location.pathname); home(); }   // a stale ?tv= link
  }
}

function enterScreen(code, sid) {
  stopTimer();
  store.set('outlier.screen', { code, sid });
  history.replaceState(null, '', `/?tv=${code}`);
  document.documentElement.classList.add('tv');
  tv = { code, sid, key: null, busy: false, revealTimers: [], fx: tvRevealFx };
  stayAwake(true);
  sfx.start();
  music.sync();
  setTimeout(sfxBanner, 400);   // still suspended by then: no click opened this screen
  window.addEventListener('resize', tvFit);
  tv.poll = setInterval(pollScreen, 1000);
  pollScreen();
}

function leaveScreen(msg) {
  if (!tv) return;
  api('/api/room/screen/leave', { code: tv.code, sid: tv.sid }).catch(() => {});
  clearInterval(tv.poll);
  tv.revealTimers.forEach(clearTimeout);
  if (tv.ro) tv.ro.disconnect();
  if (tv.mo) tv.mo.disconnect();
  window.removeEventListener('resize', tvFit);
  stayAwake(false);
  tv = null;
  music.sync();
  stopTimer();
  sfx.stopClock();
  sfxBanner();
  store.del('outlier.screen');
  document.documentElement.classList.remove('tv');
  history.replaceState(null, '', location.pathname);
  home();
  if (msg) toast(msg);
}

async function pollScreen() {
  const me = tv;
  if (!me || me.busy) return;
  me.busy = true;
  try {
    const s = await api(`/api/room/screen/state?code=${me.code}&sid=${me.sid}`);
    if (tv !== me) return;
    renderScreen(s);
    const every = s.phase === 'potato' ? 500 : 1000;
    if (me.every !== every) { clearInterval(me.poll); me.poll = setInterval(pollScreen, every); me.every = every; }
  } catch (e) {
    if (tv !== me) return;
    if (e.status === 410) {   // the tab slept past the server's 30 seconds: sign the screen back in
      try {
        const r = await api('/api/room/screen', { code: me.code });
        me.sid = r.sid;
        store.set('outlier.screen', { code: me.code, sid: r.sid });
      } catch (e2) { if (e2.status === 404) leaveScreen('That room has closed'); }
    } else if (e.status === 404) leaveScreen('That room has closed');
  } finally { me.busy = false; }
}

function renderScreen(s) {
  const key = [s.phase, s.round, s.phase === 'potato' && !!s.boom && s.boom.turn === s.turnId && s.breakMs > 0].join('|');
  if (key !== tv.key) {
    tv.key = key;
    stopTimer();
    sfx.stopClock();
    tv.revealTimers.forEach(clearTimeout);
    tv.revealTimers = [];
    tv.seenKey = tv.locked = tv.ptTurn = null;
    ({ lobby: tvLobby, pick: tvPick, question: tvQuestion, reveal: tvReveal, final: tvFinal, potato: tvPotato })[s.phase](s);
  }
  if (s.phase === 'lobby') tvLobbyUpdate(s);
  if (s.phase === 'pick') tvTicks(s, p => p.picked, on => on ? 'Ready' : 'Deciding…');
  if (s.phase === 'question') {
    const n = tvTicks(s, p => p.answered, on => on ? 'Locked in' : 'Thinking…');
    $('#tvLocked').innerHTML = `<b>${n.in}</b> of ${n.all} locked in · answer on your phone`;
  }
  if (s.phase === 'potato') tvPotatoUpdate(s);
}

// Keep a big screen from dimming or starting its screensaver mid-game. Browsers that support it get a screen wake
// lock (taken again whenever the page comes back into view, since the browser drops it when hidden). TVs whose
// browsers don't, keep playing a tiny silent video drawn from a canvas, which most TVs treat as "something's playing".
const awake = { lock: null, video: null, timer: null, on: false };
async function stayAwake(on) {
  awake.on = on;
  if (!on) {
    try { if (awake.lock) await awake.lock.release(); } catch { /* already gone */ }
    awake.lock = null;
    clearInterval(awake.timer);
    if (awake.video) { awake.video.remove(); awake.video = null; }
    return;
  }
  let locked = false;
  try { if ('wakeLock' in navigator) { awake.lock = await navigator.wakeLock.request('screen'); locked = true; } } catch { /* refused: fall back */ }
  if (!locked && !awake.video) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      const g = c.getContext('2d');
      awake.timer = setInterval(() => { g.fillStyle = `rgb(${Date.now() % 255},0,0)`; g.fillRect(0, 0, 2, 2); }, 1000);
      const v = awake.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true, loop: true });
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:.01;pointer-events:none;bottom:0;left:0';
      v.srcObject = c.captureStream(1);
      document.body.append(v);
      v.play().catch(() => {});
    } catch { /* no canvas streams either: nothing more we can do */ }
  }
}
document.addEventListener('visibilitychange', () => { if (awake.on && document.visibilityState === 'visible') stayAwake(true); });
// The TV's Leave button only shows for a few seconds after the mouse moves or a remote key is pressed.
let tvWake = null;
['pointermove', 'pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
  if (!tv) return;
  document.documentElement.classList.add('tv-poke');
  clearTimeout(tvWake);
  tvWake = setTimeout(() => document.documentElement.classList.remove('tv-poke'), 3500);
}));
document.addEventListener('pointerdown', () => { if (awake.on && awake.video && awake.video.paused) awake.video.play().catch(() => {}); });

// Every TV screen: the logo, what's happening, the join details, and a small Leave in the corner.
function tvShow(s, mid, body, cls) {
  show(`<header class="tv-top"><div class="logo">Outl<b>i</b>er</div><span class="tv-mid">${mid}</span>
      <span class="tv-join">${esc(location.host)} · <b>${esc(s.code)}</b></span></header>
    <section class="tv-main"><div class="tv-fit ${cls}" id="tvFit">${body}</div></section>
    <div class="tv-ctl"><button class="tv-snd" id="tvSnd" aria-label="${sfx.muted ? 'Turn sound on' : 'Turn sound off'}">${ic(sfx.muted ? 'mute' : 'vol')}</button>
      <button class="tv-leave" id="tvLeave">${ic('x')}<span>Leave</span></button></div>`);
  $('#tvLeave').onclick = () => leaveScreen();
  $('#tvSnd').onclick = () => sfx.setMute(!sfx.muted);
  tvWatchFit();
}

// A TV never scrolls: whatever a screen holds is shrunk (never grown) to fit the space under the top bar, and
// re-fitted whenever it changes size (players joining, reveal cards landing, the window resizing).
// Shrinking widens the box first (width / scale) so text re-wraps into the extra room before it gets smaller.
function tvFit() {
  const main = app.querySelector('.tv-main'), fit = $('#tvFit');
  if (!main || !fit) return;
  const W = main.clientWidth, H = main.clientHeight;
  if (!W || !H) return;
  let k = 1;
  for (let i = 0; i < 5; i++) {
    fit.style.width = `${W / k}px`;
    const h = fit.scrollHeight, next = Math.min(1, H / h);
    if (Math.abs(next - k) < .005) { k = next; break; }
    k = next;
  }
  fit.style.width = `${W / k}px`;
  const top = Math.max(0, (H - fit.scrollHeight * k) / 2);   // centred top to bottom when it's shorter than the screen
  fit.style.transform = `translate(0, ${top}px) scale(${k})`;
  main.scrollTop = 0;
}

function tvWatchFit() {
  if (tv && tv.ro) tv.ro.disconnect();
  const fit = $('#tvFit');
  if (!tv || !fit) return;
  let queued = false;
  const again = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; tvFit(); }, 30); };   // a timer, not a frame: frames pause when the page isn't drawn
  if ('ResizeObserver' in window) {
    tv.ro = new ResizeObserver(again);
    [...fit.children].forEach(c => tv.ro.observe(c));   // the children, not the box: tvFit itself resizes the box
    tv.mo = tv.mo || new MutationObserver(again);
    tv.mo.disconnect();
    tv.mo.observe(fit, { childList: true, subtree: true });
  }
  tvFit();
  setTimeout(tvFit, 700);   // after entrance animations and fonts settle
}

const tvRound = s => `Round ${s.round} of ${s.rounds}`;
const tvClock = () => '<div class="tv-clock"><div class="timer grow"><i id="tbar"></i></div><span class="secs" id="tsecs"></span></div>';
const tvStandings = s => `<ol class="tv-standings">${rankBy(lanes(s), p => p.score).map(({ p, rank }) => `<li>
    <span class="num rank">${rank}</span>${avatar(p.name, p.color, p.look)}<b>${esc(p.name)}</b><span class="num">${p.score}</span></li>`).join('')}</ol>`;

function tvSetupHTML(s) {
  const u = s.setup || { mode: s.mode, label: s.label, rounds: s.rounds, secs: s.secs, lives: s.lives || 3 };
  const bits = u.mode === 'potato' ? ['Fumble', u.label, `${u.lives} ${u.lives === 1 ? 'life' : 'lives'}`, `${u.secs}s turns`]
    : ['Classic', u.label, `${u.rounds} rounds`, `${u.secs}s to answer`];
  return bits.map(b => `<span>${esc(b)}</span>`).join('');
}

function tvLobby(s) {
  tvShow(s, 'Lobby', `
    <div class="tv-codebox">
      <p class="tv-hint">Join at <b>${esc(location.host)}</b> with code</p>
      <div class="tv-roomcode">${esc(s.code)}</div>
      <div class="tv-setup" id="tvSetup"></div>
    </div>
    <div class="tv-room">
      <h2 class="tv-h">Who's in <small id="tvCount"></small></h2>
      <ul class="tv-crowd" id="tvPlayers"></ul>
      <p class="tv-sub"><span class="dots"><i></i><i></i><i></i></span> Waiting for the host to start the game</p>
    </div>`, 'tv-lobby');
}

// Players pop in as they join; the list is only redrawn when someone joins, leaves or changes their look.
function tvLobbyUpdate(s) {
  const setup = tvSetupHTML(s);
  if ($('#tvSetup').innerHTML !== setup) $('#tvSetup').innerHTML = setup;
  const key = s.host + '|' + s.players.map(p => `${p.n}.${p.name}.${p.color}.${p.look}.${p.online}`).join('|');
  if (key === tv.seenKey) return;
  tv.seenKey = key;
  const seen = tv.seen || new Set();
  if (tv.seen) sfx.many('pop', s.players.filter(p => !seen.has(p.n)).length);   // not for everyone already there when the TV opens
  $('#tvPlayers').innerHTML = s.players.map((p, i) => `<li class="${seen.has(p.n) ? '' : 'pop'}${p.online ? '' : ' off'}" style="--d:${(i % 12) * .06}s">
    ${avatar(p.name, p.color, p.look)}<b>${esc(p.name)}</b>${p.n === s.host ? '<small>Host</small>' : ''}</li>`).join('');
  tv.seen = new Set(s.players.map(p => p.n));
  $('#tvCount').textContent = s.players.length;
}

// A row of avatars that light up as players get done (decided, or locked in). Returns the counts.
function tvTicks(s, on, label) {
  const live = s.players.filter(p => p.online || on(p));
  const now = new Set(live.filter(on).map(p => p.n)), was = tv.locked;
  tv.locked = now;
  if (was) sfx.many('lock', [...now].filter(n => !was.has(n)).length);
  const el = $('#tvTicks');
  if (el) el.innerHTML = live.map(p => `<li class="${now.has(p.n) ? 'in' : ''}${was && now.has(p.n) && !was.has(p.n) ? ' pop' : ''}">
    ${avatar(p.name, p.color, p.look)}<b>${esc(p.name)}</b><small>${label(now.has(p.n))}</small></li>`).join('');
  return { in: now.size, all: live.length };
}

function tvPick(s) {
  tvShow(s, tvRound(s), `
    <p class="tv-hint">Next prompt is from</p>
    <div class="tv-hintbig">${esc(s.hint)}</div>
    ${tvClock()}
    <p class="tv-sub">Double down or play it straight? Decide on your phone.</p>
    <ul class="tv-ticks" id="tvTicks"></ul>`, 'tv-stage');
  runTimer(s.remainingMs, s.roundMs, () => {});
  sfx.play('stingSoft');
  sfx.clock(s.remainingMs, false);
}

function tvQuestion(s) {
  tvShow(s, tvRound(s), `
    <p class="tv-hint">${esc(s.hint)}</p>
    <h1 class="tv-prompt">${esc(s.prompt)}</h1>
    ${tvClock()}
    <ul class="tv-ticks" id="tvTicks"></ul>
    <p class="tv-sub" id="tvLocked"></p>`, 'tv-stage');
  runTimer(s.remainingMs, s.roundMs, () => {});
  sfx.play('sting');
  sfx.clock(s.remainingMs, true);
}

// The reveal plays once a round on the TV (the phones skip theirs), then the score race and standings.
function tvReveal(s) {
  if (tv.revealed === s.round || calm()) return tvScores(s);
  tv.revealed = s.round;
  tvShow(s, tvRound(s), revealShellHTML(s.reveal.prompt, false), 'tv-rv');
  runReveal(tv, s, () => tvScores(s));
}

function tvScores(s) {
  const r = s.reveal;
  tvShow(s, tvRound(s), `
    <div class="tv-col">
      <p class="tv-hint">${esc(r.prompt)}</p>
      ${raceHTML(s, r)}
    </div>
    <div class="tv-col">
      ${teamBarHTML(s)}
      <section class="card"><h3>Standings</h3>${tvStandings(s)}</section>
    </div>
    <p class="tv-sub tv-foot">Waiting for the host to ${s.round >= s.rounds ? 'show the final standings' : 'start the next round'}</p>`, 'tv-scores');
  raceUp();
  const top = Math.max(0, ...r.results.map(x => x.points));   // as long as the slowest racer, within 0.6-2 seconds
  if (top > 0 && !calm()) sfx.play('tally', Math.min(2, Math.max(.6, (500 + Math.min(top, 100) * 24) / 1000)));
}

function tvFinal(s) {
  if (s.mode === 'potato') return tvPotatoFinal(s);
  const order = lanes(s), max = (s.rounds + 1) * 100, top = order[0];
  const winners = order.filter(p => p.score === top.score);
  tvShow(s, 'Final standings', `
    <div class="tv-col">
      ${s.teams && s.teamScores ? `<div class="tv-win"><p class="tv-hint">Team game</p><h1>${teamWinner(s)}</h1>
        <p class="tv-sub">${s.teamScores[0]} – ${s.teamScores[1]}</p></div>${teamBarHTML(s)}`
      : `<div class="tv-win"><p class="tv-hint">${winners.length > 1 ? 'Furthest from the crowd (tied)' : 'Furthest from the crowd'}</p>
        <h1>${esc(winners.map(p => p.name).join(' & '))}</h1><p class="tv-sub">${top.score} paces · ${zoneName(top.score, max)}</p></div>`}
      ${podiumHTML(s, rankBy(order, p => p.score), p => `${p.score} paces`)}
    </div>
    <div class="tv-col">${awardsHTML(s)}<section class="card"><h3>Standings</h3>${tvStandings(s)}</section></div>`, 'tv-final');
  if ($('.podium.play')) sfx.podium();
}

function tvPotatoFinal(s) {
  const byN = Object.fromEntries(s.players.map(p => [p.n, p]));
  const order = s.standings.map(n => byN[n]).filter(Boolean), win = order[0];
  const answers = s.log.filter(l => !l.timeout);
  const best = answers.reduce((a, l) => (!a || l.points > a.points ? l : a), null);
  tvShow(s, 'Fumble · Final', `
    <div class="tv-col">
      <div class="tv-win"><p class="tv-hint">Last one standing</p><h1>${esc(win ? win.name : '')}</h1>
        <p class="tv-sub">${win ? `${win.lives} ${win.lives === 1 ? 'life' : 'lives'} left · ${win.score} points` : ''}</p></div>
      ${podiumHTML(s, order.map((p, i) => ({ p, rank: i + 1 })), p => `${p.score} pts`)}
    </div>
    <div class="tv-col">
      ${best ? `<section class="card"><h3>Best answer</h3><p class="tv-best"><b>${esc(best.answer)}</b> by ${esc(best.name)} · +${best.points}${best.outlier ? ' · Outlier!' : ''}</p></section>` : ''}
      <section class="card"><h3>Standings</h3><ol class="tv-standings">${order.map((p, i) => `<li><span class="num rank">${i + 1}</span>
        ${avatar(p.name, p.color, p.look)}<b>${esc(p.name)}<small>${p.out ? 'Out' : 'Still standing'}</small></b><span class="num">${p.score}</span></li>`).join('')}</ol></section>
    </div>`, 'tv-final');
  if ($('.podium.play')) sfx.podium();
}

// Fumble: whose turn it is, big, with the prompt and the clock; everyone's lives and the answers so far alongside.
function tvPotato(s) {
  if (s.boom && s.boom.turn === s.turnId && s.breakMs > 0) {
    tvShow(s, `Fumble · Prompt ${s.round}`, potatoBreakHTML(s), 'tv-break');
    return sfx.play(s.boom.draw ? 'ding' : 'boom', !!s.boom.out);
  }
  sfx.play('sting');
  tvShow(s, `Fumble · Prompt ${s.round}`, `
    <div class="tv-col tv-turn">
      <p class="tv-hint">${esc(s.hint)}</p>
      <h1 class="tv-prompt">${esc(s.prompt)}</h1>
      <p class="pt-left" id="ptLeft"></p>
      <div class="tv-cur" id="tvCur"></div>
      ${tvClock()}
      <p class="tv-sub"><b id="ptSaid"></b> said so far · answer on your phone when it's your turn</p>
    </div>
    <div class="tv-col">
      <div id="ptTable"></div>
      <section class="card tv-log"><h3>Said so far</h3><div id="ptLog"></div></section>
    </div>`, 'tv-potato');
}

function tvPotatoUpdate(s) {
  if (!$('#tvCur')) return;
  $('#ptTable').innerHTML = potatoTable(s);
  setLog(potatoLog(s, LOGCTX()));
  $('#ptSaid').textContent = s.said;
  ptLeft(s);
  potatoPop(s);
  if (tv.ptSaid !== undefined && s.said > tv.ptSaid) sfx.play('ding');   // a new answer went on the list
  tv.ptSaid = s.said;
  if (tv.ptTurn === s.turnId) return;   // the rest only changes when the turn does
  if (tv.ptTurn != null) sfx.play('whoosh', undefined, .12);   // passed on (not the first turn of a prompt)
  const turn = tv.ptTurn = s.turnId;
  sfx.stopClock();
  const cur = s.players.find(p => p.n === s.current) || {};
  $('#tvCur').innerHTML = `${avatar(cur.name, cur.color, cur.look)}<b>${esc(cur.name || '')}</b><span>Your turn!</span>`;
  if (s.startsInMs > 0) {   // a new prompt: time to read it before the clock starts
    stopTimer();
    $('#tsecs').textContent = 'Ready';
    $('#tbar').style.width = '100%';
    setTimeout(() => { if (tv && tv.ptTurn === turn && $('#tvCur')) { runTimer(s.remainingMs, s.roundMs, () => {}); sfx.clock(s.remainingMs, false); } }, s.startsInMs);
  } else { runTimer(s.remainingMs, s.roundMs, () => {}); sfx.clock(s.remainingMs, false); }
}

// ------------------------------------------------------------ You: personal stats and badges
// Worked out by the server from every answer this browser (or your account) has given, your dailies and party games.

const statsQuery = () => `/api/me/stats?cid=${encodeURIComponent(playerId())}&streak=${streakNow().best || 0}`;
const fmtDay = ts => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function badgeHTML(b) {
  return `<li class="badge${b.earned ? ' got' : ''}" title="${esc(b.desc)}">
    <span class="badge-ic">${ic(b.earned ? b.icon : 'lock')}</span>
    <b>${esc(b.name)}</b><small>${esc(b.desc)}</small>
    <span class="badge-p">${b.earned ? (b.earnedAt ? fmtDay(b.earnedAt) : 'Earned') : esc(b.progress)}</span></li>`;
}

function youPlusHTML(st) {
  if (st.categories.locked) return `<button class="upsell-row card" id="youPlus"><span class="award-ic">${ic('lock')}</span>
    <span class="award-t"><b>Your categories</b><small>Your average score in each category, with Outlier Plus</small></span>${ic('right', 'chev')}</button>`;
  const cats = st.categories.filter(c => c.answers);
  const best = Math.max(1, ...cats.map(c => c.avgPoints));   // bars are measured against your best category
  return `<section class="card"><h3>By category</h3>${cats.length ? `<ul class="rows catstats">${cats.map(c => `<li>
      <span class="award-ic">${ic(CAT_ICON[c.id] || 'sparkles')}</span>
      <span class="main"><b>${esc(c.label)}</b><small>${c.answers} answer${c.answers === 1 ? '' : 's'} · ${c.correctPct}% right</small>
        <span class="cat-bar" aria-hidden="true"><i style="width:${(100 * c.avgPoints / best).toFixed(1)}%"></i></span></span>
      <span class="num">${c.avgPoints}<small>avg score</small></span></li>`).join('')}</ul>` : '<p class="muted">Play a few prompts to see how you do in each category.</p>'}</section>`;
}

async function youPage() {
  stopTimer();
  const name = store.get('outlier.name', '') || 'You';
  const head = `${topbar('You')}
    <section class="you-head card">
      ${avatar(name, store.get('outlier.color', 0), store.get('outlier.look'))}
      <span class="you-name"><b>${esc(name)}</b><small>${me ? esc(me.email) : 'Stats saved on this device'}</small></span>
      <button class="btn slim" id="editChar">${ic('user')}<span>Edit character</span></button>
    </section>`;
  const wire = () => { $('#back').onclick = home; $('#editChar').onclick = () => characterMenu(youPage); };
  show(`${head}<p class="muted center" id="youLoad">Totting up your numbers…</p>`);
  wire();
  let st;
  try { st = await api(statsQuery()); } catch (e) { if ($('#youLoad')) $('#youLoad').textContent = 'Could not load your stats. ' + e.message; return; }
  if (!$('#youLoad')) return;   // moved on while it loaded
  const h = st.headline;
  rememberBadges(st, false);
  syncUnlocks(st);
  const card = (v, l) => `<div class="stat"><b>${v}</b><small>${l}</small></div>`;
  const got = st.badges.filter(b => b.earned).length;
  show(`${head}
    <div class="stat-grid">
      ${card(h.answers, 'Answers given')}${card(`${h.correctPct}%`, 'Right')}
      ${card(h.outliers, 'Outliers found')}${card(h.avgPoints, 'Avg points')}
      ${card(h.dailies, 'Dailies played')}${card(h.bestDaily, 'Best daily')}
      ${card(h.parties, 'Party games')}${card(h.partyWins, 'Party wins')}
    </div>
    ${h.rarest ? `<section class="card rarest"><small>Your rarest answer</small><b>${esc(h.rarest.answer)}</b>
      <span class="muted">${esc(h.rarest.prompt)} · only ${h.rarest.share}% said it${h.rarest.outlier ? ' · Outlier!' : ''}</span></section>` : ''}
    <section class="sec"><h2 class="sec-h">Badges <small class="muted">${got} of ${st.badges.length}</small></h2>
      <ul class="badges">${st.badges.map(badgeHTML).join('')}</ul></section>
    ${youPlusHTML(st)}`);
  wire();
  if ($('#youPlus')) $('#youPlus').onclick = () => upsellScreen('See all your stats with Outlier Plus');
}

// Remembers which badges this browser has seen. Returns the ones that are new since last time; the very first look
// only records them, so nobody gets a pile of badges for things they did before badges existed.
function rememberBadges(st, celebrate = true) {
  const earned = st.badges.filter(b => b.earned).map(b => b.id), seen = store.get('outlier.badges');
  store.set('outlier.badges', earned);
  if (!Array.isArray(seen) || !celebrate) return [];
  return st.badges.filter(b => b.earned && !seen.includes(b.id));
}

async function checkBadges() {
  let st;
  try { st = await api(statsQuery()); } catch { return; }
  const fresh = rememberBadges(st), first = !Array.isArray(store.get('outlier.unlocks'));
  const items = syncUnlocks(st);
  const name = store.get('outlier.name', '') || 'You', look = lookFor(name, store.get('outlier.look'));
  const got = first ? [] : items.map(it => ({ name: it.name, desc: `${it.emote ? 'New podium emote' : 'New for your character'} · ${itemGoal(it)}`, item: true,
    part: it.part, idx: it.idx, emote: it.emote,
    html: it.emote ? avatar(name, store.get('outlier.color', 0), look, 'e-' + it.emote) : avatar(name, store.get('outlier.color', 0), lookWith(look, it.part, it.idx)) }));
  if (fresh.length || got.length) badgePop([...fresh, ...got]);
}

function badgePop(list) {
  document.querySelector('.badge-pop')?.remove();
  sfx.play('ding'); sfx.play('fanfare', undefined, .2);
  const el = document.createElement('div');
  el.className = 'badge-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'New badge');
  el.innerHTML = `<div class="bp-card">
    <p class="eyebrow">${list.every(b => b.item) ? (list.length === 1 ? 'Unlocked!' : `${list.length} items unlocked!`) : list.length === 1 ? 'New badge!' : `${list.length} new unlocks!`}</p>
    <ul>${list.slice(0, 5).map(b => `<li><span class="badge-ic${b.item ? ' bp-av' : ''}">${b.html || ic(b.icon)}</span><span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small></span></li>`).join('')}</ul>
    ${list.length > 5 ? `<p class="fine center">and ${list.length - 5} more</p>` : ''}
    <div class="bp-btns">${party ? '' : `<button class="btn slim" id="bpSee">${list.some(b => b.item) ? 'Try it on' : 'See your badges'}</button>`}<button class="btn primary slim" id="bpOk">Lovely</button></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.onclick = e => { if (e.target === el) close(); };
  $('#bpOk', el).onclick = close;
  if ($('#bpSee', el)) $('#bpSee', el).onclick = () => {
    close();
    const items = list.filter(b => b.item);
    if (!items.length) return youPage();
    const name = store.get('outlier.name', '') || 'You';   // put the new things on, then show the character
    store.set('outlier.look', items.filter(b => !b.emote).reduce((l, b) => lookWith(l, b.part, b.idx), lookFor(name, store.get('outlier.look'))));
    const emo = items.find(b => b.emote);
    if (emo) store.set('outlier.emote', emo.emote);
    characterMenu(youPage);
  };
  $('#bpOk', el).focus();
}

// Each party game is posted once per browser (game = which game this is in the room, so rematches count too)
function postPartyResult(s, place) {
  const stamp = `${s.code}|${s.game}`;
  if (!party || !place || party.resultSent === stamp) return;
  party.resultSent = stamp;
  api('/api/party/result', { cid: playerId(), mode: s.mode === 'potato' ? 'potato' : 'classic', place, players: s.players.length, code: s.code, round: s.game || 0 })
    .then(checkBadges).catch(() => {});
}

// ------------------------------------------------------------ streak reminders (web push)
// One notification in the UK evening when your streak is alive and today's Daily seven isn't played yet.
// Needs the server to have reminders switched on, and a browser with push (on iPhone, only once added to the Home Screen).

let pushKey = '';   // the server's public key, when reminders are switched on there
const pushCan = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const IOS_NOTE = 'On iPhone, add Outlier to your Home Screen first (Share → Add to Home Screen), then turn reminders on';
const BLOCKED_NOTE = 'Notifications are blocked for Outlier. Allow them in your browser settings, then try again.';
const streakOut = () => { const s = store.get('outlier.streak', {}) || {}; return { n: s.n || 0, last: s.last || '' }; };

// 'on', 'off', 'blocked', 'ios' (Home Screen first) or '' (not offered on this browser)
function remindState() {
  if (!pushKey) return '';
  if (!pushCan()) return isIOS() && !standalone() ? 'ios' : '';
  if (Notification.permission === 'denied') return 'blocked';
  return store.get('outlier.remind', false) ? 'on' : 'off';
}

function remindRowHTML() {
  const rs = remindState();
  if (!rs) return '';
  const sub = rs === 'ios' ? IOS_NOTE : rs === 'blocked' ? 'Notifications are blocked for this site in your browser settings'
    : "One nudge in the evening if you haven't played that day";
  return `<div class="card remind" id="remindRow"><span class="mini-ic">${ic('bell')}</span>
    <span class="main"><b>Remind me before my streak ends</b><small>${sub}</small></span>
    ${rs === 'on' || rs === 'off' ? `<button class="switch${rs === 'on' ? ' on' : ''}" id="remindSw" role="switch" aria-checked="${rs === 'on'}" aria-label="Remind me before my streak ends"><i></i></button>` : ''}</div>`;
}

// The bell and the switch show the same setting; repaint both in place (no screen redraw).
function remindPaint() {
  const on = remindState() === 'on';
  const bell = $('#remindBell'), sw = $('#remindSw');
  if (bell) { bell.classList.toggle('on', on); bell.setAttribute('aria-pressed', on); }
  if (sw) { sw.classList.toggle('on', on); sw.setAttribute('aria-checked', on); }
}

function remindWire() {
  for (const el of [$('#remindBell'), $('#remindSw')]) if (el) el.onclick = async () => {
    el.disabled = true;
    await remindToggle();
    el.disabled = false;
    remindPaint();
  };
}

const urlKey = b64 => Uint8Array.from(atob((b64 + '==='.slice((b64.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function remindToggle() {
  const rs = remindState();
  if (rs === 'ios') return toast(IOS_NOTE, 7000);
  if (rs === 'blocked') return toast(BLOCKED_NOTE, 5000);
  if (rs === 'on') {
    store.set('outlier.remind', false);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } catch { /* already gone */ }
    return toast('Streak reminders off');
  }
  try {   // permission is only ever asked for here, on a tap
    if (await Notification.requestPermission() !== 'granted') return toast(BLOCKED_NOTE, 5000);
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(pushKey) });
    await api('/api/push/subscribe', { cid: playerId(), subscription: sub.toJSON(), streak: streakOut() });
    store.set('outlier.remind', true);
    toast("Reminders on. We'll nudge you in the evening if your streak is at risk.", 4000);
  } catch (e) {
    toast(`Couldn't turn reminders on. ${e.message || ''}`.trim(), 4000);
  }
}

// Tell the server your streak (after a daily, and on opening the app) so tonight's reminder is only sent if needed.
function pushState() {
  if (remindState() !== 'on') return;
  api('/api/push/state', { cid: playerId(), streak: streakOut() }).then(async r => {
    if (r.subscribed) return;   // the server has lost this browser (a fresh database, say): sign it up again
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) await api('/api/push/subscribe', { cid: playerId(), subscription: sub.toJSON(), streak: streakOut() });
  }).catch(() => {});
}

// On load: ask the server whether reminders are on, register the service worker, and check the browser still has
// its subscription (it can be dropped, or permission taken away, outside the app).
async function pushBoot() {
  try { const r = await api('/api/push/key'); pushKey = r.enabled ? r.key || '' : ''; } catch { pushKey = ''; }
  if (!pushKey || !pushCan()) return;
  (async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription();
      if (store.get('outlier.remind', false) && (!sub || Notification.permission !== 'granted')) { store.set('outlier.remind', false); remindPaint(); }
      pushState();
    } catch { /* no service worker here (private mode, say): reminders just aren't offered */ }
  })();
}

// ------------------------------------------------------------ boot

(async function boot() {
  const pushReady = pushBoot();
  try { CATS = await api('/api/categories'); } catch { app.innerHTML = '<p class="center muted">Could not reach the game server.</p>'; return; }
  pick = upgradePick(pick);   // older saved picks ({ cat, tags }) become the new mix shape
  const params = new URLSearchParams(location.search);
  if (params.get('login')) await finishLogin(params.get('login'));
  await loadMe();
  await pushReady;
  if (params.get('plus')) {
    history.replaceState(null, '', location.pathname);
    for (let i = 0; i < 8 && !plan.subscribed; i++) { await new Promise(r => setTimeout(r, 1500)); await loadMe(); }
    toast(plan.subscribed ? 'Welcome to Outlier Plus!' : 'Payment received. Plus will switch on in a moment.');
  }
  const invite = params.get('room');
  const challenge = location.pathname.startsWith('/c/') && readChallenge(location.pathname);
  if (challenge) {
    history.replaceState(null, '', '/');
    return challengeIntro(challenge.seed, challenge.from, challenge.pts);
  }
  if (params.get('play')) {
    history.replaceState(null, '', location.pathname);
    return challengeIntro(params.get('play'), params.get('from') || '', params.get('pts') || '');
  }
  if (params.get('league')) {   // a league invite link
    history.replaceState(null, '', location.pathname);
    return leaguePage(params.get('league').toUpperCase().slice(0, 6), 'today');
  }
  if (params.get('tv')) return joinScreen(params.get('tv'));
  const saved = store.get('outlier.party');
  if (saved && (!invite || invite.toUpperCase() === saved.code)) enterParty(saved.code, saved.pid);
  else if (invite) partyMenu(invite.toUpperCase().slice(0, 4));
  else home();
})();
