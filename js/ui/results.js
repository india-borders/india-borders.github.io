// Election results card for a selected seat (decisions R1, 22 Nov, and U5, 26 Nov 2026).
//   data/<state>/results/index.json lists the elections held on each map version; data/<state>/results/<key>.json
//   holds the ECI results per AC and PC (up to 5 candidates + Others, NOTA, electors, turnout, winner, margin).
//   An Assembly seat shows its Assembly results and, for Lok Sabha years, the votes cast in it as a segment (a
//   lead, not a result). A Lok Sabha seat shows its results and, for Assembly years, its segments' votes added up.
//   A Top 3 | 4 | 5 switch (remembered) sets how many candidates show; the rest fold into Others.
//   Pre-2008 elections sit on the 1976 maps (Feature 5); a "Colour map" button colours the map by the card's election
//   (Feature 7, ui/colour.js), and while it is on the card follows the coloured election.
//   Loaded on demand and cached; the panel renders the card synchronously once the data is in.
import { esc } from '../scales.js';
import { getJSON } from '../data/net.js';

let CTX = null;
let IDX;                       // undefined: not asked; null: none; object: loaded
let idxP = null;
const DOCS = new Map();        // key -> doc | Promise
const pick = {};               // `${ver}:${level}` -> chosen election key (this visit)
const GREY = '#8d877b';
const HOUSE = { VS: 'Assembly', LS: 'Lok Sabha' };
const TOPN_KEY = 'borders.topN';
const fmt = (n) => (n == null || !Number.isFinite(n) ? '–' : Math.round(n).toLocaleString('en-IN'));

export function initResults(ctx) { CTX = ctx; }

export function topN() {
  try { const n = +localStorage.getItem(TOPN_KEY); return n >= 3 && n <= 5 ? n : 3; } catch { return 3; }
}
export function setTopN(n) { try { localStorage.setItem(TOPN_KEY, String(n)); } catch { /* private mode */ } }

/** The state's results index (one fetch, shared by the card and the map colouring); null where there is none. */
export function ensureIndex() {
  if (IDX !== undefined) return Promise.resolve(IDX);
  if (!CTX.STATE.results) { IDX = null; return Promise.resolve(null); }
  if (!idxP) idxP = getJSON(`data/${CTX.STATE.code}/results/index.json`).then((d) => { IDX = d; return d; }).catch(() => { IDX = null; return null; });
  return idxP;
}
/** One election's results (one fetch per election, shared). */
export function ensureDoc(key) {
  const d = DOCS.get(key);
  if (d instanceof Promise) return d;
  if (d !== undefined) return Promise.resolve(d);
  const p = getJSON(`data/${CTX.STATE.code}/results/${key}.json`).then((x) => { DOCS.set(key, x); return x; }).catch(() => { DOCS.set(key, null); return null; });
  DOCS.set(key, p);
  return p;
}
function loadIndex(onReady) { ensureIndex().then(onReady); }
function loadDoc(key, onReady) { ensureDoc(key).then(onReady); }
export const idx = () => IDX || null;
export const docOf = (key) => { const d = DOCS.get(key); return d instanceof Promise ? undefined : d; };
/** An election's short name: "Telangana VS 2023", "VS 2005 Feb". */
export const electionLabel = (e) => `${e.sn ? `${e.sn} ` : ''}${e.house} ${e.lbl || e.year}`;

// colours: the party's, else its alliance's in that election, else a fixed muted colour per party code
const FALLBACK = ['#8c6d5a', '#6b8e7f', '#9a8fb0', '#b08f6b', '#7a8f9e', '#a3866f', '#6f7f5e', '#9e7b8a', '#7f8a6a', '#a07c7c'];
export function fallbackColour(code) {
  if (!code) return GREY;
  if (code === 'IND') return '#9b958a';
  let h = 0;
  for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}
export const partyColour = (party) => (IDX?.parties?.[party] || [])[1] || null;
export const blocColour = (bloc, key) => ((IDX?.blocs?.[key] || {})[bloc] || [])[1] || null;
export const blocName = (bloc, key) => ((IDX?.blocs?.[key] || {})[bloc] || [])[0] || bloc;
// a party's name in one election where ECI printed another (codes reused across decades: JNP, JD ...), else its usual name
export const partyName = (party, key) => (key && IDX?.pnames?.[key]?.[party]) || (IDX?.parties?.[party] || [])[0] || party;
/** A seat's first and last winner on its map, in its own house: [first year, party, bloc, last year, party, bloc]. */
export const bridgeOf = (ver, level, no) => IDX?.bridge?.[ver]?.[level]?.[String(no)] || null;

