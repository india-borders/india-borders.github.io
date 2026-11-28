// Sidebar: breadcrumb, the state's maps (landing; India on the pan-India view), a selected seat (its election
// results, where its people went on the other map, its segments), a district, and About. No source, method or
// caveat text (decision T1, 22 Nov 2026), no population or night-lights values (decision V2).
// Pure rendering from state + data; actions go through ctx.act (structure from India Hex).
import { esc } from '../scales.js';
import { units, unit, list, fullName, resTag, hasDistricts, hasAssembly } from '../data/units.js';
import { lineKey } from './controls.js';
import { fmtCoords } from './geo.js';
import { initResults, resultsCard, choose, setTopN, bridgeOf, partyColour, fallbackColour, partyName, ensureIndex, idx } from './results.js';

let tok = 0;
let CTX = null;
const ICON = {
  zoom: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  gmap: '<svg viewBox="0 0 24 24"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
  earth: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export function initPanel(ctx) {
  CTX = ctx;
  initResults(ctx);
  const click = (e) => {
    const t = e.target.closest('[data-sel],[data-act],[data-lv],[data-lvl],[data-rk],[data-topn],[data-colour]');
    if (!t) return;
    if (t.dataset.topn) { setTopN(+t.dataset.topn); renderPanel(); return; }
    if (t.dataset.colour) { ctx.act.colourMap(t.dataset.colour); return; }
    if (t.dataset.rk) {   // while the map is coloured, the card's year moves the colouring with it (Feature 7)
      choose(ctx.S.get().sel, t.dataset.rk);
      if (ctx.S.get().colour) ctx.act.colourMap(t.dataset.rk, true);
      renderPanel();
      return;
    }
    if (t.dataset.sel) {
      if (t.dataset.sel === 'home') ctx.act.clearSelection();
      else { const [v, l, id] = t.dataset.sel.split(':'); ctx.act.select(v, l, +id); }
    } else if (t.dataset.lv) ctx.S.set({ listVer: t.dataset.lv, filter: '', limit: 60 });
    else if (t.dataset.lvl) ctx.S.set({ level: t.dataset.lvl, filter: '', limit: 60 });
    else if (t.dataset.act.startsWith('state:')) ctx.act.openState(t.dataset.act.slice(6));
    else ctx.act.run(t.dataset.act);
  };
  for (const id of ['panel', 'crumbs']) document.getElementById(id).addEventListener('click', click);
  // hovering a row of another map's seat outlines it on the map (decision O2)
  const panelEl = document.getElementById('panel');
  panelEl.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.lrows [data-sel]');
    if (!b) return;
    const [v, l, id] = b.dataset.sel.split(':');
    ctx.act.preview?.(v, l, +id);
  });
  panelEl.addEventListener('mouseout', (e) => {
    const b = e.target.closest('.lrows [data-sel]');
    if (b && !b.contains(e.relatedTarget)) ctx.act.preview?.(null);
  });
  document.getElementById('panel').addEventListener('input', (e) => {
    if (e.target.id === 'listFilter') ctx.S.set({ filter: e.target.value, limit: 60 });
  });
  document.getElementById('panel').addEventListener('change', (e) => {
    if (e.target.id === 'statePick') ctx.act.switchState(e.target.value);
  });
}

// ------------------------------------------------------------------------------------------------
const VL = (v) => CTX.VMETA[v].label;
const LEVEL = (l) => CTX.cfg.boundaries.levels[l];
const tag = (u) => (resTag(u) ? `<span class="rtag">${resTag(u)}</span>` : '');
const approx = () => '';   // no caveat badges on the site (decision T1)

function statePicker() {
  const { cfg, STATE } = CTX;
  if (cfg.states.length < 2) return '';
  const opts = cfg.states.map((s) => `<option value="${s.code}"${s.code === STATE.code ? ' selected' : ''}>${esc(s.name)}${s.status === 'draft' ? ' (draft)' : ''}</option>`).join('');
  return `<label class="statepick"><span>State</span><select id="statePick" aria-label="Choose a state">${opts}</select></label>`;
}
const seatBtn = (v, l, u) => `<button data-sel="${v}:${l}:${u.id}">${esc(fullName(u))}</button>`;

