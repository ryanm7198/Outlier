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

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
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

function show(html) {
  app.innerHTML = html;
  window.scrollTo(0, 0);
  walk();
}

// A small line-icon set, drawn with currentColor so icons follow the text colour.
const ICON = {
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
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 13.2 7.6 4.6M15.8 6.2 8.2 10.8"/>',
  flame: '<path d="M12 21.5c3.9 0 6.5-2.7 6.5-6.3 0-3.7-2.6-5.6-3.6-9.7-1.8 1.4-2.8 3.4-2.9 5.4-1-.9-1.8-2.2-2-3.9-2.1 2.1-3.5 4.9-3.5 8.2 0 3.6 2.6 6.3 5.5 6.3z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  crown: '<path d="M3 8l4.5 4.5L12 5l4.5 7.5L21 8l-2 11H5z"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;
const PCOL = ['#ff6b6b', '#ff9f43', '#feca57', '#7bd88f', '#2ed3b7', '#4cc9f0', '#5b8cff', '#9b7bff', '#d77bff', '#ff7bd0', '#b8c4d6', '#c9a27a'];
const PCOL_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Sky', 'Blue', 'Violet', 'Purple', 'Pink', 'Silver', 'Sand'];
const avatar = (name, color) => `<span class="av" style="--pc:${PCOL[color] || PCOL[0]}">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;
const colorOf = (s, n) => (s.players.find(p => p.n === n) || {}).color;
const CAT_ICON = { all: 'sparkles', sport: 'trophy', football: 'ball', music: 'music', film: 'film', gaming: 'gamepad',
  geography: 'globe', history: 'landmark', science: 'flask', food: 'utensils', words: 'book', misc: 'shuffle' };
const topbar = (title, right = '', back = 'back', icon = 'left') =>
  `<header class="top"><button class="iconbtn" id="${back}" aria-label="${back === 'leave' ? 'Leave' : 'Back'}">${ic(icon)}</button>
    <h1>${title}</h1><span class="top-r">${right}</span></header>`;

let timer = null;
function stopTimer() { clearInterval(timer); timer = null; }
function runTimer(ms, total, onEnd) {
  stopTimer();
  const end = performance.now() + ms;
  const tick = () => {
    const left = Math.max(0, end - performance.now());
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
const tier = pts => pts >= 100 ? 5 : pts >= 75 ? 4 : pts >= 50 ? 3 : pts >= 25 ? 2 : pts > 0 ? 1 : 0;

const ZONES = [[0, 'In the crowd'], [.12, 'Side streets'], [.3, 'Back roads'], [.5, 'Open country'], [.7, 'The wilds'], [.9, 'Off the map']];
const zoneName = (score, max) => ZONES.filter(z => score / max >= z[0]).pop()[1];

// 100 people; the lit ones gave the same answer as you. Each dot has a random rank so the crowd thins evenly.
function crowdHTML(lit) {
  const ranks = [...Array(100).keys()].sort(() => Math.random() - .5);
  return `<div class="crowd">${ranks.map(r => `<i data-rank="${r}"${r < lit ? ' class="on"' : ''}></i>`).join('')}</div>`;
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
    <div class="ends"><span>The crowd</span><span>Off the map</span></div>
  </div>`;
}

// The result starts at +0 with the whole crowd lit; buildUp() then counts it up.
function resultHTML(res) {
  const line = res.valid ? `You said <b>${esc(res.canonical)}</b>`
    : res.given ? `<span class="strike">${esc(res.given)}</span> isn't on the list yet. We've noted it for review.`
      : 'No answer given.';
  return `<div class="result" id="result">
    <div class="pts" id="pts">+0</div>
    <div class="tier" id="tier">&nbsp;</div>
    <p>${line}</p>
  </div>
  <div>${crowdHTML(res.valid ? 100 : 0)}<p class="caption" id="caption">&nbsp;</p></div>`;
}