/** The elections that have a row for this seat (its map version, level and, for partial elections, its number). */
function electionsFor(sel, no) {
  if (!IDX) return [];
  return IDX.elections.filter((e) => {
    if (e.ver !== sel.ver || !(sel.level === 'ac' ? e.n_ac : e.n_pc)) return false;
    const only = sel.level === 'ac' ? e.acs : e.pcs;
    return !only || only.includes(no);
  });
}

export function choose(sel, key) { pick[`${sel.ver}:${sel.level}`] = key; }

/**
 * The card's HTML for the current selection: '' when the seat's map has no results, a placeholder while loading.
 * `rerender` is called when data arrive.
 */
export function resultsCard(st, unitNo, rerender) {
  // the card follows the coloured election while the map is coloured (Feature 7)
  if (!st.sel || st.sel.level === 'dt' || !CTX.STATE.results) return '';
  if (IDX === undefined) { loadIndex(rerender); return '<div class="rcard loading"><h2 class="h2">Results</h2><p class="note">Loading…</p></div>'; }
  const els = electionsFor(st.sel, unitNo);
  if (!els.length) return '';
  const own = st.sel.level === 'ac' ? 'VS' : 'LS';
  const pk = `${st.sel.ver}:${st.sel.level}`;
  let e = els.find((x) => x.key === st.colour) || els.find((x) => x.key === pick[pk]);
  if (!e) e = [...els].reverse().find((x) => x.house === own) || els[els.length - 1];
  const doc = DOCS.get(e.key);
  if (doc === undefined || doc instanceof Promise) { loadDoc(e.key, rerender); }
  const older = CTX.VERS.indexOf(st.sel.ver) < CTX.VERS.length - 1;
  // year switch: one row per house, the seat's own house first
  const rows = ['VS', 'LS'].sort((a, b) => (a === own ? -1 : b === own ? 1 : 0)).map((h) => {
    const hs = els.filter((x) => x.house === h);
    if (!hs.length) return '';
    // on an older map the year buttons take its dashed line style (Feature 5: the era is shown, not explained)
    return `<div class="ryears${older ? ' old' : ''}"><span class="rh">${HOUSE[h]}</span>${hs.map((x) => `<button data-rk="${x.key}" class="${x.key === e.key ? 'on' : ''}" aria-pressed="${x.key === e.key}"${x.sn ? ` title="${esc(x.sn)}"` : ''}>${esc(String(x.lbl || x.year))}</button>`).join('')}</div>`;
  }).join('');
  const n = topN();
  const switcher = `<span class="rtop" role="group" aria-label="Candidates shown">${[3, 4, 5].map((k) => `<button data-topn="${k}" class="${k === n ? 'on' : ''}" aria-pressed="${k === n}" title="Top ${k}">${k}</button>`).join('')}</span>`;
  const coloured = st.colour === e.key;
  const paint = `<button class="rcol${coloured ? ' on' : ''}" data-colour="${e.key}" aria-pressed="${coloured}" title="${coloured ? 'Clear map colours' : 'Colour map'}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/></svg></button>`;
  const head = `<h2 class="h2 rhead">Results <span class="rtools">${paint}${switcher}</span></h2>${rows}`;
  if (doc === undefined || doc instanceof Promise) return `<div class="rcard">${head}<p class="note">Loading…</p></div>`;
  if (doc === null) return `<div class="rcard">${head}<p class="note">Not available.</p></div>`;
  const u = doc[st.sel.level][String(unitNo)];
  const kind = st.sel.level === 'ac' && e.house === 'LS' ? 'lead' : st.sel.level === 'pc' && e.house === 'VS' ? 'sum' : 'result';
  const place = e.sn ? `${e.sn} ` : '';
  const yr = e.lbl || e.year;
  const what = { result: `${place}${HOUSE[e.house]} ${yr}`,
    lead: `${place}Lok Sabha ${yr} · segment lead`,
    sum: `${place}Assembly ${yr} · segments added` }[kind];
  // decision T1 (22 Nov, round 2): no source, method or gap text; an incomplete result carries a small tag only
  const tag = unopposed(u) ? ' <span class="rtag-inc">unopposed</span>' : u?.x ? ' <span class="rtag-inc">incomplete</span>' : '';
  if (!u) return `<div class="rcard">${head}<div class="rkind">${esc(what)} <span class="rtag-inc">no result</span></div></div>`;
  return `<div class="rcard">${head}<div class="rkind">${esc(what)}${tag}</div>${body(u, e, kind, n)}</div>`;
}

