// Election-results colouring (Feature 7, approved 27 Nov 2026; docs/proposals/PROPOSAL_F7_results_choropleth.md).
//   Started from the results card ("Colour map"): the map's seats of that election (Assembly elections: ACs; Lok Sabha
//   elections: PCs, on the map the election was held on) take their winner's colour, by alliance where the election has
//   alliances coded, else by party (switch: Alliance | Party). "Shade by margin" keeps the hue and steps its opacity
//   (under 5, 5-15, over 15 points). A seat with no result has no fill. The legend line in the top bar counts the
//   seats; the year strip steps through the state's elections of the same house. Fills sit under Borders' own lines,
//   so every basemap (Map, Satellite, Terrain) shows it the same way.
//   The landing (phase 2, 27 Nov) colours India's Lok Sabha seats by general election year, each state on the map that
//   year's election was held on (data/IN/results, pipeline/national.py). Alliances are coded per state: the national
//   ones (NDA, UPA, INDIA) take one colour each there, and the legend joins each state's coding that shares it (NDA
//   with Maharashtra's MahaYuti); other alliances and parties keep their own chips.
//   Lead mode (round 6, 27 Nov): a Lok Sabha election coloured while the map shows Assembly seats colours each
//   Assembly segment by the party or alliance that led in it (the store's segment rows), labelled "segment leads",
//   with the Lok Sabha seats' lines drawn over them. No control of its own: the level switch and the card lead to it.
import { esc } from '../scales.js';
import { list } from '../data/units.js';
import { ensureIndex, ensureDoc, idx, docOf, electionLabel, partyColour, blocColour, blocName, partyName, fallbackColour, unopposed } from './results.js';

let CTX = null;
let playTimer = null;
const MAX_CHIPS = 6;

export function initColour(ctx) { CTX = ctx; }

