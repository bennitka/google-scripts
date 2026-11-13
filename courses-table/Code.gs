// Monday board -> Google Site table, driven by a settings Google Sheet.
// Token: Script Properties > MONDAY_TOKEN. Settings sheet id: CONFIG_SHEET_ID (created by setupConfig()).
// Run setupConfig() once from the editor; after that, Jen edits only the sheet.
const BOARD_ID = 7062102645;
const CACHE_SECONDS = 300;
const SKIP_TYPES = ['button', 'subtasks', 'file'];   // not offered as columns
const NONE = '(none)';
// Filters use monday's own filtering only (nothing is filtered in this script), so only these column types and
// conditions are offered. Rows of one column with "is" (or "is not") are merged into one any-of (none-of) rule.
const FILTER_OPS = {
  status:   ['is', 'is not', 'is empty', 'is not empty'],
  dropdown: ['is', 'is not', 'is empty', 'is not empty'],
  date:     ['is in the past', 'is today or in the future', 'is empty', 'is not empty'],
  text:     ['contains', 'does not contain', 'is empty', 'is not empty']
};
const OPS = ['is', 'is not', 'contains', 'does not contain', 'is in the past', 'is today or in the future', 'is empty', 'is not empty'];

// Used until a settings sheet exists; also what setupConfig() writes into it.
const DEFAULT_CONFIG = {
  columns: ['Name (Course ID)', 'Course Title', 'Course Short Description', 'Greenlight TOC'],
  filters: [['Destination', 'is', 'LinkedIn (FLW)'], ['Destination', 'is', 'App'],
            ['Acquisition Status', 'is', 'N/A'], ['Apex Release Date', 'is in the past', '']],
  sort: [['Name (Course ID)', 'Ascending']],
  group: ['Course Subject', 'Ascending', 'No']
};

// ---------- web app ----------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Courses').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getTable(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const n = cache.get('n');
    if (n) {
      const keys = Array.from({length: +n}, (_, i) => 'c' + i), parts = cache.getAll(keys);
      if (Object.keys(parts).length === +n) return JSON.parse(keys.map(k => parts[k]).join(''));
    }
  }
  const data = buildTable_(readConfig_(), loadMeta_());
  const s = JSON.stringify(data), size = 90000, chunks = {};
  let k = 0;
  for (let i = 0; i < s.length; i += size) chunks['c' + k++] = s.slice(i, i + size);
  chunks.n = String(k);
  try { cache.putAll(chunks, CACHE_SECONDS); } catch (e) {}
  return data;
}

