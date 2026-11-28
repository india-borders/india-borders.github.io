/* global h3 */
// Boot + orchestration (structure from India Hex). State lives in the store (store.js); this file
// reacts to it:
//   lines   (which map versions and level are drawn)                -> applyLines()
//   cells   (which hexagons: resolution, selected seat or viewport) -> updateCells()
//   colours (lens values -> scale -> hexagon fills / seat colours)   -> recolour()
//   chrome  (sidebar, controls) re-render from state.
// Map versions come from config (states[].versions); nothing here names a year or a state.
import { createStore, readHash, writeHash } from './store.js';
import { initHexStore, cellSet, findCell, chunksFor, manifest, values as hexRaw } from './data/hexstore.js';
import { initNet, getJSON } from './data/net.js';
import { loadUnits, unit, list, byNo, fullName, resTag, dtVer, hasDistricts, hasAssembly } from './data/units.js';
import { initLens, lensOf, hexValues, unitValues, resAvailable, seriesById } from './lens.js';
import { MapView } from './map/view.js';
import { loadVectorStyle } from './map/overlays.js';
import { rampFor, scaleFromValues, colourOf, position, rgba, fmtValue, esc } from './scales.js';
import { initPanel, renderPanel } from './ui/panel.js';
import { initFolds } from './ui/folds.js';
import { initColour, paintResults, resultsTipHTML, colouredElection, colourLevel, stopResultsPlay } from './ui/colour.js';
import { ensureIndex, docOf } from './ui/results.js';
import { initControls, renderLens, updateLegend, renderTimeline, lineKey } from './ui/controls.js';
import { initSearch } from './ui/search.js';
import { initStates } from './ui/states.js';
import { initStatusBar } from './ui/statusbar.js';
import { initMeasure } from './ui/measure.js';
const EX = () => import('./ui/exporter.js'); // loaded on first export only

const $ = (s) => document.querySelector(s);

// ---- boot ---------------------------------------------------------------------------------------
const cfg = await fetch('config.json', { cache: 'no-cache' }).then((r) => r.json());
const bootHash = new URLSearchParams(location.hash.slice(1));
const STATE = cfg.states.find((s) => s.code === bootHash.get('st')) || cfg.states.find((s) => s.code === cfg.defaults.state) || cfg.states[0];
const LOCATE_ON_BOOT = bootHash.get('loc') === '1';   // set when Find me switched state
for (const v of cfg.variables) {   // value quantisation and years per resolution are per state
  if (STATE.q?.[v.id]) v.q = STATE.q[v.id];
  if (STATE.res_years?.[v.id]) v.res_years = STATE.res_years[v.id];
}
// line styles are configured for the older map ("1976": dashed) and the newer one ("2008": solid); a state's
// other versions (Assam's 2023 map, say) take the style of their place in the order, or `style` if given
STATE.versions.forEach((v, i) => {
  const role = v.style || (i === 0 ? '1976' : '2008');
  for (const th of Object.values(cfg.palette)) {
    if (!th[v.id] && th[role]) th[v.id] = th[role];
    if (th.casing && !th.casing[v.id] && th.casing[role]) th.casing[v.id] = th.casing[role];
  }
});
const VERS = STATE.versions.map((v) => v.id);
const VMETA = Object.fromEntries(STATE.versions.map((v) => [v.id, v]));
const PRIMARY = STATE.primary || VERS[VERS.length - 1];
document.title = cfg.site.title;
let sideW0 = cfg.ui.sidebar_width || 392;
try { const w = +localStorage.getItem('borders.sideW'); if (w >= 300 && w <= 720) sideW0 = w; } catch { /* private mode */ }
document.documentElement.style.setProperty('--side-w', `${sideW0}px`);
if (cfg.ui.accent) document.documentElement.style.setProperty('--accent', cfg.ui.accent);
initNet(cfg.cdn, cfg.version, Object.fromEntries(cfg.states.filter((s) => s.cdn).map((s) => [s.code, s.cdn])));
initHexStore(STATE.code);
initLens(cfg);
const [U, vs] = await Promise.all([loadUnits(STATE.code), loadVectorStyle(cfg.overlays.vector_style)]);

const D = cfg.defaults;
const DEFAULTS = {
  ver: D.ver === 'newest' ? VERS[VERS.length - 1] : D.ver || 'both',
  level: (D.level || 'ac') === 'ac' && !hasAssembly() ? 'pc' : D.level || 'ac',   // no Assembly: Lok Sabha seats
  res: !cfg.features.hexagons || D.hex === 'off' || D.hex === 'auto' ? (cfg.features.hexagons ? D.hex : 'off') : +D.hex, scope: D.scope || 'view',
  sel: null, hex: null, basemap: D.basemap, overlays: D.overlays || [], var: D.variable || 'none', year: null, mode: 'value',
  from: null, density: false, threeD: false, compare: false, view: null,
  ramp: 'auto', rev: false, breaks: 'quantile', height: cfg.hex.height_default ?? 1.5, heightBy: 'value',
  state: cfg.defaults.state,
  colour: null, colourBy: 'bloc', shade: false,   // results colouring (Feature 7)
};
const hash = sanitize(readHash());

function sanitize(h) {
  const ok = {
    ver: (v) => (v === 'both' && VERS.length > 1) || VERS.includes(v),   // one map: no "Both"
    level: (v) => (v === 'ac' && hasAssembly()) || v === 'pc' || (v === 'dt' && hasDistricts()),
    res: (v) => v === 'off' || (!!cfg.features.hexagons && (v === 'auto' || cfg.hex.resolutions.includes(v))),
    scope: (v) => v === 'sel' || v === 'view',
    var: (v) => v === 'none' || cfg.variables.some((s) => s.id === v),
    basemap: (v) => cfg.basemaps.some((b) => b.id === v),
    mode: (v) => v === 'value' || v === 'change',
    year: (v) => Number.isFinite(v), from: (v) => Number.isFinite(v),
    view: (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite),
    hex: (v) => !!cfg.features.hexagons && typeof v === 'string' && h3.isValidCell(v),
    sel: (v) => !!v && VERS.includes(v.ver) && !!byNo(v.ver, v.level, v.no),
    breaks: (v) => ['quantile', 'equal', 'log'].includes(v),
    colour: (v) => typeof v === 'string' && /^[a-z]{2}_(ae|ge)\d{4}[a-z]*$/.test(v) && !!STATE.results,
    colourBy: (v) => v === 'bloc' || v === 'party',
    shade: (v) => typeof v === 'boolean',
    heightBy: (v) => v === 'value' || v === 'class',
    height: (v) => Number.isFinite(v) && v > 0 && v <= 6,
  };
  const out = { ...h };
  delete out.state;   // chosen at boot (STATE); the store holds it so the link keeps it
  for (const [k, test] of Object.entries(ok)) if (k in out && !test(out[k])) delete out[k];
  if (out.overlays) out.overlays = out.overlays.filter((o) => cfg.overlays.groups?.[o] || cfg.overlays.raster?.[o]);
  return out;
}
let theme = D.theme || 'dark';
let sideOff = false;
try { theme = localStorage.getItem('borders.theme') || theme; sideOff = localStorage.getItem('borders.side') === 'off'; } catch { /* private mode */ }
const sel0 = hash.sel ? { ver: hash.sel.level === 'dt' ? dtVer() : hash.sel.ver, level: hash.sel.level, id: byNo(hash.sel.ver, hash.sel.level, hash.sel.no).id } : null;
if (sel0 && !('level' in hash)) hash.level = sel0.level; // a link to a seat opens at that seat's level

const S = createStore({
  ...DEFAULTS, ...hash, sel: sel0, here: null, state: STATE.code,
  opacity: D.opacity ?? 0.55, theme, mask: false, labels: true, outline: true, hexLines: true, lineScale: 1, cbSafe: false,
  panel: 'place', filter: '', limit: 60, listVer: PRIMARY, comparePos: 0.5, side: sideOff,
});

