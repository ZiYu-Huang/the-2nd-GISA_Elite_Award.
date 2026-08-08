/**
 * 第二屆 GISA 創櫃菁英選拔 — 評分系統後端
 * Google Apps Script Web App（以 JSONP 回應，供 GitHub Pages 前端呼叫）
 *
 * ── 速度設計重點 ────────────────────────────────────────────────
 * 1. 前端只在「開啟頁面」時打一次 bootstrap，之後查看評分／總覽／最終確認
 *    全部用記憶體資料渲染，不再連線 → 使用者感受 0 延遲。
 * 2. 送出評分時用 rowIndex 快取直接定位列，命中時只做一次 setValues，
 *    不需要整張表 getValues。
 * 3. 後台監控用 action=ping 只讀 ScriptProperties 的版本號（不開試算表），
 *    版本沒變就不傳資料，因此可以 3 秒一次也很輕。
 * ────────────────────────────────────────────────────────────────
 *
 * 首次安裝：
 *   1) 在目標 Google 試算表 → 擴充功能 → Apps Script，貼上本檔。
 *   2) 執行一次 setupSheets()（會建立所有工作表、寫入今年名單、產生後台金鑰）。
 *   3) 部署 → 新增部署作業 → 網頁應用程式
 *      - 執行身分：我
 *      - 誰可以存取：任何人
 *   4) 把 /exec 網址填進 index.html、admin.html 的 API_URL。
 */

/* ═══════════════════════ 基本設定 ═══════════════════════ */

var SHEETS = {
  COMPANIES: '公司名單',
  JUDGES:    '評審名單',
  SCORES:    '評分明細',
  CONFIRM:   '最終確認',
  CONFIG:    '設定'
};

/** 五大構面。key 為前端欄位代號，順序即為試算表欄位順序。 */
var DIMS = [
  { key: 'I', name: '產品創新與行銷', max: 30 },
  { key: 'M', name: '市場需求與規模', max: 30 },
  { key: 'T', name: '技術門檻',       max: 20 },
  { key: 'E', name: '經營團隊',       max: 10 },
  { key: 'F', name: '財務狀況',       max: 10 }
];

var SCORE_HEADERS = ['時間戳記', '評審', '簡報順序', '決選公司']
  .concat(DIMS.map(function (d) { return d.name + '(上限' + d.max + ')'; }))
  .concat(['總分', '評語', '已確認', '確認時間']);

var COL = {
  TS: 1, JUDGE: 2, PID: 3, TEAM: 4,
  DIM0: 5,                       // 第一個構面欄
  TOTAL: 5 + DIMS.length,        // 10
  COMMENT: 6 + DIMS.length,      // 11
  CONFIRMED: 7 + DIMS.length,    // 12
  CONFIRM_TS: 8 + DIMS.length    // 13
};
var SCORE_WIDTH = SCORE_HEADERS.length; // 13

var CONFIRM_HEADERS = ['時間戳記', '評審', '已評公司數', '公司總數', '是否全數評完', '明細(JSON)', '確認時間'];

/** 今年度參賽公司（依簡報順序） */
var COMPANIES_2026 = [
  '鉅怡智慧股份有限公司',
  '峻魁智慧股份有限公司',
  '股感媒體科技股份有限公司',
  '滙嘉健康生活科技股份有限公司',
  '星益欣數位服務股份有限公司',
  '台灣居護股份有限公司',
  '騰雲運算股份有限公司',
  '夯客股份有限公司',
  '蒙恩聽障烘焙坊股份有限公司',
  '成心科技股份有限公司'
];

/** 今年度評審委員（單位, 姓名職稱） */
var JUDGES_2026 = [
  ['證券櫃檯買賣中心',                 '簡立忠董事長'],
  ['國家發展基金',                     '汪庭安執行秘書'],
  ['經濟部中小及新創企業署',           '李冠志署長'],
  ['意德士科技(股)公司',               '闕聖哲董事長'],
  ['中天生物科技(股)公司',             '陳振文董事長'],
  ['普萊德科技(股)公司',               '陳清港董事長'],
  ['SparkLabs Taiwan 新創加速器暨創投基金', '邱彥錡共同創辦人暨管理合夥人'],
  ['（測試用，正式活動可刪除）',        '測試評審']
];