function crumbs(st) {
  const parts = [[CTX.STATE.name, 'home']];
  if (st.sel && !CTX.STATE.national) {
    const u = unit(st.sel);
    parts.push([st.sel.level === 'dt' ? 'Districts, 2001' : VL(st.sel.ver), null]);
    if (st.sel.level === 'ac' && u.pc != null) parts.push([`PC ${list(st.sel.ver, 'pc')[u.pc].name}`, `${st.sel.ver}:pc:${u.pc}`]);
    parts.push([u.name, null]);
  } else if (st.panel === 'about') parts.push(['About', null]);
  const html = parts.map(([n, s], i) => (i === parts.length - 1 || !s
    ? `<span>${esc(n)}</span>${i < parts.length - 1 ? '<span class="sep">/</span>' : ''}` : `<button data-sel="${s}">${esc(n)}</button><span class="sep">/</span>`));
  if (CTX.cfg.states.length > 1) {   // the state is a button that opens the state list (visible in the phone's collapsed sheet)
    html[0] = `<button class="statechip" data-act="states" aria-haspopup="dialog" title="Change the state">${esc(CTX.STATE.name)}<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>${parts.length > 1 ? '<span class="sep">/</span>' : ''}`;
  }
  document.getElementById('crumbs').innerHTML = html.join('');
}

function googleLinks(lng, lat, z) {
  if (!CTX.cfg.features.google_links) return '';
  const gm = `https://www.google.com/maps/@${lat},${lng},${Math.round(z)}z/data=!3m1!1e3`;
  const ge = `https://earth.google.com/web/@${lat},${lng},300a,${Math.round(40000000 / 2 ** z)}d,35y,0h,0t,0r`;
  return `<a class="icon" href="${gm}" target="_blank" rel="noopener" title="Open in Google Maps (satellite)">${ICON.gmap}</a>
    <a class="icon" href="${ge}" target="_blank" rel="noopener" title="Open in Google Earth">${ICON.earth}</a>`;
}

function resCounts(v, l) {
  const c = { SC: 0, ST: 0 };
  for (const u of list(v, l)) if (c[u.res] != null) c[u.res]++;
  return `${c.SC} SC · ${c.ST} ST`;
}

// ---- landing ------------------------------------------------------------------------------------
/** The landing's Lok Sabha years (Feature 7, phase 2): each colours the map by its winners; the same year again clears. */
function nationalResults(st) {
  if (!CTX.STATE.results) return '';
  const I = idx();
  if (!I) { ensureIndex().then((x) => { if (x) renderPanel(); }); return ''; }
  const ls = (I.elections || []).filter((e) => e.house === 'LS');
  if (!ls.length) return '';
  const old = CTX.VERS[0];
  return `<h2 class="h2">Lok Sabha results</h2>
    <div class="ryears nat">${ls.map((e) => {
    const on = e.key === st.colour;
    // held on the older map (dashed): before 2008 every state but the one-map ones (Sikkim's one seat) was on it
    const older = e.ver === old || (e.ver === 'both' && e.year < 2008);
    return `<button data-colour="${e.key}" class="${on ? 'on' : ''}${older ? ' old' : ''}" aria-pressed="${on}" title="${on ? 'Clear map colours' : `Colour the map: ${e.n_pc} seats`}">${esc(String(e.year))}</button>`;
  }).join('')}</div>`;
}