// Suspense: the score climbs continuously, slowing as it nears its final value, while the lit crowd
// thins out to the people who gave the same answer. Everything marked .wait appears once it stops.
let skipBuild = null, raceSkip = null;
function buildUp(res) {
  const lit = res.valid ? Math.max(1, Math.round(res.share)) : 0;
  const pts = $('#pts'), tierEl = $('#tier'), box = $('#result');
  const dots = [...app.querySelectorAll('.crowd i')];
  const paint = (score, crowd) => {
    pts.textContent = '+' + score;
    dots.forEach(d => d.classList.toggle('on', +d.dataset.rank < crowd));
  };
  const finish = () => {
    skipBuild = null;
    if (!pts.isConnected) return;
    const t = res.outlier ? 5 : Math.min(4, tier(res.points));
    paint(res.points, lit);
    box.className = `result t${t} done`;
    if (res.valid) tierEl.innerHTML = `<span class="tierbadge t${t}"><i></i>${TIERS[t]}</span>`;
    else tierEl.textContent = res.given ? 'Not on the list' : 'No answer';
    // A buzz for the good ones: short for Rare and Ball knowledge, a double for an Outlier.
    try { if (res.valid && t >= 3 && navigator.vibrate) navigator.vibrate(t === 5 ? [70, 50, 140] : 35); } catch { /* not supported */ }
    $('#caption').innerHTML = !res.valid ? 'No distance gained this round.'
      : res.share < 1 ? `Fewer than <b>1 in 100</b> people said ${esc(res.canonical)}`
        : `<b>${lit} in 100</b> people said ${esc(res.canonical)}`;
    app.querySelectorAll('.wait').forEach(el => el.classList.remove('wait'));
    walk();
  };
  if (!res.valid || matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
  const duration = 1500 + Math.min(res.points, 100) * 35 + Math.max(0, res.points - 100) * 10, start = performance.now();
  let stopped = false;
  skipBuild = () => { stopped = true; finish(); };
  const frame = now => {
    if (stopped || !pts.isConnected) return;
    const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 3);
    const score = Math.round(res.points * eased);
    paint(score, Math.round(100 - (100 - lit) * eased));
    tierEl.textContent = TIERS[Math.min(4, tier(score))] || ' ';
    if (t < 1) requestAnimationFrame(frame); else finish();
  };
  requestAnimationFrame(frame);
}
app.addEventListener('click', () => { if (skipBuild) skipBuild(); if (raceSkip) raceSkip(); });   // tap to skip the build-up

function outlierHTML(list, mine) {
  if (list.some(o => o.name === mine)) return '<p class="muted center">You found the Outlier.</p>';
  return `<p class="muted center">${list.length > 1 ? 'The Outliers were' : 'The Outlier was'} ${list.map(o => `<b>${esc(o.name)}</b>`).join(' and ')}</p>`;
}

function boardHTML(board, mine, total) {
  const more = total && total > board.length;
  return `<details><summary>${more ? `See the top answers (${total} in all)` : `See every answer (${board.length})`}</summary><ol class="rows board">${board.map(b => `
    <li class="${b.name === mine ? 'me' : ''}"><span class="main"><b>${esc(b.name)}</b></span>
    ${b.outlier ? '<span class="tag">Outlier</span>' : ''}<span class="share">${b.share}%</span><span class="num">${b.points}</span></li>`).join('')}</ol></details>`;
}