const hexRGB = (hex) => {
  const h = String(hex || '#888888').replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const rgba = (hex, a) => { const [r, g, b] = hexRGB(hex); return `rgba(${r},${g},${b},${a})`; };

/** The coloured election's index entry, or null. */
export function colouredElection() {
  const key = CTX?.S.get().colour;
  return key ? (idx()?.elections || []).find((e) => e.key === key) || null : null;
}
export const levelOf = (e) => (e.house === 'VS' ? 'ac' : 'pc');
/** The level an election colours: its own seats, or, for a Lok Sabha election while the map shows Assembly seats, its
 * segments' leads (where the store has them). */
export const colourLevel = (e, st = CTX.S.get()) => (e.house === 'LS' && e.lead && st.level === 'ac' ? 'ac' : levelOf(e));
const isLead = (e, lvl) => e.house === 'LS' && lvl === 'ac';
const docKey = (e, lvl) => (e.national && lvl === 'ac' ? `${e.key}_ac` : e.key);   // the landing keeps leads apart
/** The coloured election's name as shown: "LS 2024", or "LS 2024 · segment leads" in lead mode. */
export function colourTitle(e, st = CTX.S.get()) {
  return `${electionLabel(e)}${isLead(e, colourLevel(e, st)) ? ' · segment leads' : ''}`;
}

/** The winner's colour key and colour for one seat: alliance (where coded and chosen), else party. */
function winnerKey(u, e, byBloc) {
  if (byBloc && u.wb) {   // the landing's seats carry their state's alliance colour and name (bc, bn)
    const col = u.bc || blocColour(u.wb, e.key);
    if (col) return { k: `b:${u.wb}`, label: u.wb, title: u.bn || blocName(u.wb, e.key), colour: col };
  }
  const p = u.w;
  return { k: `p:${p}`, label: p, title: partyName(p, e.key), colour: partyColour(p) || fallbackColour(p) };
}

/**
 * Colour the map by the election in st.colour; resolves true when painted (false: nothing to paint).
 * Sets ctx.rt.resLegend for the legend line.
 */
export async function paintResults(view) {
  const st = CTX.S.get();
  const I = await ensureIndex();
  const e = (I?.elections || []).find((x) => x.key === st.colour);
  if (!e) { CTX.rt.resLegend = null; return false; }
  const lvl = colourLevel(e, st);
  const doc = await ensureDoc(docKey(e, lvl));
  if (!doc || CTX.S.get().colour !== e.key) return false;
  if (e.national) return paintNational(view, e, doc, st, lvl);
  const ids = new Map(list(e.ver, lvl).map((u) => [String(u.no), u.id]));
  const hasBlocs = Object.keys(I.blocs?.[e.key] || {}).length > 0;
  const byBloc = hasBlocs && st.colourBy !== 'party';
  const colours = new Map();
  const tally = new Map();
  let seats = 0;
  for (const [no, u] of Object.entries(doc[lvl] || {})) {
    const id = ids.get(no);
    const top = (u.c || [])[0];
    if (id == null || !top || (top[3] == null && !unopposed(u)) || !u.w) continue;   // no result: no fill (never "Others", never a colour)
    const w = winnerKey(u, e, byBloc);
    colours.set(id, rgba(w.colour, shadeAlpha(st, u)));
    const t = tally.get(w.k) || { ...w, n: 0 };
    t.n += 1;
    tally.set(w.k, t);
    seats += 1;
  }
  view.setUnitColours(e.ver, lvl, colours);
  view.setFillOpacity(view.dark ? 0.68 : 0.62);
  CTX.rt.resLegend = { e, items: [...tally.values()].sort((x, y) => y.n - x.n || x.label.localeCompare(y.label)), hasBlocs, byBloc, seats, lead: isLead(e, lvl) };
  return true;
}

const shadeAlpha = (st, u) => (st.shade && u.mp != null ? (u.mp < 5 ? 0.38 : u.mp < 15 ? 0.68 : 1) : 1);
const stateName = (code) => CTX.cfg.states.find((s) => s.code === code)?.name || code;

/** The landing: every state's seats (or segments) on the map its election was held on (doc[lvl] = {role: {no: unit}}). */
function paintNational(view, e, doc, st, lvl) {
  const byBloc = !!e.blocs && st.colourBy !== 'party';
  const sets = {};
  const groups = new Map();
  const natOf = new Map(Object.entries(e.nat || {}).map(([code, col]) => [String(col).toLowerCase(), code]));
  let seats = 0;
  for (const [role, units] of Object.entries(doc[lvl] || {})) {
    const ids = new Map(list(role, lvl).map((u) => [String(u.no), u.id]));
    const m = new Map();
    for (const [no, u] of Object.entries(units)) {
      const id = ids.get(no);
      const top = (u.c || [])[0];
      if (id == null || !top || (top[3] == null && !unopposed(u)) || !u.w) continue;   // no result: no fill
      const w = winnerKey(u, e, byBloc);
      m.set(id, rgba(w.colour, shadeAlpha(st, u)));
      // a state's own coding of a national alliance (MahaYuti, UDF, INC with JD(S)) shares its colour: one chip
      const nat = w.k.startsWith('b:') ? natOf.get(String(w.colour).toLowerCase()) : null;
      const joined = !!nat;
      const gk = nat ? `n:${nat}` : w.k;
      const g = groups.get(gk) || { joined, nat, colour: w.colour, n: 0, title: w.title, codes: new Map(), sts: new Map() };
      g.n += 1;
      g.codes.set(w.label, (g.codes.get(w.label) || 0) + 1);
      g.sts.set(u.st, (g.sts.get(u.st) || 0) + 1);
      groups.set(gk, g);
      seats += 1;
    }
    sets[role] = m;
  }
  const items = [...groups.entries()].map(([k, g]) => {
    const codes = [...g.codes.entries()].sort((x, y) => y[1] - x[1]);
    return { k, colour: g.colour, n: g.n, label: g.nat || codes[0][0], sts: g.sts, title: g.joined ? codes.map(([c, n]) => `${c} ${n}`).join(' · ') : g.title };
  }).sort((x, y) => y.n - x.n || x.label.localeCompare(y.label));
  const seen = new Set();   // one name on two chips (an alliance coloured otherwise in one state): name that state
  for (const t of items) {
    if (seen.has(t.label)) t.label = `${t.label} (${stateName([...t.sts.entries()].sort((x, y) => y[1] - x[1])[0][0])})`;
    seen.add(t.label);
  }
  view.setUnitColourSets(lvl, sets);
  view.setFillOpacity(view.dark ? 0.68 : 0.62);
  CTX.rt.resLegend = { e, items, hasBlocs: !!e.blocs, byBloc, seats, lead: isLead(e, lvl) };
  return true;
}

/** The legend line: election, Alliance | Party, seat counts by winner, Shade by margin, clear. '' when not colouring. */
export function resultsLegendHTML() {
  const L = CTX?.rt.resLegend;
  const st = CTX?.S.get();
  if (!L || !st?.colour || L.e.key !== st.colour) return '';
  const chips = L.items.slice(0, MAX_CHIPS).map((t) => `<span class="rl-chip" title="${esc(t.title)}"><i style="background:${t.colour}"></i>${esc(t.label)} <b>${t.n}</b></span>`).join('')
    + (L.items.length > MAX_CHIPS ? `<span class="rl-chip more" title="${esc(L.items.slice(MAX_CHIPS).map((t) => `${t.label} ${t.n}`).join(', '))}">+${L.items.length - MAX_CHIPS}</span>` : '');
  const by = L.hasBlocs ? `<span class="seg sm rl-by"><button data-k="colourBy" data-v="bloc" class="${L.byBloc ? 'on' : ''}">Alliance</button><button data-k="colourBy" data-v="party" class="${L.byBloc ? '' : 'on'}">Party</button></span>` : '';
  return `<div class="rleg"><span class="rl-name">${esc(electionLabel(L.e))}${L.lead ? ' · segment leads' : ''}</span>${by}
    <span class="rl-chips">${chips}</span>
    <button class="chip mini rl-shade${st.shade ? ' on' : ''}" data-rshade="1" aria-pressed="${!!st.shade}">Shade by margin</button>
    <button class="rl-x" data-rclear="1" title="Clear colours" aria-label="Clear colours">✕</button></div>`;
}

/** The year strip while colouring: the state's elections of the same house, with Play. '' when not colouring. */
export function resultsTimelineHTML(playIcon, pauseIcon) {
  const e = colouredElection();
  if (!e) return '';
  const same = (idx()?.elections || []).filter((x) => x.house === e.house);
  if (same.length < 2) return '';
  return `<button class="play rplay" aria-label="${playTimer ? 'Pause' : 'Play through the elections'}">${playTimer ? pauseIcon : playIcon}</button>
    <div class="years">${same.map((x) => `<button data-ckey="${x.key}" class="${x.key === e.key ? 'on' : ''}"${x.sn ? ` title="${esc(x.sn)}"` : ''}>${esc(String(x.lbl || x.year).replace(/^20/, "'"))}</button>`).join('')}</div>`;
}

export function toggleResultsPlay(render) {
  if (playTimer) { stopResultsPlay(render); return; }
  const step = () => {
    const e = colouredElection();
    if (!e) { stopResultsPlay(render); return; }
    const same = (idx()?.elections || []).filter((x) => x.house === e.house);
    const i = same.findIndex((x) => x.key === e.key);
    if (i >= same.length - 1) { stopResultsPlay(render); return; }
    CTX.act.colourMap(same[i + 1].key, true);
  };
  const e = colouredElection();
  const same = (idx()?.elections || []).filter((x) => x.house === e?.house);
  if (e && same.length && same[same.length - 1].key === e.key) CTX.act.colourMap(same[0].key, true);
  playTimer = setInterval(step, 1700);
  render();
}
export function stopResultsPlay(render) {
  if (playTimer) { clearInterval(playTimer); playTimer = null; render?.(); }
}

/** The tooltip block for the seat under the pointer: election, winner, share, margin, runner-up. */
export function resultsTipHTML(at) {
  const e = colouredElection();
  if (!e) return '';
  const lvl = colourLevel(e);
  const lead = isLead(e, lvl);
  const doc = docOf(docKey(e, lvl));
  if (!doc) return '';
  let u = null;
  if (e.national) {   // the landing: the seat on the map its state's election was held on
    for (const role of Object.keys(doc[lvl] || {})) {
      const id = at?.[role]?.[lvl];
      const u0 = id != null ? list(role, lvl)[id] : null;
      if (!u0 || e.roles?.[u0.st] !== role) continue;
      u = doc[lvl][role][String(u0.no)] || null;
      break;
    }
  } else {
    const id = at?.[e.ver]?.[lvl];
    if (id == null) return '';
    const u0 = list(e.ver, lvl)[id];
    u = u0 ? doc[lvl][String(u0.no)] : null;
  }
  const label = esc(`${electionLabel(e)}${lead ? ' · segment lead' : ''}${u?.py ? ` · polled ${u.py}` : ''}`);   // Punjab 1992 in 1991
  const top = (u?.c || [])[0];
  if (!u || !top || (top[3] == null && !unopposed(u))) return `<div class="t3 rtip"><span class="rtl">${label}</span> <span class="rtag-inc">no result</span></div>`;
  const total = (u.c || []).reduce((t, c) => t + (c[3] || 0), 0) + (u.o || 0) + (u.nota || 0);
  const share = total > 0 ? ((100 * top[3]) / total).toFixed(1) : null;
  const S = CTX.S.get();
  const byBloc = S.colourBy !== 'party' && (e.national ? !!e.blocs : Object.keys(idx()?.blocs?.[e.key] || {}).length > 0);
  const w = winnerKey(u, e, byBloc);
  return `<div class="t3 rtip"><span class="rtl">${label}</span>${unopposed(u) ? ' <span class="rtag-inc">unopposed</span>' : u.x ? ' <span class="rtag-inc">incomplete</span>' : ''}
    <div class="rtw"><i style="background:${w.colour}"></i><b>${esc(top[0] || partyName(top[1], e.key) || '')}</b> ${esc(top[1] || '')}${top[2] && top[2] !== top[1] ? ` · ${esc(top[2])}` : ''}</div>
    <div class="rtm">${share != null ? `${share}%` : ''}${u.mp != null ? ` · ${lead ? 'led by' : 'margin'} ${u.mp.toFixed(1)} pts` : ''}${u.r ? ` · v ${esc(u.r)}` : ''}</div></div>`;
}