/** Elected unopposed: the winner is the only candidate and no votes were cast (ECI prints no poll). */
export const unopposed = (u) => !!(u && u.w && (u.c || []).length === 1 && u.c[0] && u.c[0][3] == null && u.c[0][1] === u.w);

function colourOf(party, bloc, key) {
  return (IDX.parties[party] || [])[1] || ((IDX.blocs[key] || {})[bloc] || [])[1] || GREY;
}
const partyTitle = (p, key) => partyName(p, key);
const blocLabel = (b, key) => ((IDX.blocs[key] || {})[b] || [])[0] || b;

function body(u, e, kind, n) {
  if (unopposed(u)) {   // no poll: the winner, and the electors on the roll
    const c = u.c[0];
    return `<div class="rwin"><i style="background:${colourOf(c[1], c[2], e.key)}"></i><div><b>${esc(c[0] || partyTitle(c[1], e.key) || c[1])}</b>${c[0] ? ` <span class="rp" title="${esc(partyTitle(c[1], e.key))}">${esc(c[1] || '')}</span>` : ''}
      <div class="rm">elected unopposed</div></div></div>${u.e != null ? `<div class="rfacts"><span><small>Electors</small>${fmt(u.e)}</span></div>` : ''}`;
  }
  let all = (u.c || []).filter((c) => c && Number.isFinite(c[3]));
  if (!all.length) return '';   // no votes in the source (e.g. a poll postponed): no zero figures
  // added-up Assembly votes of a Lok Sabha seat: bars by votes (the combined independents can outpoll a party);
  // the winner stays the leading party
  if (kind === 'sum') all = [...all].sort((a, b) => b[3] - a[3]);
  const cands = all.slice(0, n);
  const others = (u.o || 0) + all.slice(n).reduce((t, c) => t + c[3], 0);
  const total = all.reduce((t, c) => t + c[3], 0) + (u.o || 0) + (u.nota || 0);
  const pct = (v) => (total > 0 ? (100 * v) / total : NaN);
  const p1 = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '–');
  const top = kind === 'sum' ? all.find((c) => c[1] === u.w) || all[0] : all[0];
  const verb = { result: 'won by', lead: 'led by', sum: 'ahead by' }[kind];
  const win = `<div class="rwin"><i style="background:${colourOf(top[1], top[2], e.key)}"></i><div><b>${esc(top[0] || partyTitle(top[1], e.key) || top[1])}</b>${top[0] ? ` <span class="rp" title="${esc(partyTitle(top[1], e.key))}">${esc(top[1] || '')}</span>` : ''}
      <div class="rm">${u.m != null ? `${verb} <b>${fmt(u.m)}</b>${u.mp != null ? ` (${u.mp.toFixed(1)}%)` : ''}` : ''}${u.r ? ` · runner-up ${esc(u.r)}` : ''}</div></div></div>`;
  const bar = (label, sub, v, col, title = '') => {
    const s = pct(v);
    return `<div class="rrow"><span class="rn"${title ? ` title="${esc(title)}"` : ''}>${label}${sub ? ` <small>${sub}</small>` : ''}</span><span class="rv">${p1(s)}</span>
      <span class="br"><i style="width:${Number.isFinite(s) ? Math.max(1, s) : 0}%;background:${col}"></i></span><span class="sub">${fmt(v)}</span></div>`;
  };
  // segments added up for a Lok Sabha seat are party totals (no candidate): the party is the label
  const bars = cands.map((c) => (c[0]
    ? bar(esc(c[0]), `${esc(c[1] || '')}${c[2] && c[2] !== c[1] ? ` · ${esc(c[2])}` : ''}`, c[3], colourOf(c[1], c[2], e.key), `${partyTitle(c[1], e.key)}${c[2] ? `, ${blocLabel(c[2], e.key)}` : ''}`)
    : bar(esc(c[1] === 'IND' ? 'Independents' : partyName(c[1], e.key) || '–'), `${c[1] === 'IND' ? '' : esc(c[1] || '')}${c[2] && c[2] !== c[1] ? ` · ${esc(c[2])}` : ''}`, c[3], colourOf(c[1], c[2], e.key), blocLabel(c[2], e.key) || ''))).join('')
    + (others ? bar('Others', '', others, GREY) : '') + (u.nota != null ? bar('NOTA', '', u.nota, '#b5ada0') : '');
  const facts = `<div class="rfacts"><span><small>Turnout</small>${u.t != null ? `${u.t.toFixed(1)}%` : '–'}</span><span><small>Electors</small>${fmt(u.e)}</span><span><small>Votes</small>${fmt(total)}</span></div>`;
  return `${win}<div class="rrows">${bars}</div>${facts}`;
}
