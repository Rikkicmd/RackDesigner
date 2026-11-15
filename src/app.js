'use strict';
/* Rack Designer: lay out server racks, allocate switch / patch panel / device ports, export the port allocation
   table (Excel, CSV, PDF) and the rack layout (PNG, SVG, PDF). One file, works offline. */

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const STORE = 'sd-rack-designer-v1';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage off */ } };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }
(function fonts() { const s = document.createElement('style'); s.textContent = FONT_CSS; document.head.appendChild(s); })();

/* ---------- kit catalogue ---------- */
const KINDS = {
  rj45: { name: 'RJ45', w: 1, h: 1 },
  sfp: { name: 'SFP', w: 1.2, h: .78 },
  sfpp: { name: 'SFP+', w: 1.2, h: .78 },
  lc: { name: 'LC duplex', w: 1.25, h: .9 },
  sc: { name: 'SC', w: 1, h: 1 },
  con: { name: 'Console', w: 1, h: 1 },
  pwr: { name: 'Power outlet', w: 1.05, h: 1.05 },
  inlet: { name: 'Power inlet', w: 1.25, h: 1 },
};
const g = (kind, count, o = {}) => ({ kind, count, start: 1, prefix: '', order: 'zig', name: '', ...o });
const R = o => ({ rear: true, order: 'row', ...o });       // a port group on the back of the kit
const CATS = [['patch', 'Patch panels'], ['at', 'Allied Telesis switches'], ['network', 'Other switches and network'], ['zenitel', 'Zenitel'], ['ccure', 'C•CURE / Software House'], ['avigilon', 'Avigilon recorders'], ['server', 'Servers and recorders'], ['power', 'Power: UPS and PDUs'], ['acc', 'Accessories and shelves'], ['onshelf', 'Shelf kit (sits on a shelf)'], ['custom', 'Custom']];
/* Avigilon NVR5, from the NVR5 datasheet: VAL is 1U with 4 bays, one PSU; STD 2U, 10 bays; Premium 2U with 12 to 28 bays,
   two PSUs, 1G and 10G SFP+ network ports. Network, management and power are on the back; the front is a bezel over the drives. */
const AVG = (id, model, h, bays, cu, sfp, psu) => ({ id, cat: 'avigilon', family: 'avg', look: 'avg', name: 'Avigilon ' + model, model, h, pre: 'NVR', face: '#25292d', bays, psu,
  groups: [g('rj45', cu, R({ prefix: 'NIC' })), ...(sfp ? [g('sfpp', sfp, R({ prefix: '10G-' }))] : []), g('rj45', 1, R({ name: 'iDRAC', prefix: 'iDRAC' }))] });
/* APC Smart-UPS style rack UPS: display and buttons on the front, outlets, network card slot and input on the back. */
const UPS = (id, model, h, c13, c19) => ({ id, cat: 'power', family: 'ups', look: 'ups', name: 'UPS ' + model, model, h, pre: 'UPS', face: '#262b2f', psu: 1, pin: 'Input',
  groups: [g('rj45', 1, R({ name: 'NMC', prefix: 'NMC' })), g('pwr', c13, R({ prefix: 'OUT' })), ...(c19 ? [g('pwr', c19, R({ prefix: 'C19-' }))] : [])] });
/* 0U vertical PDUs hang at the back of the rack, at the sides. */
const VPDU = (id, name, c13, c19) => ({ id, cat: 'power', name, vert: true, h: 0, pre: 'PDU', face: '#1f2326', psu: 1, pin: 'Input',
  groups: [g('pwr', c13, { order: 'row' }), ...(c19 ? [g('pwr', c19, { order: 'row', prefix: 'C19-' })] : [])] });

/* Allied Telesis switches, drawn from their front panels. x530 (from the x530 installation guide): copper ports
   1-20 / 1-40 at 1G, then multi-gig 100M/1/2.5/5G ports, then SFP+ cages two high, then the management panel with
   the console, management port, USB, eco-friendly button and switch ID LED. x230: 1G copper then SFP, console on the
   front; the 10 and 18 port bodies are narrower than 19" and sit in a rack kit (body = width in mm). */
const MGMT = [g('con', 1, { prefix: 'CON', name: 'Console', order: 'row', panel: true }), g('rj45', 1, { prefix: 'MGMT', name: 'MGMT', order: 'row', panel: true, after: 46 })];
const X530 = (id, model, cu, mg, sfp, o = {}) => ({ id, cat: 'at', family: 'at', look: 'at', name: 'Allied Telesis ' + model, model, h: 1, pre: 'SW', face: '#33383e', psu: 1, poe: /P/.test(model.slice(-4)),
  groups: [...(cu ? [g('rj45', cu, { poe: /GP/.test(model) })] : []), ...(mg ? [g('rj45', mg, { start: cu + 1, mg: true, poe: /P|HX/.test(model.slice(-4)) })] : []),
    g('sfpp', sfp, { start: cu + mg + 1, rows: 2 }), ...(o.noMgmt ? [g('con', 1, { prefix: 'CON', name: 'Console', order: 'row', panel: true, after: 30 })] : MGMT)], ...o });
const X230 = (id, model, cu, sfp, body) => ({ id, cat: 'at', family: 'at', look: 'at', name: 'Allied Telesis ' + model, model, h: 1, pre: 'SW', face: '#33383e', psu: 1, body,
  groups: [g('rj45', cu, { poe: /GP/.test(model) }), g('sfp', sfp, { start: cu + 1, rows: sfp >= 4 ? 2 : 1 }), g('con', 1, { prefix: 'CON', name: 'Console', order: 'row', panel: true, after: 22 })] });
const CATALOG = [
  { id: 'cat6-24', cat: 'patch', name: 'Cat6 patch panel, 24 port', h: 1, pre: 'PP', face: '#1c2023', groups: [g('rj45', 24, { order: 'row' })] },
  { id: 'cat6-48', cat: 'patch', name: 'Cat6 patch panel, 48 port', h: 2, pre: 'PP', face: '#1c2023', groups: [g('rj45', 48, { order: 'row' })] },
  { id: 'cat6a-24', cat: 'patch', name: 'Cat6A patch panel, 24 port', h: 1, pre: 'PP', face: '#1c2023', groups: [g('rj45', 24, { order: 'row' })] },
  { id: 'fpp-12lc', cat: 'patch', name: 'Fibre patch panel, 12 × LC duplex', h: 1, pre: 'FPP', face: '#23282c', groups: [g('lc', 12, { order: 'row' })] },
  { id: 'fpp-24lc', cat: 'patch', name: 'Fibre patch panel, 24 × LC duplex', h: 1, pre: 'FPP', face: '#23282c', groups: [g('lc', 24, { order: 'row' })] },
  { id: 'fpp-12sc', cat: 'patch', name: 'Fibre patch panel, 12 × SC', h: 1, pre: 'FPP', face: '#23282c', groups: [g('sc', 12, { order: 'row' })] },
  X530('x530-28', 'x530-28GPXm', 20, 4, 4),
  X530('x530-28t', 'x530-28GTXm', 20, 4, 4),
  X530('x530-52', 'x530-52GPXm', 40, 8, 4),
  X530('x530-52t', 'x530-52GTXm', 40, 8, 4),
  X530('x530-18', 'x530-18GHXm', 0, 16, 2),
  X530('x530-10', 'x530-10GHXm', 0, 8, 2),
  X530('x530l-28', 'x530L-28GPX', 24, 0, 4, { noMgmt: true }),
  X530('x530l-52', 'x530L-52GPX', 48, 0, 4, { noMgmt: true }),
  X230('x230-28', 'x230-28GP', 24, 4, 440),
  X230('x230-28t', 'x230-28GT', 24, 4, 341),
  X230('x230-18', 'x230-18GP', 16, 2, 341),
  X230('x230-18t', 'x230-18GT', 16, 2, 341),
  X230('x230-10', 'x230-10GP', 8, 2, 210),
  X230('x230-10t', 'x230-10GT', 8, 2, 263),
  X230('x230l-17', 'x230L-17GT', 16, 1, 341),
  X230('x230l-26', 'x230L-26GT', 24, 2, 341),
  { id: 'sw-24', cat: 'network', name: 'Switch, 24 + 4 SFP', h: 1, pre: 'SW', face: '#2b3238', psu: 1, groups: [g('rj45', 24), g('sfp', 4, { start: 25 })] },
  { id: 'sw-48', cat: 'network', name: 'Switch, 48 + 4 SFP', h: 1, pre: 'SW', face: '#2b3238', psu: 1, groups: [g('rj45', 48), g('sfp', 4, { start: 49 })] },
  { id: 'fw', cat: 'network', name: 'Router / firewall', h: 1, pre: 'FW', face: '#33302b', psu: 1, groups: [g('rj45', 8, { order: 'row', prefix: 'P' }), g('sfp', 2, { prefix: 'X', order: 'row' })] },
  { id: 'mc', cat: 'network', name: 'Media converter chassis', h: 1, pre: 'MC', face: '#2e3237', psu: 1, groups: [g('rj45', 8, { order: 'row', prefix: 'T' }), g('lc', 8, { order: 'row', prefix: 'F' })] },
  { id: 'ccure', cat: 'server', name: 'C•CURE 9000 server', h: 1, pre: 'SRV', face: '#30373d', psu: 2, groups: [g('rj45', 2, R({ prefix: 'NIC' })), g('rj45', 1, R({ name: 'iDRAC', prefix: 'iDRAC' }))] },
  AVG('avg5-val', 'NVR5 Value', 1, 4, 2, 0, 1),
  AVG('avg5-std', 'NVR5 Standard', 2, 10, 2, 1, 1),
  AVG('avg5-prm', 'NVR5 Premium 96-160TB', 2, 12, 6, 2, 2),
  AVG('avg5-prm2', 'NVR5 Premium 192-224TB', 2, 18, 4, 4, 2),
  AVG('avg5-prm3', 'NVR5 Premium 252-432TB', 2, 28, 4, 2, 2),
  { id: 'avg', cat: 'server', name: 'NVR server, 2U', h: 2, pre: 'NVR', face: '#2f363c', psu: 2, groups: [g('rj45', 4, R({ prefix: 'NIC' })), g('rj45', 1, R({ name: 'BMC', prefix: 'BMC' }))] },
  { id: 'nvr', cat: 'server', name: 'NVR / recorder', h: 2, pre: 'NVR', face: '#2f363c', psu: 1, groups: [g('rj45', 2, R({ prefix: 'LAN' }))] },
  { id: 'srv1', cat: 'server', name: 'Server, 1U', h: 1, pre: 'SRV', face: '#30373d', psu: 2, groups: [g('rj45', 4, R({ prefix: 'NIC' })), g('rj45', 1, R({ name: 'iDRAC', prefix: 'iDRAC' }))] },
  { id: 'srv2', cat: 'server', name: 'Server, 2U', h: 2, pre: 'SRV', face: '#30373d', psu: 2, groups: [g('rj45', 4, R({ prefix: 'NIC' })), g('rj45', 1, R({ name: 'iDRAC', prefix: 'iDRAC' }))] },
  ...[['icx', 'ICX-500', '100M'], ['icx510', 'ICX-510', '1G'], ['icx510ia', 'ICX-510-IA', '1G']].map(([id, model, spd]) => ({ id, cat: 'zenitel', family: 'icx', look: 'icx', name: 'Zenitel ' + model, model, h: 1, pre: 'ICX', face: '#2a2d31', half: true, sw: 50, speed: spd, psu: 1, pin: 'DC in',
    groups: [g('rj45', 2, { prefix: 'ETH', start: 0, order: 'row', rear: true }), g('con', 1, { prefix: 'CON', name: 'Console', order: 'row', rear: true })] })),
  /* Software House IP-ACM v2: one door, two readers, a PoE Ethernet port and a second Ethernet port. The 2U pull-out drawer holds six. */
  { id: 'acm-drawer', cat: 'ccure', name: 'IP-ACM pull-out drawer, 2U (6 boards)', model: 'IP-ACM drawer', h: 2, pre: 'ACD', face: '#2a2f33', groups: [], art: 'drawer', slots: 6, holds: 'acm' },
  { id: 'ipacm', cat: 'ccure', name: 'IP-ACM v2 door module (in a drawer)', model: 'IP-ACM v2', h: 1, pre: 'ACM', face: '#1f6b46', acm: true, sw: 100 / 6, psu: 0,
    groups: [g('rj45', 1, { name: 'ETH1 (PoE)', prefix: 'ETH', order: 'row', poe: true }), g('rj45', 1, { name: 'ETH2', prefix: 'ETH', start: 2, order: 'row' })] },
  { id: 'kvm', cat: 'server', name: 'KVM terminal', h: 1, pre: 'KVM', face: '#2c3034', psu: 1, groups: [g('rj45', 8, R({ prefix: 'CH' })), g('rj45', 1, R({ name: 'LAN', prefix: 'LAN' }))] },
  UPS('ups2', 'SMT2200RMI2U style, 2U', 2, 8, 1),
  UPS('ups3', 'SMT3000RMI2U style, 2U', 2, 8, 1),
  UPS('ups1', 'SMT1500RMI2U style, 2U', 2, 4, 0),
  UPS('ups5', 'SRT5KRMXLI style, 3U', 3, 6, 4),
  { id: 'pdu', cat: 'power', name: 'PDU, 8 way, 1U', h: 1, pre: 'PDU', face: '#1f2326', psu: 1, pin: 'Input', groups: [g('pwr', 8, { order: 'row' })] },
  VPDU('vpdu-16', 'Vertical PDU, 0U, 16 way', 16, 0),
  VPDU('vpdu-24', 'Vertical PDU, 0U, 20 × C13 + 4 × C19', 20, 4),

  { id: 'cm', cat: 'acc', name: 'Cable manager', h: 1, pre: 'CM', face: '#25292c', groups: [], art: 'cm' },
  { id: 'brush', cat: 'acc', name: 'Brush plate', h: 1, pre: 'BP', face: '#25292c', groups: [], art: 'brush' },
  { id: 'blank', cat: 'acc', name: 'Blanking plate', h: 1, pre: 'BL', face: '#2a2e31', groups: [], art: 'blank' },
  { id: 'shelf', cat: 'acc', name: 'Shelf, 2U (kit sits on it)', h: 2, pre: 'SH', face: '#1d2124', groups: [], art: 'shelf' },
  { id: 'shelf1', cat: 'acc', name: 'Shelf, 1U', h: 1, pre: 'SH', face: '#1d2124', groups: [], art: 'shelf' },
  { id: 'shelf3', cat: 'acc', name: 'Shelf, 3U', h: 3, pre: 'SH', face: '#1d2124', groups: [], art: 'shelf' },
  { id: 'fan', cat: 'acc', name: 'Fan tray', h: 1, pre: 'FAN', face: '#2a2e31', psu: 1, groups: [], art: 'fan' },
  { id: 'desk-nvr', cat: 'onshelf', name: 'Desktop NVR, 8 PoE', h: 1, pre: 'NVR', face: '#2f363c', sw: 36, psu: 1, groups: [g('rj45', 1, { name: 'LAN', prefix: 'LAN', order: 'row' }), g('rj45', 8, { prefix: 'PoE', order: 'row' })] },
  { id: 'desk-sw', cat: 'onshelf', name: 'Desktop switch, 8 port', h: 1, pre: 'SW', face: '#2b3238', sw: 26, psu: 1, groups: [g('rj45', 8, { order: 'row' })] },
  { id: 'router', cat: 'onshelf', name: 'Router / modem', h: 1, pre: 'RTR', face: '#33302b', sw: 22, psu: 1, groups: [g('rj45', 1, { name: 'WAN', prefix: 'WAN', order: 'row' }), g('rj45', 4, { prefix: 'LAN', order: 'row' })] },
  { id: 'minipc', cat: 'onshelf', name: 'Mini PC / workstation', h: 1, pre: 'PC', face: '#30373d', sw: 16, psu: 1, groups: [g('rj45', 1, { name: 'LAN', prefix: 'LAN', order: 'row' })] },
  { id: 'psu-box', cat: 'onshelf', name: 'Power supply (PSU)', h: 1, pre: 'PSU', face: '#262b2f', sw: 22, psu: 1, groups: [g('pwr', 4, { prefix: 'OUT', order: 'row' })] },
  { id: 'mc1', cat: 'onshelf', name: 'Media converter', h: 1, pre: 'MC', face: '#2e3237', sw: 13, psu: 1, groups: [g('rj45', 1, { name: 'TX', prefix: 'TX', order: 'row' }), g('lc', 1, { name: 'FX', prefix: 'FX', order: 'row' })] },
  { id: 'box', cat: 'onshelf', name: 'Small device', h: 1, pre: 'DEV', face: '#353b40', sw: 20, psu: 1, groups: [g('rj45', 2, { order: 'row' })] },
  { id: 'custom', cat: 'custom', name: 'Custom device', h: 1, pre: 'DEV', face: '#353b40', psu: 1, groups: [g('rj45', 4, { order: 'row' })] },
];
const CAT_BY = Object.fromEntries(CATALOG.map(c => [c.id, c]));
const PASSIVE = new Set(['patch']);

/* port colours */
const STATUS = {
  patched: { name: 'Patched', c: '#2fb3aa' },
  external: { name: 'To field / outside', c: '#4c8dff' },
  reserved: { name: 'Reserved', c: '#e8a33a' },
  faulty: { name: 'Faulty / disabled', c: '#e5484d' },
  free: { name: 'Free', c: '#14181b' },
};
const CABLE_COL = { blue: '#2f74d0', yellow: '#e8c32a', green: '#2e9d4f', red: '#d23b33', grey: '#8a9297', white: '#e9ecee', black: '#22262a', orange: '#ec7d22', purple: '#8250c4', pink: '#e06aa8', aqua: '#2ec4d6', 'OS2 yellow': '#f2d43a', 'OM4 violet': '#b36bdc' };
const VLAN_PAL = ['#4c8dff', '#e8a33a', '#2fb3aa', '#e06aa8', '#9a7cf0', '#7cc95a', '#ec7d22', '#45c4e0', '#d9d24a', '#c46a4f', '#8fa3a0', '#ff8f8f'];

/* ---------- state ---------- */
let P;                                      // project
let sel = { rack: null, dev: null, port: null };
let view = 'rack', colourBy = 'status', leads = true, zoom = 1, pick = null;
let tq = '', tFree = false, tRack = '';
const undoS = [], redoS = [];
let IDX = new Map();                        // device id -> { rack, d }

function blankRack(n) { return { id: uid(), name: 'RACK-' + String(n).padStart(2, '0'), location: '', u: 42, width: '600', depth: '800', notes: '', devices: [] }; }
function newProject() { const r = blankRack(1); return { v: 1, name: 'New rack project', site: '', by: '', racks: [r] }; }
function reindex() { IDX = new Map(); for (const r of P.racks) for (const d of r.devices) IDX.set(d.id, { rack: r, d }); }
const curRack = () => P.racks.find(r => r.id === sel.rack) || P.racks[0];
const devOf = id => IDX.get(id)?.d;
const rackOf = id => IDX.get(id)?.rack;

function save() { lsSet(STORE, JSON.stringify({ P, sel, colourBy, leads, face })); $('#projname').textContent = (P.name || 'Untitled') + (P.site ? ' · ' + P.site : ''); }
function snap() { undoS.push(JSON.stringify(P)); if (undoS.length > 80) undoS.shift(); redoS.length = 0; }
function change(fn, o = {}) { snap(); fn(); reindex(); save(); render(o); }
function undo() { if (!undoS.length) return; redoS.push(JSON.stringify(P)); P = JSON.parse(undoS.pop()); fixSel(); reindex(); save(); render(); }
function redo() { if (!redoS.length) return; undoS.push(JSON.stringify(P)); P = JSON.parse(redoS.pop()); fixSel(); reindex(); save(); render(); }
function fixSel() {
  reindex();
  if (!P.racks.find(r => r.id === sel.rack)) sel.rack = P.racks[0]?.id;
  if (sel.dev && !IDX.has(sel.dev)) { sel.dev = null; sel.port = null; }
  if (sel.dev && sel.port && !portList(devOf(sel.dev)).some(p => p.id === sel.port)) sel.port = null;
}