function landing(st) {
  const { VERS, VMETA, STATE, cfg } = CTX;
  if (STATE.national) {   // the pan-India view (decision N1)
    const states = cfg.states.filter((s) => !s.national);
    const n = list(VERS[VERS.length - 1], 'pc').length;   // the current map's seats (some states have no older map here)
    return `<h1 class="title" style="margin-top:6px">India</h1>
      <p class="lede">${states.length} states · ${n} Lok Sabha seats. Click a seat or a state to open it.</p>
      ${nationalResults(st)}
      <h2 class="h2">States</h2>
      <div class="rows">${states.map((s) => `<button class="row" data-act="state:${s.code}"><span class="rk"></span><span class="nm">${esc(s.name)}</span><span class="vl"><small>${s.versions.map((v) => esc(v.label)).join(' · ')}</small></span></button>`).join('')}</div>`;
  }
  const nAc = list(VERS[0], 'ac').length; const nPc = list(VERS[0], 'pc').length;
  const cards = VERS.map((v) => {
    const m = VMETA[v];
    return `<div class="vcard">
      <div class="vhead">${lineKey(v)}<span class="vname">${esc(m.label)}</span></div>
      <div class="vlong">${esc(m.long)}${m.used ? `, ${esc(m.used)}` : ''}.</div>
      <div class="vfacts">${hasAssembly() ? `${list(v, 'ac').length} AC (${resCounts(v, 'ac')}) · ` : ''}${list(v, 'pc').length} PC (${resCounts(v, 'pc')})</div>
    </div>`;
  }).join('');
  return `${statePicker()}<h1 class="title" style="margin-top:14px">${esc(STATE.name)}</h1>
    <p class="lede">${hasAssembly() ? `${nAc} Assembly · ` : ''}${nPc} Lok Sabha seat${nPc === 1 ? "" : "s"}${hasAssembly() ? '' : ' (no Assembly)'}. Click a seat for its results${VERS.length > 1 ? " and where its people went" : ""}.</p>
    <div class="vcards">${cards}</div>
    ${seatList(st)}`;
}

function seatList(st) {
  const { VERS } = CTX;
  const v = VERS.includes(st.listVer) ? st.listVer : CTX.PRIMARY;
  const l = st.level;
  let rows = list(v, l);
  if (st.filter) {
    const q = st.filter.toLowerCase().trim();
    rows = rows.filter((u) => u.name.toLowerCase().includes(q) || (u.alt || '').toLowerCase().includes(q) || String(u.no) === q);
  }
  const lim = st.limit || 60;
  const row = (u) => {
    const pc = l === 'ac' && u.pc != null ? list(v, 'pc')[u.pc] : null;
    return `<button class="row" data-sel="${v}:${l}:${u.id}"><span class="rk">${u.no}</span><span class="nm">${esc(fullName(u))}${resTag(u) ? ` <small>${resTag(u)}</small>` : ''}${u.hidden ? ' <small>not drawn</small>' : ''}</span><span class="vl">${pc ? `<small>${esc(pc.name)}</small>` : (u.district ? `<small>${esc(u.district)}</small>` : '')}</span></button>`;
  };
  return `<h2 class="h2">Seats</h2>
    <div class="tabs">${VERS.map((x) => `<button data-lv="${x}" class="${x === v ? 'on' : ''}">${lineKey(x)}${esc(VL(x))}</button>`).join('')}
      <span class="tabs-gap"></span>${[...(hasAssembly() ? ['ac'] : []), 'pc', ...(hasDistricts() ? ['dt'] : [])].map((x) => `<button data-lvl="${x}" class="${x === l ? 'on' : ''}">${esc(LEVEL(x).short)}<small>${list(v, x).length}</small></button>`).join('')}</div>
    <input class="filter" id="listFilter" placeholder="Filter by name or number" value="${esc(st.filter)}">
    <div class="rows">${rows.slice(0, lim).map(row).join('') || '<div class="note">No match.</div>'}</div>
    ${rows.length > lim ? `<button class="more" data-act="more">Show all ${rows.length}</button>` : ''}`;
}