var PROPS = PropertiesService.getScriptProperties();
var CACHE = CacheService.getScriptCache();

var P_VERSION   = 'DATA_VERSION';
var P_ADMIN_KEY = 'ADMIN_KEY';
var C_ROWMAP    = 'ROWMAP_V2';
var C_LISTS     = 'LISTS_V2';

/* ═══════════════════════ 入口 ═══════════════════════ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    out = route(p);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return reply(out, p.callback);
}

/** GAS 的 POST 會觸發 CORS preflight，成本高；前端一律走 GET/JSONP。
 *  這裡保留 doPost 只是為了讓誤用的請求也能得到正常回應。 */
function doPost(e) {
  return doGet(e);
}

function reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function route(p) {
  var action = String(p.action || '').trim();
  switch (action) {
    case 'ping':      return apiPing(p);
    case 'bootstrap': return apiBootstrap(p);
    case 'save':      return apiSave(p);
    case 'confirm':   return apiConfirm(p);
    case 'admin':     return apiAdmin(p);
    default:          throw new Error('未知的 action：' + action);
  }
}

/* ═══════════════════════ 共用工具 ═══════════════════════ */

function ss() { return SpreadsheetApp.getActive(); }

function sheet(name) {
  var s = ss().getSheetByName(name);
  if (!s) throw new Error('找不到工作表「' + name + '」，請先執行 setupSheets()。');
  return s;
}

function getVersion() {
  return Number(PROPS.getProperty(P_VERSION) || 0);
}

function bumpVersion() {
  var v = getVersion() + 1;
  PROPS.setProperty(P_VERSION, String(v));
  return v;
}

function nowIso() { return new Date().toISOString(); }

function round2(n) { return Math.round(n * 100) / 100; }

/** 讀取公司與評審名單（5 分鐘快取，這兩份名單活動中不會變）。 */
function getLists() {
  var hit = CACHE.get(C_LISTS);
  if (hit) {
    try { return JSON.parse(hit); } catch (ignore) {}
  }

  var cs = sheet(SHEETS.COMPANIES).getDataRange().getValues();
  var projects = [];
  for (var i = 1; i < cs.length; i++) {
    var id = String(cs[i][0] || '').trim();
    var team = String(cs[i][1] || '').trim();
    if (!id || !team) continue;
    projects.push({ id: id, team: team });
  }

  var js = sheet(SHEETS.JUDGES).getDataRange().getValues();
  var judges = [];
  for (var k = 1; k < js.length; k++) {
    var org = String(js[k][0] || '').trim();
    var name = String(js[k][1] || '').trim();
    if (!name) continue;
    judges.push({ org: org, name: name });
  }

  var lists = { projects: projects, judges: judges };
  CACHE.put(C_LISTS, JSON.stringify(lists), 300);
  return lists;
}

/** 檢查評審是否在名單內（防呆：擋掉亂改網址的 ?judge=）。 */
function requireJudge(name) {
  var judge = String(name || '').trim();
  if (!judge) throw new Error('缺少評審姓名，請使用您的專屬連結。');
  var judges = getLists().judges;
  for (var i = 0; i < judges.length; i++) {
    if (judges[i].name === judge) return judge;
  }
  throw new Error('「' + judge + '」不在評審名單中，請確認您的專屬連結是否正確。');
}

function requireAdmin(key) {
  var expect = PROPS.getProperty(P_ADMIN_KEY);
  if (!expect) throw new Error('後台金鑰尚未設定，請執行一次 setupSheets()。');
  if (String(key || '') !== expect) throw new Error('後台金鑰不正確。');
}

/** judge|pid → 試算表列號 的快取，讓「更新既有評分」不必掃描整張表。 */
function loadRowMap() {
  var hit = CACHE.get(C_ROWMAP);
  if (hit) {
    try { return JSON.parse(hit); } catch (ignore) {}
  }
  return null;
}