const BBOX = STATE.bbox;
let initView = { bounds: [[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]], fitBoundsOptions: { padding: 30 } };
if (hash.view) initView = { zoom: hash.view[0], center: [hash.view[2], hash.view[1]] };
const view = new MapView('map', { cfg, vs, versions: VERS, view: initView });

const ctx = { cfg, S, view, cview: null, rt: { hexHint: '' }, geo: {}, feat: {}, act: {}, STATE, VERS, VMETA, PRIMARY };
ctx.activeVer = (st = S.get()) => (st.level === 'dt' ? dtVer() : st.ver === 'both' ? PRIMARY : st.ver);
window.borders = { S, view, cfg, ctx }; // debug / test hook (tools/shot.py)
const rt = ctx.rt;
let st0Ready = false;

// ---- helpers ------------------------------------------------------------------------------------
const views = () => (ctx.cview ? [view, ctx.cview] : [view]);
const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
const levelOne = (l) => cfg.boundaries.levels[l].short;
let toastTimer;
function toast(msg, { spin = false, ttl = 0 } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  if (!msg) { el.hidden = true; return; }
  el.innerHTML = `${spin ? '<span class="spin"></span>' : ''}<span>${msg}</span>`;
  el.hidden = false;
  if (ttl) toastTimer = setTimeout(() => { el.hidden = true; }, ttl);
}
function padding() {
  if (isMobile()) return { top: 70, bottom: Math.round(window.innerHeight * 0.5) + 20, left: 20, right: 60 };
  const lens = $('#lens');
  return { top: 90, bottom: 80, left: lens.classList.contains('closed') ? 40 : lens.offsetWidth + 40, right: 70 };
}
function fit(b, opts = {}) {
  view.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: padding(), maxZoom: 13.5, duration: 900, ...opts });
}

// ---- boundaries ---------------------------------------------------------------------------------
const geoLoading = {};
function ensureGeo(ver, level) {
  const key = `${ver}_${level}`;
  if (!geoLoading[key]) {
    geoLoading[key] = getJSON(`data/${STATE.code}/boundaries/${level === 'dt' ? 'districts' : key}.json`).then((fc) => {
      ctx.geo[key] = fc;
      ctx.feat[key] = new Map(fc.features.map((f) => [f.id, f]));
      views().forEach((v) => v.setBoundaryData(ver, level, fc));
      return fc;
    });
  }
  return geoLoading[key];
}
let outlineFC = null;
const outlineReady = Promise.all([getJSON(`data/${STATE.code}/boundaries/outline.json`), view.ready]).then(([fc]) => {
  outlineFC = fc;
  views().forEach((v) => v.setOutline(fc));
});
// every state's outline (the landing's file): other states are drawn and can be clicked (decision U2)
const NAT = cfg.states.find((x) => x.national);
if (STATE.national) outlineReady.then(() => { ctx.others = outlineFC; });
else if (NAT) {
  Promise.all([getJSON(`data/${NAT.code}/boundaries/outline.json`), view.ready]).then(([fc]) => {
    ctx.others = fc;
    const rest = { type: 'FeatureCollection', features: fc.features.filter((f) => f.properties.st !== STATE.code) };
    views().forEach((v) => v.setOthers(rest));
  }).catch(() => {});
}
const shownVers = (st) => (st.compare ? [VERS[0]] : st.ver === 'both' ? VERS : [st.ver]);
const labelVer = (st) => (st.compare ? VERS[0] : ctx.activeVer(st));

/** Lines and labels for the current version, level and swipe state (both views). */
function applyLines() {
  const st = S.get();
  const dt = st.level === 'dt';   // districts: their lines, with the chosen map's Assembly lines faint underneath
  view.setLines({ level: st.level, dtVer: dtVer(), subtle: STATE.national ? 0.6 : 1, vers: Object.fromEntries(VERS.map((v) => [v, shownVers(st).includes(v)])), outline: st.outline, pcOver: leadOver(st) });
  applyNatSplit(st);
  if (ctx.cview) {
    const right = VERS[VERS.length - 1];
    const cl = dt ? 'ac' : st.level;
    ctx.cview.setLines({ level: cl, vers: Object.fromEntries(VERS.map((v) => [v, v === right])), outline: st.outline });
    ctx.cview.setLabels(list(right, cl), cfg.boundaries.levels[cl].label_minzoom, st.labels, (u) => u.name);
  }
  return Promise.all([...VERS.map((v) => ensureGeo(v, dt ? 'ac' : st.level)), ...(dt ? [ensureGeo(dtVer(), 'dt')] : [])]);
}

/**
 * The landing's Lok Sabha colouring in a year when some states voted on their older map (Assam and J&K until 2019):
 * the states of each map, as a set of the older map's states; null otherwise.
 */
let natSplitOn = false;
function natOld(st) {
  if (!STATE.national || !st.colour || st.ver !== 'both' || !['pc', 'ac'].includes(st.level)) return null;
  const e = colouredElection();
  if (!e?.national || e.ver !== 'both') return null;
  return new Set(Object.entries(e.roles || {}).filter(([, r]) => r === VERS[0]).map(([c]) => c));
}
/** Labels for the map shown; on the landing in such a year, each state's lines and labels on its election's map only. */
function applyNatSplit(st = S.get()) {
  const old = natOld(st);
  if (STATE.national && (old || natSplitOn)) {
    const inOld = ['in', ['get', 'st'], ['literal', old ? [...old] : []]];
    views().forEach((v) => v.setStateFilter(old ? { [VERS[0]]: inOld, [VERS[VERS.length - 1]]: ['!', inOld] } : null));
  }
  natSplitOn = !!old;
  const lvl = st.level;
  const L = old
    ? [...list(VERS[VERS.length - 1], lvl).filter((u) => !old.has(u.st)), ...list(VERS[0], lvl).filter((u) => old.has(u.st))]
    : list(labelVer(st), lvl);
  view.setLabels(L, cfg.boundaries.levels[lvl].label_minzoom, st.labels, (u) => u.name);
}
/** Lead mode (a Lok Sabha election on Assembly seats): the version whose Lok Sabha lines go over the segments. */
function leadOver(st = S.get()) {
  const e = st.colour ? colouredElection() : null;
  return e && e.house === 'LS' && colourLevel(e, st) === 'ac' ? e.ver : null;
}
/** The map under the pointer: while the landing shows each state on its own election's map, the one drawn there. */
function pickVer(st, p) {
  if (natSplitOn && st.ver === 'both') {   // the map the seat's state is drawn on in this year (not just any hit)
    const old = natOld(st);
    for (const v of [...VERS].reverse()) {
      const id = p.at[v]?.[st.level];
      if (id == null) continue;
      if (!old || (v === VERS[0]) === old.has(list(v, st.level)[id]?.st)) return v;
    }
  }
  return labelVer(st);
}

// ---- cells ---------------------------------------------------------------------------------------
let cellTok = 0;
function viewBBox(pad = 0.08) {
  const b = view.map.getBounds();
  const w = b.getWest(); const e = b.getEast(); const s = b.getSouth(); const n = b.getNorth();
  const dx = (e - w) * pad; const dy = (n - s) * pad;
  return [w - dx, s - dy, e + dx, n + dy];
}
function autoResForView() {
  const z = view.map.getZoom();
  let res = null;
  for (const [r, minz] of Object.entries(cfg.hex.auto_zoom)) if (z >= minz && cfg.hex.resolutions.includes(+r)) res = Math.max(res ?? 0, +r);
  return res;
}
function autoResForUnit(u) {
  const max = cfg.hex.auto_max_cells || 90000;
  for (const r of [...cfg.hex.resolutions].sort((a, b) => b - a)) if ((u.h8 || 0) / 7 ** (8 - r) <= max) return r;
  return cfg.hex.resolutions[0];
}
const selField = (sel) => `${sel.ver}.${sel.level}`;