// ---- a selected seat ----------------------------------------------------------------------------
function hero(st) {
  const u = unit(st.sel);
  const { ver: v, level: l } = st.sel;
  if (l === 'dt') {
    return `<div class="kicker">District, 2001 · <b>${u.no}</b>${u.area ? ` · ${Math.round(u.area).toLocaleString('en-IN')} km²` : ''}</div>
    <h1 class="title${u.name.length > 20 ? ' small' : ''}">${esc(u.name)}</h1>
    <div class="acts">${u.bbox ? `<button class="icon" data-act="zoom" title="Zoom to">${ICON.zoom}</button>` : ''}<button class="icon" data-act="copy" title="Copy link">${ICON.link}</button>${u.lp ? googleLinks(u.lp[0], u.lp[1], 9) : ''}</div>`;
  }
  const links = [];
  if (l === 'ac' && u.pc != null) links.push(`<span>PC</span>${seatBtn(v, 'pc', list(v, 'pc')[u.pc])}`);
  if (u.district) links.push(`<span>District</span><span class="plain">${esc(u.district)}</span>`);
  const z = l === 'pc' ? 9 : 11;
  return `<div class="kicker">${lineKey(v)} ${esc(VL(v))} · ${esc(LEVEL(l).one)} · No. <b>${u.no}</b>${u.area ? ` · ${Math.round(u.area).toLocaleString('en-IN')} km²` : ''}</div>
    <h1 class="title${u.name.length > 20 ? ' small' : ''}">${esc(u.name)}${tag(u)}</h1>
    ${u.alt ? `<div class="alt">now <b>${esc(u.alt)}</b></div>` : ''}
    <div class="meta">${links.join('')}${approx(v)}</div>
    <div class="acts">
      ${u.bbox ? `<button class="icon" data-act="zoom" title="Zoom to">${ICON.zoom}</button>` : ''}
      <button class="icon" data-act="copy" title="Copy link">${ICON.link}</button>
      ${u.lp ? googleLinks(u.lp[0], u.lp[1], z) : ''}
    </div>`;
}

/** A district's seats on every map version: the Assembly seats that hold its people (and the Lok Sabha seats, in one line). */
function districtSeats(st) {
  const u = unit(st.sel);
  const pct = (x) => `${x >= 99 || x < 10 ? x.toFixed(1) : Math.round(x)}%`;
  return [...CTX.VERS].reverse().map((v) => {
    const s = (u.s || {})[v];
    if (!s || !(s.ac || []).length) return '';
    const whole = s.ac.filter((r) => r[0] >= 0 && r[1] >= 0.01);
    const rows = s.ac.map(([id, share]) => {
      if (share < 0.002) return '';
      const o = id >= 0 ? list(v, 'ac')[id] : null;
      const name = o ? `<button class="nm-btn" data-sel="${v}:ac:${id}">${esc(fullName(o))}</button>${resTag(o) ? ` <small>${resTag(o)}</small>` : ''}` : '<span class="t2">outside every seat</span>';
      return `<div class="lrow"><span class="rk">${o ? o.no : '–'}</span><span class="nm">${name}</span><span class="vl">${pct(share * 100)}</span>
        <span class="br"><i style="width:${Math.max(1.5, share * 100)}%"></i></span></div>`;
    }).join('');
    const pcs = (s.pc || []).filter((r) => r[0] >= 0 && r[1] >= 0.01).map(([id, share]) => `<button class="nm-btn" data-sel="${v}:pc:${id}">${esc(list(v, 'pc')[id].name)}</button> ${pct(100 * share)}`);
    return `<h2 class="h2">Seats, ${esc(VL(v))}</h2>
      <p class="lede-s">${whole.length} Assembly seat${whole.length === 1 ? '' : 's'} (1%+ of its people).${pcs.length ? ` Lok Sabha: ${pcs.join(', ')}.` : ''}</p><div class="lrows">${rows}</div>`;
  }).join('');
}

/** Feature 5's bridge: the linked seat's last winner on the older map, or its first on the newer one ("2004 INC"). */
function bridge(ov, l, o, later) {
  const b = bridgeOf(ov, l, o.no);
  if (!b) return '';
  const [y, party] = later ? [b[0], b[1]] : [b[3], b[4]];
  const col = partyColour(party) || fallbackColour(party);
  const e = (idx()?.elections || []).find((x) => x.ver === ov && x.house === (l === 'ac' ? 'VS' : 'LS') && String(x.lbl || x.year) === String(y));
  return ` <small class="bridge" title="${esc(partyName(party, e?.key))}"><i style="background:${col}"></i>${esc(String(y))} ${esc(party)}</small>`;
}