// ---------- monday ----------
function gql(query, variables) {
  const token = PropertiesService.getScriptProperties().getProperty('MONDAY_TOKEN');
  if (!token) throw new Error('MONDAY_TOKEN is not set in Script Properties');
  const res = UrlFetchApp.fetch('https://api.monday.com/v2', {
    method: 'post', muteHttpExceptions: true,
    headers: {Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2025-04'},
    payload: JSON.stringify({query, variables})
  });
  const j = JSON.parse(res.getContentText());
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// Every column the sheet can pick, with a unique display label ("Title" or "Title (type)" when titles repeat).
function loadMeta_() {
  const d = gql('query($b:[ID!]){boards(ids:$b){columns{id title type settings_str}}}', {b: [BOARD_ID]});
  if (!d.boards || !d.boards.length) throw new Error('monday returned no board ' + BOARD_ID + ': the token in Script Properties (MONDAY_TOKEN) is wrong, or its owner cannot see the Courses board');
  const cols = d.boards[0].columns.filter(c => c.id === 'name' || SKIP_TYPES.indexOf(c.type) < 0);
  if (!cols.some(c => c.id === 'name')) cols.unshift({id: 'name', title: 'Name', type: 'name'});
  const count = {};
  cols.forEach(c => count[c.title] = (count[c.title] || 0) + 1);
  return cols.map(c => ({id: c.id, title: c.title, type: c.type, settings: c.settings_str,
                         label: c.id === 'name' ? 'Name (Course ID)' : count[c.title] > 1 ? c.title + ' (' + c.type + ')' : c.title}));
}

function fetchItems_(ids, rules) {
  const real = ids.filter(i => i !== 'name');
  const f = `id type text
    ... on StatusValue { label } ... on MirrorValue { display_value } ... on BoardRelationValue { display_value }
    ... on FormulaValue { display_value } ... on LinkValue { url } ... on CheckboxValue { checked }`;
  const first = `query($b:[ID!],$ids:[String!]){boards(ids:$b){items_page(limit:500${rules && rules.length ? ',query_params:{operator:and,rules:[' + rules.join(',') + ']}' : ''}){cursor items{name column_values(ids:$ids){${f}}}}}}`;
  const next = `query($cursor:String!,$ids:[String!]){next_items_page(limit:500,cursor:$cursor){cursor items{name column_values(ids:$ids){${f}}}}}`;
  let page = gql(first, {b: [BOARD_ID], ids: real}).boards[0].items_page, out = page.items;
  while (page.cursor) { page = gql(next, {cursor: page.cursor, ids: real}).next_items_page; out = out.concat(page.items); }
  return out.map(it => {
    const v = {name: it.name};
    it.column_values.forEach(c => v[c.id] = cellText_(c));
    return v;
  });
}

function labelIds_(m) {
  let s = {}, map = {};
  try { s = JSON.parse(m.settings || '{}'); } catch (e) {}
  if (m.type === 'status') Object.keys(s.labels || {}).forEach(k => map[String(s.labels[k]).toLowerCase()] = +k);
  else (s.labels || []).forEach(l => map[String(l.name).toLowerCase()] = l.id);
  return {map, names: m.type === 'status' ? Object.keys(s.labels || {}).map(k => s.labels[k]) : (s.labels || []).map(l => l.name)};
}

// Turn the sheet's filter rows into monday query_params rules (strings). Throws a plain-English error for a row
// monday can't do.
function monRules_(rules, meta) {
  const byId = {}, sets = {}, out = [];
  meta.forEach(m => byId[m.id] = m);
  rules.forEach(r => {
    const m = byId[r.id], ok = FILTER_OPS[m.type], where = 'Filters row ' + r.row;
    if (!ok) throw new Error(where + ': monday cannot filter on "' + m.label + '" (it is a ' + m.type + ' column). Pick a status, dropdown, date or text column.');
    if (ok.indexOf(r.op) < 0) throw new Error(where + ': "' + r.op + '" is not available for "' + m.label + '". Use one of: ' + ok.join(', ') + '.');
    const c = '{column_id:"' + r.id + '",';
    if (r.op === 'is' || r.op === 'is not') {
      const k = r.id + '|' + r.op;
      (sets[k] = sets[k] || {m, op: r.op, rows: []}).rows.push(r);
    }
    else if (r.op === 'is empty') out.push(c + 'compare_value:[],operator:is_empty}');
    else if (r.op === 'is not empty') out.push(c + 'compare_value:[],operator:is_not_empty}');
    else if (r.op === 'is in the past') out.push(c + 'compare_value:["TODAY"],operator:lower_than}');
    else if (r.op === 'is today or in the future') out.push(c + 'compare_value:["TODAY"],operator:greater_than_or_equals}');
    else {
      if (!String(r.val).trim()) throw new Error(where + ': type a value to look for.');
      out.push(c + 'compare_value:[' + JSON.stringify(String(r.val)) + '],operator:' + (r.op === 'contains' ? 'contains_text' : 'not_contains_text') + '}');
    }
  });
  Object.keys(sets).forEach(k => {
    const g = sets[k], li = labelIds_(g.m);
    const ids = g.rows.map(r => {
      const id = li.map[String(r.val).toLowerCase()];
      if (id === undefined) throw new Error('Filters row ' + r.row + ': "' + r.val + '" is not a choice in "' + g.m.label + '". Choices: ' + li.names.join(', ') + '.');
      return id;
    });
    out.push('{column_id:"' + g.m.id + '",compare_value:[' + ids.join(',') + '],operator:' + (g.op === 'is' ? 'any_of' : 'not_any_of') + '}');
  });
  return out;
}

function cellText_(v) {
  if (v.display_value) return v.display_value;
  if (v.url) return v.url;
  if (v.label) return v.label;
  if (v.checked) return '✓';
  return v.text || '';
}

// ---------- settings ----------
function readConfig_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID');
  if (!id) return {columnsRaw: DEFAULT_CONFIG.columns.join(', '), filters: DEFAULT_CONFIG.filters,
                   sort: DEFAULT_CONFIG.sort, group: DEFAULT_CONFIG.group};
  const ss = SpreadsheetApp.openById(id);
  const rows = (name, r, c, n) => ss.getSheetByName(name).getRange(r, 1, n, c).getValues()
    .map(x => x.map(v => String(v).trim())).filter(x => x[0]);
  return {
    columnsRaw: String(ss.getSheetByName('Columns').getRange('B4').getValue()),
    filters: rows('Filters', 5, 3, 30),
    sort: rows('Sort', 5, 2, 3),
    group: ss.getSheetByName('Group').getRange('B4:B6').getValues().map(x => String(x[0]).trim())
  };
}

// "A, B, C" -> ['A','B','C'], keeping names that themselves contain ", " whole.
function parseList_(str, known) {
  const toks = String(str || '').split(/\s*,\s*/).filter(Boolean), set = {};
  known.forEach(k => set[k] = true);
  const out = [], unknown = [];
  for (let i = 0; i < toks.length;) {
    let hit = 0;
    for (let j = toks.length; j > i; j--) if (set[toks.slice(i, j).join(', ')]) { hit = j - i; break; }
    if (hit) { out.push(toks.slice(i, i + hit).join(', ')); i += hit; } else { unknown.push(toks[i]); i++; }
  }
  return {out, unknown};
}

// ---------- build ----------
function cmp_(a, b, dir) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b) return a === b ? 0 : (a ? -1 : 1);   // empty last, whatever the direction
  const num = /^-?[\d.,]+$/;
  const r = num.test(a) && num.test(b) ? parseFloat(a.replace(/,/g, '')) - parseFloat(b.replace(/,/g, ''))
          : a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
  return dir * r;
}