async function updateCells() {
  const t = ++cellTok;
  const st = S.get();
  rt.notice = '';
  if (st.res === 'off') { ctx.cs = null; rt.hexHint = ''; rt.shownRes = null; return recolour(); }
  const lens = lensOf(st);
  const u = st.sel ? unit(st.sel) : null;
  const useView = st.scope === 'view' || !u || u.hidden;
  let res; let cs = null;
  const fallback = (r) => { let x = r; while (x > cfg.hex.resolutions[0] && !resAvailable(lens, x)) x--; return x; };
  const viewRes = useView ? (st.res === 'auto' ? autoResForView() : st.res) : null;
  if (useView && viewRes == null) rt.notice = 'zoom in for hexagons';
  if (useView && viewRes != null) {
    res = fallback(viewRes);
    const bb = viewBBox();
    const m = await manifest(res);
    const est = (await chunksFor(res, bb)).length * (m.n / m.parents.length);
    if (est <= cfg.hex.max_cells_view) {
      toast(`Loading H${res} hexagons…`, { spin: true });
      cs = await cellSet(res, bb, { clip: viewBBox(0.15) });
    } else rt.notice = `zoom in for H${res}`;
  }
  if (!cs && u && !u.hidden) {
    res = fallback(st.res === 'auto' ? autoResForUnit(u) : st.res);
    while (res > cfg.hex.resolutions[0] && (u.h8 || 0) / 7 ** (8 - res) > cfg.hex.max_cells_selection) {
      res--; rt.notice = `${u.name} is too large for H${st.res} · showing H${res}`;
    }
    toast(`Loading H${res} hexagons for ${esc(u.name)}…`, { spin: true });
    cs = await cellSet(res, u.bbox, { filter: { field: selField(st.sel), id: st.sel.id } });
  }
  if (t !== cellTok) return;
  toast('');
  ctx.cs = cs;
  rt.shownRes = cs ? cs.res : null;
  if (cs && !cs.n && u) rt.notice = `no H${cs.res} cell has its centre in ${u.name}; try a finer level`;
  rt.hexHint = cs && cs.n ? `H${cs.res} · ${cs.n.toLocaleString('en-IN')} cells` : rt.notice;
  if (cs && cs.n && rt.notice) rt.hexHint = `H${cs.res} · ${cs.n.toLocaleString('en-IN')} · ${rt.notice}`;
  await recolour();
}
let cellTimer;
const updateCellsSoon = (ms = 200) => { clearTimeout(cellTimer); cellTimer = setTimeout(updateCells, ms); };

// ---- colouring ------------------------------------------------------------------------------------
let colTok = 0;
let ver = 0;

function inSelMask(cs, st) {
  if (!st.sel) return null;
  const f = cs.f[selField(st.sel)];
  if (!f) return null;
  const m = new Uint8Array(cs.n);
  for (let i = 0; i < cs.n; i++) m[i] = f[i] === st.sel.id ? 1 : 0;
  return m;
}

function fills(vals, sc, cs, st, mask) {
  const out = new Uint8Array(cs.n * 4);
  const a1 = Math.round(st.opacity * 255);
  const a0 = Math.round(st.opacity * 255 * 0.32);
  for (let i = 0; i < cs.n; i++) {
    const c = vals ? colourOf(vals[i], sc) : null;
    if (!c) { out[4 * i + 3] = 0; continue; }
    const [r, g, b] = rgba(c);
    let a = mask && !mask[i] ? a0 : a1;
    if (sc.faintFirst && vals[i] < sc.breaks[0]) a = Math.round(a * 0.3);
    out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = b; out[4 * i + 3] = a;
  }
  return out;
}

/**
 * 0..1 height of a value. "value": in proportion to the value (capped at the 99.5th percentile of what is
 * shown, so one outlier cannot flatten the rest) - differences read as they are; "class": by colour class.
 */
function heightFn(pool, sc, st) {
  if (st.heightBy === 'class') return (v) => position(v, sc);
  const a = [];
  for (const x of pool) if (Number.isFinite(x)) a.push(Math.abs(x));
  a.sort((x, y) => x - y);
  const top = a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.995))] || a[a.length - 1] : 1;
  return (v) => (Number.isFinite(v) && top > 0 ? Math.min(1, Math.abs(v) / top) : 0);
}

function elevations(vals, sc, cs, st, pool) {
  const k = { 6: 2.2, 7: 1.4, 8: 1 }[cs.res] || 1;
  const f = heightFn(pool, sc, st);
  const e = new Float32Array(cs.n);
  const scale = cfg.hex.extrude_scale * k * st.height;
  for (let i = 0; i < cs.n; i++) e[i] = Number.isFinite(vals[i]) ? 20 + f(vals[i]) * scale : 0;
  return e;
}

async function paint(v, lens, st, cver) {
  const cs = ctx.cs;
  const mask = cs ? inSelMask(cs, st) : null;
  const vals = cs && !lens.none ? await hexValues(cs, lens) : null;
  const uvals = !lens.none && !vals ? unitValues(cver, st.level, lens) : null;
  return (shared) => {
    let sc = null; let scopeLabel = ''; let coverage = null;
    const ramp = rampFor(lens, st.cbSafe, st.ramp, st.rev);
    if (vals) {
      let fin = 0; let n = 0;
      for (let i = 0; i < cs.n; i++) if (!mask || mask[i]) { n++; if (Number.isFinite(vals[i])) fin++; }
      coverage = { fin, n };
      let pool = vals;
      if (mask) { pool = []; for (let i = 0; i < vals.length; i++) if (mask[i]) pool.push(vals[i]); }
      sc = shared || scaleFromValues(pool, lens, ramp, st.breaks) || scaleFromValues(vals, lens, ramp, st.breaks);
      scopeLabel = st.sel ? unit(st.sel).name : 'the hexagons in view';
      v.setHexes({ cs, fill: fills(vals, sc, cs, st, mask), elev: st.threeD ? elevations(vals, sc, cs, st, pool) : null, threeD: st.threeD, lines: st.hexLines, version: ++ver });
      v.setUnitColours(cver, st.level, null);
    } else {
      v.setHexes({ cs, fill: null, elev: null, threeD: false, lines: true, version: ++ver });
      if (uvals) {
        sc = shared || scaleFromValues(Array.from(uvals), lens, ramp, st.breaks);
        scopeLabel = st.level === 'dt' ? 'the 2001 districts' : `${cfg.boundaries.levels[st.level].label} seats, ${VMETA[cver].label}`;
        const colours = new Map();
        const heights = st.threeD ? new Map() : null;
        const f = st.threeD && sc ? heightFn(Array.from(uvals), sc, st) : null;
        if (sc) {
          list(cver, st.level).forEach((u) => {
            const c = colourOf(uvals[u.id], sc);
            if (!c) return;
            colours.set(u.id, c);
            if (heights) heights.set(u.id, 50 + f(uvals[u.id]) * cfg.hex.extrude_scale * 4 * st.height);
          });
        }
        v.setUnitColours(cver, st.level, colours, heights);
      } else v.setUnitColours(cver, st.level, null);
    }
    return { sc, scopeLabel, coverage };
  };
}

async function recolour() {
  const t = ++colTok;
  const st = S.get();
  if (st.colour) {   // Feature 7: the seats take their winners' colours
    const ok = await paintResults(view);
    if (t !== colTok) return;
    if (ok) { rt.legend = null; if (STATE.national) applyNatSplit(); view.setLines({ pcOver: leadOver() }); updateLegend(); renderTimeline(); renderPanel(); return; }
  }
  rt.resLegend = null;
  if (natSplitOn) applyNatSplit();
  if (view.shown?.pcOver) view.setLines({ pcOver: null });
  views().forEach((v) => v.setFillOpacity(st.opacity));
  const lens = lensOf(st);
  const applyMain = await paint(view, lens, st, labelVer(st));
  const applyCmp = ctx.cview ? await paint(ctx.cview, lens, st, VERS[VERS.length - 1]) : null;
  if (t !== colTok) return;
  const { sc, scopeLabel, coverage } = applyMain();
  if (applyCmp) applyCmp(ctx.cs ? sc : null);
  rt.legend = { sc, lens, scopeLabel, coverage };
  updateLegend();
  renderPanel();
}