function saveRowMap(map) {
  try { CACHE.put(C_ROWMAP, JSON.stringify(map), 21600); } catch (ignore) {}
}

function buildRowMap(sh) {
  var last = sh.getLastRow();
  var map = {};
  if (last < 2) { saveRowMap(map); return map; }
  var vals = sh.getRange(2, COL.JUDGE, last - 1, 2).getValues(); // 評審, 簡報順序
  for (var i = 0; i < vals.length; i++) {
    var j = String(vals[i][0] || '').trim();
    var pid = String(vals[i][1] || '').trim();
    if (!j || !pid) continue;
    map[j + '|' + pid] = i + 2;
  }
  saveRowMap(map);
  return map;
}

function readAllScoreRows() {
  var sh = sheet(SHEETS.SCORES);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SCORE_WIDTH).getValues();
}

function rowToRecord(r) {
  var scores = {};
  for (var i = 0; i < DIMS.length; i++) {
    var v = r[COL.DIM0 - 1 + i];
    scores[DIMS[i].key] = (v === '' || v === null) ? null : Number(v);
  }
  var ts = r[COL.TS - 1];
  return {
    judge: String(r[COL.JUDGE - 1] || '').trim(),
    pid:   String(r[COL.PID - 1] || '').trim(),
    team:  String(r[COL.TEAM - 1] || '').trim(),
    scores: scores,
    total: Number(r[COL.TOTAL - 1] || 0),
    comment: String(r[COL.COMMENT - 1] || ''),
    confirmed: String(r[COL.CONFIRMED - 1] || '') === '是',
    at: (ts instanceof Date) ? ts.getTime() : (ts ? new Date(ts).getTime() : 0)
  };
}

function readConfirmMap() {
  var sh = ss().getSheetByName(SHEETS.CONFIRM);
  var map = {};
  if (!sh) return map;
  var last = sh.getLastRow();
  if (last < 2) return map;
  var vals = sh.getRange(2, 1, last - 1, CONFIRM_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var j = String(vals[i][1] || '').trim();
    if (!j) continue;
    var at = vals[i][6];
    map[j] = (at instanceof Date) ? at.getTime() : (at ? new Date(at).getTime() : Date.now());
  }
  return map;
}

/* ═══════════════════════ API：ping ═══════════════════════ */

/** 只讀 ScriptProperties，不開試算表 → 通常 100ms 內回應，可高頻輪詢。 */
function apiPing(p) {
  requireAdmin(p.key);
  return { ok: true, v: getVersion(), t: Date.now() };
}

/* ═══════════════════════ API：bootstrap ═══════════════════════ */

/**
 * 評審開啟頁面時唯一的一次連線。
 * 一次帶回：活動設定、構面定義、公司名單、該評審已打過的全部分數、是否已最終確認。
 */
function apiBootstrap(p) {
  var judge = requireJudge(p.judge);
  var lists = getLists();

  var rows = readAllScoreRows();
  var mine = {};
  for (var i = 0; i < rows.length; i++) {
    var rec = rowToRecord(rows[i]);
    if (rec.judge !== judge || !rec.pid) continue;
    mine[rec.pid] = {
      scores: rec.scores,
      total: rec.total,
      comment: rec.comment,
      at: rec.at
    };
  }

  var confirmMap = readConfirmMap();

  return {
    ok: true,
    v: getVersion(),
    judge: judge,
    org: (function () {
      for (var k = 0; k < lists.judges.length; k++) {
        if (lists.judges[k].name === judge) return lists.judges[k].org;
      }
      return '';
    })(),
    locked: !!confirmMap[judge],
    confirmedAt: confirmMap[judge] || 0,
    dims: DIMS,
    projects: lists.projects,
    mine: mine,
    serverTime: Date.now()
  };
}

/* ═══════════════════════ API：save ═══════════════════════ */