/** Where the seat's people were (for the newer map) or went (for the older map), on each other version: shares only. */
function lineage(st) {
  const u = unit(st.sel);
  const { ver: v, level: l } = st.sel;
  if (u.hidden) return '<div class="note">Not drawn on this map.</div>';
  const order = CTX.VERS;
  const pct = (x) => `${x >= 99 || x < 10 ? x.toFixed(1) : Math.round(x)}%`;
  return Object.entries(u.x || {}).map(([ov, rows]) => {
    if (!rows.length) return '';
    const later = order.indexOf(ov) > order.indexOf(v);
    const head = later ? `Where its people went · ${esc(VL(ov))}` : `Where its people were · ${esc(VL(ov))}`;
    const n = rows.filter((r) => r[1] >= 0.01).length;
    const lede = n <= 1 ? `${pct(100 * rows[0][1])} in one seat.` : `${n} seats (1%+ each); the largest ${pct(100 * rows[0][1])}.`;
    const body = rows.map(([oid, share]) => {
      if (share < 0.002) return '';
      const o = oid >= 0 ? list(ov, l)[oid] : null;
      const name = o ? `<button class="nm-btn" data-sel="${ov}:${l}:${oid}">${esc(fullName(o))}</button>${resTag(o) ? ` <small>${resTag(o)}</small>` : ''}${bridge(ov, l, o, later)}` : '<span class="t2">outside every seat</span>';
      return `<div class="lrow"><span class="rk">${o ? o.no : '–'}</span><span class="nm">${name}</span><span class="vl">${pct(share * 100)}</span>
        <span class="br"><i style="width:${Math.max(1.5, share * 100)}%"></i></span></div>`;
    }).join('');
    return `<h2 class="h2">${head}</h2><p class="lede-s">${lede}</p><div class="lrows">${body}</div>`;
  }).join('');
}

function members(st) {
  const u = unit(st.sel);
  const { ver: v, level: l } = st.sel;
  if (l === 'pc') {
    if (!hasAssembly()) return '';   // a Union territory without an Assembly: the seat has no segments
    const acs = list(v, 'ac').filter((a) => a.pc === u.id);
    return `<h2 class="h2">Segments <small>${acs.length}</small></h2><div class="rows">${acs.map((a) => `<button class="row" data-sel="${v}:ac:${a.id}"><span class="rk">${a.no}</span><span class="nm">${esc(fullName(a))}${resTag(a) ? ` <small>${resTag(a)}</small>` : ''}${a.hidden ? ' <small>not drawn</small>' : ''}</span><span class="vl"></span></button>`).join('')}</div>`;
  }
  if (u.pc == null) return '';
  const sib = list(v, 'ac').filter((a) => a.pc === u.pc && a.id !== u.id);
  return `<h2 class="h2">Also in ${esc(list(v, 'pc')[u.pc].name)}</h2><div class="rows">${sib.map((a) => `<button class="row" data-sel="${v}:ac:${a.id}"><span class="rk">${a.no}</span><span class="nm">${esc(fullName(a))}${resTag(a) ? ` <small>${resTag(a)}</small>` : ''}</span><span class="vl"></span></button>`).join('')}</div>`;
}