function questionHTML(text) {
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

// How many prompts one category pick gives. Mirrors pool() in server.py.
function countOne(p) {
  const c = catOf(p.cat);
  if (!c.tagsets) return c.count;
  const kids = kidsOf(c), lead = leadOf(c);
  const subs = kids.length ? p.tags.filter(t => kids.some(k => k.id === t) || lead.tags.some(x => x.id === t)) : [];
  return c.tagsets.filter(tags => {
    if (!tags.every(t => !t.startsWith('~only:') || p.tags.includes(t.slice(6)))) return false;   // decade versions need their decade
    let home = c;
    const kid = (tags.find(t => t.startsWith('~cat:')) || '').slice(5);
    if (kid) {
      if (subs.length && !subs.includes(kid)) return false;
      home = catOf(kid);
    } else if (subs.length && !subs.some(t => lead.tags.some(x => x.id === t))) return false;
    const mine = kids.length ? p.tags.filter(t => home.filters.some(g => g.tags.some(x => x.id === t))) : p.tags;
    return (mine.length || !tags.includes('~deep')) && passes(home.filters, tags, p.tags);
  }).length;
}

const selsOf = p => Object.entries((p && p.sels) || {});
function poolCount(p) {
  const sels = selsOf(p);
  return sels.length ? sels.reduce((n, [cat, tags]) => n + countOne({ cat, tags }), 0) : catOf('all').count;
}

function labelOne(cat, tags) {
  const c = catOf(cat);
  // A group with every option ticked reads as the whole category, so "Sport" not "Sport · Tennis · Boxing · ...".
  const named = c.filters.filter(g => !g.tags.filter(t => t.count).every(t => tags.includes(t.id)))
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
  if (p.sels) return { sels: Object.fromEntries(selsOf(p).filter(([cat]) => CATS.some(c => c.id === cat))) };
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

// The category a Daily five uses: the one picked category, or Everything for a mix.
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
    return new Set(chosen.length ? chosen : g.tags.filter(t => t.count).map(t => t.id));
  });
  const full = k => c.filters[k].tags.filter(t => t.count).every(t => groups[k].has(t.id));
  const allOn = () => groups.every((_, k) => full(k));
  // A group with nothing ticked means any of it, so just Premier League is Premier League in every era.
  const tags = () => groups.flatMap((g, k) => full(k) || !g.size ? [] : [...g]);
  const ok = () => groups.some(g => g.size);   // something ticked, or Select all
  openSheet(c.label, () => {
    const n = ok() ? countOne({ cat, tags: tags() }) : 0;
    return `<button class="selall${allOn() ? ' on' : ''}" data-all><span class="box">${allOn() ? ic('check') : ''}</span><span><b>Select all</b><small>Everything in ${esc(c.label)}</small></span></button>
      ${c.filters.map((g, k) => `<div class="group"><h4>${esc(g.label)}${groups[k].size ? '' : ' <small>any</small>'}</h4><div class="chips">${g.tags.map(t =>
        chipHTML(groups[k].has(t.id), `data-k="${k}" data-t="${t.id}"`, t.label, !t.count)).join('')}</div></div>`).join('')}
      <div class="sheet-f">
        ${current ? '<button class="btn" data-remove>Remove</button>' : ''}
        <button class="btn primary" data-ok ${ok() ? '' : 'disabled'}>${ok() ? `Confirm · ${n} prompts` : 'Tick some, or Select all'}</button>
      </div>`;
  }, (e, s) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.all !== undefined) {
      const on = !allOn();
      groups.forEach((g, k) => { g.clear(); if (on) c.filters[k].tags.filter(t => t.count).forEach(t => g.add(t.id)); });
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
  const live = [...kids.filter(k => k.count).map(k => k.id), ...lead.tags.filter(t => t.count).map(t => t.id)];
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
        ${kids.map(k => chipHTML(ticked.has(k.id), `data-kid="${k.id}"`, k.label, !k.count,
          `<span class="more">${(kidTags[k.id] || []).length ? 'custom' : ''}${ic('right')}</span>`)).join('')}
        ${lead.tags.map(t => chipHTML(ticked.has(t.id), `data-t="${t.id}"`, t.label, !t.count)).join('')}
      </div></div>
      <p class="fine">${ic('right')}<span>Tap ${kids.map(k => esc(k.label)).join(' or ')} to choose its eras and competitions.</span></p>
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

function mountPicker(el, onChange) {
  const sel = id => id in pick.sels || kidsOf(catOf(id)).some(k => k.id in pick.sels);
  const tile = x => {
    const on = x.id === 'all' ? !selsOf(pick).length : sel(x.id);
    const own = pick.sels[x.id];
    const sub = x.id !== 'all' && on ? (own && !own.length && !kidsOf(x).some(k => k.id in pick.sels) ? 'All of it' : 'Custom') : `${x.count} prompts`;
    return `<button class="tile${on ? ' on' : ''}" data-cat="${x.id}" aria-pressed="${on}">
      <span class="tile-ic">${on && x.id !== 'all' ? ic('check') : ic(CAT_ICON[x.id] || 'sparkles')}</span><span class="tile-l">${esc(x.label)}</span><span class="tile-n">${sub}</span></button>`;
  };
  const save = () => { store.set('outlier.pick', pick); draw(); onChange && onChange(); };
  const draw = () => {
    const sels = selsOf(pick), n = poolCount(pick);
    el.innerHTML = `<div class="picker">
      <div class="tiles">${CATS.filter(x => !x.parent).map(tile).join('')}</div>
      <div class="mix">
        <div class="narrow-h"><h3>Your mix</h3><span class="count">${n} prompt${n === 1 ? '' : 's'}</span></div>
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
  const streak = store.get('outlier.streak', { n: 0 });
  const mode = (id, icon, title, sub, primary) => `<button class="mode${primary ? ' primary' : ''}" id="${id}">
    <span class="mode-ic">${ic(icon)}</span><span class="mode-t"><b>${title}</b><small>${sub}</small></span>${ic('right', 'chev')}</button>`;
  show(`<div class="hero">
      <div class="logo">Outl<b>i</b>er</div>
      <p>Give the answer nobody else did.</p>
      ${crowdHTML(3)}
    </div>
    <div class="modes">
      ${mode('solo', 'user', 'Play solo', 'Daily five, or a quick game to challenge a friend', true)}
      ${mode('party', 'users', 'Party game', 'Everyone plays together on their own phone')}
    </div>
    ${streak.n > 1 ? `<div class="streak">${ic('flame')}<span><b>${streak.n}-day</b> daily streak</span></div>` : ''}
    <section class="card how">
      <h3>How it works</h3>
      <ol class="steps">
        <li><b>1</b><span>Get a prompt, like <i>Name a Pixar film</i>, and 30 seconds to answer.</span></li>
        <li><b>2</b><span>Any correct answer scores, from 10 for the one everyone says up to 99 for the rarest. The fewer people who say it, the more it is worth.</span></li>
        <li><b>3</b><span>Find the <b>Outlier</b>, the single rarest answer on the list (two on very long lists), for a big 150.</span></li>
      </ol>
      <p class="fine">Every answer played shifts how common it is. In party games, players who give the same answer share half the points.</p>
    </section>`);
  $('#solo').onclick = soloMenu;
  $('#party').onclick = () => partyMenu();
}

// ------------------------------------------------------------ solo

function soloMenu() {
  stopTimer();
  const recent = store.get('outlier.recent', []).map(upgradePick);
  show(`${topbar('Play solo')}
    ${recent.length ? `<section class="sec"><h2 class="sec-h">Jump back in</h2><div class="recent">${recent.map((r, i) =>
      `<button class="recentbtn" data-i="${i}">${ic(CAT_ICON[selsOf(r).length === 1 ? (catOf(selsOf(r)[0][0]).parent || selsOf(r)[0][0]) : 'all'] || 'sparkles')}<span>${esc(pickLabel(r))}</span></button>`).join('')}</div></section>` : ''}
    <section class="sec"><h2 class="sec-h">Choose a category</h2><div id="picker"></div></section>
    <details class="seedbox"><summary>${ic('link')}<span>Got a challenge link or seed from a friend?</span>${ic('right', 'chev')}</summary>
      <div class="row"><input type="text" id="seedIn" placeholder="Paste the link or seed" autocomplete="off"><button class="btn" id="seedGo">Play</button></div>
    </details>
    <div class="cta">
      <button class="btn primary big" id="free"></button>
      <button class="btn big" id="daily"></button>
    </div>`);
  const refresh = () => {
    const c = catOf(dailyCat(pick)), saved = store.get('outlier.daily.' + c.id);
    const today = new Date().toLocaleDateString('en-CA');
    const done = saved && saved.date === today && saved.done;
    const n = poolCount(pick);   // the categories themselves are listed in Your mix, so keep this line short
    $('#free').innerHTML = `${ic('play')}<span><b>Quick game</b><small>${selsOf(pick).length ? 'Custom' : 'Everything'} · ${n} prompt${n === 1 ? '' : 's'}</small></span>`;
    $('#daily').innerHTML = `${ic('calendar')}<span><b>Daily five · ${esc(c.label)}</b><small>${done ? `Played today: ${saved.total} paces. Tap to view.` : 'Same five prompts for everyone today'}</small></span>`;
    $('#free').disabled = !poolCount(pick);
  };
  mountPicker($('#picker'), refresh);
  refresh();
  $('#back').onclick = home;
  $('#daily').onclick = startDaily;
  $('#free').onclick = () => startGame();
  app.querySelectorAll('.recentbtn').forEach(b => b.onclick = () => {
    pick = JSON.parse(JSON.stringify(recent[+b.dataset.i]));
    store.set('outlier.pick', pick);
    startGame();
  });
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

async function startDaily() {
  let day;
  try { day = await api('/api/daily?cat=' + encodeURIComponent(dailyCat(pick))); } catch (e) { return toast(e.message); }
  const key = 'outlier.daily.' + day.cat;
  let saved = store.get(key);
  if (!saved || saved.date !== day.date) saved = { date: day.date, number: day.number, label: day.label, results: [], done: false };
  const run = { day, key, saved };
  saved.done ? dailySummary(run) : dailyQuestion(run);
}

const sum = results => results.reduce((n, r) => n + r.points, 0);

function ask(prompt, roundMs, header, onResult) {
  show(header + questionHTML(prompt.text));
  const onTimeout = wireAnswer(prompt.id, async text => {
    stopTimer();
    onResult(await api('/api/answer', { promptId: prompt.id, answer: text }));
  });
  runTimer(roundMs, roundMs, onTimeout);
  $('#input').focus();
}

function dailyQuestion(run) {
  const { day, saved } = run, i = saved.results.length;
  const header = `<header class="bar"><button class="link" id="quit">✕ Quit</button>
    <span>${esc(day.label)} #${day.number} · ${i + 1}/${day.prompts.length}</span><span class="pill">${sum(saved.results)}</span></header>`;
  ask(day.prompts[i], day.roundMs, header, res => {
    const before = sum(saved.results);
    saved.results.push({ prompt: res.prompt, given: res.given, canonical: res.canonical, valid: res.valid, points: res.points, share: res.share });
    saved.done = saved.results.length >= day.prompts.length;
    saved.total = sum(saved.results);
    store.set(run.key, saved);
    if (saved.done) bumpStreak(saved.date);
    const max = day.prompts.length * 100;
    show(`<header class="bar"><span></span><span>${esc(day.label)} #${day.number} · ${i + 1}/${day.prompts.length}</span><span></span></header>
      <p class="muted center">${esc(res.prompt)}</p>
      ${resultHTML(res)}
      <div class="after wait">
        <div class="card">${trailHTML([{ name: 'You', from: before, to: saved.total, me: true }], max)}
          <p class="zone">${zoneName(saved.total, max)}<span class="muted">${saved.total} paces from the crowd</span></p></div>
        ${outlierHTML(res.board.filter(b => b.outlier), res.canonical)}
        ${boardHTML(res.board, res.canonical, res.boardTotal)}
        <button class="btn primary" id="next">${saved.done ? 'See your day' : 'Next prompt'}</button>
      </div>`);
    buildUp(res);
    $('#next').onclick = () => saved.done ? dailySummary(run) : dailyQuestion(run);
  });
  $('#quit').onclick = soloMenu;
}

function bumpStreak(date) {
  const s = store.get('outlier.streak', { n: 0, last: '' });
  if (s.last === date) return;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  store.set('outlier.streak', { n: s.last === d.toISOString().slice(0, 10) ? s.n + 1 : 1, last: date });
}

function dailySummary(run) {
  const { saved } = run, max = saved.results.length * 100;
  const squares = saved.results.map(r => SQUARES[tier(r.points)]).join('');
  const label = saved.label || run.day.label;
  show(`<header class="bar"><button class="link" id="back">‹ Back</button><span>${esc(label)} #${saved.number}</span><span></span></header>
    <div class="total">${saved.total}<small> / ${max * 1.5} paces</small></div>
    <div class="squares">${squares}</div>
    <div class="card">${trailHTML([{ name: 'You', from: 0, to: saved.total, me: true }], max)}
      <p class="zone">You ended up: ${zoneName(saved.total, max)}</p></div>
    <ul class="rows card">${saved.results.map(r => `<li><span class="main"><b>${r.valid ? esc(r.canonical) : `<span class="strike">${esc(r.given || 'No answer')}</span>`}</b>
      <small>${esc(r.prompt)}</small></span><span class="num">+${r.points}</span></li>`).join('')}</ul>
    <div class="stack">
      <button class="btn primary" id="share">Share result</button>
      <button class="btn" id="free">Play a quick game</button>
    </div>
    <p class="muted center">New prompts tomorrow.</p>`);
  $('#back').onclick = soloMenu;
  $('#free').onclick = () => startGame();
  $('#share').onclick = () => shareText(`Outlier · ${label} #${saved.number}\n${saved.total}/${max * 1.5} paces from the crowd\n${squares}`);
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
  gameQuestion({ game, rival: opts.rival || null, results: [] });
}

function gameQuestion(run) {
  const { game, results, rival } = run, i = results.length, n = game.prompts.length;
  const theirs = rival ? rival.points.slice(0, i).reduce((a, b) => a + b, 0) : 0;
  const header = `<header class="bar"><button class="link" id="quit">✕ Quit</button>
    <span>${esc(game.label)} · ${i + 1}/${n}</span><span class="pill">${sum(results)}${rival ? ` v ${theirs}` : ''}</span></header>`;
  ask(game.prompts[i], game.roundMs, header, res => {
    const before = sum(results);
    results.push({ prompt: res.prompt, given: res.given, canonical: res.canonical, valid: res.valid, points: res.points });
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
        ${boardHTML(res.board, res.canonical, res.boardTotal)}
        <button class="btn primary" id="next">${done ? 'See your score' : 'Next prompt'}</button>
      </div>`);
    buildUp(res);
    $('#next').onclick = () => done ? gameSummary(run) : gameQuestion(run);
  });
  $('#quit').onclick = soloMenu;
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
  const squares = results.map(r => SQUARES[tier(r.points)]).join('');
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
    <ul class="rows card">${results.map((r, i) => `<li><span class="main"><b>${r.valid ? esc(r.canonical) : `<span class="strike">${esc(r.given || 'No answer')}</span>`}</b>
      <small>${esc(r.prompt)}</small></span><span class="num">+${r.points}${rival ? `<small>${esc(rival.name)} +${rival.points[i] || 0}</small>` : ''}</span></li>`).join('')}</ul>
    <div class="card seed">
      <label for="who">Challenge a friend on these 7 prompts</label>
      <input type="text" id="who" maxlength="16" placeholder="Your name" value="${esc(store.get('outlier.name', ''))}" autocomplete="off">
      <button class="btn primary" id="share">Send challenge</button>
      <p class="muted">Seed: <code>${esc(game.seed)}</code></p>
    </div>
    <div class="stack"><button class="btn" id="again">New game</button></div>`);
  $('#back').onclick = soloMenu;
  $('#again').onclick = () => startGame();
  $('#share').onclick = () => {
    const name = $('#who').value.trim().slice(0, 16) || 'A friend';
    store.set('outlier.name', name);
    shareText(`I scored ${total} on Outlier ${squares}\nCan you beat me?`, challengeLink(run, name));
  };
}

// A challenge link: ?play=<seed>&from=<name>&pts=12.40.100...
function challengeIntro(seed, from, pts) {
  stopTimer();
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
}

// ------------------------------------------------------------ party

let party = null;

function partyMenu(code = '') {
  stopTimer();
  show(`${topbar('Party game')}
    <section class="field"><label for="name">Your name</label>
      <input type="text" id="name" maxlength="16" placeholder="What should everyone call you?" value="${esc(store.get('outlier.name', ''))}" autocomplete="nickname"></section>
    <section class="card choice${code ? '' : ' lead'}">
      <div class="choice-h"><span class="mode-ic">${ic('crown')}</span><div><b>Host a game</b><small>Get a room code, pick the category, start when everyone's in</small></div></div>
      <button class="btn${code ? '' : ' primary'}" id="create">Create a room</button>
    </section>
    <section class="card choice${code ? ' lead' : ''}">
      <div class="choice-h"><span class="mode-ic">${ic('users')}</span><div><b>Join a game</b><small>Enter the 4-letter code from the host's screen</small></div></div>
      <form id="join" class="row">
        <input type="text" id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" autocomplete="off" aria-label="Room code">
        <button class="btn${code ? ' primary' : ''}">Join</button>
      </form>
    </section>`);
  const go = async (path, body) => {
    const name = $('#name').value.trim();
    if (!name) { $('#name').focus(); return toast('Enter a name first'); }
    store.set('outlier.name', name);
    try { const r = await api(path, { ...body, name }); enterParty(r.code, r.pid); } catch (e) { toast(e.message); }
  };
  $('#back').onclick = home;
  $('#create').onclick = () => go('/api/room/create', {});
  $('#join').onsubmit = e => { e.preventDefault(); go('/api/room/join', { code: $('#code').value.trim() }); };
}

function enterParty(code, pid) {
  store.set('outlier.party', { code, pid });
  party = { code, pid, key: null, busy: false, rounds: 5, secs: 30 };
  party.poll = setInterval(pollParty, 1000);
  pollParty();
}

function leaveParty(msg) {
  if (party) clearInterval(party.poll);
  party = null;
  store.del('outlier.party');
  history.replaceState(null, '', location.pathname);
  home();
  if (msg) toast(msg);
}

async function pollParty() {
  if (!party || party.busy) return;
  party.busy = true;
  try {
    const state = await api(`/api/room/state?code=${party.code}&pid=${party.pid}`);
    if (party) renderParty(state);
  } catch (e) {
    if (e.status === 404) return leaveParty('That room has closed');
  } finally { if (party) party.busy = false; }
}

async function partyPost(path, extra) {
  try {
    const state = await api(path, { code: party.code, pid: party.pid, ...extra });
    if (party) renderParty(state);
  } catch (e) { toast(e.message); }
}

function playersHTML(s) {
  return s.players.map(p => `<li class="${p.n === s.you ? 'me' : ''}${p.online ? '' : ' off'}">
    ${avatar(p.name, p.color)}
    <span class="main"><b>${esc(p.name)}</b>${p.n === s.you ? '<small>You</small>' : ''}</span>
    ${p.n === s.host ? '<span class="tag">Host</span>' : ''}
    ${!p.online ? '<span class="tag">Away</span>'
      : s.phase === 'question' ? `<span class="tag">${p.answered ? 'Locked in' : 'Thinking'}</span>`
      : s.phase === 'pick' ? `<span class="tag">${p.picked ? 'Ready' : 'Deciding'}</span>`
      : s.phase !== 'final' && s.phase !== 'lobby' && s.doubles && p.doubleLeft ? '<span class="tag dbl">×2 left</span>' : ''}
  </li>`).join('');
}

function renderParty(s) {
  const host = s.you === s.host;
  const answered = s.phase === 'question' && s.yourAnswer != null;
  const key = [s.phase, s.round, host, answered, s.phase === 'pick' && s.picked, s.phase === 'final' && (s.asks || []).join('.')].join('|');
  if (key !== party.key) {
    party.key = key;
    stopTimer();
    ({ lobby: partyLobby, pick: partyPick, question: partyQuestion, reveal: partyReveal, final: partyFinal })[s.phase](s, host, answered);
    const leave = $('#leave');
    if (leave) leave.onclick = () => leaveParty();
  }
  const sw = $('#colors');
  if (sw) sw.innerHTML = colorsHTML(s);
  const list = $('#players');
  if (list) {
    list.innerHTML = playersHTML(s);
    const count = list.closest('.card') && list.closest('.card').querySelector('h3 small');
    if (count) count.textContent = s.players.length;
  }
}

function colorsHTML(s) {
  const mine = colorOf(s, s.you), taken = new Set(s.players.filter(p => p.n !== s.you).map(p => p.color));
  return PCOL.map((c, i) => `<button class="swatch${i === mine ? ' on' : ''}" data-c="${i}" ${taken.has(i) ? 'disabled' : ''}
    style="--pc:${c}" aria-label="${PCOL_NAMES[i]}${taken.has(i) ? ' (taken)' : ''}" aria-pressed="${i === mine}">${i === mine ? ic('check') : ''}</button>`).join('');
}

const partyBar = (s, mid) => topbar(mid, `<span class="pill">${esc(s.code)}</span>`, 'leave', 'x');

function partyLobby(s, host) {
  const seg = (id, values, current, unit) => `<div class="seg" id="${id}">${values.map(n =>
    `<button class="chip${n === current ? ' on' : ''}" data-n="${n}" aria-pressed="${n === current}">${n}${unit}</button>`).join('')}</div>`;
  show(`${partyBar(s, 'Lobby')}
    <section class="card codecard">
      <p class="eyebrow">Room code</p>
      <div class="roomcode">${esc(s.code)}</div>
      <button class="btn slim" id="invite">${ic('share')}<span>Share invite link</span></button>
    </section>
    <section class="card"><h3>Players <small>${s.players.length}</small></h3><ul class="rows players" id="players"></ul></section>
    <section class="card"><h3>Your colour</h3><div class="swatches" id="colors"></div></section>
    ${host ? `<section class="sec"><h2 class="sec-h">Category</h2><div id="picker"></div></section>
      <section class="card settings">
        <div class="setting"><span>Rounds</span>${seg('rounds', [3, 5, 7, 10], party.rounds, '')}</div>
        <div class="setting"><span>Time to answer</span>${seg('secs', [15, 30, 45, 60], party.secs, 's')}</div>
        <p class="fine">${ic('zap')}<span>Play <b>Everything</b> to unlock double downs: before each round everyone sees the category and can double that round's score, once per game.</span></p>
      </section>
      <div class="cta"><button class="btn primary big" id="start">${ic('play')}<span><b>Start game</b><small>Everyone in the room plays along</small></span></button></div>`
      : `<div class="waiting card"><span class="dots"><i></i><i></i><i></i></span><p>Waiting for the host to pick a category and start</p></div>`}`);
  $('#invite').onclick = () => shareText(`${location.origin}/?room=${s.code}`);
  $('#colors').onclick = e => { const b = e.target.closest('[data-c]'); if (b && !b.disabled) partyPost('/api/room/color', { color: +b.dataset.c }); };
  if (!host) return;
  mountPicker($('#picker'), () => { $('#start').disabled = !poolCount(pick); });
  const chips = (id, field) => $(id).onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    party[field] = +b.dataset.n;
    $(id).querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  };
  chips('#rounds', 'rounds');
  chips('#secs', 'secs');
  $('#start').disabled = !poolCount(pick);
  $('#start').onclick = startParty;
}

const startParty = () => partyPost('/api/room/start', { ...apiPick(pick), rounds: party.rounds, secs: party.secs });

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
      <h2>${esc(s.prompt)}</h2>
      <div class="card center"><p class="muted">Locked in</p><h2>${esc(s.yourAnswer) || 'No answer'}</h2></div>
      <div class="card"><h3>Players</h3><ul class="rows" id="players"></ul></div>`);
    return runTimer(s.remainingMs, s.roundMs, () => {});
  }
  show(partyBar(s, mid) + `<p class="hint">${esc(s.hint)}${s.doubling ? ' · <b>Doubling ×2</b>' : ''}</p>` + questionHTML(s.prompt));
  const onTimeout = wireAnswer(s.promptId, text => partyPost('/api/room/answer', { answer: text }));
  runTimer(s.remainingMs, s.roundMs, onTimeout);
  $('#input').focus();
}

const lanes = s => [...s.players].sort((a, b) => b.score - a.score);

// What the crowd said: bars for the commonest answers, with each player's name on the answer they gave.
function crowdChart(r) {
  const top = Math.max(...r.crowd.map(b => b.share), 1);
  return `<div class="card"><h3>What the crowd said <small class="muted">${r.answers} possible answers</small></h3>
    <ul class="bars">${r.crowd.map(b => {
      const who = r.results.filter(x => x.canonical === b.name).map(x => `<span class="who">${esc(x.name)}</span>`).join('');
      return `<li class="${who ? 'picked' : ''}${b.outlier ? ' out' : ''}"><div class="bl"><b>${esc(b.name)}</b>${who}</div>
        <div class="bt"><i style="width:${(100 * b.share / top).toFixed(1)}%"></i></div><span class="bs">${b.share}%</span></li>`;
    }).join('')}</ul></div>`;
}

function partyReveal(s, host) {
  const r = s.reveal, mine = r.results.find(x => x.n === s.you);
  const last = s.round >= s.rounds;
  show(`${partyBar(s, `Round ${s.round}/${s.rounds} · ${esc(s.label)}`)}
    <p class="muted center">${esc(r.prompt)}</p>
    ${mine ? resultHTML(mine) : ''}
    ${raceHTML(s, r)}
    <div class="after${mine ? ' wait' : ''}">
    ${crowdChart(r)}
    <div class="card">${trailHTML(lanes(s).map(p => {
      const got = r.results.find(x => x.n === p.n);
      return { name: p.name, from: p.score - (got ? got.points : 0), to: p.score, me: p.n === s.you, color: p.color };
    }), (s.rounds + 1) * 100)}</div>
    ${outlierHTML(r.outliers, mine && mine.canonical)}
    <p class="muted center">Most common: <b>${esc(r.commonest.name)}</b></p>
    ${host ? `<button class="btn primary" id="next">${last ? 'Final standings' : 'Next round'}</button>`
      : `<p class="muted center">Waiting for the host to continue.</p>`}
    </div>`);
  if (mine) buildUp(mine);
  raceUp();
  if (host) $('#next').onclick = () => partyPost('/api/room/next');
}

// ---- the score race: every player's round score climbs from 0 together. Higher scores take longer,
// so the best answer lands last, and each number pulses and takes the colour of the rarity it just reached.
function raceHTML(s, r) {
  return `<ul class="race card">${r.results.map(x => `<li class="racer${x.n === s.you ? ' me' : ''}" data-pts="${x.points}" data-out="${x.outlier ? 1 : 0}" data-t="0">
    ${avatar(x.name, colorOf(s, x.n))}
    <span class="rmain"><b>${esc(x.name)}</b>
      <small class="rsub">${x.valid ? `${esc(x.canonical)} · ${x.share}% said it`
        : x.given ? `<span class="strike">${esc(x.given)}</span> · not on the list` : 'No answer'}</small>
      <span class="rbar"><i></i></span></span>
    <span class="rside"><span class="rnum">0</span><span class="rlabel">&nbsp;</span></span>
    <span class="rtags">${x.outlier ? '<span class="tag">Outlier</span>' : ''}${x.shared ? '<span class="tag">Shared ½</span>' : ''}${x.doubled ? '<span class="tag dbl">×2</span>' : ''}</span>
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
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
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
  const order = lanes(s), max = (s.rounds + 1) * 100, top = order[0];
  const tied = order.filter(p => p.score === top.score).length > 1;
  const asked = (s.asks || []).map(n => (s.players.find(p => p.n === n) || {}).name).filter(Boolean);
  const iAsked = (s.asks || []).includes(s.you);
  show(`${partyBar(s, 'Final standings')}
    <div class="center"><p class="muted">${tied ? 'Furthest from the crowd (tied)' : 'Furthest from the crowd'}</p>
      <h2>${esc(order.filter(p => p.score === top.score).map(p => p.name).join(' & '))}</h2>
      <p class="muted">${top.score} paces · ${zoneName(top.score, max)}</p></div>
    <div class="card">${trailHTML(order.map(p => ({ name: p.name, from: 0, to: p.score, me: p.n === s.you, color: p.color })), max)}</div>
    <ol class="rows card players">${order.map((p, i) => `<li class="${p.n === s.you ? 'me' : ''}"><span class="num rank">${i + 1}</span>
      ${avatar(p.name, p.color)}
      <span class="main"><b>${esc(p.name)}</b><small>${zoneName(p.score, max)}</small></span><span class="num">${p.score}</span></li>`).join('')}</ol>
    ${awardsHTML(s)}
    ${asked.length ? `<p class="muted center">${asked.map(esc).join(', ')} ${asked.length === 1 ? 'wants' : 'want'} a rematch</p>` : ''}
    ${host ? `<div class="stack"><button class="btn primary" id="again">Rematch<small>Same players and settings, fresh prompts</small></button>
      <button class="btn" id="lobby">Change category</button></div>`
      : `<button class="btn${iAsked ? '' : ' primary'}" id="ask" ${iAsked ? 'disabled' : ''}>${iAsked ? 'Rematch requested' : 'Ask for a rematch'}</button>
         <p class="muted center">The host starts the next game.</p>`}`);
  if (!host) { if ($('#ask')) $('#ask').onclick = () => partyPost('/api/room/ask'); return; }
  $('#again').onclick = () => partyPost('/api/room/rematch');
  $('#lobby').onclick = () => partyPost('/api/room/lobby');
}

// ------------------------------------------------------------ boot

(async function boot() {
  try { CATS = await api('/api/categories'); } catch { app.innerHTML = '<p class="center muted">Could not reach the game server.</p>'; return; }
  pick = upgradePick(pick);   // older saved picks ({ cat, tags }) become the new mix shape
  const params = new URLSearchParams(location.search);
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
  const saved = store.get('outlier.party');
  if (saved && (!invite || invite.toUpperCase() === saved.code)) enterParty(saved.code, saved.pid);
  else if (invite) partyMenu(invite.toUpperCase().slice(0, 4));
  else home();
})();