function apiSave(p) {
  var judge = requireJudge(p.judge);

  var confirmMap = readConfirmMap();
  if (confirmMap[judge]) {
    throw new Error('您已完成最終確認，分數已封存，無法再修改。');
  }

  var pid = String(p.projectId || '').trim();
  if (!pid) throw new Error('缺少公司編號。');

  var projects = getLists().projects;
  var team = '';
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].id === pid) { team = projects[i].team; break; }
  }
  if (!team) throw new Error('找不到編號 ' + pid + ' 的公司。');

  // 後端再驗一次分數範圍（前端已擋，這裡是最後一道防線）
  var values = [];
  var total = 0;
  for (var d = 0; d < DIMS.length; d++) {
    var dim = DIMS[d];
    var raw = p[dim.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new Error('「' + dim.name + '」尚未填寫。');
    }
    var n = Number(raw);
    if (!isFinite(n)) throw new Error('「' + dim.name + '」請輸入數字。');
    if (n < 0 || n > dim.max) {
      throw new Error('「' + dim.name + '」需介於 0 ～ ' + dim.max + ' 分。');
    }
    n = round2(n);
    values.push(n);
    total += n;
  }
  total = round2(total);

  var comment = String(p.comment || '').trim();
  if (comment.length > 300) comment = comment.slice(0, 300);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet(SHEETS.SCORES);
    var key = judge + '|' + pid;
    var map = loadRowMap();
    if (!map) map = buildRowMap(sh);

    var row = map[key];
    // 快取可能過期，寫入前驗證該列確實屬於這位評審與這家公司
    if (row) {
      var check = sh.getRange(row, COL.JUDGE, 1, 2).getValues()[0];
      if (String(check[0]).trim() !== judge || String(check[1]).trim() !== pid) {
        map = buildRowMap(sh);
        row = map[key];
      }
    }

    var rowValues = [new Date(), judge, pid, team]
      .concat(values)
      .concat([total, comment, '', '']);

    if (row) {
      sh.getRange(row, 1, 1, SCORE_WIDTH).setValues([rowValues]);
    } else {
      row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, SCORE_WIDTH).setValues([rowValues]);
      map[key] = row;
      saveRowMap(map);
    }

    var v = bumpVersion();
    return { ok: true, v: v, total: total, at: Date.now() };
  } finally {
    lock.releaseLock();
  }
}

/* ═══════════════════════ API：confirm ═══════════════════════ */

function apiConfirm(p) {
  var judge = requireJudge(p.judge);
  var projects = getLists().projects;

  var rows = readAllScoreRows();
  var mine = {};
  var detail = {};
  for (var i = 0; i < rows.length; i++) {
    var rec = rowToRecord(rows[i]);
    if (rec.judge !== judge || !rec.pid) continue;
    mine[rec.pid] = rec;
  }
  for (var k = 0; k < projects.length; k++) {
    var pr = projects[k];
    if (!mine[pr.id]) {
      throw new Error('尚有公司未評分（' + pr.id + '｜' + pr.team + '），無法送出最終確認。');
    }
    detail[pr.id] = { team: pr.team, total: mine[pr.id].total };
  }

  var confirmMap = readConfirmMap();
  if (confirmMap[judge]) {
    return { ok: true, v: getVersion(), confirmedAt: confirmMap[judge], already: true };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = new Date();

    var csh = sheet(SHEETS.CONFIRM);
    csh.appendRow([
      now, judge, projects.length, projects.length, '是',
      JSON.stringify(detail), now
    ]);

    // 在明細列標記「已確認」，之後這位評審的分數就鎖定不可改
    var ssh = sheet(SHEETS.SCORES);
    var map = loadRowMap();
    if (!map) map = buildRowMap(ssh);
    for (var j = 0; j < projects.length; j++) {
      var r = map[judge + '|' + projects[j].id];
      if (r) {
        ssh.getRange(r, COL.CONFIRMED, 1, 2).setValues([['是', now]]);
      }
    }

    var v = bumpVersion();
    return { ok: true, v: v, confirmedAt: now.getTime() };
  } finally {
    lock.releaseLock();
  }
}

/* ═══════════════════════ API：admin ═══════════════════════ */

/**
 * 後台快照。帶 since=<版本號>：版本沒變就只回 {changed:false}，幾乎不耗資源。
 */