// ---- hexagon / you are here ------------------------------------------------------------------------
async function hexBand(st) {
  const info = await CTX.act.hexInfo(st.hex);
  if (!info) return '';
  const rows = [...CTX.VERS].reverse().map((v) => {
    const a = info.f[`${v}.ac`]; const p = info.f[`${v}.pc`];
    const ac = a >= 0 ? list(v, 'ac')[a] : null; const pc = p >= 0 ? list(v, 'pc')[p] : null;
    const acTxt = ac ? `AC ${ac.no} ${seatBtn(v, 'ac', ac)}` : `<span class="t2">${pc?.acs_hidden ? 'AC not drawn here' : 'no AC'}</span>`;
    const pcTxt = pc ? `PC ${pc.no} ${seatBtn(v, 'pc', pc)}` : '';
    return `<div class="hrow"><span class="vtag">${lineKey(v)}${esc(VL(v))}</span><div>${acTxt}<br>${pcTxt}</div></div>`;
  }).join('') + (() => {   // the 2001 district of this hexagon
    const d = hasDistricts() ? info.f[`${units().dt_ver}.dt`] : -1;
    return d >= 0 ? `<div class="hrow"><span class="vtag">District</span><div><button data-sel="${units().dt_ver}:dt:${d}">${esc(list(units().dt_ver, 'dt')[d].name)}</button> <small class="t2">Census 2001</small></div></div>` : '';
  })();
  const blocks = '';   // no variables on this site (decision V2)
  const here = st.here ? `<div class="kicker"><b>You are here</b> · accurate to ${st.here.acc < 1000 ? `${Math.round(st.here.acc)} m` : `${(st.here.acc / 1000).toFixed(1)} km`}</div>` : '';
  return `<section class="band"><button class="icon close" data-act="closehex" title="Close">${ICON.x}</button>
    ${here}<div class="kicker">H${info.res} hexagon · ${info.area.toFixed(2)} km²</div>
    <h2 class="title mono">${info.h}</h2>
    <div class="coords">${st.here ? `${esc(fmtCoords(st.here.lng, st.here.lat))} <small>your position</small>` : `${esc(fmtCoords(info.lng, info.lat))} <small>hexagon centre</small>`}</div>
    <div class="hrows">${rows}</div>
    <div class="acts"><button class="icon" data-act="copyhex" title="Copy H3 id">${ICON.link}</button>${googleLinks(info.lng, info.lat, { 6: 11, 7: 13, 8: 15 }[info.res])}</div>
    ${blocks}</section>`;
}

// ---- about ----------------------------------------------------------------------------------------
function about() {
  const { cfg, VERS, VMETA } = CTX;
  return `<div class="kicker">About</div><h1 class="title small">${esc(cfg.site.title)}</h1>
    <p class="lede">${esc(cfg.site.tagline)}.</p>
    <ol class="steps">
      <li>Pick a map and a level at the top. Older lines are dashed.</li>
      <li>Hover to see the seat on every map; click for its results.</li>
      <li>Click another state on the map to open it.</li>
      <li>Swipe compares the maps. H hides the panels.</li>
    </ol>
    ${CTX.STATE.national ? '' : `<h2 class="h2">Maps</h2>
    ${VERS.map((v) => `<p class="note"><b>${lineKey(v)} ${esc(VMETA[v].label)}</b>: ${esc(VMETA[v].long)}${VMETA[v].used ? `, ${esc(VMETA[v].used)}` : ''}.</p>`).join('')}`}
    <h2 class="h2">Credits</h2>
    <p class="note">${esc(cfg.site.data_credit)}. Basemaps: OpenFreeMap / OpenMapTiles / OpenStreetMap contributors; Esri.</p>
    <button class="textbtn" data-act="back" style="margin-top:16px">Back</button>`;
}

let lastPlace = null;

/** Progressive render: sections fill in as their data arrives (kept while it does, so nothing flickers). */
export async function renderPanel() {
  const t = ++tok;
  const st = CTX.S.get();
  crumbs(st);
  const panel = document.getElementById('panel');
  if (st.panel === 'about') { panel.innerHTML = about(); return; }
  const focused = document.activeElement?.id === 'listFilter';
  const place = JSON.stringify([st.sel, st.hex, st.panel]);
  const keep = place === lastPlace ? panel.scrollTop : 0;
  lastPlace = place;
  let html = '<div id="sec-band"></div>';
  if (st.sel) {   // decision O1: on the newer map the results come first
    const results = resultsCard(st, unit(st.sel).no, () => { if (JSON.stringify(CTX.S.get().sel) === JSON.stringify(st.sel)) renderPanel(); });
    const newer = CTX.VERS.indexOf(st.sel.ver) === CTX.VERS.length - 1;
    const people = st.sel.level === 'dt' ? districtSeats(st) : lineage(st);
    html += hero(st) + (newer ? results + people : people + results) + members(st);
  }
  else html += landing(st);
  panel.innerHTML = html;
  panel.scrollTop = keep;
  if (focused) { const f = document.getElementById('listFilter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  if (st.hex && CTX.cfg.features.hexagons) {
    const band = await hexBand(st);
    if (t === tok) { const el = document.getElementById('sec-band'); if (el) el.innerHTML = band; }
  }
}