// ---- selection ------------------------------------------------------------------------------------
const CP_MIN = 0.01; // counterparts drawn when they hold at least 1% of the seat's people
async function showSelection() {
  const st = S.get();
  if (!st.sel) { views().forEach((v) => { v.setSelection(null, false); v.setCounterparts(null); }); return; }
  const { ver: sv, level, id } = st.sel;
  const u = unit(st.sel);
  await ensureGeo(sv, level);
  rt.selFeat = ctx.feat[`${sv}_${level}`].get(id) || null;
  views().forEach((v) => v.setSelection(rt.selFeat, st.mask, lensOf(st).none));
  views().forEach((v) => v.setCounterparts(null));
  void u; void CP_MIN;
  await showSegments();
}

/** A selected Lok Sabha seat shows its Assembly segments' lines and names, in the map's own Assembly style. */
async function showSegments() {
  const st = S.get();
  if (!st.sel || st.sel.level !== 'pc' || STATE.national) { views().forEach((v) => v.setSegments(null)); return; }
  const { ver: sv, id } = st.sel;
  await ensureGeo(sv, 'ac');
  if (S.get().sel !== st.sel) return;
  const acs = list(sv, 'ac').filter((a) => a.pc === id && !a.hidden);
  const feats = acs.map((a) => ctx.feat[`${sv}_ac`].get(a.id)).filter(Boolean);
  views().forEach((v) => v.setSegments(feats, sv, acs));
}

/** Outline one seat crisply while its row in the panel is hovered (decision O2); null clears it. */
let previewTok = 0;
async function preview(v, level, id) {
  const t = ++previewTok;
  if (id == null || id < 0) { views().forEach((w) => w.setCounterparts(null)); return; }
  await ensureGeo(v, level);
  if (t !== previewTok) return;
  const f = ctx.feat[`${v}_${level}`]?.get(id);
  views().forEach((w) => w.setCounterparts(f ? [f] : null));
}

function select(sv, level, id, { fly = true } = {}) {
  if (STATE.national) {   // the landing: open the seat (or district) in its own state, same level and map choice
    const u = list(sv, level)[id];
    if (!u) return;
    const target = cfg.states.find((x) => x.code === u.st);
    const tver = level === 'dt' ? target.versions[target.versions.length - 1].id : u.sv;
    const e = S.get().colour ? colouredElection() : null;   // the landing's colouring opens the state coloured the same
    const r = e?.national ? docOf(level === 'ac' ? `${e.key}_ac` : e.key)?.[level]?.[sv]?.[String(u.no)] : null;
    ctx.act.openState(u.st, `${tver}.${level}.${u.pno}`, e?.national ? { m: tver, cl: r?.k || null } : {});
    return;
  }
  if (level === 'dt') sv = dtVer();   // districts live under one version (their links and hexagon field)
  const st = S.get();
  const patch = { sel: { ver: sv, level, id }, hex: null, here: null, filter: '', panel: 'place' };
  if (level !== 'dt' && st.ver !== 'both' && st.ver !== sv && !st.compare) patch.ver = sv;
  if (st.level !== level) patch.level = level;
  S.set(patch);
  const u = list(sv, level)[id];
  const box = u.bbox || (u.pc != null ? list(sv, 'pc')[u.pc].bbox : null);
  if (fly && box) fit(box);
  if (isMobile()) $('#side').classList.remove('peek');
}

function clearSelection() {
  S.set({ sel: null, hex: null, here: null, panel: 'place', filter: '' });
  fit(BBOX, { maxZoom: 8 });
}

// ---- hexagon card ----------------------------------------------------------------------------------
const hexInfoCache = new Map();
async function hexInfo(h3id) {
  if (hexInfoCache.has(h3id)) return hexInfoCache.get(h3id);
  const c = await findCell(h3id);
  if (!c) return null;
  const cs = { res: c.res, n: 1, parts: [{ c: c.chunk, idx: [c.i] }], area: h3.cellArea(h3id, 'km2') };
  const [lat, lng] = h3.cellToLatLng(h3id);
  const vars = {};
  await Promise.all(cfg.variables.map(async (s) => {
    vars[s.id] = await Promise.all(s.years.map(async (y) => { const v = await hexRaw(cs, s, y); return v ? v[0] : NaN; }));
  }));
  const info = { ...c, area: cs.area, lat, lng, vars };
  hexInfoCache.set(h3id, info);
  return info;
}

async function goToHex(h3id) {
  const c = await findCell(h3id);
  if (!c) { toast(`That hexagon is not in ${STATE.name} (H6–H8 cells only)`, { ttl: 4000 }); return; }
  S.set({ hex: h3id, here: null });
  const [lat, lng] = h3.cellToLatLng(h3id);
  view.map.flyTo({ center: [lng, lat], zoom: { 6: 10, 7: 11.5, 8: 13.5 }[c.res] });
}

// ---- swipe: the first version on the left, the last on the right ------------------------------------
async function setCompare(on) {
  const mapB = $('#mapB');
  if (on && !ctx.cview) {
    mapB.hidden = false;
    const c = view.map.getCenter();
    // registered only once its style exists, so boundary files arriving meanwhile don't hit it
    const cv = new MapView('mapB', { cfg, vs, versions: VERS, interactive: false, view: { center: [c.lng, c.lat], zoom: view.map.getZoom(), pitch: view.map.getPitch(), bearing: view.map.getBearing() } });
    await cv.ready;
    ctx.cview = cv;
    for (const [key, fc] of Object.entries(ctx.geo)) { const [v, l] = key.split('_'); ctx.cview.setBoundaryData(v, l, fc); }
    if (outlineFC) ctx.cview.setOutline(outlineFC);
    view.map.on('move', syncCompare);
    $('#swipe').hidden = false;
    for (const [side, v] of [['left', VERS[0]], ['right', VERS[VERS.length - 1]]]) {
      const tag = document.createElement('div');
      tag.className = `side-tag ${side}`;
      tag.innerHTML = `${lineKey(v)}${esc(VMETA[v].label)}`;
      $('#stage').appendChild(tag);
    }
    mirror();
    positionSwipe();
  } else if (!on && ctx.cview) {
    view.map.off('move', syncCompare);
    ctx.cview.map.remove();
    ctx.cview = null;
    mapB.hidden = true;
    $('#swipe').hidden = true;
    document.querySelectorAll('.side-tag').forEach((e) => e.remove());
  }
  applyLines();
  recolour();
}
function syncCompare() {
  if (!ctx.cview) return;
  const m = view.map;
  ctx.cview.map.jumpTo({ center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() });
}
function positionSwipe() {
  const pct = S.get().comparePos * 100;
  $('#mapB').style.clipPath = `inset(0 0 0 ${pct}%)`;
  $('#swipe').style.left = `${pct}%`;
  const l = $('.side-tag.left'); const r = $('.side-tag.right');
  if (l) l.style.left = `calc(${pct}% - ${l.offsetWidth + 12}px)`;
  if (r) r.style.left = `calc(${pct}% + 12px)`;
}
function mirror() {
  const cv = ctx.cview;
  if (!cv) return;
  const st = S.get();
  cv.setBasemap(cfg.basemaps.find((b) => b.id === st.basemap) || cfg.basemaps[0]);
  cv.setOverlays(effectiveOverlays(st, st.basemap));
  cv.setFillOpacity(st.opacity);
  cv.setLineScale(st.lineScale);
  cv.setSelection(st.sel ? rt.selFeat : null, st.mask, lensOf(st).none);
  cv.setHexSelection(st.hex);
  applyLines();
}

function effectiveOverlays(st, bmId) {
  const off = cfg.basemaps.find((b) => b.id === bmId)?.overlays_off || [];
  return st.overlays.filter((o) => !off.includes(o));
}