function apiAdmin(p) {
  requireAdmin(p.key);

  var v = getVersion();
  var since = Number(p.since || -1);
  if (since === v && String(p.force || '') !== '1') {
    return { ok: true, v: v, changed: false, t: Date.now() };
  }

  var lists = getLists();
  var rows = readAllScoreRows();
  var confirmMap = readConfirmMap();

  var records = [];
  for (var i = 0; i < rows.length; i++) {
    var rec = rowToRecord(rows[i]);
    if (!rec.judge || !rec.pid) continue;
    records.push({
      judge: rec.judge,
      pid: rec.pid,
      s: DIMS.map(function (d) { return rec.scores[d.key]; }),
      total: rec.total,
      comment: rec.comment,
      at: rec.at
    });
  }

  var judges = lists.judges.map(function (j) {
    return {
      org: j.org,
      name: j.name,
      confirmed: !!confirmMap[j.name],
      confirmedAt: confirmMap[j.name] || 0
    };
  });

  return {
    ok: true,
    v: v,
    changed: true,
    t: Date.now(),
    dims: DIMS,
    projects: lists.projects,
    judges: judges,
    records: records
  };
}

/* ═══════════════════════ 安裝 / 維護 ═══════════════════════ */

/**
 * 建立所有工作表、寫入今年度名單、產生後台金鑰。
 * 可重複執行：已存在的工作表不會被覆寫，只補上缺的表頭。
 */
function setupSheets() {
  var book = ss();

  // 1) 公司名單
  var cs = book.getSheetByName(SHEETS.COMPANIES);
  if (!cs) {
    cs = book.insertSheet(SHEETS.COMPANIES);
    cs.getRange(1, 1, 1, 2).setValues([['簡報順序', '決選公司']]);
    var crows = COMPANIES_2026.map(function (name, i) { return [i + 1, name]; });
    cs.getRange(2, 1, crows.length, 2).setValues(crows);
    cs.setFrozenRows(1);
    cs.autoResizeColumns(1, 2);
  }

  // 2) 評審名單
  var js = book.getSheetByName(SHEETS.JUDGES);
  if (!js) {
    js = book.insertSheet(SHEETS.JUDGES);
    js.getRange(1, 1, 1, 3).setValues([['單位', '評審', '專屬連結']]);
    js.getRange(2, 1, JUDGES_2026.length, 2).setValues(JUDGES_2026);
    js.setFrozenRows(1);
    js.autoResizeColumns(1, 3);
  }

  // 3) 評分明細
  var sc = book.getSheetByName(SHEETS.SCORES);
  if (!sc) {
    sc = book.insertSheet(SHEETS.SCORES);
    sc.getRange(1, 1, 1, SCORE_WIDTH).setValues([SCORE_HEADERS]);
    sc.setFrozenRows(1);
    sc.getRange(1, 1, 1, SCORE_WIDTH).setFontWeight('bold');
  }

  // 4) 最終確認
  var cf = book.getSheetByName(SHEETS.CONFIRM);
  if (!cf) {
    cf = book.insertSheet(SHEETS.CONFIRM);
    cf.getRange(1, 1, 1, CONFIRM_HEADERS.length).setValues([CONFIRM_HEADERS]);
    cf.setFrozenRows(1);
    cf.getRange(1, 1, 1, CONFIRM_HEADERS.length).setFontWeight('bold');
  }

  // 5) 後台金鑰
  var key = PROPS.getProperty(P_ADMIN_KEY);
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    PROPS.setProperty(P_ADMIN_KEY, key);
  }
  if (!PROPS.getProperty(P_VERSION)) PROPS.setProperty(P_VERSION, '1');

  // 6) 設定表（把金鑰與說明放在人看得到的地方）
  var cg = book.getSheetByName(SHEETS.CONFIG);
  if (!cg) cg = book.insertSheet(SHEETS.CONFIG);
  cg.clear();
  cg.getRange(1, 1, 6, 2).setValues([
    ['項目', '內容'],
    ['後台金鑰 ADMIN_KEY', key],
    ['後台網址', 'https://<你的帳號>.github.io/<repo>/admin.html?key=' + key],
    ['評審連結格式', 'https://<你的帳號>.github.io/<repo>/?judge=<評審姓名 URL 編碼>'],
    ['資料版本', '由系統自動維護，請勿手動修改'],
    ['說明', '修改「公司名單」或「評審名單」後，最多 5 分鐘生效；要立即生效請執行 clearCaches()']
  ]);
  cg.getRange(1, 1, 1, 2).setFontWeight('bold');
  cg.setColumnWidth(1, 200);
  cg.setColumnWidth(2, 620);

  buildJudgeLinks();
  clearCaches();

  Logger.log('完成。後台金鑰 ADMIN_KEY = %s', key);
  return key;
}

