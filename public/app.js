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

let timer = null;
function stopTimer() { clearInterval(timer); timer = null; }
function runTimer(ms, total, onEnd) {
  stopTimer();
  const end = performance.now() + ms;
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    const bar = $('#tbar'), secs = $('#tsecs');
    if (bar) { bar.style.width = (100 * left / total) + '%'; bar.classList.toggle('low', left < 6000); }
    if (secs) secs.textContent = Math.ceil(left / 1000);
    if (left <= 0) { stopTimer(); onEnd(); }
  };
  timer = setInterval(tick, 100);
  tick();
}

async function shareText(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    if (navigator.clipboard) { await navigator.clipboard.writeText(text); toast('Copied'); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const ta = Object.assign(document.createElement('textarea'), { value: text });
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
        <div class="mark" data-to="${pct(l.to)}" style="left:${pct(l.from)}%">${esc(l.name[0].toUpperCase())}</div>
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
let skipBuild = null;
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
    tierEl.textContent = res.valid ? TIERS[t] : res.given ? 'Not on the list' : 'No answer';
    $('#caption').innerHTML = !res.valid ? 'No distance gained this round.'
      : res.share < 1 ? `Fewer than <b>1 in 100</b> people said ${esc(res.canonical)}`
        : `<b>${lit} in 100</b> people said ${esc(res.canonical)}`;
    app.querySelectorAll('.wait').forEach(el => el.classList.remove('wait'));
    walk();
  };
  if (!res.valid || matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
  const duration = 1500 + res.points * 35, start = performance.now();
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
app.addEventListener('click', () => skipBuild && skipBuild());   // tap to skip the build-up

function outlierHTML(list, mine) {
  if (list.some(o => o.name === mine)) return '<p class="muted center">You found the Outlier.</p>';
  return `<p class="muted center">${list.length > 1 ? 'The Outliers were' : 'The Outlier was'} ${list.map(o => `<b>${esc(o.name)}</b>`).join(' and ')}</p>`;
}

function boardHTML(board, mine) {
  return `<details><summary>See every answer (${board.length})</summary><ol class="rows board">${board.map(b => `
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
let pick = store.get('outlier.pick', { cat: 'all', tags: [] });
const catOf = id => CATS.find(c => c.id === id) || CATS[0];

function poolCount(p) {
  const c = catOf(p.cat);
  if (!c.tagsets) return c.count;
  // Mirrors pool() in server.py: for Era, every decade a question spans must be picked.
  return c.tagsets.filter(tags => (p.tags.length || !tags.includes('~deep')) && c.filters.every(g => {
    const chosen = g.tags.filter(t => p.tags.includes(t.id));
    if (!chosen.length) return true;
    const have = g.tags.filter(t => tags.includes(t.id)).length;
    const hit = chosen.filter(t => tags.includes(t.id)).length;
    return hit > 0 && (g.label !== 'Era' || hit === have);
  })).length;
}

function pickLabel(p) {
  const c = catOf(p.cat);
  const tags = c.filters.flatMap(g => g.tags).filter(t => p.tags.includes(t.id)).map(t => t.label);
  return [c.label, ...tags].join(' · ');
}

function mountPicker(el, onChange) {
  const draw = () => {
    const c = catOf(pick.cat);
    el.innerHTML = `<div class="picker">
      <div class="group"><h3>Category</h3><div class="chips">${CATS.map(x =>
        `<button class="chip${x.id === c.id ? ' on' : ''}" data-cat="${x.id}">${esc(x.label)}</button>`).join('')}</div></div>
      ${c.filters.map(g => `<div class="group"><h3>${esc(g.label)}</h3><div class="chips">${g.tags.map(t =>
        `<button class="chip${pick.tags.includes(t.id) ? ' on' : ''}" data-tag="${t.id}" ${t.count ? '' : 'disabled'}>${esc(t.label)}</button>`).join('')}</div></div>`).join('')}
      <p class="muted">${poolCount(pick)} prompts match${c.filters.length && !pick.tags.length ? ' · tap a filter to narrow it down' : ''}</p>
    </div>`;
  };
  el.onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.cat) pick = { cat: b.dataset.cat, tags: [] };
    else pick.tags = pick.tags.includes(b.dataset.tag) ? pick.tags.filter(t => t !== b.dataset.tag) : [...pick.tags, b.dataset.tag];
    store.set('outlier.pick', pick);
    draw();
    onChange && onChange();
  };
  draw();
}

// ------------------------------------------------------------ home

function home() {
  stopTimer();
  const streak = store.get('outlier.streak', { n: 0 });
  show(`<div class="hero">
      <div class="logo">Outl<b>i</b>er</div>
      <p>Give the answer nobody else did.</p>
      ${crowdHTML(3)}
    </div>
    <div class="stack">
      <button class="btn primary" id="solo">Play solo<small>Daily five or a seven-prompt game</small></button>
      <button class="btn" id="party">Party game<small>Everyone joins on their own phone</small></button>
    </div>
    ${streak.n > 1 ? `<p class="muted center">Daily streak: ${streak.n} days</p>` : ''}
    <details class="card"><summary>How it works</summary>
      <p class="muted">You get a prompt and 30 seconds. Any correct answer scores, but rarer answers score more:
      from 10 for the one everyone says up to 99, and each question has one Outlier (two on very long lists) worth the full 100. Your points are paces away from the crowd.
      Every answer played shifts how common it is, so the rarest answer today might not be tomorrow.
      In party games, players who give the same answer share half the points.</p>
    </details>`);
  $('#solo').onclick = soloMenu;
  $('#party').onclick = () => partyMenu();
}

// ------------------------------------------------------------ solo

function soloMenu() {
  stopTimer();
  show(`<header class="bar"><button class="link" id="back">‹ Back</button><span>Solo</span><span></span></header>
    <div id="picker"></div>
    <div class="stack">
      <button class="btn primary" id="daily"></button>
      <button class="btn" id="free"></button>
    </div>
    <details class="card"><summary>Got a seed from a friend?</summary>
      <div class="row"><input type="text" id="seedIn" placeholder="Paste the seed or link" autocomplete="off"><button class="btn" id="seedGo">Play</button></div>
    </details>`);
  const refresh = () => {
    const c = catOf(pick.cat), saved = store.get('outlier.daily.' + c.id);
    const today = new Date().toLocaleDateString('en-CA');
    const done = saved && saved.date === today && saved.done;
    $('#daily').innerHTML = `Daily five · ${esc(c.label)}<small>${done ? `Played today: ${saved.total} paces. Tap to view.` : 'Same five prompts for everyone today'}</small>`;
    $('#free').innerHTML = `Seven-prompt game<small>${esc(pickLabel(pick))} · send the seed to challenge a friend</small>`;
    $('#free').disabled = !poolCount(pick);
  };
  mountPicker($('#picker'), refresh);
  refresh();
  $('#back').onclick = home;
  $('#daily').onclick = startDaily;
  $('#free').onclick = () => startGame();
  $('#seedGo').onclick = () => {
    const raw = $('#seedIn').value.trim();
    let seed = raw, from = '', pts = '';
    try { const u = new URL(raw); seed = u.searchParams.get('play') || ''; from = u.searchParams.get('from') || ''; pts = u.searchParams.get('pts') || ''; } catch { /* a bare seed */ }
    if (!seed) return toast('Paste a seed or challenge link');
    from ? challengeIntro(seed, from, pts) : startGame({ seed });
  };
}

async function startDaily() {
  let day;
  try { day = await api('/api/daily?cat=' + encodeURIComponent(pick.cat)); } catch (e) { return toast(e.message); }
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
        ${boardHTML(res.board, res.canonical)}
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
    <div class="total">${saved.total}<small> / ${max} paces</small></div>
    <div class="squares">${squares}</div>
    <div class="card">${trailHTML([{ name: 'You', from: 0, to: saved.total, me: true }], max)}
      <p class="zone">You ended up: ${zoneName(saved.total, max)}</p></div>
    <ul class="rows card">${saved.results.map(r => `<li><span class="main"><b>${r.valid ? esc(r.canonical) : `<span class="strike">${esc(r.given || 'No answer')}</span>`}</b>
      <small>${esc(r.prompt)}</small></span><span class="num">+${r.points}</span></li>`).join('')}</ul>
    <div class="stack">
      <button class="btn primary" id="share">Share result</button>
      <button class="btn" id="free">Play a seven-prompt game</button>
    </div>
    <p class="muted center">New prompts tomorrow.</p>`);
  $('#back').onclick = soloMenu;
  $('#free').onclick = () => startGame();
  $('#share').onclick = () => shareText(`Outlier · ${label} #${saved.number}\n${saved.total}/${max} paces from the crowd\n${squares}`);
}

// ------------------------------------------------------------ seven-prompt games
// Every game has a seed (its prompts' codes). Sharing the seed lets a friend play the same seven
// prompts; the link carries your name and per-prompt points so they can see what they have to beat.

async function startGame(opts = {}) {
  const seen = store.get('outlier.seen', []);
  let game;
  try {
    game = await api(opts.seed ? `/api/game?seed=${encodeURIComponent(opts.seed)}`
      : `/api/game?cat=${encodeURIComponent(pick.cat)}&tags=${encodeURIComponent(pick.tags.join(','))}&exclude=${encodeURIComponent(seen.join(','))}`);
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
        ${boardHTML(res.board, res.canonical)}
        <button class="btn primary" id="next">${done ? 'See your score' : 'Next prompt'}</button>
      </div>`);
    buildUp(res);
    $('#next').onclick = () => done ? gameSummary(run) : gameQuestion(run);
  });
  $('#quit').onclick = soloMenu;
}

function challengeLink(run, name) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('play', run.game.seed);
  u.searchParams.set('from', name);
  u.searchParams.set('pts', run.results.map(r => r.points).join('.'));
  return u.toString();
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
    <div class="total">${total}<small> / ${max} paces</small></div>
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
    shareText(`I scored ${total}/${max} on Outlier ${squares}\nCan you beat me on the same 7 prompts?\n${challengeLink(run, name)}`);
  };
}

// A challenge link: ?play=<seed>&from=<name>&pts=12.40.100...
function challengeIntro(seed, from, pts) {
  stopTimer();
  const points = (pts || '').split('.').map(n => Math.max(0, Math.min(100, parseInt(n, 10) || 0)));
  const rival = from ? { name: from.slice(0, 16), points } : null;
  const total = rival ? points.reduce((a, b) => a + b, 0) : 0;
  show(`<div class="hero">
      <div class="logo">Outl<b>i</b>er</div>
      <p>${rival ? `<b>${esc(rival.name)}</b> scored <b>${total}</b> paces on 7 prompts.<br>Can you get further from the crowd?`
        : 'Someone sent you a seven-prompt game.'}</p>
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
  show(`<header class="bar"><button class="link" id="back">‹ Back</button><span>Party game</span><span></span></header>
    <div class="group"><h3>Your name</h3>
      <input type="text" id="name" maxlength="16" placeholder="Name" value="${esc(store.get('outlier.name', ''))}"></div>
    <button class="btn primary" id="create">Host a new room</button>
    <p class="muted center">or join one</p>
    <form id="join" class="stack">
      <input type="text" id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" autocomplete="off">
      <button class="btn">Join room</button>
    </form>`);
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
    <span class="main"><b>${esc(p.name)}</b></span>
    ${p.n === s.host ? '<span class="tag">Host</span>' : ''}
    ${!p.online ? '<span class="tag">Away</span>'
      : s.phase === 'question' ? `<span class="tag">${p.answered ? 'Locked in' : 'Thinking'}</span>`
      : s.phase === 'pick' ? `<span class="tag">${p.picked ? 'Ready' : 'Deciding'}</span>`
      : s.phase !== 'final' && p.doubleLeft ? '<span class="tag dbl">×2 left</span>' : ''}
  </li>`).join('');
}

function renderParty(s) {
  const host = s.you === s.host;
  const answered = s.phase === 'question' && s.yourAnswer != null;
  const key = [s.phase, s.round, host, answered, s.phase === 'pick' && s.picked].join('|');
  if (key !== party.key) {
    party.key = key;
    stopTimer();
    ({ lobby: partyLobby, pick: partyPick, question: partyQuestion, reveal: partyReveal, final: partyFinal })[s.phase](s, host, answered);
    const leave = $('#leave');
    if (leave) leave.onclick = () => leaveParty();
  }
  const list = $('#players');
  if (list) list.innerHTML = playersHTML(s);
}

const partyBar = (s, mid) => `<header class="bar"><button class="link" id="leave">✕ Leave</button><span>${mid}</span><span class="pill">${esc(s.code)}</span></header>`;

function partyLobby(s, host) {
  show(`${partyBar(s, 'Lobby')}
    <div><p class="muted center">Room code</p><div class="roomcode">${esc(s.code)}</div></div>
    <button class="btn" id="invite">Share invite link</button>
    <div class="card"><h3>Players</h3><ul class="rows" id="players"></ul></div>
    ${host ? `<div id="picker"></div>
      <div class="group"><h3>Rounds</h3><div class="chips" id="rounds">${[3, 5, 7, 10].map(n =>
        `<button class="chip${n === party.rounds ? ' on' : ''}" data-n="${n}">${n}</button>`).join('')}</div></div>
      <div class="group"><h3>Time to answer</h3><div class="chips" id="secs">${[15, 30, 45, 60].map(n =>
        `<button class="chip${n === party.secs ? ' on' : ''}" data-n="${n}">${n}s</button>`).join('')}</div></div>
      <p class="muted">Everyone gets one double down per game: before each round you see the category, and can double that round's score.</p>
      <button class="btn primary" id="start">Start game</button>`
      : '<p class="muted center">Waiting for the host to pick a category and start.</p>'}`);
  $('#invite').onclick = () => shareText(`${location.origin}/?room=${s.code}`);
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

const startParty = () => partyPost('/api/room/start', { cat: pick.cat, tags: pick.tags, rounds: party.rounds, secs: party.secs });

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
    <div class="after${mine ? ' wait' : ''}">
    <ul class="rows card">${r.results.map(x => `<li class="${x.n === s.you ? 'me' : ''}">
      <span class="main"><b>${esc(x.name)}</b><small>${x.valid ? `${esc(x.canonical)} · ${x.share}% said it`
        : x.given ? `<span class="strike">${esc(x.given)}</span> · not on the list` : 'No answer'}</small></span>
      ${x.outlier ? '<span class="tag">Outlier</span>' : ''}${x.shared ? '<span class="tag">Shared ½</span>' : ''}${x.doubled ? '<span class="tag dbl">×2</span>' : ''}<span class="num">+${x.points}</span></li>`).join('')}</ul>
    ${crowdChart(r)}
    <div class="card">${trailHTML(lanes(s).map(p => {
      const got = r.results.find(x => x.n === p.n);
      return { name: p.name, from: p.score - (got ? got.points : 0), to: p.score, me: p.n === s.you };
    }), (s.rounds + 1) * 100)}</div>
    ${outlierHTML(r.outliers, mine && mine.canonical)}
    <p class="muted center">Most common: <b>${esc(r.commonest.name)}</b></p>
    ${host ? `<button class="btn primary" id="next">${last ? 'Final standings' : 'Next round'}</button>`
      : `<p class="muted center">Waiting for the host to continue.</p>`}
    </div>`);
  if (mine) buildUp(mine);
  if (host) $('#next').onclick = () => partyPost('/api/room/next');
}

function partyFinal(s, host) {
  const order = lanes(s), max = (s.rounds + 1) * 100, top = order[0];
  const tied = order.filter(p => p.score === top.score).length > 1;
  show(`${partyBar(s, 'Final standings')}
    <div class="center"><p class="muted">${tied ? 'Furthest from the crowd (tied)' : 'Furthest from the crowd'}</p>
      <h2>${esc(order.filter(p => p.score === top.score).map(p => p.name).join(' & '))}</h2>
      <p class="muted">${top.score} paces · ${zoneName(top.score, max)}</p></div>
    <div class="card">${trailHTML(order.map(p => ({ name: p.name, from: 0, to: p.score, me: p.n === s.you })), max)}</div>
    <ol class="rows card">${order.map((p, i) => `<li class="${p.n === s.you ? 'me' : ''}"><span class="num">${i + 1}</span>
      <span class="main"><b>${esc(p.name)}</b><small>${zoneName(p.score, max)}</small></span><span class="num">${p.score}</span></li>`).join('')}</ol>
    ${host ? `<div class="stack"><button class="btn primary" id="again">Play again</button>
      <button class="btn" id="lobby">Change category</button></div>`
      : '<p class="muted center">Waiting for the host to start another game.</p>'}`);
  if (!host) return;
  $('#again').onclick = startParty;
  $('#lobby').onclick = () => partyPost('/api/room/lobby');
}

// ------------------------------------------------------------ boot

(async function boot() {
  try { CATS = await api('/api/categories'); } catch { app.innerHTML = '<p class="center muted">Could not reach the game server.</p>'; return; }
  if (!CATS.some(c => c.id === pick.cat)) pick = { cat: 'all', tags: [] };
  const params = new URLSearchParams(location.search);
  const invite = params.get('room');
  if (params.get('play')) {
    history.replaceState(null, '', location.pathname);
    return challengeIntro(params.get('play'), params.get('from') || '', params.get('pts') || '');
  }
  const saved = store.get('outlier.party');
  if (saved && (!invite || invite.toUpperCase() === saved.code)) enterParty(saved.code, saved.pid);
  else if (invite) partyMenu(invite.toUpperCase().slice(0, 4));
  else home();
})();