function buildTable_(cfg, meta) {
  const byLabel = {};
  meta.forEach(m => byLabel[m.label] = m);
  byLabel['Name'] = byLabel['Name (Course ID)'];            // old sheets say just "Name"
  const labels = meta.map(m => m.label).concat('Name');
  const pick = (name, where) => {
    const m = byLabel[name];
    if (!m) throw new Error(where + ': there is no column called "' + name + '". Choose one from the dropdown.');
    return m;
  };
  const shown = parseList_(cfg.columnsRaw, labels);
  if (shown.unknown.length) throw new Error('Columns: no column called "' + shown.unknown[0] + '". Choose from the dropdown.');
  if (!shown.out.length) throw new Error('Columns: pick at least one column to show.');
  const shownMeta = shown.out.map(l => byLabel[l]);
  const rules = cfg.filters.map((f, i) => {
    if (OPS.indexOf(f[1]) < 0) throw new Error('Filters row ' + (i + 1) + ': pick a condition from the dropdown (got "' + f[1] + '").');
    return {id: pick(f[0], 'Filters row ' + (i + 1)).id, op: f[1], val: f[2], row: i + 1};
  });
  const sorts = cfg.sort.map((s, i) => ({id: pick(s[0], 'Sort row ' + (i + 1)).id, dir: /^desc/i.test(s[1]) ? -1 : 1}));
  const gName = cfg.group[0], gm = gName && gName !== NONE ? pick(gName, 'Group') : null;
  const gDir = /^desc/i.test(cfg.group[1] || '') ? -1 : 1;

  const ids = {};
  shownMeta.concat(rules.map(r => ({id: r.id})), sorts.map(s => ({id: s.id})), gm ? [gm] : []).forEach(m => ids[m.id] = true);
  const items = fetchItems_(Object.keys(ids), monRules_(rules, meta));
  items.sort((a, b) => { for (const s of sorts) { const c = cmp_(a[s.id], b[s.id], s.dir); if (c) return c; } return 0; });

  const groups = {};
  items.forEach(it => { const g = gm ? (it[gm.id] || 'No ' + gm.title) : ''; (groups[g] = groups[g] || []).push(shownMeta.map(m => it[m.id] || '')); });
  const names = Object.keys(groups).sort((a, b) => cmp_(a, b, gDir));
  const first = sorts[0] ? shownMeta.findIndex(m => m.id === sorts[0].id) : -1;
  return {
    headers: shownMeta.map(m => m.id === 'name' ? 'Course id' : m.label),
    groupBy: gm ? gm.title : '',
    collapsed: /^y/i.test(cfg.group[2] || ''),
    defaultSort: first >= 0 ? {index: first, dir: sorts[0].dir} : null,
    total: items.length,
    updated: new Date().toISOString(),
    groups: names.map(g => ({title: g, rows: groups[g]}))
  };
}