/** 在「評審名單」填入各評審的專屬連結（需先在 C1 上方設定 BASE_URL）。 */
function buildJudgeLinks() {
  var base = PROPS.getProperty('BASE_URL') || 'https://ZiYu-Huang.github.io/the-2nd-GISA_Elite_Award./';
  var js = sheet(SHEETS.JUDGES);
  var last = js.getLastRow();
  if (last < 2) return;
  var names = js.getRange(2, 2, last - 1, 1).getValues();
  var links = names.map(function (r) {
    var n = String(r[0] || '').trim();
    return [n ? base + '?judge=' + encodeURIComponent(n) : ''];
  });
  js.getRange(2, 3, links.length, 1).setValues(links);
}

/** 設定 GitHub Pages 網址後重建評審連結。 */
function setBaseUrl(url) {
  PROPS.setProperty('BASE_URL', url);
  buildJudgeLinks();
  clearCaches();
}

/** 名單改過、或資料手動編輯過之後，執行這個讓快取立即失效。 */
function clearCaches() {
  CACHE.remove(C_ROWMAP);
  CACHE.remove(C_LISTS);
  bumpVersion();
}

/** 取得後台金鑰（忘記時執行）。 */
function showAdminKey() {
  var key = PROPS.getProperty(P_ADMIN_KEY);
  Logger.log('ADMIN_KEY = %s', key);
  return key;
}

/**
 * 解除某位評審的最終確認鎖定（例如按錯了，需要重新開放修改）。
 * 用法：在編輯器選這個函式，先把 JUDGE_TO_UNLOCK 改成該評審姓名再執行。
 */
var JUDGE_TO_UNLOCK = '';
function unlockJudge() {
  var judge = String(JUDGE_TO_UNLOCK || '').trim();
  if (!judge) throw new Error('請先設定 JUDGE_TO_UNLOCK 為要解鎖的評審姓名。');

  var cf = sheet(SHEETS.CONFIRM);
  var last = cf.getLastRow();
  for (var i = last; i >= 2; i--) {
    if (String(cf.getRange(i, 2).getValue()).trim() === judge) cf.deleteRow(i);
  }

  var sc = sheet(SHEETS.SCORES);
  var slast = sc.getLastRow();
  if (slast >= 2) {
    var vals = sc.getRange(2, COL.JUDGE, slast - 1, 1).getValues();
    for (var k = 0; k < vals.length; k++) {
      if (String(vals[k][0]).trim() === judge) {
        sc.getRange(k + 2, COL.CONFIRMED, 1, 2).setValues([['', '']]);
      }
    }
  }
  clearCaches();
  Logger.log('已解除 %s 的最終確認鎖定。', judge);
}

/**
 * 清空本年度所有評分（正式活動前的彩排資料清除用）。
 * 只清「評分明細」與「最終確認」的資料列，名單與表頭保留。
 */
function resetAllScores() {
  var sc = sheet(SHEETS.SCORES);
  if (sc.getLastRow() > 1) sc.deleteRows(2, sc.getLastRow() - 1);
  var cf = sheet(SHEETS.CONFIRM);
  if (cf.getLastRow() > 1) cf.deleteRows(2, cf.getLastRow() - 1);
  clearCaches();
  Logger.log('已清空所有評分資料。');
}