// ---- actions used by UI modules ------------------------------------------------------------------
ctx.act = {
  select, clearSelection, goToHex, hexInfo, toast, preview,
  resize() { views().forEach((v) => v.map.resize()); },
  prefetchYear(y) { const st = S.get(); if (ctx.cs) hexValues(ctx.cs, lensOf(st, { year: y })).catch(() => {}); },
  async tool(id) {
    const st = S.get();
    const m = view.map;
    if (id === 'zin') m.zoomIn();
    else if (id === 'zout') m.zoomOut();
    else if (id === 'home') clearSelection();
    else if (id === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
    else if (id === '3d') S.set({ threeD: !st.threeD });
    else if (id === 'compare') S.set({ compare: !st.compare });
    else if (id === 'png') {
      toast('Preparing image…', { spin: true });
      const lens = lensOf(st);
      const place = st.sel ? `${fullName(unit(st.sel))} (${VMETA[st.sel.ver].label})` : STATE.name;
      const what = st.compare ? `${VMETA[VERS[0]].label} | ${VMETA[VERS[VERS.length - 1]].label}` : st.ver === 'both' ? VERS.map((v) => VMETA[v].label).join(' and ') : VMETA[st.ver].label;
      await (await EX()).png(ctx, { title: lens.none ? place : `${place}: ${lens.title}`, subtitle: `${st.level === 'dt' ? 'Districts (Census 2001)' : `${cfg.boundaries.levels[st.level].label} seats`}, ${what}${ctx.cs ? ` · H${ctx.cs.res} hexagons` : ''} · ${new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}` });
      toast('');
    } else if (id === 'locate') locate();
    else if (id === 'measure') ctx.measure?.toggle();
    else if (id === 'clean') ctx.act.clean?.();
    else if (id === 'north') m.easeTo({ bearing: 0, pitch: st.threeD ? (cfg.hex.pitch_3d ?? 52) : 0, duration: 600 });
  },
  run(action) {
    const st = S.get();
    if (action === 'zoom' && st.sel) { const u = unit(st.sel); if (u.bbox) fit(u.bbox); }
    else if (action === 'copy') navigator.clipboard?.writeText(location.href).then(() => toast('Link copied', { ttl: 1800 }));
    else if (action === 'copyhex') navigator.clipboard?.writeText(st.hex).then(() => toast('H3 id copied', { ttl: 1800 }));
    else if (action === 'closehex') S.set({ hex: null, here: null });
    else if (action === 'more') S.set({ limit: 100000 });
    else if (action === 'about') S.set({ panel: 'about' });
    else if (action === 'back') S.set({ panel: 'place' });
    else if (action === 'states') ctx.act.openStates?.();
  },
  /** Colour the map by an election (Feature 7): its seats' level and map; the same key again clears it unless `keep`. */
  colourMap(key, keep = false) {
    const st = S.get();
    if (!key || (!keep && st.colour === key)) { S.set({ colour: null }); return; }
    ensureIndex().then((I) => {
      const e = (I?.elections || []).find((x) => x.key === key);
      if (!e) return;
      const now = S.get();
      const patch = { colour: key };
      const lvl = colourLevel(e, now);   // Assembly seats stay for a Lok Sabha year: its segments' leads
      if (now.level !== lvl) patch.level = lvl;
      if (e.national) {   // the landing: Lok Sabha seats, each state on the map its election was held on
        if (!now.colour) natBase = now.ver;
        const keepBoth = natBase === 'both' || (natBase == null && now.ver === 'both');
        natVer = e.ver === 'both' || keepBoth ? 'both' : e.ver;
        if (now.ver !== natVer) patch.ver = natVer;
        S.set(patch);
        return;
      }
      if (now.ver !== 'both' && now.ver !== e.ver) patch.ver = e.ver;
      S.set(patch);
    });
  },
  /**
   * Open another state with the same level, map choice (by role: older / both / newer), basemap and labels.
   * extra: {m, cl} to set its map and colour it by one of its elections (from the landing's colouring).
   */
  openState(code, sel = null, extra = {}) {
    const st = S.get();
    const target = cfg.states.find((x) => x.code === code);
    if (!target) return;
    const tv = target.versions.map((v) => v.id);
    const bits = [];
    if (st.level !== 'pc' && (st.level !== 'dt' || !target.national)) bits.push(`l=${st.level}`);
    const older = VERS.length > 1 && st.ver === VERS[0];
    let m = st.ver === 'both' ? 'both' : older ? tv[0] : tv[tv.length - 1];
    let cl = extra.cl;
    const e = STATE.national && st.colour ? colouredElection() : null;
    if (e?.national) {   // the landing's colouring: the state's own election of that year, on its map
      if (cl === undefined) cl = e.keys?.[code]?.[0] || null;
      const role = e.roles?.[code];   // a state with no result that year keeps the map shown
      m = extra.m || (role ? (role === VERS[0] ? tv[0] : tv[tv.length - 1]) : m);
      if (cl) bits.push(`cl=${cl}`);
      if (cl && st.colourBy === 'party') bits.push('cb=party');
      if (cl && st.shade) bits.push('sh=1');
    }
    if (tv.length === 1) m = tv[0];   // a state with one map (Jharkhand) opens on it, whatever was chosen here
    if (m !== tv[tv.length - 1]) bits.push(`m=${m}`);
    if (st.compare && tv.length > 1) bits.push('cmp=1');
    if (st.basemap !== DEFAULTS.basemap) bits.push(`b=${st.basemap}`);
    if (st.overlays?.length) bits.push(`o=${st.overlays.join(',')}`);
    if (sel) bits.push(`s=${sel}`);
    ctx.act.switchState(code, bits.join('&') || (code === STATE.code ? '' : ''));
  },
  /** Open another state: a fresh page for it (its own data, scales and seats); `extra` adds hash keys. */
  switchState(code, extra = '') {
    if (code === STATE.code && !extra) return;
    const h = [code === cfg.defaults.state ? '' : `st=${code}`, extra].filter(Boolean).join('&');
    location.replace(`${location.pathname}${location.search}${h ? `#${h}` : '#'}`);
    location.reload();
  },
};

function pointInGeom(g, lng, lat) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []).some((poly) => inRing(poly[0]) && !poly.slice(1).some(inRing));
}
/** On the landing, the state under a point where the map shown has no seat of it (Delhi, say, has no older map here). */
let natStates = null;
function natGap(st, ll) {
  if (!STATE.national || st.level === 'dt' || !ctx.others) return null;
  natStates ??= ctx.others.features.map((f) => ({ f, s: cfg.states.find((x) => x.code === f.properties.st) })).filter((x) => x.s);
  const hit = natStates.find(({ f, s }) => {
    const [x0, y0, x1, y1] = s.bbox || [-180, -90, 180, 90];
    return ll.lng >= x0 && ll.lng <= x1 && ll.lat >= y0 && ll.lat <= y1 && pointInGeom(f.geometry, ll.lng, ll.lat);
  });
  return hit ? hit.s : null;
}
/** The seat id at a point on every version and level: {ver: {ac, pc}} (null where none). */
async function seatsAt(lng, lat) {
  const at = {};
  for (const v of VERS) {
    at[v] = {};
    for (const l of ['ac', 'pc']) {
      at[v][l] = null;
      const fc = await ensureGeo(v, l).catch(() => null);
      for (const f of fc?.features || []) {
        const b = list(v, l)[f.id]?.bbox;
        if (b && (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3])) continue;
        if (pointInGeom(f.geometry, lng, lat)) { at[v][l] = f.id; break; }
      }
    }
  }
  return at;
}