/* ---------- devices and ports ---------- */
const psuOf = d => clamp(d.psu ?? CAT_BY[d.type]?.psu ?? 0, 0, 4);   // power inlets (PSUs) on the back
function inletGroup(d) {
  const n = psuOf(d); if (!n) return null;
  return { id: 'pw', kind: 'inlet', count: n, start: 1, prefix: 'PSU', order: 'row', rear: true, name: n === 1 ? (CAT_BY[d.type]?.pin || 'Power in') : '' };
}
const allGroups = d => { const ig = inletGroup(d); return ig ? [...d.groups, ig] : d.groups; };
const isPow = k => k === 'pwr' || k === 'inlet';
function portList(d) {
  const out = [];
  if (!d) return out;
  for (const gr of allGroups(d)) for (let i = 0; i < gr.count; i++) {
    const n = gr.start + i;
    out.push({ id: gr.id + '-' + n, n, i, gr, kind: gr.kind, name: gr.count === 1 && gr.name ? gr.name : (gr.prefix || '') + n });
  }
  return out;
}
const portById = (d, pid) => portList(d).find(p => p.id === pid);
const pdata = (d, pid) => d.ports[pid] || {};
function portStatus(d, pid) {
  const x = d.ports[pid];
  if (!x) return 'free';
  if (x.faulty) return 'faulty';
  if (x.link && IDX.has(x.link.d)) return 'patched';
  if (x.ext) return 'external';
  if (x.reserved || x.desc || x.vlan || x.notes || x.cable) return 'reserved';
  return 'free';
}
function vlanCol(v) { const n = parseInt(v, 10); if (isNaN(n)) { let h = 0; for (const c of String(v)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return VLAN_PAL[h % VLAN_PAL.length]; } return VLAN_PAL[n % VLAN_PAL.length]; }
function portFill(d, pid) {
  const st = portStatus(d, pid), x = d.ports[pid] || {};
  if (colourBy === 'vlan') return x.vlan ? vlanCol(x.vlan) : (st === 'free' ? STATUS.free.c : '#59626a');
  if (colourBy === 'cable') return x.colour ? CABLE_COL[x.colour] || '#59626a' : (st === 'free' ? STATUS.free.c : '#59626a');
  return STATUS[st].c;
}
function nextLabel(pre) {
  let max = 0; const re = new RegExp('^' + pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
  for (const r of P.racks) for (const d of r.devices) { const m = re.exec(d.label || ''); if (m) max = Math.max(max, +m[1]); }
  return pre + '-' + String(max + 1).padStart(2, '0');
}
function makeDev(type, u, side) {
  const c = CAT_BY[type];
  const d = { id: uid(), type, label: nextLabel(c.pre), model: c.model || '', u, h: c.h, ip: '', serial: '', notes: '',
    groups: c.groups.map(gr => ({ ...gr, id: uid().slice(0, 4) })), ports: {} };
  if (side && side !== 'full') d.side = side;
  return d;
}
const devName = d => CAT_BY[d.type]?.name || 'Device';
const isShelf = d => CAT_BY[d.type]?.art === 'shelf' || CAT_BY[d.type]?.art === 'drawer';   // holds other kit
const isDrawer = d => CAT_BY[d.type]?.art === 'drawer';
const isV = d => !!CAT_BY[d.type]?.vert;            // 0U vertical PDU at the back
const accepts = (sh, type) => !!CAT_BY[type] && (isDrawer(sh) ? !!CAT_BY[type].acm : !CAT_BY[type].acm && !CAT_BY[type].vert);
const holderWord = sh => isDrawer(sh) ? 'drawer' : 'shelf';
const sideOf = d => d.side || 'full';
const shelfOf = d => (d.on && devOf(d.on)) || null;       // the shelf this kit sits on, if any
const inRack = d => !shelfOf(d);
const uOf = d => isV(d) ? '0U' : (shelfOf(d) || d).u;
const uRange = d => isV(d) ? '0U' : d.h > 1 ? d.u + '–' + (d.u + d.h - 1) : '' + d.u;

const SIDE_TXT = { left: 'left half', right: 'right half' };
const vTxt = d => '0U, back of the rack, ' + (d.v === 'right' ? 'right' : 'left') + ' side';
function posTxt(d) {
  const sh = shelfOf(d);
  if (isV(d)) return vTxt(d);
  if (sh && isDrawer(sh)) return 'in drawer ' + sh.label + ', slot ' + d.slot + ' (U' + uRange(sh) + ')';
  if (sh) return 'on shelf ' + sh.label + ' (U' + uRange(sh) + ')';
  return 'U' + uRange(d) + (SIDE_TXT[sideOf(d)] ? ', ' + SIDE_TXT[sideOf(d)] : '');
}
const swOf = d => clamp(+d.sw || CAT_BY[d.type]?.sw || 100, 5, 100);
function shelfItems(sh) { const r = rackOf(sh.id); return r ? r.devices.filter(x => x.on === sh.id).sort((a, b) => (a.slot || 0) - (b.slot || 0)) : []; }
const shelfUsed = (sh, except) => isDrawer(sh) ? Math.round(shelfItems(sh).filter(x => x.id !== except).length * 100 / CAT_BY[sh.type].slots) : shelfItems(sh).reduce((t, x) => t + (x.id === except ? 0 : swOf(x)), 0);
const freeSlot = sh => { const used = new Set(shelfItems(sh).map(x => x.slot)); for (let i = 1; i <= CAT_BY[sh.type].slots; i++) if (!used.has(i)) return i; return 0; };
const vItems = (r, side) => r.devices.filter(x => isV(x) && (x.v || 'left') === side).sort((a, b) => (a.vi || 0) - (b.vi || 0));
function orderedDevs(r) { // top of the rack first, kit on a shelf straight after its shelf
  const out = [];
  for (const d of r.devices.filter(x => inRack(x) && !isV(x)).sort((a, b) => b.u - a.u || (a.side === 'right') - (b.side === 'right'))) { out.push(d); if (isShelf(d)) out.push(...shelfItems(d)); }
  return out.concat(vItems(r, 'left'), vItems(r, 'right'));
}
function clash(u, h, side, o) {
  if (!inRack(o) || isV(o)) return false;
  if (!(u <= o.u + o.h - 1 && o.u <= u + h - 1)) return false;
  return side === 'full' || sideOf(o) === 'full' || sideOf(o) === side;
}
function placeOK(r, u, h, except, side = 'full') {
  if (u < 1 || u + h - 1 > r.u) return false;
  return !r.devices.some(o => o.id !== except && clash(u, h, side, o));
}
function lowestFree(r, h) { for (let u = 1; u + h - 1 <= r.u; u++) if (placeOK(r, u, h)) return u; return 0; }
function freeSpot(r, h, half, except) { // { u, side } of the lowest space that fits, or null
  if (half) for (const o of r.devices.filter(x => inRack(x) && !isV(x) && sideOf(x) !== 'full' && x.id !== except).sort((a, b) => a.u - b.u)) { // pair up with half-width kit first
    const side = sideOf(o) === 'left' ? 'right' : 'left';
    if (placeOK(r, o.u, h, except, side)) return { u: o.u, side };
  }
  for (let u = 1; u + h - 1 <= r.u; u++) for (const side of half ? ['left', 'right'] : ['full']) if (placeOK(r, u, h, except, side)) return { u, side };
  return null;
}
function usedU(r) { return r.devices.filter(x => inRack(x) && !isV(x)).reduce((t, d) => t + d.h * (sideOf(d) === 'full' ? 1 : .5), 0); }
function badDev(r, d) {
  if (!inRack(d)) return false;
  if (isV(d)) return vItems(r, d.v || 'left').length > 2;
  if (isShelf(d) && shelfUsed(d) > 100) return true;
  return d.u < 1 || d.u + d.h - 1 > r.u || r.devices.some(o => o.id !== d.id && clash(d.u, d.h, sideOf(d), o));
}
function portRef(dId, pid, withRack = true) {
  const hit = IDX.get(dId); if (!hit) return '?';
  const p = portById(hit.d, pid);
  return (withRack ? hit.rack.name + ' / ' : '') + (hit.d.label || devName(hit.d)) + ' port ' + (p ? p.name : '?');
}
function unlink(d, pid) {
  const x = d.ports[pid]; if (!x || !x.link) return;
  const o = devOf(x.link.d); if (o && o.ports[x.link.p] && o.ports[x.link.p].link?.d === d.id) delete o.ports[x.link.p].link;
  delete x.link;
}
function link(d, pid, o, opid) {
  unlink(d, pid); unlink(o, opid);
  const a = d.ports[pid] = d.ports[pid] || {}, b = o.ports[opid] = o.ports[opid] || {};
  a.link = { d: o.id, p: opid }; b.link = { d: d.id, p: pid };
  for (const k of ['cable', 'colour', 'vlan']) { if (a[k] && !b[k]) b[k] = a[k]; else if (b[k] && !a[k]) a[k] = b[k]; }
  if (!a.cable && !b.cable) a.cable = b.cable = nextCable();
}
function nextCable() {
  let max = 0;
  for (const r of P.racks) for (const d of r.devices) for (const k in d.ports) { const m = /^C-(\d+)$/.exec(d.ports[k].cable || ''); if (m) max = Math.max(max, +m[1]); }
  return 'C-' + String(max + 1).padStart(3, '0');
}
function setPort(d, pid, k, v) {
  const x = d.ports[pid] = d.ports[pid] || {};
  if (v === '' || v === false) delete x[k]; else x[k] = v;
  if ((k === 'cable' || k === 'colour') && x.link) { const o = devOf(x.link.d); if (o) { const y = o.ports[x.link.p] = o.ports[x.link.p] || {}; if (v === '' || v === false) delete y[k]; else y[k] = v; } }
  if (!Object.keys(x).length) delete d.ports[pid];
}
function stdPorts(d) { // does the device have its catalogue port layout?
  const a = d.groups, b = CAT_BY[d.type]?.groups || [];
  return a.length === b.length && a.every((gr, i) => ['kind', 'count', 'start', 'prefix', 'name', 'mg', 'rows'].every(k => (gr[k] ?? '') === (b[i][k] ?? '')));
}
function swapType(d, type) { // change model: new faceplate, allocations kept by port name
  const c = CAT_BY[type], r = rackOf(d.id);
  const groups = c.groups.map(gr => ({ ...gr, id: uid().slice(0, 4) }));
  const byName = new Map(portList({ groups, type, psu: d.psu }).map(p => [p.kind + '|' + p.name, p.id]));   // same port: same name and type
  const old = portList(d), lost = old.filter(p => d.ports[p.id] && !byName.has(p.kind + '|' + p.name));
  if (lost.length && !confirm(`${lost.length} allocated port${lost.length > 1 ? 's' : ''} (${lost.slice(0, 6).map(p => p.name).join(', ')}${lost.length > 6 ? '…' : ''}) ${lost.length > 1 ? "aren't" : "isn't"} on the ${c.model}, so ${lost.length > 1 ? 'they' : 'it'} would be cleared. Carry on?`)) return false;
  if (c.h !== d.h && inRack(d) && !placeOK(r, d.u, c.h, d.id, c.half ? (sideOf(d) === 'full' ? 'left' : sideOf(d)) : 'full')) { toast(`The ${c.model} doesn't fit here.`); return false; }
  if (!c.half && sideOf(d) !== 'full' && inRack(d) && !placeOK(r, d.u, c.h, d.id, 'full')) { toast(`The ${c.model} is full width and the other half of this U is in use.`); return false; }
  change(() => {
    const ports = {};
    for (const p of old) {
      const x = d.ports[p.id]; if (!x) continue;
      const nid = byName.get(p.kind + '|' + p.name);
      if (!nid) { unlink(d, p.id); continue; }
      ports[nid] = x;
      if (x.link) { const o = devOf(x.link.d); if (o?.ports[x.link.p]?.link) o.ports[x.link.p].link.p = nid; }
    }
    d.type = type; d.groups = groups; d.ports = ports; d.model = c.model; d.h = c.h;
    if (c.half && sideOf(d) === 'full') d.side = 'left'; if (!c.half) delete d.side;
  });
  return true;
}
function removeDev(id) {
  const hit = IDX.get(id); if (!hit) return;
  if (isShelf(hit.d)) for (const it of shelfItems(hit.d)) removeDev(it.id);
  for (const p of Object.keys(hit.d.ports)) unlink(hit.d, p);
  hit.rack.devices = hit.rack.devices.filter(x => x.id !== id);
}
function prune(d) { // drop allocations on ports that no longer exist
  const ids = new Set(portList(d).map(p => p.id));
  for (const k of Object.keys(d.ports)) if (!ids.has(k)) { unlink(d, k); delete d.ports[k]; }
}

/* ---------- rack drawing (SVG) ---------- */
const UH = 40, PADT = 50, PADB = 30;
let FW = 820, RAIL = 30, NUMW = 34, LBLW = 160;   // full size; a narrower face is used on a phone so labels stay readable
const isPhone = () => matchMedia('(max-width: 760px)').matches;
function setGeom(compact) { if (compact) { FW = 500; RAIL = 18; NUMW = 22; LBLW = 118; } else { FW = 820; RAIL = 30; NUMW = 34; LBLW = 160; } }
function withFull(fn) { const c = FW !== 820; setGeom(false); try { return fn(); } finally { if (c) setGeom(true); } }
let face = 'front';                                // which side of the racks is drawn: front or rear
const VPW = () => FW === 820 ? 46 : 30;            // width of a 0U PDU strip at the back
const OX = () => face === 'rear' ? VPW() : 0;      // room for the PDU strips in the rear view
const RX = () => OX() + NUMW + RAIL;               // left edge of the 19" opening
function withFace(f, fn) { const o = face; face = f; try { return fn(); } finally { face = o; } }
const rackW = () => NUMW * 2 + RAIL * 2 + FW + OX() * 2;
const rackH = r => PADT + r.u * UH + PADB;
const devY = (r, d) => PADT + (r.u - (d.u + d.h - 1)) * UH;
const uAtY = (r, y) => r.u - Math.floor((y - PADT) / UH);
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

const grFace = gr => gr.rear ? 'rear' : 'front';
function layoutPorts(d, W, H, left = LBLW, right = 24, all = false) {
  const avail = W - left - right, gap = 3, bg = 7, GG = 16;
  const blocks = allGroups(d).filter(gr => gr.count > 0 && (all || grFace(gr) === face)).map(gr => {
    const K = KINDS[gr.kind] || KINDS.rj45;
    let rows = gr.rows || (gr.order === 'row' ? Math.ceil(gr.count / 24) : (gr.count >= 8 ? 2 : 1));
    rows = clamp(rows, 1, d.h * 2);
    const cols = Math.ceil(gr.count / rows);
    return { gr, K, rows, cols, nG: Math.max(0, Math.ceil(cols / 6) - 1) };
  });
  if (!blocks.length) return [];
  const unit = blocks.reduce((t, b) => t + b.cols * b.K.w, 0);
  const fixed = blocks.reduce((t, b) => t + b.cols * gap + b.nG * bg + (b.gr.after || 0), 0) + (blocks.length - 1) * GG;
  const pw = Math.min(24, (avail - fixed) / unit);
  const out = []; let x = left;
  for (const b of blocks) {
    const w = pw * b.K.w;
    let ph = Math.min(17, (H - 8 - (b.rows - 1) * gap) / b.rows) * b.K.h;
    ph = Math.min(ph, w * 1.05);
    const top = (H - (b.rows * ph + (b.rows - 1) * gap)) / 2;
    for (let i = 0; i < b.gr.count; i++) {
      let row, col;
      if (b.gr.order === 'row') { row = Math.floor(i / b.cols); col = i % b.cols; } else if (b.rows === 2) { col = Math.floor(i / 2); row = i % 2; } else { col = i; row = 0; }
      const n = b.gr.start + i;
      const name = b.gr.count === 1 && b.gr.name ? b.gr.name : (b.gr.prefix || '') + n;
      out.push({ id: b.gr.id + '-' + n, kind: b.gr.kind, n, name, short: name.length > 4 ? (b.gr.count === 1 && b.gr.prefix ? b.gr.prefix : String(n)) : name,
        mg: b.gr.mg, panel: b.gr.panel, rear: b.gr.rear, x: x + col * (w + gap) + Math.floor(col / 6) * bg, y: top + row * (ph + gap), w, h: ph });
    }
    x += b.cols * (w + gap) + b.nG * bg - gap + GG + (b.gr.after || 0);
  }
  return out;
}

function portSVG(d, p, interactive) {
  const f = portFill(d, p.id), st = portStatus(d, p.id), free = st === 'free' && colourBy === 'status';
  const rgb = [1, 3, 5].map(i => parseInt(f.slice(i, i + 2), 16)), light = .299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2] > 150;
  const txt = free ? '#7d878e' : (light ? '#1b1f22' : '#ffffff');
  let shape;
  const { x, y, w, h } = p;
  if (p.kind === 'lc') shape = `<rect class="sock" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${f}" stroke="#5b646b" stroke-width=".8"/><rect x="${x + w * .14}" y="${y + h * .58}" width="${w * .3}" height="${h * .3}" fill="#0a0c0d" opacity=".55"/><rect x="${x + w * .56}" y="${y + h * .58}" width="${w * .3}" height="${h * .3}" fill="#0a0c0d" opacity=".55"/>`;
  else if (p.kind === 'sc') shape = `<rect class="sock" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="${f}" stroke="#5b646b" stroke-width=".8"/><rect x="${x + w * .3}" y="${y + h * .62}" width="${w * .4}" height="${h * .26}" fill="#0a0c0d" opacity=".55"/>`;
  else if (p.kind === 'sfp' || p.kind === 'sfpp') shape = `<rect x="${x - 1.2}" y="${y - 1.2}" width="${w + 2.4}" height="${h + 2.4}" rx="1.2" fill="#b9c0c6"/><rect class="sock" x="${x + .6}" y="${y + .6}" width="${w - 1.2}" height="${h - 1.2}" rx=".8" fill="${f}" stroke="#7d868d" stroke-width=".8"/><rect x="${x + 2}" y="${y + h - 3.2}" width="${w - 4}" height="1.4" fill="#0a0c0d" opacity=".45"/>`;
  else if (p.kind === 'inlet') shape = `<path class="sock" d="M${x + w * .14},${y}H${x + w * .86}L${x + w},${y + h * .32}V${y + h}H${x}V${y + h * .32}Z" fill="${f}" stroke="#7d868d" stroke-width=".8"/>` + [.3, .5, .7].map((k, i) => `<rect x="${x + w * k - 1}" y="${y + h * (i === 1 ? .22 : .5)}" width="2" height="${h * .26}" fill="#0a0c0d" opacity=".6"/>`).join('');
  else if (p.kind === 'pwr') shape = `<rect class="sock" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${f}" stroke="#5b646b" stroke-width=".8"/><rect x="${x + w * .22}" y="${y + h * .62}" width="${w * .14}" height="${h * .22}" fill="#0a0c0d" opacity=".6"/><rect x="${x + w * .64}" y="${y + h * .62}" width="${w * .14}" height="${h * .22}" fill="#0a0c0d" opacity=".6"/>`;
  else shape = `<rect class="sock" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.4" fill="${p.kind === 'con' && free ? '#1f3a4f' : f}" stroke="#5b646b" stroke-width=".8"/><rect x="${x + w * .32}" y="${y + h - 3}" width="${w * .36}" height="2.2" fill="#0a0c0d" opacity=".55"/>`;
  const fs = Math.min(8.5, w * .42, h * .62);
  const label = fs >= 5 ? `<text x="${x + w / 2}" y="${y + Math.min(h * .5, h - 3) + fs * .1}" font-size="${fs.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="${txt}" font-family="PlexMono, 'IBM Plex Mono', monospace" font-weight="500">${esc(p.short || (String(p.name).length > 4 ? p.n : p.name))}</text>` : '';
  if (p.mg) shape += `<rect x="${x + 1}" y="${y + h - 1.6}" width="${w - 2}" height="1.6" fill="#3d8bfd"/>`;   // multi-gig
  if (st === 'patched' && !isPow(p.kind)) shape += `<circle cx="${x + w - 2.4}" cy="${y + 2.4}" r="1.5" fill="#5dff8f"/>`;   // link LED
  const hot = interactive && sel.dev === d.id && sel.port === p.id ? ' hot' : '';
  return `<g class="port${hot}" data-p="${d.id}|${p.id}">${shape}${label}</g>`;
}

function devArt(c, d, H) {
  const art = c?.art; let s = '';
  if (art === 'cm') for (let i = 0, n = Math.floor((FW - 190) / 66); i < n; i++) s += `<rect x="${LBLW + 10 + i * 66}" y="${H * .18}" width="44" height="${H * .64}" rx="5" fill="#15181a" stroke="#3b4248"/>`;
  else if (art === 'brush') { s += `<rect x="${LBLW}" y="${H * .32}" width="${FW - LBLW - 40}" height="${H * .36}" rx="4" fill="#0f1113"/>`; for (let x = LBLW + 6; x < FW - 44; x += 4) s += `<line x1="${x}" y1="${H * .34}" x2="${x + 1.5}" y2="${H * .66}" stroke="#41484e" stroke-width="1"/>`; }
  else if (art === 'blank') for (let x = LBLW + 20; x < FW - 60; x += 14) s += `<rect x="${x}" y="${H * .3}" width="6" height="${H * .4}" rx="3" fill="#1d2023"/>`;
  else if (art === 'drawer') s += `<rect x="26" y="${H - 18}" width="${Math.min(110, LBLW - 40)}" height="9" rx="4.5" fill="#15181a" stroke="#6b757c"/><rect x="${LBLW - 6}" y="3" width="2" height="${H - 6}" fill="#15181a"/>`;
  else if (art === 'shelf') s += `<rect x="16" y="${H - 9}" width="${FW - 32}" height="8" fill="#5a636a"/><rect x="16" y="${H - 9}" width="${FW - 32}" height="2" fill="#7b858c"/>`;
  else if (art === 'fan') for (let i = 0, n = Math.floor((FW - LBLW - 40) / 150); i < n; i++) { const cx = LBLW + 100 + i * 150; s += `<circle cx="${cx}" cy="${H / 2}" r="${H * .38}" fill="#15181a" stroke="#454c52"/><circle cx="${cx}" cy="${H / 2}" r="${H * .1}" fill="#454c52"/>`; }
  if (/^(srv|avg$|nvr|ccure)/.test(d.type)) { const cols = FW < 800 ? 2 : 4, rows = d.h === 1 ? 1 : 2, n = cols * rows; for (let i = 0; i < n; i++) { const col = i % (n / rows), row = Math.floor(i / (n / rows)); s += `<rect x="${FW - 36 - cols * 66 + col * 66}" y="${6 + row * (H - 12) / rows}" width="60" height="${(H - 12) / rows - 4}" rx="2" fill="#1b1f22" stroke="#454c52"/><circle cx="${FW - 36 - cols * 66 + col * 66 + 52}" cy="${6 + row * (H - 12) / rows + 6}" r="1.8" fill="#3bd16f"/>`; } }
  return s;
}

const SHELF_PAD = 24;
const MM = 450;   // usable width between the rack rails, mm
function bodyOf(d, b) { // a narrower switch body in a rack kit: { x, w } inside the device box
  const c = CAT_BY[d.type];
  if (c?.look === 'icx') { const ear = 16, w = Math.min(b.w - ear - 6, b.w * 162 / 225); return { x: b.side === 'right' ? (b.w - ear - w) / 2 : ear + (b.w - ear - w) / 2, w }; }
  if (!c?.body || b.half || b.item) return null;
  const w = Math.min(b.w - 40, b.w * c.body / MM); return { x: (b.w - w) / 2, w };
}
function lookSVG(d, b, ports) { // the parts of a real faceplate that aren't ports
  const c = CAT_BY[d.type], W = b.w, H = b.h, by = bodyOf(d, b); let s = '';
  const lit = col => `<circle r="1.9" fill="${col}"/>`;
  if (c.look === 'at') {
    if (by) { // rack kit: metal plate across the rack, switch body in the middle
      s += `<rect x="16" y="1" width="${W - 32}" height="${H - 2}" fill="#5d666d"/>`;
      for (const x of [26, W - 34]) s += `<rect x="${x}" y="${H / 2 - 6}" width="8" height="12" rx="4" fill="#3a4147"/>`;
      s += `<rect x="${by.x}" y="0" width="${by.w}" height="${H}" rx="2" fill="${c.face}" stroke="#0a0c0d" stroke-width="1.2"/>`;
    }
    const bx = by ? by.x : 0, lx = bx + (by ? 8 : 26);
    s += `<text x="${lx}" y="10.5" font-size="7.6" font-weight="600" letter-spacing=".02em" fill="#c9d3d8" font-family="Plex, sans-serif">Allied Telesis</text>`;
    s += `<text x="${lx}" y="${H - 5}" font-size="8" fill="#9fb0b6" font-family="Plex, sans-serif">${esc(c.model)}</text>`;
    // management panel behind the console / MGMT ports, with USB, eco-friendly button and switch ID LED
    const pp = ports.filter(p => p.panel);
    if (pp.length) {
      const x0 = Math.min(...pp.map(p => p.x)) - 4, x1 = Math.max(...pp.map(p => p.x + p.w)) + 4, y0 = Math.min(...pp.map(p => p.y)) - 3, y1 = Math.max(...pp.map(p => p.y + p.h)) + 3;
      const extra = (c.groups.find(gr => gr.after)?.after || 22) - 6;
      s += `<rect x="${x0}" y="${y0}" width="${x1 - x0 + extra}" height="${y1 - y0}" rx="2" fill="#24282c" stroke="#4b545b" stroke-width=".8"/>`;
      const ux = x1 + 3, cy = (y0 + y1) / 2;
      s += `<rect x="${ux}" y="${cy - 9}" width="11" height="5" rx=".8" fill="#c9d0d5"/><text x="${ux + 5.5}" y="${cy - 1}" font-size="3.6" text-anchor="middle" fill="#9fb0b6" font-family="Plex, sans-serif">USB</text>`;
      s += `<circle cx="${ux + 5.5}" cy="${cy + 6}" r="3.6" fill="#1b2a1f" stroke="#4fbf6a" stroke-width=".8"/><text x="${ux + 5.5}" y="${cy + 7.3}" font-size="3.3" text-anchor="middle" fill="#7fe39a" font-family="Plex, sans-serif">ECO</text>`;
      if (extra > 30) s += `<rect x="${ux + 15}" y="${cy - 8}" width="12" height="15" rx="1" fill="#0b0d0e"/><text x="${ux + 21}" y="${cy + 3.6}" font-size="11" text-anchor="middle" fill="#43e06e" font-family="PlexMono, monospace">1</text>`;
    }
    // system LEDs
    const lx2 = (by ? by.x + by.w : W - 16) - 12;
    s += `<g transform="translate(${lx2},${H / 2 - 5})">${lit('#43e06e')}</g><g transform="translate(${lx2},${H / 2 + 5})">${lit('#2a3a2e')}</g>`;
  }
  if (c.look === 'avg') { // Avigilon NVR5: a mesh bezel over the drive bays, logo and power button on the right
    const bx = LBLW, bw = W - bx - 130, rows = H > 60 ? (c.bays > 10 ? 3 : 2) : 1, cols = Math.ceil(Math.min(c.bays, 12) / rows);
    s += `<text x="26" y="10.5" font-size="7.6" font-weight="600" letter-spacing=".16em" fill="#c9d3d8" font-family="Plex, sans-serif">AVIGILON</text><text x="26" y="${H - 5}" font-size="8" fill="#9fb0b6" font-family="Plex, sans-serif">${esc(c.model)}</text>`;
    s += `<rect x="${bx}" y="4" width="${bw}" height="${H - 8}" rx="3" fill="#15181b" stroke="#3a4248"/>`;
    for (let i = 0; i < rows * cols; i++) { const cw = (bw - 12) / cols, rh = (H - 16) / rows, cx = bx + 6 + (i % cols) * cw, cy = 8 + Math.floor(i / cols) * rh; s += `<rect x="${cx + 1}" y="${cy + 1}" width="${cw - 3}" height="${rh - 3}" rx="1.5" fill="#1d2226" stroke="#2c343a" stroke-width=".8"/><circle cx="${cx + cw - 7}" cy="${cy + rh / 2}" r="1.5" fill="#3d8bfd" opacity=".8"/>`; }
    for (let x = bx + 4; x < bx + bw - 4; x += 5) s += `<line x1="${x}" y1="5" x2="${x - 4}" y2="${H - 5}" stroke="#000" stroke-opacity=".35" stroke-width="1.6"/>`;
    const rx = bx + bw + 14;
    s += `<rect x="${rx}" y="${H / 2 - 11}" width="72" height="22" rx="3" fill="#0f1214" stroke="#3a4248"/><text x="${rx + 36}" y="${H / 2 + 3.5}" font-size="9" font-weight="600" letter-spacing=".14em" text-anchor="middle" fill="#e6ebee" font-family="Plex, sans-serif">AVIGILON</text>`;
    s += `<circle cx="${rx + 90}" cy="${H / 2}" r="6" fill="#1b1f22" stroke="#7d878e"/><path d="M${rx + 90},${H / 2 - 3.5}v3.2M${rx + 87.4},${H / 2 - 2}a3.4 3.4 0 1 0 5.2 0" fill="none" stroke="#4fa8ff" stroke-width="1.1" stroke-linecap="round"/>`;
    s += `<circle cx="${rx + 104}" cy="${H / 2 - 5}" r="1.9" fill="#43e06e"/><circle cx="${rx + 104}" cy="${H / 2 + 5}" r="1.9" fill="#3d8bfd"/>`;
  }
  if (c.look === 'ups') { // rack UPS: vented front with the display panel and buttons
    const px = W - 190;
    for (let x = LBLW; x < px - 12; x += 7) s += `<rect x="${x}" y="${H * .2}" width="3" height="${H * .6}" rx="1.5" fill="#15181a"/>`;
    s += `<rect x="${px}" y="${H / 2 - 17}" width="150" height="34" rx="4" fill="#14181a" stroke="#4b545b"/><rect x="${px + 8}" y="${H / 2 - 11}" width="78" height="22" rx="2" fill="#0e2421" stroke="#2fb3aa" stroke-width=".8"/>`;
    s += `<text x="${px + 47}" y="${H / 2 - 1.5}" font-size="8" text-anchor="middle" fill="#5fd4cb" font-family="PlexMono, monospace">ONLINE</text><text x="${px + 47}" y="${H / 2 + 7.5}" font-size="6.5" text-anchor="middle" fill="#5fd4cb" font-family="PlexMono, monospace">230V  42%</text>`;
    [0, 1, 2].forEach(i => { s += `<circle cx="${px + 98 + i * 12}" cy="${H / 2 + 5}" r="3.6" fill="#2a3035" stroke="#6b757c" stroke-width=".7"/>`; });
    s += `<circle cx="${px + 110}" cy="${H / 2 - 8}" r="1.8" fill="#43e06e"/><circle cx="${px + 98}" cy="${H / 2 - 8}" r="1.8" fill="#3a3f44"/><circle cx="${px + 122}" cy="${H / 2 - 8}" r="1.8" fill="#3a3f44"/>`;
    s += `<text x="26" y="${H - 6}" font-size="8" fill="#9fb0b6" font-family="Plex, sans-serif">${esc(c.model.replace(/ style.*$/, ''))}</text>`;
  }
  if (c.look === 'icx') { // IA-RS1 shelf bay with the ICX body; LEDs on the front, network ports on the back
    s += `<rect x="${b.side === 'right' ? 0 : 16}" y="1" width="${W - 16}" height="${H - 2}" fill="#3e464c"/>`;
    s += `<rect x="${by.x}" y="1" width="${by.w}" height="${H - 2}" rx="2.5" fill="${c.face}" stroke="#0a0c0d" stroke-width="1.1"/>`;
    s += `<text x="${by.x + 6}" y="10.5" font-size="7.4" font-weight="600" letter-spacing=".08em" fill="#d7dde0" font-family="Plex, sans-serif">ZENITEL</text>`;
    const anyLink = ports.some(p => portStatus(d, p.id) === 'patched');
    const leds = [['#43e06e', 1], ['#43e06e', 1], ['#f0a33a', 0], ['#3d8bfd', 1], ['#43e06e', anyLink], ['#43e06e', anyLink]];
    const ox = by.x + by.w * .36;
    leds.forEach(([col, on], i) => { s += `<circle cx="${ox + (i % 3) * 8}" cy="${H / 2 - 4 + Math.floor(i / 3) * 9}" r="2.1" fill="${on ? col : '#3a3f44'}"/>`; });
  }
  return s;
}
const RLW = () => FW === 820 ? 100 : 66;           // label space on the back of kit
const mirrorBody = (by, b) => by && face === 'rear' ? { x: b.w - by.x - by.w, w: by.w } : by;
function rearSVG(d, b, ports) { // the back of a piece of kit
  const c = CAT_BY[d.type] || {}, W = b.w, H = b.h, by = mirrorBody(bodyOf(d, b), b), passive = c.cat === 'patch' || (c.art && c.art !== 'fan');
  let s = '';
  if (by) { s += `<rect x="${b.pos === 'right' ? 0 : b.half ? 0 : 16}" y="1" width="${b.half ? W - 16 : W - 32}" height="${H - 2}" fill="#3e464c" opacity=".7"/>`; if (b.half) s += `<rect x="${b.pos === 'right' ? W - 16 : 0}" y="0" width="16" height="${H}" fill="#4a5258" opacity=".6"/>`; }
  const bx = by ? by.x : 0, bw = by ? by.w : W;
  s += `<rect class="face" x="${bx}" y="0" width="${bw}" height="${H}" rx="2" fill="${passive ? '#202427' : '#1b1f22'}" stroke="#0a0c0d" stroke-width="1.2" ${passive ? 'opacity=".8"' : ''}/>`;
  if (c.art === 'shelf') s += devArt(c, d, H);
  if (c.cat === 'patch') for (let x = 30; x < W - 30; x += 44) s += `<rect x="${x}" y="${H * .3}" width="36" height="${H * .4}" rx="2" fill="#2b3035" stroke="#3b4248"/>`;   // punch-down blocks
  if (c.art === 'drawer') s += `<rect x="${W * .25}" y="${H * .3}" width="${W * .5}" height="${H * .4}" rx="4" fill="#0f1113"/>` + Array.from({ length: 40 }, (_, i) => `<line x1="${W * .25 + 6 + i * (W * .5 - 12) / 40}" y1="${H * .33}" x2="${W * .25 + 7.5 + i * (W * .5 - 12) / 40}" y2="${H * .67}" stroke="#41484e"/>`).join('');
  for (const p of ports.filter(p => p.kind === 'inlet')) s += `<rect x="${p.x - 4}" y="3" width="${p.w + 8}" height="${H - 6}" rx="2" fill="#2a3035" stroke="#4b545b" stroke-width=".8"/><rect x="${p.x - 1}" y="${H - 8}" width="${p.w + 2}" height="3" rx="1.5" fill="#6b757c"/>`;
  const end = ports.length ? Math.max(...ports.map(p => p.x + p.w)) + 14 : bx + Math.min(RLW(), bw * .4) + 10;
  if (!passive && bx + bw - 12 - end > 30) for (let x = end; x < bx + bw - 14; x += 6) s += `<rect x="${x}" y="${H * .22}" width="2.6" height="${H * .56}" rx="1.3" fill="#0c0e10"/>`;
  const lw = by ? Math.min(70, bw * .3) : RLW() - 10, lx = bx + 8;
  s += `<text x="${lx}" y="${H > 45 ? H / 2 : 16}" font-size="11" font-weight="600" fill="#ffffff" font-family="Plex, 'IBM Plex Sans', sans-serif">${esc(trunc(d.label || c.name, Math.max(3, Math.floor(lw / 6.6))))}</text>`;
  s += `<text x="${lx}" y="${H > 45 ? H / 2 + 13 : 29}" font-size="8.5" fill="#8e9ba0" font-family="Plex, sans-serif">${esc(trunc((d.model || c.model || c.name || '') , Math.max(3, Math.floor(lw / 4.6))))}</text>`;
  return s;
}
const DLW = () => LBLW;                            // label space at the left of an IP-ACM drawer
function devBox(r, d) { // where a device is drawn, in rack drawing units
  if (isV(d)) {
    const side = d.v === 'right' ? 'right' : 'left', list = vItems(r, side), n = clamp(list.length, 1, 2), i = clamp(list.indexOf(d), 0, 1), gap = 8, h = (r.u * UH - (n - 1) * gap) / n;
    return { x: side === 'left' ? 3 : rackW() - VPW() + 3, y: PADT + i * (h + gap), w: VPW() - 6, h, vert: true, side };
  }
  const sh = shelfOf(d);
  if (sh) {
    const sb = devBox(r, sh);
    if (isDrawer(sh)) {
      const n = CAT_BY[sh.type].slots, sw = (sb.w - DLW() - 10) / n, x = DLW() + (clamp(d.slot || 1, 1, n) - 1) * sw;
      return { x: sb.x + x, y: sb.y + 5, w: sw - 4, h: sb.h - 10, item: true, acm: true, rel: { x, y: 5 } };
    }
    const usable = sb.w - LBLW - SHELF_PAD; let x = LBLW;
    for (const it of shelfItems(sh)) {
      const w = usable * swOf(it) / 100 - 4;
      const rx = face === 'rear' ? sb.w - x - w : x;   // seen from the back, the shelf runs the other way
      if (it === d) return { x: sb.x + rx, y: sb.y + 3, w, h: sb.h - 13, item: true, rel: { x: rx, y: 3 } };
      x += w + 4;
    }
  }
  const side = sideOf(d), half = side !== 'full';
  const pos = half && face === 'rear' ? (side === 'left' ? 'right' : 'left') : side;   // left and right swap at the back
  return { x: RX() + (pos === 'right' ? FW / 2 : 0), y: devY(r, d) + 1, w: half ? FW / 2 : FW, h: d.h * UH - 2, half, side, pos };
}
function vpduPorts(d, b) { // outlets down a vertical PDU, the input at the bottom
  const ps = portList(d), top = 34, bot = 6, n = ps.length; if (!n) return [];
  const step = (b.h - top - bot) / n, h = clamp(step - 3, 3, 17), w = Math.min(b.w - 10, h * 1.3);
  return ps.map((p, i) => ({ id: p.id, kind: p.kind, n: p.n, name: p.name, short: p.kind === 'inlet' ? 'IN' : String(p.n), x: (b.w - w) / 2, y: top + i * step + (step - h) / 2, w, h }));
}
function acmPorts(d, b) { // the two Ethernet ports on an IP-ACM, bottom right of its window
  if (face === 'rear') return [];
  const ps = portList(d).filter(p => p.kind !== 'inlet'), w = Math.min(17, (b.w - 14) / 2.4), h = w * .85;
  return ps.map((p, i) => ({ id: p.id, kind: p.kind, n: p.n, name: p.name, short: 'E' + p.n, x: b.w - 5 - (ps.length - i) * (w + 3) + 3, y: b.h - h - 5, w, h }));
}
function devPorts(d, b) {
  if (b.vert) return vpduPorts(d, b);
  if (b.acm) return acmPorts(d, b);
  if (b.item) return layoutPorts(d, b.w, b.h - 15, 5, 5).map(p => ({ ...p, y: p.y + 15 }));
  if (face === 'rear') {
    const by = mirrorBody(bodyOf(d, b), b);
    if (by) return layoutPorts(d, by.w, b.h - 4, Math.min(70, by.w * .3) + 10, 8).map(p => ({ ...p, x: p.x + by.x, y: p.y + 2 }));
    return layoutPorts(d, b.w, b.h, RLW(), 14);
  }
  const c = CAT_BY[d.type], by = bodyOf(d, b);
  if (c?.look === 'icx' && by) return layoutPorts(d, b.w, b.h - 6, by.x + by.w * .62, b.w - by.x - by.w + 5).map(p => ({ ...p, y: p.y + 4 }));
  if (by) { const lw = Math.min(LBLW - 26, by.w * .3); return layoutPorts(d, by.w, b.h, lw + 6, 22).map(p => ({ ...p, x: p.x + by.x })); }
  if (b.half) return layoutPorts(d, b.w, b.h, Math.min(LBLW, b.w * .45), 22);
  return layoutPorts(d, b.w, b.h);
}
function wrap(s, n, lines) { // break text into at most `lines` lines of n characters
  const out = []; let cur = '';
  for (const w of String(s || '').split(/\s+/).filter(Boolean)) { if ((cur + ' ' + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  const res = [];
  for (const part of String(s || '').includes('\n') ? String(s).split('\n').map(x => x.trim()).filter(Boolean) : out) res.push(trunc(part, n));
  return res.slice(0, lines);
}
function acmSVG(d, b, sh) { // an IP-ACM in its drawer: a label window when shut, the board when open
  const W = b.w, H = b.h, n = Math.max(4, Math.floor((W - 8) / 5.6)), tl = wrap(d.tag, Math.max(4, Math.floor((W - 8) / 4.5)), H > 50 ? 3 : 1);
  let s = '';
  if (sh.open) {
    s += `<rect class="face" width="${W}" height="${H}" rx="2" fill="#1f6b46" stroke="#0d2f1f" stroke-width="1"/>`;
    for (let i = 0; i < Math.floor((W - 10) / 9); i++) s += `<rect x="${5 + i * 9}" y="2" width="7" height="6" fill="#2fa36a" stroke="#0d2f1f" stroke-width=".5"/>`;   // terminal blocks
    s += `<rect x="${W / 2 - 9}" y="${H / 2 - 10}" width="18" height="14" fill="#111" opacity=".8"/>`;
    s += `<text x="5" y="18" font-size="9.5" font-weight="600" fill="#fff" font-family="Plex, sans-serif">${esc(trunc(d.label, n))}</text>`;
  } else {
    s += `<rect class="face" width="${W}" height="${H}" rx="2" fill="#f2eedf" stroke="#8d8672" stroke-width="1"/>`;
    s += `<rect x="3" y="3" width="13" height="11" rx="2" fill="#0b7a75"/><text x="9.5" y="11.5" font-size="8" font-weight="600" text-anchor="middle" fill="#fff" font-family="Plex, sans-serif">${d.slot}</text>`;
    s += `<text x="19" y="12" font-size="9.5" font-weight="600" fill="#1b1f22" font-family="Plex, sans-serif">${esc(trunc(d.label, Math.max(3, n - 3)))}</text>`;
    tl.forEach((t, i) => { s += `<text x="4" y="${24 + i * 9.5}" font-size="7.6" fill="#3c4348" font-family="Plex, sans-serif">${esc(t)}</text>`; });
  }
  return s;
}
function vpduSVG(r, d, b, o) {
  const ports = devPorts(d, b), bad = badDev(r, d), W = b.w;
  let s = `<g class="dev vert${bad ? ' bad' : ''}" data-d="${d.id}" transform="translate(${b.x},${b.y})"><rect class="face" width="${W}" height="${b.h}" rx="4" fill="${d.colour || '#1f2326'}" stroke="#0a0c0d" stroke-width="1.2"/>`;
  s += `<rect x="3" y="3" width="${W - 6}" height="26" rx="2" fill="#0e2421" stroke="#2fb3aa" stroke-width=".8"/><text x="${W / 2}" y="13" font-size="7" text-anchor="middle" fill="#5fd4cb" font-family="PlexMono, monospace">${W > 30 ? '16.0A' : 'PDU'}</text>`;
  s += `<text x="${W / 2}" y="24" font-size="6.5" font-weight="600" text-anchor="middle" fill="#fff" font-family="Plex, sans-serif">${esc(trunc(d.label, W > 30 ? 7 : 5))}</text>`;
  for (const p of ports) s += portSVG(d, p, o.interactive);
  if (o.interactive && sel.dev === d.id) s += `<rect x="-2" y="-2" width="${W + 4}" height="${b.h + 4}" rx="4" fill="none" stroke="#2fb3aa" stroke-width="3" pointer-events="none"/>`;
  return s + '</g>';
}
function devSVG(r, d, o = {}) {
  const c = CAT_BY[d.type], b = devBox(r, d), W = b.w, H = b.h;
  if (b.vert) return vpduSVG(r, d, b, o);
  const ports = devPorts(d, b);
  const selD = o.interactive && sel.dev === d.id;
  const bad = badDev(r, d);
  const x = o.rel && b.rel ? b.rel.x : b.x, y = o.rel && b.rel ? b.rel.y : (o.y ?? b.y);
  let s = `<g class="dev${bad ? ' bad' : ''}${b.item ? ' item' : ''}" data-d="${d.id}" transform="translate(${x},${y})">`;
  if (face === 'rear' && !b.item) s += rearSVG(d, b, ports);
  else if (b.acm) s += acmSVG(d, b, shelfOf(d));
  else s += `<rect class="face" x="0" y="0" width="${W}" height="${H}" rx="${b.item ? 3 : 2}" fill="${d.colour || c?.face || '#30363b'}" stroke="#0a0c0d" stroke-width="1.2"/>`;
  if (face === 'rear' && !b.item || b.acm) { /* drawn above */ } else if (b.item) {
    s += `<rect x="0" y="0" width="${W}" height="3" rx="1.5" fill="#ffffff" opacity=".08"/>`;
    s += `<text x="6" y="12" font-size="10" font-weight="600" fill="#ffffff" font-family="Plex, 'IBM Plex Sans', sans-serif">${esc(trunc(d.label || c?.name, Math.max(3, Math.floor((W - 10) / 6.4))))}</text>`;
  } else {
    const lEar = b.side !== 'right', rEar = b.side !== 'left';
    if (lEar) s += `<rect x="0" y="0" width="16" height="${H}" fill="#4a5258"/>`;
    if (rEar) s += `<rect x="${W - 16}" y="0" width="16" height="${H}" fill="#4a5258"/>`;
    for (let k = 0; k < d.h; k++) { const cy = k * UH + UH / 2; if (lEar) s += `<circle cx="8" cy="${cy}" r="3.2" fill="#202427"/>`; if (rEar) s += `<circle cx="${W - 8}" cy="${cy}" r="3.2" fill="#202427"/>`; }
    if (!b.half) s += devArt(c, d, H);
    if (c?.look) {
      s += lookSVG(d, b, ports);
      const by = bodyOf(d, b), lx = by ? by.x + 6 : 26, lw = by ? (c.look === 'icx' ? by.w * .34 : Math.min(LBLW - 26, by.w * .3)) : LBLW - 26;
      s += `<text x="${lx}" y="${H / 2 + 4.5}" font-size="${c.look === 'icx' ? 11 : 12.5}" font-weight="600" fill="#ffffff" font-family="Plex, 'IBM Plex Sans', sans-serif">${esc(trunc(d.label || c.model, Math.max(3, Math.floor((lw - 2) / 7.6))))}</text>`;
      if (c.look === 'icx') s += `<text x="${lx}" y="${H - 5}" font-size="7.4" fill="#9fb0b6" font-family="Plex, sans-serif">${esc(trunc(d.model || c.model, Math.max(3, Math.floor(lw / 4.4))))}</text>`;
    } else {
    const lw = b.half ? Math.min(LBLW, W * .45) : LBLW, lx = lEar ? 26 : 10;
    const ly = d.h === 1 ? 17 : H / 2 - 4;
    s += `<text x="${lx}" y="${ly}" font-size="13" font-weight="600" fill="#ffffff" font-family="Plex, 'IBM Plex Sans', sans-serif">${esc(trunc(d.label || c?.name, Math.floor((lw - lx - 4) / 8)))}</text>`;
    s += `<text x="${lx}" y="${ly + 14}" font-size="10.5" fill="#a9b5b9" font-family="Plex, 'IBM Plex Sans', sans-serif">${esc(trunc(d.model || c?.name, Math.floor((lw - lx - 4) / 5.4)))}</text>`;
    if (c?.badge && !b.half) s += `<text x="${W - 22}" y="${H - 6}" font-size="8" text-anchor="end" fill="#7d878e" font-family="Plex, sans-serif" font-weight="600">${c.badge}</text>`;
    }
  }
  for (const p of ports) s += portSVG(d, p, o.interactive);
  if (isDrawer(d) && inRack(d) && face === 'front') {
    const n = CAT_BY[d.type].slots, sw = (W - DLW() - 10) / n, items = shelfItems(d);
    for (let k = 1; k <= n; k++) if (!items.some(x => x.slot === k)) {
      const ex = DLW() + (k - 1) * sw;
      s += `<g class="slotadd"${o.interactive ? ` data-acmslot="${d.id}|${k}"` : ''}><rect x="${ex}" y="5" width="${sw - 4}" height="${H - 10}" rx="2" fill="#1b1f22" stroke="#59626a" stroke-dasharray="3 3"/><text x="${ex + (sw - 4) / 2}" y="${H / 2 - 2}" text-anchor="middle" font-size="9" fill="#7d878e" font-family="Plex, sans-serif">Slot ${k}</text>${o.interactive ? `<text x="${ex + (sw - 4) / 2}" y="${H / 2 + 10}" text-anchor="middle" font-size="8.5" fill="#5fd4cb" font-family="Plex, sans-serif">+ IP-ACM</text>` : ''}</g>`;
    }
    for (const it of items) s += devSVG(r, it, { ...o, rel: true });
  } else if (isShelf(d) && !isDrawer(d) && inRack(d)) {
    const items = shelfItems(d);
    if (!items.length && o.interactive) s += `<text x="${(LBLW + W - SHELF_PAD) / 2}" y="${H / 2 + 2}" text-anchor="middle" font-size="11" fill="#7d878e" font-family="Plex, sans-serif">Drop shelf kit here</text>`;
    for (const it of items) s += devSVG(r, it, { ...o, rel: true });
  }

  if (selD) s += `<rect x="-2" y="-2" width="${W + 4}" height="${H + 4}" rx="3" fill="none" stroke="#2fb3aa" stroke-width="3" pointer-events="none"/>`;
  return s + '</g>';
}

function portCentre(r, d, pid) {
  const b = devBox(r, d), p = devPorts(d, b).find(q => q.id === pid);
  if (!p) return null;
  return { x: b.x + p.x + p.w / 2, y: b.y + p.y + p.h / 2, kind: p.kind };
}
function leadPath(a, b) {
  const sag = 18 + Math.min(60, Math.abs(a.x - b.x) * .08);
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${a.x.toFixed(1)},${(a.y + sag).toFixed(1)} ${b.x.toFixed(1)},${(b.y + sag).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}
function leadCol(x, kind) { if (x.colour) return CABLE_COL[x.colour] || '#2f74d0'; return kind === 'lc' || kind === 'sc' ? '#2ec4d6' : isPow(kind) ? '#16191c' : '#2f74d0'; }
function leadsSVG(r) {
  let s = ''; const done = new Set();
  for (const d of r.devices) for (const pid in d.ports) {
    const x = d.ports[pid]; if (!x.link) continue;
    const key = [d.id + pid, x.link.d + x.link.p].sort().join('~'); if (done.has(key)) continue; done.add(key);
    const o = devOf(x.link.d); if (!o || rackOf(o.id) !== r) continue;
    const a = portCentre(r, d, pid), b = portCentre(r, o, x.link.p); if (!a || !b) continue;
    const col = leadCol(x, a.kind);
    s += `<path d="${leadPath(a, b)}" fill="none" stroke="${isPow(a.kind) && !x.colour ? '#c9d0d5' : '#000'}" stroke-opacity="${isPow(a.kind) && !x.colour ? '.55' : '.35'}" stroke-width="4.2" stroke-linecap="round"/><path d="${leadPath(a, b)}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round" opacity=".92"/>`;
  }
  return `<g class="leads" pointer-events="none">${s}</g>`;
}

function rackSVG(r, o = {}) {
  const W = rackW(), H = rackH(r), x0 = OX() + NUMW, x1 = W - OX() - NUMW, rear = face === 'rear';
  const numCol = o.export ? '#4c5b59' : '#7c8a88';
  let s = '';
  if (o.export) s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
  s += `<text x="${W / 2}" y="22" text-anchor="middle" font-size="17" font-weight="600" fill="${o.export ? '#172322' : 'currentColor'}" font-family="Plex, 'IBM Plex Sans', sans-serif">${esc(r.name)}${r.location ? ' · ' + esc(r.location) : ''}${rear ? ' · back' : o.both ? ' · front' : ''}</text>`;
  s += `<text x="${W / 2}" y="38" text-anchor="middle" font-size="11.5" fill="${numCol}" font-family="Plex, 'IBM Plex Sans', sans-serif">${rear ? 'Seen from the back · ' : ''}${r.u}U · ${usedU(r)}U used, ${r.u - usedU(r)}U free${r.width && !rear ? ' · ' + esc(r.width) + ' × ' + esc(r.depth) + ' mm' : ''}</text>`;
  if (rear) { // cabinet sides with room for 0U PDUs
    s += `<rect x="0" y="${PADT - 10}" width="${W}" height="${r.u * UH + 20}" rx="6" fill="#1d2124" stroke="#151819" stroke-width="2"/>`;
    for (const side of ['left', 'right']) if (!vItems(r, side).length && o.interactive) { const vx = side === 'left' ? 3 : W - VPW() + 3; s += `<rect class="vslot" data-vside="${side}" x="${vx}" y="${PADT}" width="${VPW() - 6}" height="${r.u * UH}" rx="4" fill="transparent" stroke="#59626a" stroke-dasharray="4 4"/><text x="${vx + (VPW() - 6) / 2}" y="${PADT + r.u * UH / 2}" text-anchor="middle" font-size="9" fill="#7d878e" font-family="Plex, sans-serif" transform="rotate(-90 ${vx + (VPW() - 6) / 2} ${PADT + r.u * UH / 2})">0U PDU space</text>`; }
  }
  s += `<rect x="${x0 - 4}" y="${PADT - 10}" width="${x1 - x0 + 8}" height="${r.u * UH + 20}" rx="5" fill="#2a2f33" stroke="#151819" stroke-width="2"/>`;
  s += `<rect x="${x0 + RAIL}" y="${PADT}" width="${FW}" height="${r.u * UH}" fill="#121517"/>`;
  for (const rx of [x0, x1 - RAIL]) {
    s += `<rect x="${rx}" y="${PADT}" width="${RAIL}" height="${r.u * UH}" fill="#3b4248"/>`;
    for (let i = 0; i < r.u; i++) for (const k of [7, 20, 33]) s += `<rect x="${rx + RAIL / 2 - 3}" y="${PADT + i * UH + k - 3}" width="6" height="6" fill="#1a1d20"/>`;
  }
  for (let i = 0; i < r.u; i++) {
    const u = r.u - i, y = PADT + i * UH;
    if (i) s += `<line x1="${x0 + RAIL}" y1="${y}" x2="${x1 - RAIL}" y2="${y}" stroke="#20252a" stroke-width="1"/>`;
    for (const tx of [x0 - 8, x1 + 8]) s += `<text x="${tx}" y="${y + UH / 2 + 4}" text-anchor="${tx < W / 2 ? 'end' : 'start'}" font-size="11" fill="${numCol}" font-family="PlexMono, 'IBM Plex Mono', monospace">${u}</text>`;
    if (o.interactive) s += `<rect class="slot" data-u="${u}" x="${x0 + RAIL}" y="${y}" width="${FW}" height="${UH}" fill="transparent"/>`;
  }
  for (const d of r.devices.filter(x => inRack(x) && !isV(x)).sort((a, b) => a.u - b.u)) s += devSVG(r, d, o);
  if (rear) for (const d of r.devices.filter(isV)) s += devSVG(r, d, o);
  if (leads) s += leadsSVG(r);
  if (o.interactive) s += '<g id="hov" pointer-events="none"></g><g id="ghost" pointer-events="none"></g>';
  return { W, H, body: s };
}
function svgDoc(parts, W, H, scale = 1) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><style>${FONT_CSS}</style>${parts}</svg>`;
}
function rackDoc(r, f = face) { return withFull(() => f === 'both' ? bothDoc(r) : withFace(f, () => { const x = rackSVG(r, { export: true }); return { svg: svgDoc(x.body, x.W, x.H), W: x.W, H: x.H }; })); }
function bothDoc(r) { // front and back side by side
  const a = withFace('front', () => rackSVG(r, { export: true, both: true })), b = withFace('rear', () => rackSVG(r, { export: true })), gap = 40, W = a.W + gap + b.W, H = Math.max(a.H, b.H);
  return { svg: svgDoc(`<rect width="${W}" height="${H}" fill="#fff"/>${a.body}<g transform="translate(${a.W + gap},0)">${b.body}</g>`, W, H), W, H };
}
function allRacksDoc() { return withFull(allRacksDoc0); }
function allRacksDoc0() {
  let x = 0, H = 0, body = ''; const gap = 40;
  for (const r of P.racks) { const s = rackSVG(r, { export: true, both: false }); body += `<g transform="translate(${x},0)">${s.body}</g>`; x += s.W + gap; H = Math.max(H, s.H); }
  const W = x - gap;
  return { svg: svgDoc(`<rect width="${W}" height="${H}" fill="#fff"/>` + body, W, H), W, H };
}
function svgToPng(svg, W, H, scale = 2) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c);
    };
    img.onerror = e => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

/* ---------- rendering the UI ---------- */
let pane = 'rack';                         // phone: which pane shows (kit, rack, table, details)
function setPane(p) {
  pane = p;
  if (p === 'table') view = 'table'; else if (p === 'rack' || p === 'kit') view = 'rack';
  hideTip(); render();
}
function syncPanes() {
  const ph = isPhone(), b = document.body;
  b.classList.toggle('sheet', ph && pane === 'details');
  b.classList.toggle('kitopen', pane === 'kit');
  $$('#nav button').forEach(x => x.classList.toggle('on', x.dataset.pane === (pane === 'details' ? 'details' : pane === 'kit' ? 'kit' : view)));
}
function openDetails() { if (isPhone()) { pane = 'details'; syncPanes(); $('#panel').scrollTop = 0; } }
function render(o = {}) {
  fixSel();
  const compact = isPhone(); if ((FW !== 820) !== compact) setGeom(compact);
  renderTabs(); renderTools();
  $('#stage').hidden = view !== 'rack'; $('#table').hidden = view !== 'table';
  if (view === 'rack') renderRack(); else renderTable();
  if (o.panel !== false) renderPanel();
  $('#b-undo').disabled = !undoS.length; $('#b-redo').disabled = !redoS.length;
  syncPanes();
}
function renderTabs() {
  const r0 = curRack();
  $('#tabs').innerHTML = P.racks.map(r => `<button data-rack="${r.id}" class="${r === r0 && view === 'rack' ? 'on' : ''}" title="${esc(r.location)}">${esc(r.name)}</button>`).join('')
    + `<button class="add" data-act="addrack" title="Add a rack">+ Rack</button><span class="grow"></span>`
    + `<button class="view ${view === 'rack' ? 'on' : ''}" data-view="rack">Rack view</button> <button class="view ${view === 'table' ? 'on' : ''}" data-view="table">Port table</button>`;
}
function legendHTML() {
  if (colourBy === 'status') return Object.values(STATUS).map(s => `<span><i style="background:${s.c}"></i>${s.name}</span>`).join('');
  const seen = new Map();
  for (const r of P.racks) for (const d of r.devices) for (const k in d.ports) {
    const v = colourBy === 'vlan' ? d.ports[k].vlan : d.ports[k].colour;
    if (v && !seen.has(v)) seen.set(v, colourBy === 'vlan' ? vlanCol(v) : CABLE_COL[v]);
  }
  if (!seen.size) return `<span>No ${colourBy === 'vlan' ? 'VLANs' : 'cable colours'} set yet.</span>`;
  return [...seen].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })).map(([k, c]) => `<span><i style="background:${c}"></i>${colourBy === 'vlan' ? 'VLAN ' : ''}${esc(k)}</span>`).join('');
}
function renderTools() {
  if (view !== 'rack') { $('#tools').innerHTML = ''; $('#tools').hidden = true; return; }
  $('#tools').hidden = false;
  $('#tools').innerHTML = `<button class="btn sm tool-add" data-act="kit">+ Add kit</button>` + (pick ? `<span class="pickbar">Click the port to patch ${esc(portRef(pick.d, pick.p, false))} to<button class="btn sm" data-act="cancelpick">Cancel</button></span>` : '')
    + `<span class="seg" title="Which side of the rack to show">${[['front', 'Front'], ['rear', 'Back']].map(([k, n]) => `<button data-face="${k}" class="${face === k ? 'on' : ''}">${n}</button>`).join('')}</span>`
    + `<span class="lbl">Colour ports by</span><span class="seg">${[['status', 'Status'], ['vlan', 'VLAN'], ['cable', isPhone() ? 'Cable' : 'Cable colour']].map(([k, n]) => `<button data-cb="${k}" class="${colourBy === k ? 'on' : ''}">${n}</button>`).join('')}</span>`
    + `<label><input type="checkbox" id="t-leads" ${leads ? 'checked' : ''}> ${isPhone() ? 'Leads' : 'Patch leads'}</label>`
    + `<span class="zoom"><button data-z="-" title="Zoom out">−</button>${isPhone() ? '<button class="w" data-z="fit">Fit</button>' : '<button class="w" data-z="fit" title="Fit the rack to the width">Fit width</button><button class="w" data-z="all" title="Show the whole rack">Whole rack</button>'}<button data-z="+" title="Zoom in">+</button></span>`
    + `<div id="legend">${legendHTML()}</div>`;
}
function renderRack() {
  const r = curRack(), x = rackSVG(r, { interactive: true });
  $('#stage').classList.toggle('pick', !!pick);
  $('#stage').innerHTML = `<svg class="rack" id="rsvg" viewBox="0 0 ${x.W} ${x.H}" width="${Math.round(x.W * zoom)}" height="${Math.round(x.H * zoom)}" style="color:var(--ink)">${x.body}</svg>`;
}
function fitZoom(mode) {
  const st = $('#stage'), r = curRack();
  const zw = (st.clientWidth - (isPhone() ? 14 : 44)) / rackW(), zh = (st.clientHeight - 48) / rackH(r);
  // fit the width so ports are readable; only shrink to fit the height when that costs little
  if (mode === 'width' || isPhone()) zoom = clamp(zw, .25, 1.8);
  else if (mode === 'all') zoom = clamp(Math.min(zw, zh), .15, 1.8);
  else zoom = clamp(zh >= zw * .6 ? Math.min(zw, zh) : zw, .25, 1.8);  // whole rack when that keeps it readable
}

function kitIcon(type, w = 64) { return withFull(() => withFace('front', () => kitIcon0(type, w))); }
function kitIcon0(type, w) {
  const c = CAT_BY[type], d = { type, h: c.h || 1, groups: c.groups.map((gr, i) => ({ ...gr, id: 'i' + i })), ports: {}, label: '', model: '', psu: 0 };
  const H = (c.h || 1) * UH - 2, ports = layoutPorts(d, FW, H, LBLW, 24, true);
  let s = `<rect width="${FW}" height="${H}" rx="3" fill="${c.face}"/><rect width="16" height="${H}" fill="#4a5258"/><rect x="${FW - 16}" width="16" height="${H}" fill="#4a5258"/>` + devArt(c, d, H);
  s += `<rect x="26" y="${H / 2 - 7}" width="100" height="6" rx="2" fill="#a9b5b9" opacity=".7"/>`;
  for (const p of ports) s += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="1" fill="${p.kind === 'lc' || p.kind === 'sc' ? '#2b5f66' : p.kind.startsWith('sfp') ? '#59626a' : p.kind === 'pwr' ? '#111' : '#0c0e10'}" stroke="#6b757c" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${FW} ${H}" style="width:${w}px" aria-hidden="true">${s}</svg>`;
}
function kitThumb(type) { // a close-up of the left part of the face, so ports are visible at list size
  const c = CAT_BY[type], H = (c.h || 1) * UH - 2;

  return kitIcon(type, 72).replace(`viewBox="0 0 820 ${H}"`, `viewBox="0 0 400 ${H}"`);
}
function kitSummary(c) {
  const gs = c.groups.filter(gr => !gr.panel);
  if (c.look === 'icx') return ' · 2 Ethernet (' + c.speed + ') and console, on the back';
  if (c.art === 'drawer') return ' · holds 6 IP-ACM v2 boards, label windows on the front';
  if (c.look === 'avg') return ` · ${c.bays} drive bays · ${gs.filter(gr => gr.name !== 'iDRAC').map(gr => gr.count + ' × ' + (gr.kind === 'sfpp' ? '10G SFP+' : '1G')).join(' + ')}, iDRAC · ${c.psu} PSU${c.psu > 1 ? 's' : ''}`;
  const t = gs.map(gr => gr.count + ' ' + (gr.mg ? 'multi-gig' : gr.kind === 'rj45' && c.family === 'at' ? '× 1G' : gr.kind === 'pwr' ? (gr.prefix === 'C19-' ? '× C19' : '× outlets') : KINDS[gr.kind].name)).join(', ');
  return (t ? ' · ' + t : '') + (c.groups.some(gr => gr.poe) ? ', PoE+' : '') + (c.body ? ` · ${c.body} mm body` : '') + (c.groups.length && c.groups.every(gr => gr.rear) ? ', on the back' : '');
}
function renderLib() {
  const q = $('#lib-q').value.trim().toLowerCase();
  let s = '';
  for (const [cat, nm] of CATS) {
    const items = CATALOG.filter(c => c.cat === cat && (!q || (c.name + ' ' + (c.model || '') + ' ' + nm).toLowerCase().includes(q)));
    if (!items.length) continue;
    s += `<div class="lcat">${nm}</div>` + items.map(c => `<button class="kit" draggable="true" data-kit="${c.id}">${kitThumb(c.id)}<span>${esc(c.name)}<small>${c.cat === 'onshelf' ? 'On a shelf' : c.acm ? 'Goes in an IP-ACM drawer' : c.vert ? '0U, at the back of the rack' : c.half ? c.h + 'U, half width' : c.h + 'U'}${kitSummary(c)}</small></span></button>`).join('');
  }
  $('#lib-list').innerHTML = s || '<p class="note">No kit matches.</p>';
}

/* ---------- right panel ---------- */
const fld = (label, k, v, o = {}) => `<label class="f"><span>${label}</span>${o.select
  ? `<select data-k="${k}">${o.select.map(x => Array.isArray(x) ? `<option value="${esc(x[0])}" ${String(x[0]) === String(v ?? '') ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${String(x) === String(v ?? '') ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`
  : o.area ? `<textarea data-k="${k}" placeholder="${esc(o.ph || '')}">${esc(v)}</textarea>`
  : `<input data-k="${k}" value="${esc(v ?? '')}" placeholder="${esc(o.ph || '')}" ${o.type ? `type="${o.type}"` : ''} ${o.list ? `list="${o.list}"` : ''} ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''}>`}${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</label>`;
function renderPanel() {
  const el = $('#pbody');
  const key = sel.dev + '|' + sel.port;
  if (key !== renderPanel.key) { renderPanel.key = key; requestAnimationFrame(() => { $('#panel').scrollTop = 0; }); }
  const d = sel.dev && devOf(sel.dev);
  if (d && sel.port) el.innerHTML = portPanel(d, sel.port);
  else if (d) el.innerHTML = devPanel(d);
  else el.innerHTML = rackPanel(curRack());
}
function rackPanel(r) {
  const devs = orderedDevs(r);
  let ports = 0, used = 0;
  for (const d of r.devices) for (const p of portList(d)) { ports++; if (portStatus(d, p.id) !== 'free') used++; }
  const bad = r.devices.filter(d => badDev(r, d));
  return `<div data-scope="proj"><div class="ph">Project</div>
    ${fld('Project name', 'name', P.name)}
    <div class="g2">${fld('Site', 'site', P.site)}${fld('Drawn by', 'by', P.by)}</div></div>
    <div data-scope="rack"><div class="sec">Rack</div>
    <div class="g2">${fld('Rack name', 'name', r.name)}${fld('Size', 'u', r.u, { select: [4, 6, 9, 12, 15, 18, 20, 22, 24, 27, 32, 36, 37, 40, 42, 45, 47, 48].map(n => [n, n + 'U']) })}</div>
    ${fld('Location', 'location', r.location, { ph: 'e.g. Comms room G.12' })}
    <div class="g2">${fld('Width (mm)', 'width', r.width, { select: ['', '600', '800'] })}${fld('Depth (mm)', 'depth', r.depth, { select: ['', '450', '600', '800', '1000', '1200'] })}</div>
    ${fld('Notes', 'notes', r.notes, { area: 1 })}</div>
    <div class="stats"><div><b>${usedU(r)}U</b><small>used of ${r.u}U</small></div><div><b>${used}</b><small>ports in use</small></div><div><b>${ports - used}</b><small>ports free</small></div></div>
    ${bad.length ? `<div class="warnbox">${bad.map(d => esc(d.label)).join(', ')} ${bad.length > 1 ? "don't" : "doesn't"} fit or ${bad.length > 1 ? 'overlap' : 'overlaps'} other kit. Move ${bad.length > 1 ? 'them' : 'it'} or make the rack bigger.</div>` : ''}
    <div class="sec">In this rack</div>
    ${devs.length ? `<div class="rlist">${devs.map(d => `<button data-seldev="${d.id}"><span class="u mono">${shelfOf(d) ? '&nbsp;&nbsp;↳' : isV(d) ? '0U ' + (d.v === 'right' ? 'R' : 'L') : 'U' + uRange(d)}</span>
<span class="t"><b>${esc(d.label)}</b> ${esc(d.model || devName(d))}${SIDE_TXT[sideOf(d)] && inRack(d) ? ` <small style="color:var(--ink3)">(${SIDE_TXT[sideOf(d)]})</small>` : ''}</span></button>`).join('')}</div>` : '<p class="note">Nothing in this rack yet. Drag kit from the list on the left.</p>'}
    <div class="btns" style="margin-top:14px"><button class="btn" data-act="duprack">Duplicate rack</button><button class="btn danger" data-act="delrack" ${P.racks.length < 2 ? 'disabled' : ''}>Delete rack</button></div>`;
}
function devPanel(d) {
  const c = CAT_BY[d.type], r = rackOf(d.id), ps = portList(d);
  const used = ps.filter(p => portStatus(d, p.id) !== 'free').length;
  const others = [];
  for (const rr of P.racks) for (const o of orderedDevs(rr)) if (o.id !== d.id && portList(o).length) others.push([o.id, (rr !== r ? rr.name + ' / ' : '') + o.label]);
  const sh = shelfOf(d), shelves = r.devices.filter(x => isShelf(x) && inRack(x) && x.id !== d.id && accepts(x, d.type));
  const posSel = !isShelf(d) && !isV(d) && (sh || shelves.length) ? fld('Where', 'pos', sh ? sh.id : '', { select: [...(c.acm ? [] : [['', 'In the rack']]), ...shelves.map(x => [x.id, (isDrawer(x) ? 'In drawer ' : 'On shelf ') + x.label + ' (U' + uRange(x) + ', ' + (isDrawer(x) ? (CAT_BY[x.type].slots - shelfItems(x).filter(y => y.id !== d.id).length) + ' slots free' : (100 - shelfUsed(x, d.id)) + '% free') + ')'])] }) : '';
  const rackSel = fld('Rack', 'rack', r.id, { select: P.racks.map(x => [x.id, x.name]) });
  return `<div class="ptitle"><span class="ico">${kitThumb(d.type)}</span><div><h2>${esc(d.label || c.name)}</h2><p>${esc(c.name)} · ${esc(r.name)} ${esc(posTxt(d))}</p></div></div>
  ${badDev(r, d) ? `<div class="warnbox">${isShelf(d) && shelfUsed(d) > 100 ? `The kit on this shelf takes ${shelfUsed(d)}% of its width. Make some of it narrower or move it to another shelf.` : "This doesn't fit here: it overlaps other kit or runs past the top of the rack."}</div>` : ''}
  <div data-scope="dev">
    <div class="g2">${fld('Label', 'label', d.label)}${c.family ? fld('Model', 'ftype', d.type, { select: CATALOG.filter(x => x.family === c.family).map(x => [x.id, x.model]) }) : fld('Model', 'model', d.model, { ph: c.name })}</div>
    ${c.family && !stdPorts(d) ? `<div class="warnbox">This ${esc(c.model)} has a port layout from an older version or one you changed. <button class="btn sm" data-act="stdports">Use the ${esc(c.model)} faceplate</button></div>` : ''}
    ${posSel}
    ${isV(d) ? `<div class="g2">${fld('Mounted', 'vside', d.v || 'left', { select: [['left', 'Back, left side'], ['right', 'Back, right side']] })}${rackSel}</div><p class="note">0U PDUs show in the Back view. Two fit on each side.</p>`
      : sh && isDrawer(sh) ? `<div class="g2">${fld('Slot in the drawer', 'slot', d.slot, { select: Array.from({ length: CAT_BY[sh.type].slots }, (_, i) => { const k = i + 1, o = shelfItems(sh).find(x => x.slot === k && x !== d); return [k, 'Slot ' + k + (o ? ' (swap with ' + o.label + ')' : '')]; }) })}<div></div></div>
    ${fld('Label on the drawer front', 'tag', d.tag, { area: 1, ph: 'e.g. D01 Reception main door', hint: 'Shows in this board\'s window on the drawer front. Start a new line for each line of text.' })}`
      : sh ? `<div class="g2">${fld('Width on the shelf (%)', 'sw', swOf(d), { type: 'number', min: 5, max: 100, hint: 'Of the shelf width' })}<div></div></div>`
      : `<div class="g3">${fld('Lowest U', 'u', d.u, { type: 'number', min: 1, max: r.u })}${fld('Height (U)', 'h', d.h, { type: 'number', min: 1, max: 20 })}${fld('Rack', 'rack', r.id, { select: P.racks.map(x => [x.id, x.name]) })}</div>
    ${isShelf(d) ? '' : fld('Width', 'side', sideOf(d), { select: [['full', 'Full width (19")'], ['left', 'Half width, left side'], ['right', 'Half width, right side']] })}`}
    ${isDrawer(d) ? drawerSec(d) : isShelf(d) ? `<div class="sec">On this shelf · ${shelfUsed(d)}% of the width used</div>${shelfItems(d).length ? `<div class="rlist">${shelfItems(d).map(x => `<button data-seldev="${x.id}"><span class="u mono">${swOf(x)}%</span><span class="t"><b>${esc(x.label)}</b> ${esc(x.model || devName(x))}</span></button>`).join('')}</div>` : '<p class="note">Nothing yet. Drag shelf kit onto it, or add it from the Shelf kit list while this shelf is selected.</p>'}` : ''}
    <div class="g2">${fld('IP address', 'ip', d.ip, { ph: 'e.g. 10.0.0.5' })}${fld('Serial no.', 'serial', d.serial)}</div>
    ${fld('Notes', 'notes', d.notes, { area: 1, ph: 'Firmware, licences, warranty…' })}
    ${powerSec(d)}
  </div>

  <div class="btns"><button class="btn" data-act="dup">Duplicate</button>${sh ? '<button class="btn" data-act="sl" title="Move left along the shelf">◀ Left</button><button class="btn" data-act="sr" title="Move right along the shelf">Right ▶</button>' : '<button class="btn" data-act="up" title="Up 1U">▲ Up</button><button class="btn" data-act="down" title="Down 1U">▼ Down</button>'}<button class="btn danger" data-act="del">Delete</button></div>
  ${ps.length ? `<div class="sec"><span>Ports · ${used} of ${ps.length} in use</span></div>
  <div class="chips">${ps.map(p => { const st = portStatus(d, p.id); return `<button data-selport="${p.id}" class="${st === 'free' ? 'free' : ''}" style="${st === 'free' ? '' : `background:${portFill(d, p.id)}`}" title="${esc(tipText(d, p))}">${esc(p.name)}</button>`; }).join('')}</div>` : ''}
  ${isShelf(d) ? '' : `<div class="sec"><span>Port layout</span><button class="btn sm" data-act="addgrp">Add ports</button></div>`}
  ${isShelf(d) ? '' : d.groups.map(gr => `<div class="grp" data-grp="${gr.id}">
    <label><span>Type</span><select data-gk="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${gr.kind === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></label>
    <label><span>Count</span><input data-gk="count" type="number" min="1" max="96" value="${gr.count}"></label>
    <label><span>First no.</span><input data-gk="start" type="number" min="0" max="999" value="${gr.start}"></label>
    <label><span>Prefix</span><input data-gk="prefix" value="${esc(gr.prefix)}"></label>
    <button class="x" data-act="delgrp" title="Remove these ports">×</button></div>`).join('') || '<p class="note">No ports. Press Add ports to give it some.</p>'}
  ${ps.length && others.length ? `<div class="sec">Patch one to one</div>
  <div class="box" id="bulk"><p class="note" style="margin:0 0 8px">Patch a run of this ${esc(d.label)}'s ports straight across to another device, e.g. patch panel ports 1–24 to switch ports 1–24.</p>
    <div class="g2"><label class="f"><span>From port</span><select id="bk-from">${ps.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    <label class="f"><span>How many</span><input id="bk-n" type="number" min="1" max="${ps.length}" value="${Math.min(ps.length, 24)}"></label></div>
    <label class="f"><span>To device</span><select id="bk-dev">${others.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</select></label>
    <label class="f"><span>Starting at its port</span><select id="bk-to"></select></label>
    <label class="f"><span>VLAN (optional)</span><input id="bk-vlan" placeholder="e.g. 30"></label>
    <button class="btn pri" data-act="bulk">Patch ports</button></div>` : ''}
  ${ps.length ? `<div class="btns"><button class="btn danger" data-act="clearports">Clear all port allocations</button></div>` : ''}`;
}
function drawerSec(d) { // the six slots of an IP-ACM drawer, with their labels
  const n = CAT_BY[d.type].slots, items = shelfItems(d);
  return `<div class="sec"><span>In this drawer · ${items.length} of ${n} IP-ACMs</span><button class="btn sm" data-act="drawopen">${d.open ? 'Show it shut' : 'Show it open'}</button></div>
  <p class="note" style="margin-top:0">The label text shows in each board's window on the drawer front.</p>
  <div class="acms">${Array.from({ length: n }, (_, i) => { const k = i + 1, it = items.find(x => x.slot === k);
    return it ? `<div class="acmrow" data-acm="${it.id}"><span class="u mono">${k}</span><input data-ak="label" value="${esc(it.label)}" placeholder="Label" aria-label="Slot ${k} label"><input data-ak="tag" value="${esc((it.tag || '').replace(/\n/g, ' / '))}" placeholder="Door / area" aria-label="Slot ${k} label text"><button class="btn sm" data-seldev="${it.id}" title="Ports, IP address and notes">Edit</button></div>`
      : `<div class="acmrow empty"><span class="u mono">${k}</span><span class="note">Empty</span><button class="btn sm" data-act="addacm" data-slot="${k}">+ IP-ACM</button></div>`; }).join('')}</div>`;
}
function powerSec(d) { // which UPS / PDU outlet feeds each power inlet, and what each outlet feeds
  const c = CAT_BY[d.type] || {}, r = rackOf(d.id), ps = portList(d);
  let s = '';
  const outs = ps.filter(p => p.kind === 'pwr');
  if (outs.length) s += `<div class="sec">Outlets · ${outs.filter(p => pdata(d, p.id).link).length} of ${outs.length} feeding kit</div><div class="rlist">${outs.map(p => { const x = pdata(d, p.id); return `<button data-selport="${p.id}"><span class="u mono">${esc(p.name)}</span><span class="t">${x.link ? '<b>' + esc(portRef(x.link.d, x.link.p, false)) + '</b>' : x.ext ? esc(x.ext) : '<small style="color:var(--ink3)">free</small>'}</span></button>`; }).join('')}</div>`;
  if (c.cat === 'patch' || (c.art && c.art !== 'fan')) return s;
  const inl = ps.filter(p => p.kind === 'inlet');
  const srcs = orderedDevs(r).filter(o => o.id !== d.id && portList(o).some(p => p.kind === 'pwr'));
  s += `<div class="sec"><span>Power · which outlet feeds it</span></div>
    <div class="g2">${fld('Power inlets (PSUs)', 'psu', psuOf(d), { type: 'number', min: 0, max: 4 })}<div></div></div>`;
  if (inl.length && !srcs.length) s += `<p class="note">Add a UPS or PDU to ${esc(r.name)} to choose the outlet. Vertical PDUs are in the Power list.</p>`;
  else s += inl.map(p => { const x = pdata(d, p.id), cur = x.link ? x.link.d + '|' + x.link.p : '';
    return `<label class="f"><span>${esc(p.name)}</span><select data-pw="${p.id}"><option value="">Not plugged in</option>${srcs.map(o => `<optgroup label="${esc(o.label + ' · ' + (o.model || devName(o)))}">${portList(o).filter(q => q.kind === 'pwr').map(q => { const y = pdata(o, q.id), v = o.id + '|' + q.id, busy = y.link && v !== cur;
      return `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(o.label + ' ' + q.name)}${busy ? ' (in use: ' + esc(portRef(y.link.d, y.link.p, false)) + ')' : ''}</option>`; }).join('')}</optgroup>`).join('')}</select></label>`; }).join('');
  return s;
}
function fillBulkTo() {

  const s = $('#bk-dev'), t = $('#bk-to'); if (!s || !t) return;
  const o = devOf(s.value); t.innerHTML = portList(o).map(p => `<option value="${p.id}">${esc(p.name)}${portStatus(o, p.id) !== 'free' ? ' (in use)' : ''}</option>`).join('');
}
function portPanel(d, pid) {
  const p = portById(d, pid), x = pdata(d, pid), st = portStatus(d, pid), ps = portList(d), i = ps.findIndex(q => q.id === pid);
  const peer = x.link && devOf(x.link.d);
  const devOpts = [];
  for (const rr of P.racks) for (const o of orderedDevs(rr)) if (o.id !== d.id && portList(o).length) devOpts.push(`<option value="${o.id}">${esc(rr.name + ' / ' + o.label)}</option>`);
  const isSwitch = CAT_BY[d.type]?.cat === 'network';
  return `<div class="ptitle"><span class="ico">${kitThumb(d.type)}</span><div><h2>${esc(d.label)} · port ${esc(p.name)}</h2><p>${KINDS[p.kind].name} · <span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${STATUS[st].c};border:1px solid rgba(0,0,0,.3)"></span> ${STATUS[st].name}</p></div></div>
  <div class="btns" style="margin:-4px 0 10px"><button class="btn sm" data-act="back">← ${esc(d.label)}</button><span style="flex:1"></span><button class="btn sm" data-act="prevport" ${i <= 0 ? 'disabled' : ''}>‹ Prev</button><button class="btn sm" data-act="nextport" ${i >= ps.length - 1 ? 'disabled' : ''}>Next ›</button></div>
  <div class="sec">Connects to</div>
  ${peer ? `<div class="link"><div class="grow"><b>${esc(portRef(x.link.d, x.link.p))}</b><small>${esc(pdata(peer, x.link.p).desc || pdata(peer, x.link.p).ext || '')}</small></div><button class="btn sm" data-act="gopeer">Go to</button><button class="btn sm danger" data-act="unlink">Unpatch</button></div>`
  : `<div class="box"><div class="g2"><label class="f"><span>Device</span><select id="ln-dev"><option value="">Choose…</option>${devOpts.join('')}</select></label><label class="f"><span>Port</span><select id="ln-port"></select></label></div>
     <div class="btns"><button class="btn pri" data-act="link">Patch</button><button class="btn" data-act="pick">Pick on the rack</button></div></div>`}
  <div data-scope="port">
    ${fld(PASSIVE.has(CAT_BY[d.type]?.cat) ? 'Outlet / far end (field side)' : 'Outside connection', 'ext', x.ext, { ph: 'e.g. CAM-01 Car park, outlet 2.14', hint: 'What this port goes to outside the racks: a field device, floor outlet or another room.' })}
    ${fld('Description', 'desc', x.desc, { ph: 'What the port is for' })}
    <div class="g2">${fld('VLAN', 'vlan', x.vlan, { ph: 'e.g. 30' })}${fld('Cable ID', 'cable', x.cable, { ph: 'e.g. C-014' })}</div>
    <div class="g2">${fld('Cable colour', 'colour', x.colour, { select: [['', '–'], ...Object.keys(CABLE_COL).map(k => [k, k[0].toUpperCase() + k.slice(1)])] })}${fld('Speed', 'speed', x.speed, { select: ['', '100M', '1G', '2.5G', '5G', '10G', '25G', '40G'] })}</div>
    ${isSwitch && p.kind === 'rj45' ? `<label class="chk"><input type="checkbox" data-k="poe" ${x.poe ? 'checked' : ''}> PoE powered</label>` : ''}
    <label class="chk"><input type="checkbox" data-k="reserved" ${x.reserved ? 'checked' : ''}> Reserved</label>
    <label class="chk"><input type="checkbox" data-k="faulty" ${x.faulty ? 'checked' : ''}> Faulty / disabled</label>
    ${fld('Notes', 'notes', x.notes, { area: 1 })}
  </div>
  <div class="btns"><button class="btn danger" data-act="clearport">Clear this port</button></div>`;
}

/* ---------- tooltips ---------- */
function tipText(d, p) {
  const x = pdata(d, p.id);
  return [d.label + ' port ' + p.name, STATUS[portStatus(d, p.id)].name, x.link ? 'To ' + portRef(x.link.d, x.link.p) : '', x.ext ? 'Outside: ' + x.ext : '', x.desc, x.vlan ? 'VLAN ' + x.vlan : ''].filter(Boolean).join(' · ');
}
function trace(d, pid) { // follow patching: this port -> peer -> (peer's outside connection)
  const steps = [], seen = new Set(); let cur = d, cp = pid;
  for (let k = 0; k < 6; k++) {
    const x = pdata(cur, cp); if (!x.link) { if (x.ext && k) steps.push(x.ext); break; }
    const o = devOf(x.link.d); if (!o || seen.has(o.id + x.link.p)) break; seen.add(o.id + x.link.p);
    const p = portById(o, x.link.p); steps.push(o.label + ' ' + (p ? p.name : '?'));
    const y = pdata(o, x.link.p);
    if (y.ext) { steps.push(y.ext); break; }
    break;
  }
  return steps;
}
function kindTxt(p) { const gr = p.gr || {}; return KINDS[p.kind].name + (gr.mg ? ' multi-gig (100M/1/2.5/5G)' : '') + (gr.poe ? ', PoE+' : '') + (gr.rear ? ', on the back' : ''); }
function portTip(d, pid) {
  const p = portById(d, pid), x = pdata(d, pid), st = portStatus(d, pid), r = rackOf(d.id);
  const row = (k, v) => v ? `<div><span class="k">${k}</span>${esc(v)}</div>` : '';
  const tr = trace(d, pid);
  return `<div class="tt"><b>${esc(d.label)} · port ${esc(p.name)}</b><span class="st" style="background:${STATUS[st].c === STATUS.free.c ? '#8fa3a0' : STATUS[st].c}">${STATUS[st].name}</span></div>`
    + row('Type', kindTxt(p) + (x.speed ? ' · ' + x.speed : '') + (x.poe ? ' · PoE in use' : ''))
    + row('Rack', r.name + ' ' + posTxt(d) + (r.location ? ' · ' + r.location : ''))
    + row('Patched to', x.link ? portRef(x.link.d, x.link.p, rackOf(x.link.d) !== r) : '')
    + row('Outside', x.ext) + row('Description', x.desc) + row('VLAN', x.vlan) + row('Cable', [x.cable, x.colour].filter(Boolean).join(' · ')) + row('Notes', x.notes)
    + (tr.length ? `<div class="path">${esc([d.label + ' ' + p.name, ...tr].join('  →  '))}</div>` : '')
    + (st === 'free' ? '<div class="path">Click to allocate this port.</div>' : '');
}
function devTip(d) {
  const r = rackOf(d.id), ps = portList(d), used = ps.filter(p => portStatus(d, p.id) !== 'free').length;
  const row = (k, v) => v ? `<div><span class="k">${k}</span>${esc(v)}</div>` : '';
  return `<div class="tt"><b>${esc(d.label)}</b></div>` + row('Kit', devName(d)) + row('Model', d.model) + row('Position', r.name + ' ' + posTxt(d) + (inRack(d) ? ' (' + d.h + 'U)' : ''))
    + (isShelf(d) ? row('On the shelf', shelfItems(d).map(x => x.label).join(', ') || 'nothing yet') + row('Shelf space', shelfUsed(d) + '% used') : '')
    + row('IP address', d.ip) + row('Serial no.', d.serial) + (ps.length ? row('Ports', used + ' of ' + ps.length + ' in use') : '') + row('Notes', d.notes)
    + `<div class="path">${shelfOf(d) ? 'Click to edit or move along the shelf' : 'Drag to move · click to edit'}</div>`;
}
function showTip(html, e) {
  const t = $('#tip'); t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = e.clientX + 16, y = e.clientY + 16;
  if (x + w > innerWidth - 8) x = e.clientX - w - 12;
  if (y + h > innerHeight - 8) y = e.clientY - h - 12;
  t.style.left = Math.max(8, x) + 'px'; t.style.top = Math.max(8, y) + 'px';
}
function hideTip() { $('#tip').hidden = true; }
let hovKey = '';
function hoverPort(d, pid) {
  const key = d ? d.id + '|' + pid : '';
  if (key === hovKey) return; hovKey = key;
  $$('#rsvg .port.peer').forEach(n => n.classList.remove('peer'));
  const hov = $('#hov'); if (hov) hov.innerHTML = '';
  if (!d) return;
  const x = pdata(d, pid); if (!x.link) return;
  const peerEl = $(`#rsvg [data-p="${x.link.d}|${CSS.escape(x.link.p)}"]`);
  if (peerEl) peerEl.classList.add('peer');
  const r = curRack(), o = devOf(x.link.d);
  if (hov && o && rackOf(o.id) === r && !leads) {
    const a = portCentre(r, d, pid), b = portCentre(r, o, x.link.p);
    if (a && b) hov.innerHTML = `<path d="${leadPath(a, b)}" fill="none" stroke="#ffd54a" stroke-width="3" stroke-linecap="round"/>`;
  }
}

/* ---------- table ---------- */
function tableRows(includeFree, rackId) {
  const rows = [];
  for (const r of P.racks) {
    if (rackId && r.id !== rackId) continue;
    for (const d of orderedDevs(r)) for (const p of portList(d)) {
      const st = portStatus(d, p.id); if (!includeFree && st === 'free') continue;
      const x = pdata(d, p.id);
      rows.push({ r, d, p, st, x, to: x.link ? portRef(x.link.d, x.link.p, rackOf(x.link.d) !== r) : '' });
    }
  }
  return rows;
}
const TCOLS = ['Rack', 'U', 'Device', 'Model', 'Port', 'Type', 'Status', 'Patched to', 'Outside connection', 'Description', 'VLAN', 'Cable ID', 'Cable colour', 'Speed', 'PoE', 'Notes'];
const rowVals = o => [o.r.name, uOf(o.d), o.d.label, o.d.model || devName(o.d), /^\d+$/.test(o.p.name) ? +o.p.name : o.p.name, KINDS[o.p.kind].name, STATUS[o.st].name, o.to, o.x.ext || '', o.x.desc || '', o.x.vlan || '', o.x.cable || '', o.x.colour || '', o.x.speed || '', o.x.poe ? 'Yes' : '', o.x.notes || ''];
function renderTable() {
  const q = tq.toLowerCase();
  const all = tableRows(tFree, tRack);
  const rows = q ? all.filter(o => rowVals(o).join(' ').toLowerCase().includes(q)) : all;
  const inp = (o, k, cls = '') => `<td class="${cls}"><input data-tp="${o.d.id}|${o.p.id}" data-k="${k}" value="${esc(o.x[k] || '')}"></td>`;
  const bar = `<div class="tbar"><input type="search" id="tq" placeholder="Search ports, VLANs, cables, devices…" value="${esc(tq)}">
    <select id="trk"><option value="">All racks</option>${P.racks.map(r => `<option value="${r.id}" ${tRack === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    <label><input type="checkbox" id="tfree" ${tFree ? 'checked' : ''}> Show free ports</label><span class="cnt">${rows.length} port${rows.length === 1 ? '' : 's'}</span></div>`;
  if (isPhone()) {
    const shown = rows.slice(0, 300);
    const f = (o, k, lbl, cls = '') => `<label class="${cls}"><span>${lbl}</span><input data-tp="${o.d.id}|${o.p.id}" data-k="${k}" value="${esc(o.x[k] || '')}"></label>`;
    $('#table').innerHTML = bar + `<div class="pcards">${shown.map(o => `<div class="pcard"><div class="top"><span class="stdot" style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${STATUS[o.st].c};border:1px solid rgba(0,0,0,.3)"></span><b>${esc(o.d.label)} · ${esc(o.p.name)}</b><small style="color:var(--ink3)">${esc(o.r.name)} U${uOf(o.d)}</small><button class="go" data-goport="${o.d.id}|${o.p.id}">Show</button></div>
      ${o.to ? `<div class="to">Patched to <button class="go" data-goport="${o.x.link.d}|${o.x.link.p}">${esc(o.to)}</button></div>` : ''}
      <div class="flds">${f(o, 'ext', 'Outside connection', 'full')}${f(o, 'desc', 'Description', 'full')}${f(o, 'vlan', 'VLAN')}${f(o, 'cable', 'Cable ID')}</div></div>`).join('')}</div>`
      + (rows.length > shown.length ? `<p class="note" style="margin-top:10px">Showing the first ${shown.length}. Search to narrow it down.</p>` : '')
      + (rows.length ? '' : `<p class="note" style="margin-top:10px">${all.length ? 'No ports match.' : 'No ports allocated yet. Tick Show free ports to fill them in here, or tap a device on the rack.'}</p>`);
    return;
  }
  let last = '';
  const body = rows.map(o => { const nd = o.d.id !== last; last = o.d.id; return `<tr class="${nd ? 'dv' : ''}">
    <td class="${nd ? '' : 'mut'}">${esc(o.r.name)}</td><td class="mono ${nd ? '' : 'mut'}">${uOf(o.d)}</td><td class="${nd ? '' : 'mut'}"><b>${esc(o.d.label)}</b></td>
    <td><button class="go" data-goport="${o.d.id}|${o.p.id}" title="Show on the rack">${esc(o.p.name)}</button></td><td class="mut">${KINDS[o.p.kind].name}</td>
    <td><span class="stdot" style="background:${STATUS[o.st].c}"></span>${STATUS[o.st].name}</td>
    <td>${o.to ? `<button class="go" data-goport="${o.x.link.d}|${o.x.link.p}">${esc(o.to)}</button>` : ''}</td>
    ${inp(o, 'ext', 'w')}${inp(o, 'desc', 'w')}${inp(o, 'vlan', 'n')}${inp(o, 'cable', 'n')}<td class="mut">${esc(o.x.colour || '')}</td>${inp(o, 'notes', 'w')}</tr>`; }).join('');
  $('#table').innerHTML = bar + `
    <table class="pt"><thead><tr><th>Rack</th><th>U</th><th>Device</th><th>Port</th><th>Type</th><th>Status</th><th>Patched to</th><th>Outside connection</th><th>Description</th><th>VLAN</th><th>Cable</th><th>Colour</th><th>Notes</th></tr></thead>
    <tbody>${body || `<tr><td colspan="13" class="mut" style="padding:16px">${all.length ? 'No ports match.' : 'No ports allocated yet. Tick Show free ports to fill them in here, or click a port on the rack.'}</td></tr>`}</tbody></table>`;
}

/* ---------- exports ---------- */
const fileBase = () => (P.name || 'rack-design').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'rack-design';
async function saveBlob(name, blob, types) {
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types });
      const w = await h.createWritable(); await w.write(blob); await w.close(); toast('Saved ' + h.name); return;
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); toast('Downloaded ' + name);
}
function cableRows() {
  const out = [], done = new Set();
  for (const r of P.racks) for (const d of orderedDevs(r)) for (const p of portList(d)) {
    const x = pdata(d, p.id);
    if (x.link && IDX.has(x.link.d)) {
      const key = [d.id + p.id, x.link.d + x.link.p].sort().join('~'); if (done.has(key)) continue; done.add(key);
      const o = devOf(x.link.d), op = portById(o, x.link.p), orr = rackOf(o.id);
      const num = v => /^\d+$/.test(v) ? +v : v;
      out.push([x.cable || '', r.name, d.label, num(p.name), orr.name, o.label, op ? num(op.name) : '?', KINDS[p.kind].name, x.colour || '', x.vlan || pdata(o, x.link.p).vlan || '', x.desc || pdata(o, x.link.p).desc || '']);
    }
  }
  return out.sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
}
const CCOLS = ['Cable ID', 'From rack', 'From device', 'From port', 'To rack', 'To device', 'To port', 'Type', 'Colour', 'VLAN', 'Description'];
function layoutRows() {
  const out = [];
  for (const r of P.racks) for (const d of orderedDevs(r)) {
    const ps = portList(d), used = ps.filter(p => portStatus(d, p.id) !== 'free').length;
    out.push([r.name, r.location || '', posShort(d), inRack(d) && !isV(d) ? d.h : '', d.label, (d.tag || '').replace(/\n/g, ' / '), devName(d), d.model || '', d.ip || '', d.serial || '', ps.length ? `${used} / ${ps.length}` : '', d.notes || '']);
  }
  return out;
}
function posShort(d) { const sh = shelfOf(d); if (isV(d)) return '0U ' + (d.v === 'right' ? 'R' : 'L'); return sh ? (isDrawer(sh) ? `${sh.label} slot ${d.slot}` : `On ${sh.label}`) : uRange(d).replace('–', '-') + (sideOf(d) === 'left' ? ' L' : sideOf(d) === 'right' ? ' R' : ''); }
const LCOLS = ['Rack', 'Location', 'U', 'Height (U)', 'Label', 'Label text', 'Kit', 'Model', 'IP address', 'Serial no.', 'Ports used', 'Notes'];
function powerRows() { // every power inlet and the outlet that feeds it
  const out = [];
  for (const r of P.racks) for (const d of orderedDevs(r)) for (const p of portList(d).filter(q => q.kind === 'inlet')) {
    const x = pdata(d, p.id), o = x.link && devOf(x.link.d), op = o && portById(o, x.link.p);
    out.push([r.name, posShort(d), d.label, d.model || devName(d), p.name, o ? o.label : '', op ? op.name : '', o ? (o.model || devName(o)) : '', x.ext || '', x.cable || '']);
  }
  return out;
}
const PCOLS = ['Rack', 'U', 'Device', 'Model', 'Inlet', 'Fed from', 'Outlet', 'Source kit', 'Outside / notes', 'Cable ID'];

function csvCell(v) { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function exportCSV(free) {
  const rows = tableRows(free).map(rowVals);
  const csv = '﻿' + [TCOLS, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  saveBlob(fileBase() + '-port-allocation.csv', new Blob([csv], { type: 'text/csv' }), [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]);
}

/* minimal XLSX writer (stored zip, inline strings) */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u) { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const te = new TextEncoder(), parts = [], cent = []; let off = 0;
  for (const f of files) {
    const name = te.encode(f.name), data = typeof f.data === 'string' ? te.encode(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    cent.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = cent.reduce((t, x) => t + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cent, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xesc = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colL = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
function xlsx(sheets) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [];
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets>${sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xesc(s.name)}'!$A$1:$${colL(s.cols.length - 1)}$${s.rows.length + 1}</definedName>`).join('')}</definedNames></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${RNS}/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B7A75"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
  sheets.forEach((s, i) => {
    const cell = (v, r, c, st) => {
      const ref = colL(c) + r;
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${st ? ` s="${st}"` : ''}><v>${v}</v></c>`;
      if (v === '' || v == null) return st ? `<c r="${ref}" s="${st}"/>` : '';
      return `<c r="${ref}" t="inlineStr"${st ? ` s="${st}"` : ''}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
    };
    const widths = s.cols.map((h, c) => clamp(Math.max(String(h).length, ...s.rows.slice(0, 500).map(r => String(r[c] ?? '').length)) + 2, 6, 48));
    const data = [`<row r="1">${s.cols.map((h, c) => cell(h, 1, c, 1)).join('')}</row>`, ...s.rows.map((row, r) => `<row r="${r + 2}">${row.map((v, c) => cell(v, r + 2, c)).join('')}</row>`)].join('');
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="${RNS}"><sheetViews><sheetView workbookViewId="0"${i === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${data}</sheetData><autoFilter ref="A1:${colL(s.cols.length - 1)}${s.rows.length + 1}"/></worksheet>` });
  });
  return zipStore(files);
}
function exportXLSX(free) {
  const blob = xlsx([
    { name: 'Port allocation', cols: TCOLS, rows: tableRows(free).map(rowVals) },
    { name: 'Cable schedule', cols: CCOLS, rows: cableRows() },
    { name: 'Rack layout', cols: LCOLS, rows: layoutRows() },
    { name: 'Power', cols: PCOLS, rows: powerRows() },
  ]);
  saveBlob(fileBase() + '-port-allocation.xlsx', blob, [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]);
}
async function exportPNG(all, both) {
  try {
    const x = all ? allRacksDoc() : rackDoc(curRack(), both ? 'both' : face);
    const c = await svgToPng(x.svg, x.W, x.H, 2);
    c.toBlob(b => saveBlob((all ? fileBase() + '-racks' : fileBase() + '-' + curRack().name) + (both ? '-front-and-back' : face === 'rear' && !all ? '-back' : face === 'rear' ? '-back' : '') + '.png', b, [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }]), 'image/png');
  } catch (e) { toast("Couldn't make the picture."); }
}
async function exportRackPDF() {
  const r = curRack(), x = rackDoc(r, 'both'), c = await svgToPng(x.svg, x.W, x.H, 2.2);
  const land = x.W > x.H, M = 10, pw = land ? 420 : 297, ph = land ? 297 : 420, s = Math.min((pw - M * 2) / x.W, (ph - M * 2 - 8) / x.H);
  const doc = new jspdf.jsPDF({ orientation: land ? 'landscape' : 'portrait', unit: 'mm', format: 'a3', compress: true });
  doc.addImage(c.toDataURL('image/png'), 'PNG', (pw - x.W * s) / 2, M, x.W * s, x.H * s);
  doc.setFontSize(8); doc.setTextColor(124, 138, 136); doc.text(pdfTxt([P.name, P.site, new Date().toLocaleDateString('en-GB')].filter(Boolean).join('  ·  ')), M, ph - 6);
  saveBlob(fileBase() + '-' + r.name + '.pdf', doc.output('blob'), [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]);
}
function exportSVG() {
  const x = rackDoc(curRack());
  saveBlob(fileBase() + '-' + curRack().name + '.svg', new Blob([x.svg], { type: 'image/svg+xml' }), [{ description: 'SVG image', accept: { 'image/svg+xml': ['.svg'] } }]);
}
const pdfTxt = s => String(s ?? '').replace(/[→]/g, '>').replace(/[–—]/g, '-').replace(/[•]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
function pdfTable(doc, y, cols, rows, o) {
  const { left, right, bottom, top, header } = o, fs = 7.6, lh = 3.3, pad = 1.4;
  const totalW = right - left, ws = cols.map(c => c.w * totalW);
  const head = () => {
    doc.setFillColor(11, 122, 117); doc.rect(left, y, totalW, 6.2, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(fs); doc.setTextColor(255);
    let x = left; cols.forEach((c, i) => { doc.text(pdfTxt(c.h), x + pad, y + 4.2); x += ws[i]; });
    y += 6.2; doc.setFont('helvetica', 'normal'); doc.setTextColor(23, 35, 34);
  };
  head();
  rows.forEach((row, ri) => {
    const lines = row.map((v, i) => doc.splitTextToSize(pdfTxt(v), ws[i] - pad * 2));
    const h = Math.max(...lines.map(l => l.length)) * lh + 2.2;
    if (y + h > bottom) { doc.addPage(); header(); y = top; head(); }
    if (ri % 2) { doc.setFillColor(242, 246, 245); doc.rect(left, y, totalW, h, 'F'); }
    let x = left; lines.forEach((l, i) => { doc.text(l, x + pad, y + 3.3); x += ws[i]; });
    doc.setDrawColor(219, 226, 225); doc.line(left, y + h, right, y + h);
    y += h;
  });
  return y;
}
async function exportPDF(free) {
  if (!window.jspdf) { toast('PDF library missing.'); return; }
  toast('Making the PDF…');
  const doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3', compress: true });
  const PW = 420, PH = 297, M = 14;
  let page = 0;
  const header = (title) => {
    page++;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(23, 35, 34); doc.text(pdfTxt(title || header.t), M, M + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(76, 91, 89);
    doc.text(pdfTxt([P.name, P.site, P.by ? 'Drawn by ' + P.by : '', new Date().toLocaleDateString('en-GB')].filter(Boolean).join('  ·  ')), M, M + 10);
    doc.setDrawColor(11, 122, 117); doc.setLineWidth(.6); doc.line(M, M + 13, PW - M, M + 13); doc.setLineWidth(.2);
    if (title) header.t = title;
  };
  let first = true;
  for (const r of P.racks) {
    if (!first) doc.addPage(); first = false;
    header(r.name + (r.location ? ' - ' + r.location : '') + ' - rack layout');
    const x = rackDoc(r, 'both'), c = await svgToPng(x.svg, x.W, x.H, 2.2);
    const maxH = PH - M * 2 - 20, maxW = 262;
    const s = Math.min(maxW / x.W, maxH / x.H), w = x.W * s, h = x.H * s;
    doc.addImage(c.toDataURL('image/png'), 'PNG', M, M + 18, w, h);
    const rows = orderedDevs(r).map(d => { const ps = portList(d); return [posShort(d), d.label, d.model || devName(d), d.ip || '', ps.length ? ps.filter(p => portStatus(d, p.id) !== 'free').length + '/' + ps.length : '']; });
    pdfTable(doc, M + 18, [{ h: 'U', w: .1 }, { h: 'Label', w: .2 }, { h: 'Kit / model', w: .38 }, { h: 'IP address', w: .18 }, { h: 'Ports', w: .14 }], rows,
      { left: M + w + 10, right: PW - M, bottom: PH - M, top: M + 18, header: () => header() });
  }
  doc.addPage(); header('Port allocation');
  const tw = [.05, .025, .055, .1, .035, .045, .055, .1, .13, .11, .035, .045, .05, .035, .025, .105];
  pdfTable(doc, M + 18, TCOLS.map((h, i) => ({ h, w: tw[i] })), tableRows(free).map(rowVals), { left: M, right: PW - M, bottom: PH - M, top: M + 18, header: () => header() });
  const pr = powerRows();
  if (pr.length) {
    doc.addPage(); header('Power schedule');
    const pcw = [.07, .07, .1, .17, .07, .1, .07, .15, .14, .06];
    pdfTable(doc, M + 18, PCOLS.map((h, i) => ({ h, w: pcw[i] })), pr, { left: M, right: PW - M, bottom: PH - M, top: M + 18, header: () => header() });
  }
  const cr = cableRows();

  if (cr.length) {
    doc.addPage(); header('Cable schedule');
    const cw = [.07, .07, .1, .06, .07, .1, .06, .07, .07, .05, .29];
    pdfTable(doc, M + 18, CCOLS.map((h, i) => ({ h, w: cw[i] })), cr, { left: M, right: PW - M, bottom: PH - M, top: M + 18, header: () => header() });
  }
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(124, 138, 136); doc.text(`Page ${i} of ${n}`, PW - M, PH - 6, { align: 'right' }); }
  saveBlob(fileBase() + '-rack-design.pdf', doc.output('blob'), [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]);
}

/* ---------- project files ---------- */
function saveFile() {
  saveBlob(fileBase() + '.rack.json', new Blob([JSON.stringify({ app: 'rack-designer', ...P }, null, 1)], { type: 'application/json' }), [{ description: 'Rack design', accept: { 'application/json': ['.json'] } }]);
}
function loadProject(o) {
  if (!o || !Array.isArray(o.racks) || !o.racks.length) throw new Error('not a rack design');
  delete o.app;
  for (const r of o.racks) { r.id = r.id || uid(); r.devices = r.devices || []; r.u = +r.u || 42; for (const d of r.devices) {
    d.ports = d.ports || {}; d.groups = d.groups || []; if (!CAT_BY[d.type]) d.type = 'custom';
    const cg = CAT_BY[d.type].groups;   // designs from before the back view: put ports that are on the back of this kit there
    d.groups.forEach((gr, i) => { const c = cg[i]; if (c && c.rear && gr.rear === undefined && c.kind === gr.kind && (c.prefix || '') === (gr.prefix || '')) gr.rear = true; });
  } }
  return o;
}

/* ---------- example ---------- */
function example() {
  P = { v: 1, name: 'Example site', site: 'Main building', by: '', racks: [] };
  const r = blankRack(1); r.u = 24; r.location = 'Comms room G.12'; P.racks.push(r);
  const add = (type, u, o = {}) => { reindex(); const d = makeDev(type, u); Object.assign(d, o); r.devices.push(d); reindex(); return d; };
  const fpp = add('fpp-12lc', 24); add('cm', 23);
  const pp1 = add('cat6-24', 22); add('cm', 21);
  const sw1 = add('x530-28', 20, { label: 'SW-01', ip: '10.10.0.2' }); add('cm', 19);
  const pp2 = add('cat6-24', 18); add('cm', 17);
  const sw2 = add('x230-28', 16, { label: 'SW-02', ip: '10.10.0.3' }); add('blank', 15);
  const srv = add('ccure', 14, { label: 'SRV-01', ip: '10.10.40.10', model: 'C•CURE 9000 MAS' });
  const nvr = add('avg5-prm', 12, { label: 'NVR-01', ip: '10.10.30.10' });
  const kvm = add('kvm', 11);
  const icx1 = add('icx', 10, { side: 'left', model: 'ICX-500' }), icx2 = add('icx', 10, { side: 'right', model: 'ICX-500' });
  add('blank', 9);
  const acd = add('acm-drawer', 7, { label: 'ACD-01' });
  const acms = [['D01 Reception\nmain door', '10.10.40.21'], ['D02 Office\ncorridor', '10.10.40.22'], ['D03 Comms room', '10.10.40.23'], ['D04 Plant room', '10.10.40.24']].map(([tag, ip], i) => { const d = makeDev('ipacm', acd.u); Object.assign(d, { on: acd.id, slot: i + 1, tag, ip, label: 'ACM-0' + (i + 1) }); r.devices.push(d); reindex(); return d; });
  const sh = add('shelf', 5);
  const onShelf = (type, o) => { const d = makeDev(type, sh.u); Object.assign(d, { on: sh.id, sw: CAT_BY[type].sw, slot: r.devices.filter(x => x.on === sh.id).length + 1 }, o); r.devices.push(d); reindex(); return d; };
  const rtr = onShelf('router', { model: 'Draytek Vigor 2865' }); const psu = onShelf('psu-box', { model: '12V 5A PSU' }); onShelf('minipc', { label: 'PC-01', model: 'Ops workstation' });
  const ups = add('ups3', 3, { label: 'UPS-01', ip: '10.10.10.5', model: 'APC SMT3000RMI2UNC' });
  const pdu = add('pdu', 1);
  const pda = add('vpdu-24', 0, { v: 'left', vi: 1, label: 'PDU-A', h: 0 }), pdb = add('vpdu-16', 0, { v: 'right', vi: 1, label: 'PDU-B', h: 0 });
  reindex();
  const P1 = d => portList(d);
  const cams = ['Car park N', 'Car park S', 'Gate 1', 'Gate 2', 'Reception', 'Loading bay', 'Corridor 1', 'Corridor 2', 'Plant room', 'Roof east'];
  cams.forEach((c, i) => { link(pp1, P1(pp1)[i].id, sw1, P1(sw1)[i].id); setPort(pp1, P1(pp1)[i].id, 'ext', `CAM-${String(i + 1).padStart(2, '0')} ${c}`); setPort(sw1, P1(sw1)[i].id, 'vlan', '30'); setPort(sw1, P1(sw1)[i].id, 'poe', true); setPort(sw1, P1(sw1)[i].id, 'colour', 'blue'); setPort(sw1, P1(sw1)[i].id, 'desc', `CAM-${String(i + 1).padStart(2, '0')}`); });
  ['Gate 1', 'Gate 2', 'Reception', 'Car park'].forEach((c, i) => { link(pp2, P1(pp2)[i].id, sw2, P1(sw2)[i].id); setPort(pp2, P1(pp2)[i].id, 'ext', 'Door station ' + c); setPort(sw2, P1(sw2)[i].id, 'vlan', '50'); setPort(sw2, P1(sw2)[i].id, 'poe', true); setPort(sw2, P1(sw2)[i].id, 'colour', 'purple'); setPort(sw2, P1(sw2)[i].id, 'desc', 'Intercom ' + c); });
  acms.forEach((a, i) => { const sp = [4, 5, 6, 8][i]; link(a, P1(a)[0].id, sw2, P1(sw2)[sp].id); setPort(sw2, P1(sw2)[sp].id, 'vlan', '40'); setPort(sw2, P1(sw2)[sp].id, 'poe', true); setPort(sw2, P1(sw2)[sp].id, 'colour', 'green'); setPort(sw2, P1(sw2)[sp].id, 'desc', a.label + ' IP-ACM'); });
  link(nvr, P1(nvr)[0].id, sw1, P1(sw1)[12].id); setPort(sw1, P1(sw1)[12].id, 'desc', 'NVR-01 NIC1'); setPort(sw1, P1(sw1)[12].id, 'colour', 'yellow');
  link(nvr, P1(nvr)[1].id, sw1, P1(sw1)[13].id); setPort(sw1, P1(sw1)[13].id, 'desc', 'NVR-01 NIC2'); setPort(sw1, P1(sw1)[13].id, 'colour', 'yellow');
  link(srv, P1(srv)[0].id, sw2, P1(sw2)[7].id); setPort(sw2, P1(sw2)[7].id, 'vlan', '40'); setPort(sw2, P1(sw2)[7].id, 'colour', 'yellow'); setPort(sw2, P1(sw2)[7].id, 'desc', 'SRV-01 NIC1');
  link(ups, P1(ups)[0].id, sw2, P1(sw2)[9].id); setPort(sw2, P1(sw2)[9].id, 'vlan', '10'); setPort(sw2, P1(sw2)[9].id, 'colour', 'grey'); setPort(sw2, P1(sw2)[9].id, 'desc', 'UPS-01 NMC');
  link(sw1, P1(sw1)[24].id, fpp, P1(fpp)[0].id); setPort(sw1, P1(sw1)[24].id, 'colour', 'aqua'); setPort(sw1, P1(sw1)[24].id, 'speed', '10G'); setPort(fpp, P1(fpp)[0].id, 'ext', 'Core uplink to MER B12, FPP-04 port 1'); setPort(sw1, P1(sw1)[24].id, 'desc', 'Uplink to core');
  link(sw1, P1(sw1)[25].id, sw2, P1(sw2)[24].id); setPort(sw1, P1(sw1)[25].id, 'colour', 'aqua'); setPort(sw1, P1(sw1)[25].id, 'speed', '1G'); setPort(sw1, P1(sw1)[25].id, 'desc', 'SW-02 uplink');
  setPort(fpp, P1(fpp)[1].id, 'reserved', true); setPort(fpp, P1(fpp)[1].id, 'desc', 'Spare core uplink');
  setPort(pp1, P1(pp1)[10].id, 'reserved', true); setPort(pp1, P1(pp1)[10].id, 'desc', 'CAM-11 (phase 2)');
  setPort(pp1, P1(pp1)[11].id, 'faulty', true); setPort(pp1, P1(pp1)[11].id, 'notes', 'Failed test, re-terminate');
  const inl = (d, n = 0) => P1(d).filter(p => p.kind === 'inlet')[n].id, out = (d, n) => P1(d).filter(p => p.kind === 'pwr')[n].id;
  link(srv, inl(srv, 0), ups, out(ups, 0)); link(nvr, inl(nvr, 0), ups, out(ups, 1)); link(kvm, inl(kvm), ups, out(ups, 2)); link(sw1, inl(sw1), ups, out(ups, 3));
  link(pda, inl(pda), ups, out(ups, 8)); setPort(pda, inl(pda), 'desc', 'Fed from UPS-01 C19');
  link(srv, inl(srv, 1), pdb, out(pdb, 0)); link(nvr, inl(nvr, 1), pdb, out(pdb, 1)); link(sw2, inl(sw2), pda, out(pda, 0)); link(icx1, inl(icx1), pda, out(pda, 1)); link(icx2, inl(icx2), pda, out(pda, 2));
  setPort(pdb, inl(pdb), 'ext', 'Wall socket B, 16A commando'); setPort(ups, inl(ups), 'ext', 'Wall socket A, 16A commando'); setPort(pdu, inl(pdu), 'ext', 'Wall socket C');
  link(icx1, P1(icx1)[0].id, sw2, P1(sw2)[10].id); setPort(sw2, P1(sw2)[10].id, 'vlan', '50'); setPort(sw2, P1(sw2)[10].id, 'desc', 'ICX-01 master');
  link(icx2, P1(icx2)[0].id, sw2, P1(sw2)[11].id); setPort(sw2, P1(sw2)[11].id, 'vlan', '50'); setPort(sw2, P1(sw2)[11].id, 'desc', 'ICX-02 redundant');
  setPort(rtr, P1(rtr)[0].id, 'ext', 'Broadband line, master socket'); link(rtr, P1(rtr)[1].id, sw1, P1(sw1)[15].id); setPort(sw1, P1(sw1)[15].id, 'desc', 'Router LAN'); setPort(sw1, P1(sw1)[15].id, 'vlan', '10');
  setPort(psu, P1(psu)[0].id, 'ext', 'Door release PSU feed');
  link(psu, inl(psu), pda, out(pda, 3)); link(rtr, inl(rtr), pda, out(pda, 4)); const pc = r.devices.find(x => x.label === 'PC-01'); link(pc, inl(pc), pda, out(pda, 5));
  setPort(pdu, P1(pdu)[1].id, 'ext', 'Rack fans');

  sel = { rack: r.id, dev: null, port: null };
  reindex();
}

/* ---------- events ---------- */
function svgPt(e) { const s = $('#rsvg'); const pt = s.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(s.getScreenCTM().inverse()); }
let drag = null, lastPT = 'mouse';
function onStageDown(e) {
  lastPT = e.pointerType || 'mouse';
  if (e.button !== 0 || lastPT === 'touch') return;
  stageAct(e, true);
}
function onStageClick(e) { if (lastPT === 'touch') stageAct(e, false); }
function stageAct(e, canDrag) {
  const pEl = e.target.closest('.port'), dEl = e.target.closest('.dev');
  const aEl = !pick && e.target.closest('[data-acmslot]');
  if (aEl) { const [sid, k] = aEl.dataset.acmslot.split('|'); addToShelf('ipacm', devOf(sid), +k); openDetails(); return; }
  const vEl = !pick && !dEl && e.target.closest('.vslot');
  if (vEl) { toast('Add a vertical PDU from the Power list in Add kit, and it goes here.'); return; }
  if (pEl) {
    const [did, pid] = pEl.dataset.p.split('|'), d = devOf(did);
    if (pick) {
      if (did === pick.d && pid === pick.p) { pick = null; render(); return; }
      const a = devOf(pick.d), x = pdata(d, pid);
      if (x.link && !confirm(`${d.label} port ${portById(d, pid).name} is already patched to ${portRef(x.link.d, x.link.p)}. Patch it here instead?`)) return;
      const kA = portById(a, pick.p).kind, kB = portById(d, pid).kind, fib = k => k === 'lc' || k === 'sc' || k.startsWith('sfp');
      change(() => link(a, pick.p, d, pid));
      if (isPow(kA) !== isPow(kB) ||
 (fib(kA) !== fib(kB) && !(kA.startsWith('sfp') || kB.startsWith('sfp')))) toast('Patched, but check the port types: ' + KINDS[kA].name + ' to ' + KINDS[kB].name + '.');
      else toast('Patched ' + portRef(pick.d, pick.p, false) + ' to ' + portRef(did, pid, false));
      sel = { rack: sel.rack, dev: pick.d, port: pick.p }; pick = null; render(); openDetails(); return;
    }
    sel.dev = did; sel.port = pid; render(); openDetails(); return;
  }
  if (dEl && !canDrag) { sel.dev = dEl.dataset.d; sel.port = null; render(); openDetails(); return; }
  if (dEl && (shelfOf(devOf(dEl.dataset.d)) || isV(devOf(dEl.dataset.d)))) { sel.dev = dEl.dataset.d; sel.port = null; render(); return; }
  if (dEl) {
    const d = devOf(dEl.dataset.d), r = curRack(), pt = svgPt(e);
    drag = { d, el: dEl, start: pt, grab: (d.u + d.h - 1) - uAtY(r, pt.y), moved: false, nu: d.u, side: sideOf(d) };
    dEl.setPointerCapture?.(e.pointerId);
    return;
  }
  if (!pick && (sel.dev || sel.port)) { sel.dev = null; sel.port = null; render(); }
}
function showFace(d, pid) { // turn the rack round when the kit or port is on the other side
  if (!d) return;
  let f = null;
  if (isV(d)) f = 'rear';
  else if (pid) { const p = portById(d, pid); if (p) f = shelfOf(d) && isDrawer(shelfOf(d)) ? 'front' : grFace(p.gr); }
  if (f && f !== face) { face = f; save(); requestAnimationFrame(() => { fitZoom(); renderRack(); }); }
}
function onStageCancel() {
 if (drag) { drag = null; renderRack(); } }
function onStageMove(e) {
  if (drag) {
    const r = curRack(), pt = svgPt(e);
    if (!drag.moved && Math.abs(pt.y - drag.start.y) < 5 && Math.abs(pt.x - drag.start.x) < 12) return;
    drag.moved = true; drag.el.classList.add('drag'); hideTip();
    const top = clamp(uAtY(r, pt.y) + drag.grab, drag.d.h, r.u);
    drag.nu = top - drag.d.h + 1;
    if (drag.side !== 'full') drag.side = sideAt(pt.x);
    const ok = placeOK(r, drag.nu, drag.d.h, drag.d.id, drag.side);
    drag.el.setAttribute('transform', `translate(${RX() + ((drag.side === 'right') !== (face === 'rear') && drag.side !== 'full' ? FW / 2 : 0)},${PADT + (r.u - top) * UH + 1})`);
    drag.el.classList.toggle('bad', !ok);
    return;
  }
  const pEl = e.target.closest?.('.port'), dEl = e.target.closest?.('.dev');
  if (pEl) { const [did, pid] = pEl.dataset.p.split('|'), d = devOf(did); if (d) { hoverPort(d, pid); showTip(portTip(d, pid), e); return; } }
  hoverPort(null);
  if (dEl) { const d = devOf(dEl.dataset.d); if (d) { showTip(devTip(d), e); return; } }
  hideTip();
}
function onStageUp() {
  if (!drag) return;
  const { d, moved, nu, side } = drag; drag = null;
  const r = curRack();
  if (!moved) { sel.dev = d.id; sel.port = null; render(); return; }
  const same = nu === d.u && side === sideOf(d);
  if (!same && placeOK(r, nu, d.h, d.id, side)) { change(() => { d.u = nu; if (side !== 'full') d.side = side; }); sel.dev = d.id; sel.port = null; render(); }
  else { if (!same) toast('Something is already in those U.'); render(); }
}
const sideAt = x => ((x < RX() + FW / 2) !== (face === 'rear')) ? 'left' : 'right';   // which half of the rack is under the pointer
function addKit(type, u, side) {
  const r = curRack(), c = CAT_BY[type];
  if (c.vert) { // 0U PDU: on the side with fewer, at the back
    const vs = vItems(r, 'left').length <= vItems(r, 'right').length ? 'left' : 'right';
    if (vItems(r, vs).length >= 2) { toast(`Both sides of ${r.name} already have two 0U PDUs.`); return; }
    let d; change(() => { d = makeDev(type, 0); d.u = 0; d.h = 0; d.v = side === 'left' || side === 'right' ? side : vs; d.vi = Math.max(0, ...vItems(r, d.v).map(x => x.vi || 0)) + 1; r.devices.push(d); });
    sel.dev = d.id; sel.port = null;
    if (face !== 'rear') { face = 'rear'; toast('0U PDUs hang at the back, so this is the Back view now.'); }
    render(); fitZoom(); renderRack(); return;
  }
  if ((c.cat === 'onshelf' || c.acm) && u == null) { // shelf kit goes on the selected shelf, or the first with room, or a new shelf; IP-ACMs the same with drawers
    const cur = sel.dev && devOf(sel.dev), want = cur && (isShelf(cur) ? cur : shelfOf(cur));
    const fits = sh => sh && rackOf(sh.id) === r && accepts(sh, type) && (isDrawer(sh) ? freeSlot(sh) > 0 : shelfUsed(sh) + (c.sw || 25) <= 100);
    let sh = fits(want) ? want : r.devices.find(x => isShelf(x) && inRack(x) && fits(x));
    if (!sh) {
      const spot = c.acm ? lowestFree(r, 2) : lowestFree(r, 2) || lowestFree(r, 1);
      if (!spot) { toast(`No room for a ${c.acm ? '2U drawer' : 'shelf'} in ${r.name}.`); return; }
      change(() => { sh = makeDev(c.acm ? 'acm-drawer' : lowestFree(r, 2) ? 'shelf' : 'shelf1', spot); r.devices.push(sh); });
      reindex(); toast(`Added ${holderWord(sh)} ${sh.label} for it.`);
      const n = undoS.length; addToShelf(type, sh); if (undoS.length > n) undoS.pop(); // the shelf and the kit on it are one undo step
      return;
    }
    return addToShelf(type, sh);
  }
  let spot;
  if (u == null) spot = freeSpot(r, c.h, c.half);
  else { const lu = u - c.h + 1, sides = side ? [side] : c.half ? ['left', 'right'] : ['full']; const sd = sides.find(x => placeOK(r, lu, c.h, null, x)); if (sd) spot = { u: lu, side: sd }; }
  if (!spot) { toast(u != null ? 'Not enough room there.' : `No ${c.h}U space left in ${r.name}.`); return; }
  let d;
  change(() => { d = makeDev(type, spot.u, spot.side); r.devices.push(d); });
  sel.dev = d.id; sel.port = null; render();
}
function addToShelf(type, sh, slot) {
  const r = rackOf(sh.id), c = CAT_BY[type], w = c.sw || (c.cat === 'onshelf' ? 25 : 100);
  if (!accepts(sh, type)) { toast(isDrawer(sh) ? `Only IP-ACM boards go in ${sh.label}.` : `IP-ACMs go in an IP-ACM drawer, not on a shelf.`); render(); return; }
  if (isDrawer(sh)) {
    const k = slot && !shelfItems(sh).some(x => x.slot === slot) ? slot : freeSlot(sh);
    if (!k) { toast(`${sh.label} is full: it holds ${CAT_BY[sh.type].slots} IP-ACMs.`); render(); return; }
    let d; change(() => { d = makeDev(type, sh.u); d.on = sh.id; d.slot = k; d.tag = ''; r.devices.push(d); });
    sel.dev = d.id; sel.port = null; if (face !== 'front') { face = 'front'; } render(); return;
  }
  if (shelfUsed(sh) + w > 100) { toast(`Not enough room on ${sh.label}: ${100 - shelfUsed(sh)}% of its width is free.`); render(); return; }
  let d;
  change(() => { d = makeDev(type, sh.u); d.on = sh.id; d.sw = w; d.slot = shelfItems(sh).reduce((m, x) => Math.max(m, x.slot || 0), 0) + 1; r.devices.push(d); });
  sel.dev = d.id; sel.port = null; render();
}
function shelfAt(r, u) { return r.devices.find(x => isShelf(x) && inRack(x) && u >= x.u && u <= x.u + x.h - 1); }
function slideOnShelf(d, dir) {
  const sh = shelfOf(d);
  if (isDrawer(sh)) { const k = d.slot + dir; if (k < 1 || k > CAT_BY[sh.type].slots) return; const o = shelfItems(sh).find(x => x.slot === k); change(() => { if (o) o.slot = d.slot; d.slot = k; }); return; }
  const items = shelfItems(sh), i = items.indexOf(d), j = i + dir;
  if (j < 0 || j >= items.length) return;
  change(() => { [items[i], items[j]] = [items[j], items[i]]; items.forEach((x, k) => { x.slot = k + 1; }); });
}
function moveDev(d, du) {
  if (shelfOf(d)) return slideOnShelf(d, du > 0 ? 1 : -1);
  if (isV(d)) { const list = vItems(rackOf(d.id), d.v || 'left'), i = list.indexOf(d), j = i + (du > 0 ? -1 : 1); if (j < 0 || j >= list.length) { toast(du > 0 ? 'Already at the top.' : 'Already at the bottom.'); return; } change(() => { [list[i], list[j]] = [list[j], list[i]]; list.forEach((x, k) => { x.vi = k + 1; }); }); return; }

  const r = rackOf(d.id); if (placeOK(r, d.u + du, d.h, d.id, sideOf(d))) change(() => { d.u += du; }); else toast(du > 0 ? 'No room above.' : 'No room below.');
}

function onPanelChange(e) {
  const t = e.target, k = t.dataset.k, scope = t.closest('[data-scope]')?.dataset.scope;
  if (t.id === 'ln-dev') { const o = devOf(t.value), cur = devOf(sel.dev); $('#ln-port').innerHTML = o ? portList(o).map(p => { const x = pdata(o, p.id); return `<option value="${p.id}">${esc(p.name)}${x.link ? ' (patched)' : portStatus(o, p.id) !== 'free' ? ' (in use)' : ''}</option>`; }).join('') : ''; const first = o && portList(o).find(p => !pdata(o, p.id).link); if (first) $('#ln-port').value = first.id; return; }
  if (t.id === 'bk-dev') { fillBulkTo(); return; }
  if (t.dataset.pw) { // power inlet -> outlet
    const d = devOf(sel.dev), pid = t.dataset.pw;
    if (!t.value) { change(() => unlink(d, pid)); return; }
    const [oid, op] = t.value.split('|'), o = devOf(oid), y = pdata(o, op);
    if (y.link && !(y.link.d === d.id && y.link.p === pid) && !confirm(`${o.label} ${portById(o, op).name} already feeds ${portRef(y.link.d, y.link.p, false)}. Plug ${d.label} in there instead?`)) { renderPanel(); return; }
    change(() => link(d, pid, o, op)); toast(`${d.label} ${portById(d, pid).name} now fed from ${o.label} ${portById(o, op).name}.`); return;
  }
  if (t.dataset.ak) { // drawer label table
    const it = devOf(t.closest('[data-acm]').dataset.acm), k2 = t.dataset.ak, v2 = t.value.trim();
    change(() => { it[k2] = k2 === 'tag' ? v2.split(/\s*\/\s*/).join('\n') : v2; }, { panel: false }); return;
  }
  if (t.closest('.grp')) {
    const d = devOf(sel.dev), gid = t.closest('.grp').dataset.grp, gk = t.dataset.gk;
    const gr = d.groups.find(x => x.id === gid); let v = t.value;
    if (gk === 'count') v = clamp(parseInt(v, 10) || 1, 1, 96); if (gk === 'start') v = clamp(parseInt(v, 10) || 0, 0, 999);
    if (gk === 'count' || gk === 'start') {
      const keep = new Set(), test = { ...gr, [gk]: v };
      for (let i = 0; i < test.count; i++) keep.add(gr.id + '-' + (test.start + i));
      const lost = Object.keys(d.ports).filter(k => k.startsWith(gr.id + '-') && !keep.has(k));
      if (lost.length && !confirm(`${lost.length} allocated port${lost.length > 1 ? 's' : ''} would be cleared. Carry on?`)) { t.value = gr[gk]; return; }
    }
    change(() => { gr[gk] = v; prune(d); });
    return;
  }
  if (!k || !scope) return;
  const v = t.type === 'checkbox' ? t.checked : t.value.trim();
  if (scope === 'proj') { change(() => { P[k] = v; }, { panel: false }); return; }
  if (scope === 'rack') {
    const r = curRack();
    change(() => { r[k] = k === 'u' ? +v : v; }, { panel: k === 'u' });
    if (k === 'name') renderTabs();
    return;
  }
  if (scope === 'dev') {
    const d = devOf(sel.dev), r = rackOf(d.id);
    if (k === 'u' || k === 'h') {
      const nu = k === 'u' ? parseInt(v, 10) : d.u, nh = k === 'h' ? parseInt(v, 10) : d.h;
      if (!(nu >= 1) || !(nh >= 1) || !placeOK(r, nu, nh, d.id, sideOf(d))) { toast(nu + nh - 1 > r.u ? "That runs past the top of the rack." : 'Something is already in those U.'); t.value = d[k]; return; }
      change(() => { d.u = nu; d.h = nh; }); return;
    }
    if (k === 'rack' && isV(d)) {
      const nr = P.racks.find(x => x.id === v), side = vItems(nr, 'left').length <= vItems(nr, 'right').length ? 'left' : 'right';
      if (vItems(nr, side).length >= 2) { toast(`No room for another 0U PDU in ${nr.name}.`); t.value = r.id; return; }
      change(() => { r.devices = r.devices.filter(x => x !== d); d.v = side; d.vi = 99; nr.devices.push(d); }); sel.rack = nr.id; render(); return;
    }
    if (k === 'rack') {
      const nr = P.racks.find(x => x.id === v), side = sideOf(d);
      const sp = placeOK(nr, d.u, d.h, null, side) ? { u: d.u, side } : freeSpot(nr, d.h, side !== 'full');
      if (!sp) { toast(`No ${d.h}U space in ${nr.name}.`); t.value = r.id; return; }
      const moving = [d, ...(isShelf(d) ? shelfItems(d) : [])];
      change(() => { r.devices = r.devices.filter(x => !moving.includes(x)); d.u = sp.u; if (sp.side !== 'full') d.side = sp.side; else delete d.side; nr.devices.push(...moving); }); sel.rack = nr.id; render(); return;
    }
    if (k === 'ftype') { if (!swapType(d, v)) t.value = d.type; return; }
    if (k === 'psu') {
      const n = clamp(parseInt(v, 10) || 0, 0, 4), lost = portList(d).filter(p => p.kind === 'inlet' && p.n > n && d.ports[p.id]);
      if (lost.length && !confirm(`${lost.map(p => p.name).join(', ')} ${lost.length > 1 ? 'are' : 'is'} plugged in or allocated and would be cleared. Carry on?`)) { t.value = psuOf(d); return; }
      change(() => { d.psu = n; prune(d); }); return;
    }
    if (k === 'vside') {
      if (vItems(r, v).filter(x => x !== d).length >= 2) { toast('Two PDUs are already on that side.'); t.value = d.v || 'left'; return; }
      change(() => { d.v = v; d.vi = Math.max(0, ...vItems(r, v).map(x => x.vi || 0)) + 1; }); return;
    }
    if (k === 'slot') {
      const sh = shelfOf(d), n = parseInt(v, 10), o = shelfItems(sh).find(x => x.slot === n && x !== d);
      change(() => { if (o) o.slot = d.slot; d.slot = n; }); return;
    }
    if (k === 'side') {
      if (!placeOK(r, d.u, d.h, d.id, v)) { toast(v === 'full' ? 'The other half of those U is in use.' : 'That half is in use.'); t.value = sideOf(d); return; }
      change(() => { if (v === 'full') delete d.side; else d.side = v; }); return;
    }
    if (k === 'pos') {
      if (!v) {
        const sp = freeSpot(r, d.h, false, d.id) || freeSpot(r, d.h, true, d.id);
        if (!sp) { toast(`No ${d.h}U space in ${r.name} to take it off the shelf.`); t.value = d.on; return; }
        change(() => { delete d.on; delete d.slot; d.u = sp.u; if (sp.side !== 'full') d.side = sp.side; else delete d.side; }); return;
      }
      const sh = devOf(v), w = d.sw ? swOf(d) : (CAT_BY[d.type].sw || (CAT_BY[d.type].cat === 'onshelf' ? 25 : 100));
      if (isDrawer(sh)) { const k2 = freeSlot(sh); if (!k2) { toast(`${sh.label} is full.`); t.value = d.on || ''; return; } change(() => { d.on = sh.id; d.slot = k2; }); return; }
      if (shelfUsed(sh, d.id) + w > 100) { toast(`Not enough room on ${sh.label}: ${100 - shelfUsed(sh, d.id)}% free.`); t.value = d.on || ''; return; }
      change(() => { d.on = sh.id; d.sw = w; delete d.side; d.slot = shelfItems(sh).filter(x => x !== d).reduce((m, x) => Math.max(m, x.slot || 0), 0) + 1; }); return;
    }
    if (k === 'sw') {
      const sh = shelfOf(d), w = clamp(parseInt(v, 10) || 0, 5, 100);
      if (shelfUsed(sh, d.id) + w > 100) { toast(`Only ${100 - shelfUsed(sh, d.id)}% of ${sh.label} is free.`); t.value = swOf(d); return; }
      change(() => { d.sw = w; }); return;
    }
    change(() => { d[k] = v; }, { panel: false });
    if (k === 'label') { const h = $('.ptitle h2'); if (h) h.textContent = v; }
    return;
  }
  if (scope === 'port') {
    const d = devOf(sel.dev);
    change(() => setPort(d, sel.port, k, v), { panel: t.type === 'checkbox' || k === 'colour' });
  }
}
function onPanelClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.seldev) { sel.dev = b.dataset.seldev; sel.port = null; showFace(devOf(sel.dev)); render(); return; }
  if (b.dataset.selport) { sel.port = b.dataset.selport; showFace(devOf(sel.dev), sel.port); render(); return; }
  const act = b.dataset.act, d = sel.dev && devOf(sel.dev), r = curRack();
  switch (act) {
    case 'duprack': change(() => { const n = JSON.parse(JSON.stringify(r)); n.id = uid(); n.name = r.name + ' copy'; const map = {}; for (const x of n.devices) { map[x.id] = uid(); } for (const x of n.devices) { x.id = map[x.id]; if (x.on) x.on = map[x.on]; for (const k in x.ports) { const l = x.ports[k].link; if (l) { if (map[l.d]) l.d = map[l.d]; else delete x.ports[k].link; } } } P.racks.push(n); sel.rack = n.id; }); break;
    case 'delrack': if (P.racks.length > 1 && confirm(`Delete ${r.name} and everything in it?`)) change(() => { reindex(); for (const x of [...r.devices]) removeDev(x.id); P.racks = P.racks.filter(x => x !== r); sel.rack = P.racks[0].id; sel.dev = sel.port = null; }); break;
    case 'drawopen': change(() => { d.open = !d.open; }); break;
    case 'addacm': addToShelf('ipacm', d, +b.dataset.slot); break;
    case 'dup': if (isV(d)) { const rr = rackOf(d.id), side = vItems(rr, 'left').length <= vItems(rr, 'right').length ? 'left' : 'right'; if (vItems(rr, side).length >= 2) { toast('No room for another 0U PDU.'); break; } let n; change(() => { n = JSON.parse(JSON.stringify(d)); n.id = uid(); n.v = side; n.vi = 99; n.label = nextLabel(CAT_BY[d.type].pre); for (const k in n.ports) delete n.ports[k].link; rr.devices.push(n); }); sel.dev = n.id; render(); break; }
    if (shelfOf(d) && isDrawer(shelfOf(d))) { const sh = shelfOf(d), k = freeSlot(sh); if (!k) { toast(`${sh.label} is full.`); break; } let n; change(() => { n = JSON.parse(JSON.stringify(d)); n.id = uid(); n.slot = k; n.label = nextLabel(CAT_BY[d.type].pre); n.tag = ''; for (const kk in n.ports) delete n.ports[kk].link; rackOf(d.id).devices.push(n); }); sel.dev = n.id; render(); break; }
    if (shelfOf(d)) { const sh = shelfOf(d); if (shelfUsed(sh) + swOf(d) > 100) { toast(`Not enough room on ${sh.label}.`); break; } let n; change(() => { n = JSON.parse(JSON.stringify(d)); n.id = uid(); n.label = nextLabel(CAT_BY[d.type].pre); n.slot = (d.slot || 0) + .5; for (const k in n.ports) delete n.ports[k].link; rackOf(d.id).devices.push(n); shelfItems(sh).forEach((x, k) => { x.slot = k + 1; }); }); reindex(); shelfItems(sh).forEach((x, k) => { x.slot = k + 1; }); sel.dev = n.id; render(); break; }
    { const c = CAT_BY[d.type]; const rr = rackOf(d.id); if (sideOf(d) !== 'full') { const sp = freeSpot(rr, d.h, true); if (!sp) { toast(`No ${d.h}U space left.`); break; } let n; change(() => { n = JSON.parse(JSON.stringify(d)); n.id = uid(); n.u = sp.u; n.side = sp.side; n.label = nextLabel(c.pre); for (const k in n.ports) delete n.ports[k].link; rr.devices.push(n); }); sel.dev = n.id; render(); break; } const above = placeOK(rr, d.u + d.h, d.h) ? d.u + d.h : lowestFree(rr, d.h); if (!above) { toast(`No ${d.h}U space left.`); break; } let n; change(() => { n = JSON.parse(JSON.stringify(d)); n.id = uid(); n.u = above; n.label = nextLabel(c.pre); for (const k in n.ports) delete n.ports[k].link; rr.devices.push(n); }); sel.dev = n.id; render(); break; }
    case 'stdports': swapType(d, d.type); break;
    case 'up': moveDev(d, 1); break;
    case 'sl': slideOnShelf(d, -1); break;
    case 'sr': slideOnShelf(d, 1); break;
    case 'down': moveDev(d, -1); break;
    case 'del': { const n = isShelf(d) ? shelfItems(d).length : 0; change(() => { removeDev(d.id); sel.dev = sel.port = null; }); toast(n ? `Deleted the shelf and the ${n} item${n > 1 ? 's' : ''} on it. Ctrl+Z brings them back.` : 'Deleted. Ctrl+Z brings it back.'); break; }
    case 'addgrp': change(() => { const used = portList(d).reduce((m, p) => Math.max(m, p.n), 0); d.groups.push(g('rj45', 4, { id: uid().slice(0, 4), order: 'row', start: used + 1 })); }); break;
    case 'delgrp': { const gid = b.closest('.grp').dataset.grp; if (Object.keys(d.ports).some(k => k.startsWith(gid + '-')) && !confirm('Remove these ports and their allocations?')) break; change(() => { d.groups = d.groups.filter(x => x.id !== gid); prune(d); }); break; }
    case 'clearports': if (confirm(`Clear every port allocation on ${d.label}?`)) change(() => { for (const k of Object.keys(d.ports)) unlink(d, k); d.ports = {}; }); break;
    case 'bulk': {
      const ps = portList(d), from = ps.findIndex(p => p.id === $('#bk-from').value), n = parseInt($('#bk-n').value, 10) || 0;
      const o = devOf($('#bk-dev').value), ops = portList(o), to = ops.findIndex(p => p.id === $('#bk-to').value), vlan = $('#bk-vlan').value.trim();
      const cnt = Math.min(n, ps.length - from, ops.length - to);
      if (cnt < 1) { toast('Nothing to patch.'); break; }
      const busy = []; for (let i = 0; i < cnt; i++) { const a = pdata(d, ps[from + i].id).link, bb = pdata(o, ops[to + i].id).link; if ((a && !(a.d === o.id && a.p === ops[to + i].id)) || (bb && !(bb.d === d.id && bb.p === ps[from + i].id))) busy.push(ps[from + i].name); }
      if (busy.length && !confirm(`${busy.length} of these ports are already patched elsewhere. Re-patch them?`)) break;
      change(() => { for (let i = 0; i < cnt; i++) { link(d, ps[from + i].id, o, ops[to + i].id); if (vlan) { setPort(d, ps[from + i].id, 'vlan', vlan); setPort(o, ops[to + i].id, 'vlan', vlan); } } });
      toast(`Patched ${cnt} port${cnt > 1 ? 's' : ''}: ${d.label} ${ps[from].name}–${ps[from + cnt - 1].name} to ${o.label} ${ops[to].name}–${ops[to + cnt - 1].name}.`);
      break;
    }
    case 'back': sel.port = null; render(); break;
    case 'prevport': case 'nextport': { const ps = portList(d), i = ps.findIndex(p => p.id === sel.port) + (act === 'nextport' ? 1 : -1); if (ps[i]) { sel.port = ps[i].id; render(); } break; }
    case 'gopeer': { const x = pdata(d, sel.port).link; sel.rack = rackOf(x.d).id; sel.dev = x.d; sel.port = x.p; showFace(devOf(x.d), x.p); render(); break; }
    case 'unlink': change(() => unlink(d, sel.port)); break;
    case 'link': {
      const o = devOf($('#ln-dev').value), op = $('#ln-port').value; if (!o || !op) { toast('Choose a device and port.'); break; }
      const x = pdata(o, op); if (x.link && !confirm(`${o.label} port ${portById(o, op).name} is already patched to ${portRef(x.link.d, x.link.p)}. Patch it here instead?`)) break;
      change(() => link(d, sel.port, o, op)); break;
    }
    case 'pick': pick = { d: d.id, p: sel.port }; if (isPhone()) pane = 'rack'; render(); toast(isPhone() ? 'Tap the other port on the rack. Zoom in with + if the ports are small.' : 'Click a port on the rack. Esc to cancel.'); break;
    case 'clearport': change(() => { unlink(d, sel.port); delete d.ports[sel.port]; }); break;
  }
}

function init() {
  const saved = lsGet(STORE);
  try { if (saved) { const s = JSON.parse(saved); P = loadProject(s.P); sel = s.sel || sel; colourBy = s.colourBy || 'status'; leads = s.leads !== false; face = s.face === 'rear' ? 'rear' : 'front'; } } catch (e) { P = null; }
  if (!P) example();
  fixSel();
  renderLib(); render(); fitZoom(); renderRack(); save();

  $('#lib-q').addEventListener('input', renderLib);
  $('#lib-list').addEventListener('click', e => { const b = e.target.closest('[data-kit]'); if (b) { view = 'rack'; if (pane === 'kit') pane = 'rack'; addKit(b.dataset.kit); openDetails(); } });
  $('#lib-x').onclick = () => setPane('rack');
  $('#scrim').onclick = () => setPane(view === 'table' ? 'table' : 'rack');
  $('#sheet-x').onclick = () => { pane = view === 'table' ? 'table' : 'rack'; syncPanes(); };
  $('#nav').addEventListener('click', e => { const b = e.target.closest('[data-pane]'); if (!b) return; const p = b.dataset.pane; if (p === pane && p === 'kit') setPane('rack'); else { setPane(p); if (p === 'rack') { fitZoom(); renderRack(); } } });
  $('#lib-list').addEventListener('dragstart', () => { if (pane === 'kit') setTimeout(() => { pane = view; syncPanes(); }, 0); }); // get the drawer out of the way of the drop
  $('#lib-list').addEventListener('dragstart', e => { const b = e.target.closest('[data-kit]'); if (b) { e.dataTransfer.setData('text/plain', 'kit:' + b.dataset.kit); e.dataTransfer.effectAllowed = 'copy'; } });
  const st = $('#stage');
  st.addEventListener('dragover', e => {
    if (!$('#rsvg')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const r = curRack(), pt = svgPt(e), u = clamp(uAtY(r, pt.y), 1, r.u);
    $('#ghost').innerHTML = `<rect x="${RX()}" y="${PADT + (r.u - u) * UH}" width="${FW}" height="${UH}" fill="#2fb3aa" opacity=".3" stroke="#2fb3aa" stroke-width="2"/>`;
  });
  st.addEventListener('dragleave', () => { const gh = $('#ghost'); if (gh) gh.innerHTML = ''; });
  st.addEventListener('drop', e => {
    const v = e.dataTransfer.getData('text/plain'); if (!v.startsWith('kit:')) return; e.preventDefault();
    const r = curRack(), pt = svgPt(e), u = clamp(uAtY(r, pt.y), 1, r.u), c = CAT_BY[v.slice(4)];
    if (c.vert) { addKit(c.id, null, face === 'rear' ? (pt.x < rackW() / 2 ? 'left' : 'right') : null); return; }
    const sh = shelfAt(r, u);
    if (sh && accepts(sh, c.id) && (c.cat === 'onshelf' || c.acm || !placeOK(r, u - c.h + 1, c.h))) { addToShelf(c.id, sh, isDrawer(sh) ? clamp(Math.floor((pt.x - devBox(r, sh).x - DLW()) / ((devBox(r, sh).w - DLW() - 10) / CAT_BY[sh.type].slots)) + 1, 1, CAT_BY[sh.type].slots) : null); return; }   // onto a shelf or into a drawer
    if (c.cat === 'onshelf' || c.acm) { addKit(c.id); return; }
    const side = c.half ? sideAt(pt.x) : null;
    // drop puts the kit's top at the U under the pointer; if that doesn't fit, try with its bottom there
    const ok = uu => (c.half ? [side, side === 'left' ? 'right' : 'left'] : ['full']).some(sd => placeOK(r, uu - c.h + 1, c.h, null, sd));
    if (ok(u)) addKit(c.id, u, c.half && placeOK(r, u - c.h + 1, c.h, null, side) ? side : null); else if (ok(u + c.h - 1)) addKit(c.id, u + c.h - 1); else { toast('Not enough room there.'); renderRack(); }
  });
  st.addEventListener('pointerdown', onStageDown);
  st.addEventListener('pointermove', onStageMove);
  st.addEventListener('pointerup', onStageUp);
  st.addEventListener('pointercancel', onStageCancel);
  st.addEventListener('click', onStageClick);
  st.addEventListener('pointerleave', () => { if (!drag) { hideTip(); hoverPort(null); } });
  st.addEventListener('scroll', hideTip);

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rack) { sel = { rack: b.dataset.rack, dev: null, port: null }; view = 'rack'; render(); fitZoom(); renderRack(); }
    else if (b.dataset.view) { view = b.dataset.view; pane = view; hideTip(); render(); }
    else if (b.dataset.act === 'addrack') { change(() => { const r = blankRack(P.racks.length + 1); while (P.racks.some(x => x.name === r.name)) r.name += '+'; P.racks.push(r); sel = { rack: r.id, dev: null, port: null }; view = 'rack'; }); fitZoom(); renderRack(); }
  });
  $('#tools').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.face) { face = b.dataset.face; hideTip(); save(); render(); fitZoom(); renderRack(); }
    else if (b.dataset.cb) { colourBy = b.dataset.cb; save(); render({ panel: true }); }
    else if (b.dataset.z) { const z = b.dataset.z; if (z === 'fit') fitZoom('width'); else if (z === 'all') fitZoom('all'); else zoom = clamp(zoom * (z === '+' ? 1.2 : 1 / 1.2), .25, 3); renderRack(); }
    else if (b.dataset.act === 'cancelpick') { pick = null; render(); }
    else if (b.dataset.act === 'kit') setPane('kit');
  });
  $('#tools').addEventListener('change', e => { if (e.target.id === 't-leads') { leads = e.target.checked; save(); renderRack(); } });
  const pn = $('#panel');
  pn.addEventListener('change', onPanelChange);
  pn.addEventListener('click', onPanelClick);
  pn.addEventListener('focusin', e => { if (e.target.id === 'bk-dev' || e.target.id === 'bk-to') { if (!$('#bk-to').options.length) fillBulkTo(); } });
  new MutationObserver(() => { if ($('#bk-to') && !$('#bk-to').options.length) fillBulkTo(); }).observe(pn, { childList: true });
  const tb = $('#table');
  tb.addEventListener('input', e => { if (e.target.id === 'tq') { tq = e.target.value; const pos = e.target.selectionStart; renderTable(); const q = $('#tq'); q.focus(); q.setSelectionRange(pos, pos); } });
  tb.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'tfree') { tFree = t.checked; renderTable(); return; }
    if (t.id === 'trk') { tRack = t.value; renderTable(); return; }
    if (t.dataset.tp) { const [did, pid] = t.dataset.tp.split('|'), d = devOf(did); snap(); setPort(d, pid, t.dataset.k, t.value.trim()); reindex(); save(); $('#b-undo').disabled = false; renderPanel(); }
  });
  tb.addEventListener('click', e => { const b = e.target.closest('[data-goport]'); if (b) { const [did, pid] = b.dataset.goport.split('|'); sel = { rack: rackOf(did).id, dev: did, port: pid }; view = 'rack'; pane = 'rack'; showFace(devOf(did), pid); render(); openDetails(); } });

  $('#b-undo').onclick = undo; $('#b-redo').onclick = redo;
  $('#b-new').onclick = () => {
    const c = prompt('Start a new project? Type 1 for an empty 42U rack, or 2 for the example rack.', '1');
    if (c === null) return;
    snap(); if (c.trim() === '2') example(); else { P = newProject(); sel = { rack: P.racks[0].id, dev: null, port: null }; }
    reindex(); save(); render(); fitZoom(); renderRack();
  };
  $('#b-save').onclick = saveFile;
  $('#b-open').onclick = () => $('#f-open').click();
  $('#f-open').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const o = loadProject(JSON.parse(await f.text())); snap(); P = o; sel = { rack: P.racks[0].id, dev: null, port: null }; reindex(); save(); render(); fitZoom(); renderRack(); toast('Opened ' + f.name); }
    catch (err) { toast("That file isn't a rack design."); }
  };
  const more = $('#m-more');
  $('#b-more').onclick = e => { e.stopPropagation(); $('#m-export').hidden = true; more.hidden = !more.hidden; };
  more.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; more.hidden = true; ({ new: () => $('#b-new').click(), open: () => $('#b-open').click(), save: saveFile, theme: () => $('#b-theme').click() })[b.dataset.m](); });
  const menu = $('#m-export');
  $('#b-export').onclick = e => { e.stopPropagation(); more.hidden = true; menu.hidden = !menu.hidden; };
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) { menu.hidden = true; more.hidden = true; } });
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-x]'); if (!b) return; menu.hidden = true;
    const free = $('#x-free').checked;
    ({ xlsx: () => exportXLSX(free), csv: () => exportCSV(free), pdf: () => exportPDF(free), png: () => exportPNG(false), pngboth: () => exportPNG(false, true), svg: exportSVG, pdfrack: exportRackPDF, pngall: () => exportPNG(true) })[b.dataset.x]();
  });
  $('#b-theme').onclick = () => {
    const root = document.documentElement, dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark'; lsSet(STORE + '-theme', root.dataset.theme);
  };
  const th = lsGet(STORE + '-theme'); if (th) document.documentElement.dataset.theme = th;

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }
    if (e.key === 'Escape' && pane === 'kit') { setPane(view); return; }
    if (e.key === 'Escape') { if (pick) { pick = null; render(); } else if (!typing && (sel.dev || sel.port)) { if (sel.port) sel.port = null; else sel.dev = null; render(); } return; }
    if (typing || view !== 'rack') return;
    const d = sel.dev && devOf(sel.dev); if (!d) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !sel.port) { e.preventDefault(); change(() => { removeDev(d.id); sel.dev = null; }); toast('Deleted. Ctrl+Z brings it back.'); }
    else if (e.key === 'ArrowUp' && !sel.port && !shelfOf(d)) { e.preventDefault(); moveDev(d, 1); }
    else if (e.key === 'ArrowDown' && !sel.port && !shelfOf(d)) { e.preventDefault(); moveDev(d, -1); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !sel.port && shelfOf(d)) { e.preventDefault(); slideOnShelf(d, e.key === 'ArrowRight' ? 1 : -1); }
    else if (sel.port && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { const ps = portList(d), i = ps.findIndex(p => p.id === sel.port) + (e.key === 'ArrowRight' ? 1 : -1); if (ps[i]) { sel.port = ps[i].id; render(); } }
  });
  let wasPhone = isPhone();
  addEventListener('resize', () => {
    const ph = isPhone();
    if (ph !== wasPhone) { wasPhone = ph; if (!ph && pane === 'details') pane = view; render(); }
    if (view === 'rack') { fitZoom(); renderRack(); } else renderTable();
  });
}
init();