// ---------- settings sheet: run setupConfig() once ----------
const FILTER_HELP = 'Only courses matching every column below are shown. Two "is" rows for the same column mean either one (Destination is A, Destination is B). Only status, dropdown, date and text columns can be filtered, the same as in monday.';
function setupConfig() {
  const props = PropertiesService.getScriptProperties();
  const old = props.getProperty('CONFIG_SHEET_ID');
  if (old) { refreshLists(); Logger.log('Already set up: ' + SpreadsheetApp.openById(old).getUrl()); return; }
  const ss = SpreadsheetApp.create('Courses table settings');
  props.setProperty('CONFIG_SHEET_ID', ss.getId());
  const mk = (name, first) => first ? ss.getSheets()[0].setName(name) : ss.insertSheet(name);
  const cols = mk('Columns', true), fil = mk('Filters'), sor = mk('Sort'), grp = mk('Group'), lst = mk('Lists'), val = mk('Values');
  const head = (sh, title, help) => {
    sh.getRange('A1').setValue(title).setFontSize(16).setFontWeight('bold');
    sh.getRange('A2').setValue(help).setFontColor('#666666');
  };
  const bold = r => r.setFontWeight('bold').setBackground('#f3f3f3');

  head(cols, 'Columns', 'Which columns the table shows, in this order. The page updates within 5 minutes.');
  cols.getRange('A4').setValue('Columns to show').setFontWeight('bold');
  cols.getRange('B4').setValue(DEFAULT_CONFIG.columns.join(', ')).setWrap(true);
  cols.getRange('A6').setValue('Name (Course ID) is the course number; the page shows it as "Course id".').setFontColor('#666666');
  cols.setColumnWidth(1, 260); cols.setColumnWidth(2, 520);

  head(fil, 'Filters', FILTER_HELP);
  bold(fil.getRange('A4:C4')).setValues([['Column', 'Condition', 'Value']]);
  fil.getRange(5, 1, DEFAULT_CONFIG.filters.length, 3).setValues(DEFAULT_CONFIG.filters);
  fil.setColumnWidth(1, 260); fil.setColumnWidth(2, 220); fil.setColumnWidth(3, 300);

  head(sor, 'Sort', 'Order of the rows inside each group. Up to three levels; the page also lets visitors click any column header to re-sort.');
  bold(sor.getRange('A4:B4')).setValues([['Column', 'Direction']]);
  sor.getRange(5, 1, DEFAULT_CONFIG.sort.length, 2).setValues(DEFAULT_CONFIG.sort);
  sor.setColumnWidth(1, 260); sor.setColumnWidth(2, 160);

  head(grp, 'Group', 'Rows are grouped by one column. Choose (none) for a single flat list.');
  grp.getRange('A4:A6').setValues([['Group by'], ['Order'], ['Groups start collapsed']]).setFontWeight('bold');
  grp.getRange('B4:B6').setValues(DEFAULT_CONFIG.group.map(x => [x]));
  grp.setColumnWidth(1, 220); grp.setColumnWidth(2, 260);

  lst.getRange('A1').setValue('All columns (refreshed daily, do not edit)').setFontWeight('bold');
  val.getRange('A1').setValue('Choices per column (refreshed daily, do not edit)').setFontWeight('bold');
  lst.hideSheet(); val.hideSheet();
  refreshLists();

  const dd = (sh, a1, rule) => sh.getRange(a1).setDataValidation(rule.setAllowInvalid(true).build());
  dd(cols, 'B4', SpreadsheetApp.newDataValidation().requireValueInRange(lst.getRange('A2:A300'), true));
  dd(fil, 'A5:A34', SpreadsheetApp.newDataValidation().requireValueInRange(lst.getRange('C2:C300'), true));
  dd(fil, 'B5:B34', SpreadsheetApp.newDataValidation().requireValueInList(OPS, true));
  dd(sor, 'A5:A7', SpreadsheetApp.newDataValidation().requireValueInRange(lst.getRange('A2:A300'), true));
  dd(sor, 'B5:B7', SpreadsheetApp.newDataValidation().requireValueInList(['Ascending', 'Descending'], true));
  dd(grp, 'B4', SpreadsheetApp.newDataValidation().requireValueInRange(lst.getRange('B2:B300'), true));
  dd(grp, 'B5', SpreadsheetApp.newDataValidation().requireValueInList(['Ascending', 'Descending'], true));
  dd(grp, 'B6', SpreadsheetApp.newDataValidation().requireValueInList(['No', 'Yes'], true));

  ScriptApp.newTrigger('onConfigEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('refreshLists').timeBased().everyDays(1).create();
  Logger.log('Settings sheet: ' + ss.getUrl());
}

// Refresh the hidden dropdown sources from monday (column names, and the choices of status/dropdown columns).
function refreshLists() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID'));
  const meta = loadMeta_();
  const lst = ss.getSheetByName('Lists'), val = ss.getSheetByName('Values');
  lst.clearContents(); val.clearContents();
  const cs = ss.getSheetByName('Columns');                 // older sheets had a "show as" table here; it is gone
  cs.getRange('A6:B27').clearContent().clearDataValidations().setFontWeight('normal').setBackground(null);
  cs.getRange('A6').setValue('Name (Course ID) is the course number; the page shows it as "Course id".').setFontColor('#666666');
  // A = column labels (for column pickers), B = "(none)" + labels (for Group by).
  lst.getRange(1, 1, 1, 3).setValues([['All columns (refreshed daily, do not edit)', 'With (none)', 'Filterable columns']]);
  const fcols = meta.filter(m => FILTER_OPS[m.type]);
  lst.getRange(2, 3, fcols.length, 1).setValues(fcols.map(m => [m.label]));
  const fs = ss.getSheetByName('Filters');                 // older sheets: point the filter picker at filterable columns
  fs.getRange('A2').setValue(FILTER_HELP).setFontColor('#666666');
  fs.getRange('A5:A34').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(lst.getRange('C2:C300'), true).setAllowInvalid(true).build());
  lst.getRange(2, 1, meta.length, 1).setValues(meta.map(m => [m.label]));
  lst.getRange(2, 2, meta.length + 1, 1).setValues([[NONE]].concat(meta.map(m => [m.label])));
  const choices = [];
  meta.forEach(m => {
    let s = {};
    try { s = JSON.parse(m.settings || '{}'); } catch (e) {}
    let list = [];
    if (m.type === 'status' && s.labels) list = Object.keys(s.labels).map(k => s.labels[k]);
    if (m.type === 'dropdown' && s.labels) list = s.labels.map(l => l.name);
    if (list.length) choices.push([m.label].concat(list.filter(Boolean)));
  });
  const w = Math.max(1, choices.reduce((a, c) => Math.max(a, c.length), 1));
  if (choices.length) {
    const grid = Array.from({length: w}, (_, r) => choices.map(c => c[r] || ''));   // columns = choices
    val.getRange(1, 1, w, choices.length).setValues(grid);
  }
}

// When a filter's Column changes, offer that column's choices in the Value cell.
function onConfigEdit(e) {
  const r = e.range, sh = r.getSheet();
  if (sh.getName() !== 'Filters' || r.getColumn() !== 1 || r.getRow() < 5) return;
  const val = e.source.getSheetByName('Values'), name = String(r.getValue());
  const cell = sh.getRange(r.getRow(), 3);
  cell.clearDataValidations();
  if (!name || !val.getLastColumn()) return;
  const hdr = val.getRange(1, 1, 1, val.getLastColumn()).getValues()[0], i = hdr.indexOf(name);
  if (i < 0) return;
  const list = val.getRange(2, i + 1, Math.max(1, val.getLastRow() - 1), 1).getValues().map(x => String(x[0])).filter(Boolean);
  if (list.length) cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build());
}