/** The other state whose outline holds a point, if any (bbox first, then the outline polygon). */
async function stateAt(lng, lat) {
  if (ctx.others) {   // every state's outline, loaded at start (pipeline/national.py)
    for (const f of ctx.others.features) {
      if (f.properties.st === STATE.code) continue;
      if (pointInGeom(f.geometry, lng, lat)) return cfg.states.find((x) => x.code === f.properties.st) || null;
    }
    return null;
  }
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inGeom = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).some((poly) => inRing(poly[0]) && !poly.slice(1).some(inRing));
  for (const s of cfg.states) {
    if (s.code === STATE.code || s.national) continue;
    const [x0, y0, x1, y1] = s.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    const fc = await getJSON(`data/${s.code}/boundaries/outline.json`).catch(() => null);
    if (fc?.features?.some((f) => inGeom(f.geometry))) return s;
  }
  return null;
}

/**
 * Find me: dot + accuracy circle, your H8 hexagon with the H7 cell around it, and the hexagon card
 * with your seat on every map version. The seat selection is left alone; your position never goes
 * into the link.
 */
let locating = false;
function locate() {
  if (!navigator.geolocation) { toast('Location unavailable', { ttl: 3500 }); return; }
  if (!window.isSecureContext) { toast('Location needs https', { ttl: 3500 }); return; }
  if (locating) return;
  locating = true;
  toast('Locating…', { spin: true });
  const done = () => { locating = false; };
  const onPos = async (p) => {
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    if (STATE.national) {   // the India view: open the state you are in
      done();
      const s = await stateAt(lng, lat).catch(() => null);
      if (s) { toast(`${s.name}…`, { spin: true }); ctx.act.switchState(s.code, 'loc=1'); }
      else toast('Outside the states on this map', { ttl: 4000 });
      return;
    }
    const at = await seatsAt(lng, lat);   // by the seats' outlines (no hexagon index on this site)
    done();
    if (!VERS.some((v) => at[v].ac != null || at[v].pc != null)) {
      const other = LOCATE_ON_BOOT ? null : await stateAt(lng, lat).catch(() => null);   // never switch twice
      if (other) { toast(`${other.name}…`, { spin: true }); ctx.act.switchState(other.code, 'loc=1'); return; }
      toast('Outside the states on this map', { ttl: 4000 });
      return;
    }
    const bits = [...VERS].reverse().map((v) => {
      const a = at[v].ac; const pp = at[v].pc;
      if (a != null) return `${list(v, 'ac')[a].name} (${VMETA[v].label})`;
      return pp != null ? `${list(v, 'pc')[pp].name} Lok Sabha seat (${VMETA[v].label})` : null;
    }).filter(Boolean);
    // select your seat on the map shown (its card has the results), then mark where you are
    const st = S.get();
    const sv = ctx.activeVer(st) || VERS[VERS.length - 1];
    const lvl = st.level === 'pc' ? 'pc' : 'ac';
    const id = at[sv]?.[lvl] ?? at[sv]?.pc;
    if (id != null) select(sv, at[sv]?.[lvl] != null ? lvl : 'pc', id, { fly: false });
    S.set({ here: { lat, lng, acc: accuracy } });
    toast(`You are in ${bits.join(' · ') || STATE.name}${accuracy > 1500 ? ` (accurate to about ${Math.round(accuracy / 1000)} km)` : ''}`, { ttl: 5000 });
    view.map.flyTo({ center: [lng, lat], zoom: Math.max(view.map.getZoom(), accuracy > 3000 ? 11 : 13), duration: 1400, padding: padding() });
    if (isMobile()) $('#side').classList.remove('peek');
  };
  const onErr = (e, retried) => {
    if (e.code === 3 && !retried) {
      navigator.geolocation.getCurrentPosition(onPos, (e2) => onErr(e2, true), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
      return;
    }
    done();
    const msg = { 1: 'Location blocked in the browser settings', 2: 'Position unavailable', 3: 'Location timed out' }[e.code] || 'Location failed';
    toast(msg, { ttl: 5000 });
  };
  navigator.geolocation.getCurrentPosition(onPos, (e) => onErr(e, false), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

// ---- hover tooltip: every version at the cursor, the shown one first -------------------------------
function versionOrder(st) {
  const first = st.compare ? VERS[0] : ctx.activeVer(st);
  return [first, ...VERS.filter((v) => v !== first)];
}
function seatText(v, at) {
  const ac = at.ac != null ? list(v, 'ac')[at.ac] : null;
  const pc = at.pc != null ? list(v, 'pc')[at.pc] : null;
  if (!ac && !pc) return `<span class="t2">outside this map</span>`;
  const r = (u) => (resTag(u) ? ` <small>(${resTag(u)})</small>` : '');
  if (STATE.national) { const u = ac || pc; return u ? `<span class="tv-pc"><b>${esc(u.name)}</b>${r(u)}</span><span class="tv-ac">${esc(u.sn)}</span>` : ''; }
  const acTxt = ac ? `AC ${ac.no} ${esc(fullName(ac))}${r(ac)}` : (pc && pc.acs_hidden ? '<span class="t2">AC not drawn here</span>' : '<span class="t2">no AC</span>');
  const pcTxt = pc ? `PC ${pc.no} ${esc(fullName(pc))}${r(pc)}` : '';
  return `<span class="tv-ac">${acTxt}</span><span class="tv-pc">${pcTxt}</span>`;
}
function tipHTML(p, st) {
  const did = hasDistricts() ? p.at[dtVer()]?.dt : null;
  let html = did != null && list(dtVer(), 'dt')[did] ? `<div class="trow"><span class="vtag">District</span><div><b>${esc(list(dtVer(), 'dt')[did].name)}</b> <small>Census 2001</small></div></div>` : '';
  if (STATE.national) {
    const cv = pickVer(st, p);
    if (st.level === 'dt') { const d = p.at[cv]?.dt != null ? list(cv, 'dt')[p.at[cv].dt] : null; return d ? `<span class="tv-pc"><b>${esc(d.name)}</b></span><span class="tv-ac">${esc(d.sn)}</span>` : ''; }
    return seatText(cv, st.level === 'ac' ? p.at[cv] : { pc: p.at[cv]?.pc }) + (st.colour ? resultsTipHTML(p.at) : '');
  }
  html += versionOrder(st).map((v) => `<div class="trow"><span class="vtag">${lineKey(v)}${esc(v)}</span><div>${seatText(v, p.at[v])}</div></div>`).join('');
  if (st.colour) html += resultsTipHTML(p.at);
  const lens = lensOf(st);
  if (!lens.none) {
    if (p.hex != null && ctx.cs && tipVals.vals) {
      const v = tipVals.vals[p.hex];
      if (Number.isFinite(v)) html += `<div class="t3">H${ctx.cs.res} · <b>${fmtValue(v, lens)}</b> ${esc(lens.unitLabel)}</div>`;
    } else {
      const cv = labelVer(st);
      const id = p.at[cv][st.level];
      if (id != null) {
        const vals = unitValues(cv, st.level, lens);
        html += `<div class="t3">${esc(levelOne(st.level))} ${list(cv, st.level)[id].no} · <b>${fmtValue(vals[id], lens)}</b> ${esc(lens.unitLabel)}</div>`;
      }
    }
  }
  return html;
}
const tipVals = { key: '', vals: null };
function refreshTipVals() {
  const st = S.get();
  const lens = lensOf(st);
  const key = JSON.stringify([ctx.cs?.res, ctx.cs?.n, lens.id, lens.year, lens.mode, lens.from, lens.density]);
  if (key === tipVals.key) return;
  tipVals.key = key; tipVals.vals = null;
  if (ctx.cs && !lens.none) hexValues(ctx.cs, lens).then((v) => { if (tipVals.key === key) tipVals.vals = v; });
}

// ---- map interaction ------------------------------------------------------------------------------
let hover = null;
let hoverOther = null;
let natBase = null;   // the landing's map choice before its colouring began (restored when it is cleared)
let natVer = null;    // the map the landing's colouring last chose
function wireMap() {
  const tip = $('#tip');
  const m = view.map;
  m.on('mousemove', (e) => {
    if (ctx.measure?.active) { tip.hidden = true; return; } // the ruler has the pointer
    const st = S.get();
    const p = view.pick(e.point);
    const cv = pickVer(st, p);
    const id = p.at[cv]?.[st.level] ?? null;
    const key = id == null ? null : `${cv}|${st.level}|${id}`;
    if (hover !== key) {
      if (hover) { const [hv, hl, hid] = hover.split('|'); view.setUnitHover(hv, hl, +hid, false); }
      hover = key;
      if (key) view.setUnitHover(cv, st.level, id, true);
    }
    const gap = id == null ? natGap(st, e.lngLat) : null;   // the landing: a state with no seat on the map shown
    if (gap) {
      m.getCanvas().style.cursor = 'pointer';
      tip.innerHTML = `<span class="tv-pc"><b>${esc(gap.name)}</b></span>`;
      tip.hidden = false;
      const r = m.getContainer().getBoundingClientRect();
      tip.style.left = `${Math.min(e.point.x + 14, r.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.min(e.point.y + 14, r.height - tip.offsetHeight - 8)}px`;
      return;
    }
    const any = VERS.some((v) => p.at[v].ac != null || p.at[v].pc != null || p.at[v].dt != null);
    const other = !any && p.other && p.other !== STATE.code ? p.otherId : null;
    if (hoverOther !== other) { view.setOtherHover(hoverOther, false); hoverOther = other; view.setOtherHover(other, true); }
    m.getCanvas().style.cursor = p.hex != null || any || other != null ? 'pointer' : '';
    if (other != null) {
      const s = cfg.states.find((x) => x.code === p.other);
      tip.innerHTML = `<span class="tv-pc"><b>${esc(s?.name || '')}</b></span>`;
      tip.hidden = false;
      const r = m.getContainer().getBoundingClientRect();
      tip.style.left = `${Math.min(e.point.x + 14, r.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.min(e.point.y + 14, r.height - tip.offsetHeight - 8)}px`;
      return;
    }
    if (!any && p.hex == null) { tip.hidden = true; return; }
    refreshTipVals();
    tip.innerHTML = tipHTML(p, st);
    tip.hidden = false;
    const r = m.getContainer().getBoundingClientRect();
    tip.style.left = `${Math.min(e.point.x + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.min(e.point.y + 14, r.height - tip.offsetHeight - 8)}px`;
  });
  m.getCanvas().addEventListener('mouseleave', () => {
    tip.hidden = true;
    view.setOtherHover(hoverOther, false); hoverOther = null;
    if (hover) { const [hv, hl, hid] = hover.split('|'); view.setUnitHover(hv, hl, +hid, false); hover = null; }
  });

  m.on('click', (e) => {
    if (ctx.measure?.active) return; // clicks add ruler points
    const st = S.get();
    const p = view.pick(e.point);
    const inSel = p.hex != null && ctx.cs && (!st.sel || ctx.cs.f[selField(st.sel)]?.[p.hex] === st.sel.id);
    if (p.hex != null && inSel) { S.set({ hex: ctx.cs.h[p.hex], here: null }); if (isMobile()) $('#side').classList.remove('peek'); return; }
    const cv = pickVer(st, p);
    let level = st.level;
    let id = p.at[cv][level];
    if (id == null && level === 'ac' && p.at[cv].pc != null) { level = 'pc'; id = p.at[cv].pc; } // no AC drawn here: take the PC
    const anyHere = VERS.some((v) => p.at[v].ac != null || p.at[v].pc != null || p.at[v].dt != null);
    if (id == null && !anyHere && p.other && p.other !== STATE.code) { ctx.act.openState(p.other); return; }   // another state
    if (id == null) { const g = natGap(st, e.lngLat); if (g) ctx.act.openState(g.code); return; }   // the landing: no seat shown there
    if (st.sel && st.sel.ver === cv && st.sel.level === level && st.sel.id === id) { if (st.hex) S.set({ hex: null }); return; }
    select(cv, level, id, { fly: false });
  });

  m.on('moveend', () => {
    const st = S.get();
    if (st.res !== 'off' && (st.scope === 'view' || !st.sel)) updateCellsSoon(250);
    if (!st.sel) S.set({ view: [+m.getZoom().toFixed(2), +m.getCenter().lat.toFixed(4), +m.getCenter().lng.toFixed(4)] });
  });

  const grip = $('#swipe .swipe-grip');
  let dragging = false;
  const move = (x) => {
    const r = $('#stage').getBoundingClientRect();
    S.set({ comparePos: Math.min(0.95, Math.max(0.05, (x - r.left) / r.width)) });
  };
  grip.addEventListener('pointerdown', (e) => { dragging = true; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
  grip.addEventListener('pointerup', () => { dragging = false; });
}

// ---- sidebar: collapsible on desktop (the phone layout keeps its bottom sheet) --------------------
function setSide(off) {
  document.getElementById('app').classList.toggle('side-off', !!off);
  try { localStorage.setItem('borders.side', off ? 'off' : 'on'); } catch { /* ignore */ }
  // the map's container changes width: let MapLibre re-measure once the transition has run
  setTimeout(() => views().forEach((v) => v.map.resize()), 320);
}

// ---- menu ------------------------------------------------------------------------------------------
function wireMenu() {
  const menu = $('#menu');
  const items = [['about', 'About'], ...(cfg.site.github ? [['github', 'Source on GitHub']] : []),
    ['theme', 'Light / dark'], ['copy', 'Copy link'], ['reset', 'Reset']];
  menu.innerHTML = items.map(([id, l]) => (id === 'github' ? `<a href="${esc(cfg.site.github)}" target="_blank" rel="noopener">${l}</a>` : `<button data-m="${id}">${l}</button>`)).join('');
  $('#menuBtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const id = b.dataset.m;
    if (id === 'about') S.set({ panel: 'about' });
    if (id === 'theme') S.set({ theme: S.get().theme === 'dark' ? 'light' : 'dark' });
    if (id === 'copy') ctx.act.run('copy');
    if (id === 'reset') { location.hash = ''; location.reload(); }
  });
  $('#home').onclick = (e) => { e.preventDefault(); clearSelection(); };
  $('#sideToggle').onclick = () => S.set({ side: !S.get().side });
  $('#sideOpen').onclick = () => S.set({ side: false });
  wireSheet();
  wireSideResize();
}

/** Desktop: drag the side panel's right edge to set its width (decision W1); remembered; double-click resets. */
function wireSideResize() {
  const side = $('#side');
  const h = document.createElement('div');
  h.className = 'side-resize';
  h.title = 'Drag to resize the panel (double-click to reset)';
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'vertical');
  side.appendChild(h);
  let start = null; let raf = 0;
  const setW = (w) => document.documentElement.style.setProperty('--side-w', `${Math.round(Math.min(720, Math.max(300, w)))}px`);
  const resize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => views().forEach((v) => v.map.resize())); };
  h.addEventListener('pointerdown', (e) => {
    if (isMobile()) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    start = { x: e.clientX, w: side.getBoundingClientRect().width };
    document.body.classList.add('resizing');
  });
  h.addEventListener('pointermove', (e) => { if (start) { setW(start.w + e.clientX - start.x); resize(); } });
  const end = () => {
    if (!start) return;
    start = null;
    document.body.classList.remove('resizing');
    try { localStorage.setItem('borders.sideW', String(Math.round(side.getBoundingClientRect().width))); } catch { /* private mode */ }
    resize();
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { setW(cfg.ui.sidebar_width || 392); try { localStorage.removeItem('borders.sideW'); } catch { /* */ } resize(); });
}

/**
 * Phone bottom sheet: three heights (peek, half, full). Swipe up or down on the handle or the header to move a
 * step; a tap there opens it further (from full, back to peek). Buttons, links and the search box keep their own taps.
 */
function wireSheet() {
  const side = $('#side');
  const now = () => (side.classList.contains('peek') ? 0 : side.classList.contains('full') ? 2 : 1);
  const set = (i) => { side.classList.toggle('peek', i === 0); side.classList.toggle('full', i === 2); };
  let drag = null;
  const end = (y) => {
    if (!drag) return;
    const dy = y - drag.y;
    if (Math.abs(dy) < 12) set(drag.i === 2 ? 0 : drag.i + 1);
    else set(Math.max(0, Math.min(2, drag.i + (dy < 0 ? 1 : -1) * (Math.abs(dy) > 220 ? 2 : 1))));
    drag = null;
  };
  for (const el of [$('#sheetHandle'), side.querySelector('.mast'), $('#crumbs')]) {
    el.addEventListener('pointerdown', (e) => {
      if (!isMobile() || e.target.closest('button, a, input, .menu')) return;
      e.preventDefault();                       // no text selection or native drag, which would cancel the swipe
      el.setPointerCapture?.(e.pointerId);      // the release comes back here, never as a click on the map
      drag = { y: e.clientY, last: e.clientY, i: now() };
    });
    el.addEventListener('pointermove', (e) => { if (drag) drag.last = e.clientY; });
    el.addEventListener('pointerup', (e) => end(e.clientY));
    el.addEventListener('pointercancel', () => end(drag ? drag.last : 0));
  }
  $('#sheetHandle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(now() === 2 ? 0 : now() + 1); } });
}

// ---- subscriptions -----------------------------------------------------------------------------------
function subscribe() {
  S.on(['theme'], (st) => {
    document.documentElement.dataset.theme = st.theme;
    document.querySelector('meta[name=theme-color]').content = st.theme === 'dark' ? '#131417' : '#f5f3ee';
    try { localStorage.setItem('borders.theme', st.theme); } catch { /* ignore */ }
  });
  S.on(['basemap'], (st, prev) => {
    const bm = cfg.basemaps.find((b) => b.id === st.basemap) || cfg.basemaps[0];
    view.setBasemap(bm);
    if (bm.overlays_off?.length) S.set({ overlays: st.overlays.filter((o) => !bm.overlays_off.includes(o)) });
    else if (!st.overlays.length && cfg.basemaps.find((b) => b.id === prev.basemap)?.overlays_off?.length) S.set({ overlays: D.overlays || [] });
    view.setOverlays(effectiveOverlays(S.get(), st.basemap));
    mirror();
    recolour();
  });
  S.on(['overlays'], (st) => { view.setOverlays(effectiveOverlays(st, st.basemap)); mirror(); });
  S.on(['ver', 'level', 'labels', 'outline'], async (st, prev, changed) => {
    if (changed.has('level') || changed.has('ver')) { toast('Loading…', { spin: true }); }
    await applyLines().catch((e) => console.error(e));
    toast('');
    if (changed.has('level') || changed.has('ver')) recolour();
  });
  S.on(['sel'], () => { showSelection(); mirror(); });
  S.on(['level', 'ver'], () => showSegments());
  S.on(['basemap', 'theme'], (st) => { if (st.colour) setTimeout(recolour, 60); });   // fill strength follows the basemap's darkness
  S.on(['colour', 'colourBy', 'shade'], (st, prev, changed) => {
    if (changed.has('colour') && !st.colour) {
      stopResultsPlay(renderTimeline);
      if (natBase != null) { const v = natBase; natBase = null; if (st.ver !== v) S.set({ ver: v }); }   // the landing's map before
    }
    recolour();
    renderPanel();
  });
  S.on(['level', 'ver'], (st, prev, changed) => {
    if (changed.has('ver') && st.ver !== natVer) natBase = null;   // the visitor chose a map: keep it
    const e = st.colour ? colouredElection() : null;
    if (e && (st.level !== colourLevel(e, st) || (st.ver !== 'both' && st.ver !== e.ver))) S.set({ colour: null });
  });
  S.on(['mask', 'var'], (st) => views().forEach((v) => v.setSelection(st.sel ? rt.selFeat : null, st.mask, lensOf(st).none)));
  S.on(['hex'], (st) => views().forEach((v) => v.setHexSelection(st.hex)));
  S.on(['here'], (st) => views().forEach((v) => v.setHere(st.here)));
  S.on(['res', 'scope', 'sel'], () => updateCellsSoon(st0Ready ? 50 : 0));
  S.on(['var', 'year', 'mode', 'from', 'density', 'cbSafe', 'hexLines', 'threeD', 'opacity', 'ramp', 'rev', 'breaks', 'height', 'heightBy'], (st) => {
    const lens = lensOf(st);
    if (ctx.cs && !lens.none && !resAvailable(lens, ctx.cs.res)) updateCellsSoon(0);
    else recolour();
  });
  S.on(['opacity'], (st) => views().forEach((v) => v.setFillOpacity(st.opacity)));
  S.on(['lineScale'], (st) => views().forEach((v) => v.setLineScale(st.lineScale)));
  S.on(['threeD'], (st) => {
    view.map.easeTo({ pitch: st.threeD ? (cfg.hex.pitch_3d ?? 52) : 0, duration: 900 });
    if (st.threeD && lensOf(st).none) S.set({ var: cfg.variables[0].id }); // 3D needs something to measure
  });
  S.on(['side'], (st) => setSide(st.side));
  S.on(['compare'], (st, prev) => { if (!!st.compare !== !!prev.compare) setCompare(!!st.compare); });
  S.on(['comparePos'], positionSwipe);
  S.on(['sel', 'hex', 'here', 'panel', 'filter', 'limit', 'level', 'ver', 'listVer', 'theme', 'var'], () => renderPanel());
  // your own position (Find me) is never written into shareable links
  S.on(null, (st) => writeHash({ ...st, sel: st.sel ? { ver: st.sel.ver, level: st.sel.level, no: unit(st.sel).no } : null, view: st.sel || st.here ? null : st.view, hex: st.here ? null : st.hex }, DEFAULTS));
}

// ---- start --------------------------------------------------------------------------------------------
await view.ready;
document.documentElement.dataset.theme = S.get().theme;
if (sideOff) document.getElementById('app').classList.add('side-off');
const st0 = S.get();
view.setBasemap(cfg.basemaps.find((b) => b.id === st0.basemap) || cfg.basemaps[0]);
view.setOverlays(effectiveOverlays(st0, st0.basemap));
view.setFillOpacity(st0.opacity);
// status bar (scale, camera height, pointer coordinates) and the ruler, on the main map
if (cfg.features.coordinates !== false) initStatusBar(view.map, { el: $('#statusbar'), toast });
else $('#statusbar').hidden = true;
if (cfg.features.measure) {
  ctx.measure = initMeasure(view.map, {
    card: $('#measureCard'),
    onChange: (on) => { rt.measuring = on; $('#tip').hidden = true; document.querySelectorAll('[data-tool="measure"]').forEach((b) => b.classList.toggle('on', on)); },
  });
}
initPanel(ctx);
initControls(ctx);
initSearch(ctx);
initStates(ctx);
initFolds(ctx);
initColour(ctx);
toast('Loading…', { spin: true });
applyLines().catch((e) => console.error(e)).then(() => { if ($('#toast').textContent.startsWith('Loading')) toast(''); recolour(); });
await outlineReady;
wireMap();
wireMenu();
subscribe();
if (st0.sel) { showSelection(); const u = unit(st0.sel); if (!hash.view && u.bbox) fit(u.bbox, { duration: 0 }); }
if (st0.compare) await setCompare(true);
if (st0.threeD) view.map.setPitch(cfg.hex.pitch_3d ?? 52);
st0Ready = true;
if (isMobile() && !st0.sel) $('#side').classList.add('peek');
renderPanel();
await updateCells();
if (hash.hex && h3.isValidCell(hash.hex)) S.set({ hex: hash.hex });
renderLens();
renderTimeline();
// warm the other level once the first view is drawn
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
setTimeout(() => idle(() => VERS.forEach((v, i) => setTimeout(() => ensureGeo(v, st0.level === 'ac' ? 'pc' : 'ac'), i * 800))), 4000);
if (LOCATE_ON_BOOT) locate();   // Find me opened this state: finish the job here
