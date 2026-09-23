// ==UserScript==
// @name         NJAU 选课助手
// @namespace    njau-course-helper
// @version      0.10.0
// @description  南京农业大学数字教务选课助手（仅供本人账号使用）
// @match        https://szjw.njau.edu.cn/xkxzd/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ================= 配置 =================
  const CFG = {
    // 目标课程，可同时抢多门。每项 keywords 需全部包含才命中，teacher 留空不筛选
    // group：写相同值的课程为「二选一」组，抢到其中一门后自动跳过其余
    targets: [
      { name: '园艺学概论', keywords: ['园艺学概论'], teacher: '', done: false },
      { name: '管理学概论', keywords: ['管理学概论'], teacher: '', done: false },
    ],
    // 以下三项留空即可，脚本会自动从页面请求里学到
    xklcId: '',
    xklbCodes: [],
    // 基础轮询间隔（毫秒），最低 300
    pollIntervalMs: 2000,
    // 每次请求附加的随机抖动上限（毫秒），避免固定节奏
    jitterMs: 300,
    // 连续失败时退避间隔的上限（毫秒）
    maxBackoffMs: 10000,
    // 退避倍数，失败一次间隔乘一次
    backoffFactor: 2,
    // 最长运行时间，避免忘记关闭
    maxDurationMs: 2 * 60 * 60 * 1000,
    // 命中后是否自动提交
    autoSubmit: true,
    // 余量字段识别不到时，是否仍然尝试提交
    submitWhenSeatUnknown: true,
    // 整点突刺：每小时整点前后这些分钟内，改用更快的间隔
    burstIntervalMs: 300,
    burstJitterMs: 100,
    burstWindowMinutes: 2,
    // 手动刷新页面后是否自动继续轮询
    resumeAfterReload: true,
  };

  const API = '/api/xkxzd/jsxsd/xkxzd';
  const SEAT_KEYS = [
    'yl', 'syl', 'kcyl', 'yxl', 'remaining', 'remain', 'surplus',
    'kyxrs', 'kexrs', 'bml', 'rl', 'capacity', 'zrs', 'kxrs',
  ];

  // ================= 状态 =================
  const STATE = {
    codes: new Set(),
    xklcId: '',
    items: [],
    gotList: false,
    selectTemplate: null,
    running: false,
    stopAt: 0,
    timer: null,
    ticks: 0,
    dumped: false,
    submitted: 0,
    failures: 0,
    interval: 0,
    burst: false,
    lastSelect: null,
    bodyByCode: {},
    itemsByCode: {},
  };

  // ================= 面板 =================
  let panel, statusEl, logEl;
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;background:#111;color:#0f0;' +
      'border:1px solid #444;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.4);' +
      'font:12px/1.55 monospace;padding:10px;';
    panel.innerHTML =
      '<div style="font-weight:bold;color:#fff;margin-bottom:6px">NJAU 选课助手 v0.10</div>' +
      '<div id="njau-status">等待页面请求…</div>' +
      '<div id="njau-info" style="color:#aaa;margin-top:4px"></div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
      '<button id="njau-start" style="flex:1;cursor:pointer">开始轮询</button>' +
      '<button id="njau-stop" style="flex:1;cursor:pointer">停止</button>' +
      '</div>' +
      '<button id="njau-diag" style="width:100%;margin-top:6px;cursor:pointer">诊断（把下面日志发我）</button>' +
      '<div id="njau-log" style="margin-top:8px;max-height:140px;overflow:auto;white-space:pre-wrap;color:#8f8"></div>';
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#njau-status');
    logEl = panel.querySelector('#njau-log');
    panel.querySelector('#njau-start').addEventListener('click', start);
    panel.querySelector('#njau-stop').addEventListener('click', function () { stop(); });
    panel.querySelector('#njau-diag').addEventListener('click', diagnose);
    refreshInfo();
  }

  function allItems() {
    const out = [];
    Object.keys(STATE.itemsByCode).forEach(function (c) {
      (STATE.itemsByCode[c] || []).forEach(function (it) { out.push(it); });
    });
    if (!out.length && STATE.items.length) return STATE.items;
    return out;
  }

  function diagnose() {
    log('诊断: codes=[' + Array.from(STATE.codes).join(',') + '] xklcId=' + (STATE.xklcId || '空'));
    const counts = Object.keys(STATE.itemsByCode).map(function (c) {
      return c + ':' + (STATE.itemsByCode[c] || []).length;
    }).join(' ');
    log('诊断: 各类别条数=' + (counts || '无'));
    const sample = allItems()[0];
    if (sample) {
      log('诊断: 首条字段=' + Object.keys(sample).join(','));
      log('诊断: 首条JSON=' + JSON.stringify(sample).slice(0, 300));
    }
    const pool = allItems();
    (CFG.targets || []).forEach(function (t) {
      const hit = pool.some(function (it) { return matches(it, t); });
      log('诊断: 目标[' + t.name + '] 命中=' + hit + ' done=' + !!t.done);
    });
    if (STATE.lastSelect) log('诊断: 上次提交 HTTP ' + STATE.lastSelect.status + ' ' + String(STATE.lastSelect.text).slice(0, 160));
  }

  function refreshInfo() {
    const info = panel && panel.querySelector('#njau-info');
    if (info) {
      const total = (CFG.targets || []).length;
      const done = (CFG.targets || []).filter(function (t) { return t.done; }).length;
      const skipped = (CFG.targets || []).filter(function (t) { return t.skipped; }).length;
      info.textContent = '目标=' + done + '/' + total + (skipped ? '（跳过' + skipped + '）' : '') +
        ' codes=[' + Array.from(STATE.codes).join(',') + '] xklcId=' + (STATE.xklcId || '-') +
        ' 列表=' + STATE.items.length + ' 提交=' + STATE.submitted +
        ' 间隔=' + (STATE.interval || '-') + 'ms 失败=' + STATE.failures;
    }
  }

  function log(msg) {
    console.log('[NJAU]', msg);
    if (!logEl) return;
    logEl.textContent = new Date().toLocaleTimeString() + ' ' + msg + '\n' + logEl.textContent;
    statusEl.textContent = msg;
    refreshInfo();
  }

  // ================= 工具 =================
  function findArrays(node, out) {
    out = out || [];
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object' && node[0] !== null) out.push(node);
      node.forEach(function (v) { findArrays(v, out); });
    } else if (node && typeof node === 'object') {
      Object.keys(node).forEach(function (k) { findArrays(node[k], out); });
    }
    return out;
  }

  function looksLikeCourse(el) {
    if (!el || typeof el !== 'object') return false;
    return el.kcmcZh !== undefined || el.kcmc !== undefined || el.kch !== undefined || el.kth !== undefined;
  }

  function extractItems(json) {
    const arrays = findArrays(json);
    let best = null;
    let bestScore = -1;
    arrays.forEach(function (arr) {
      let score = 0;
      for (let i = 0; i < arr.length; i++) if (looksLikeCourse(arr[i])) score++;
      if (score > bestScore) { best = arr; bestScore = score; }
    });
    if (bestScore > 0) return best;
    return arrays.length ? arrays.reduce(function (a, b) { return a.length >= b.length ? a : b; }) : [];
  }

  function matches(item, target) {
    if (!target.keywords || !target.keywords.length) return false;
    const s = JSON.stringify(item);
    for (let i = 0; i < target.keywords.length; i++) {
      if (s.indexOf(target.keywords[i]) === -1) return false;
    }
    if (target.teacher && s.indexOf(target.teacher) === -1) return false;
    return true;
  }

  function seatsOf(obj) {
    for (let i = 0; i < SEAT_KEYS.length; i++) {
      const k = SEAT_KEYS[i];
      const v = obj[k];
      if (typeof v === 'number') return { key: k, value: v };
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return { key: k, value: Number(v) };
    }
    return null;
  }

  function findTzdId(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      if (/tzd/i.test(keys[i]) && obj[keys[i]]) return obj[keys[i]];
    }
    for (let i = 0; i < keys.length; i++) {
      if (/id$/i.test(keys[i])) {
        const v = String(obj[keys[i]]);
        if (/^\d{15,25}$/.test(v)) return v;
      }
    }
    return null;
  }

  function isOk(json) {
    if (!json || typeof json !== 'object') return false;
    const c = json.code !== undefined ? json.code : json.status;
    if (c === undefined) return json.success === true;
    return c === 0 || c === '0' || c === 200 || c === '200' || c === true;
  }

  // ================= 关键：监听页面自身请求，学习真实字段 =================
  function onListBody(body) {
    if (!body || typeof body !== 'object') return;
    if (body.xklbCode) {
      const code = String(body.xklbCode);
      STATE.codes.add(code);
      try { STATE.bodyByCode[code] = JSON.parse(JSON.stringify(body)); } catch (e) { /* ignore */ }
    }
    if (body.xklcId) STATE.xklcId = String(body.xklcId);
    refreshInfo();
  }

  function onSelectBody(body) {
    if (body && typeof body === 'object') {
      STATE.selectTemplate = body;
      if (body.xklbCode) STATE.codes.add(String(body.xklbCode));
      if (body.xklcId) STATE.xklcId = String(body.xklcId);
      refreshInfo();
    }
  }

  function onListResponse(body, json) {
    onListBody(body);
    const items = extractItems(json);
    const code = body && body.xklbCode ? String(body.xklbCode) : null;
    STATE.gotList = true;
    if (items.length) {
      STATE.items = items;
      if (code) STATE.itemsByCode[code] = items;
    }
    if (!STATE.dumped && items.length) {
      STATE.dumped = true;
      console.log('[NJAU] 样例课程条目：', JSON.stringify(items[0], null, 2));
      console.log('[NJAU] 字段列表：', Object.keys(items[0]).join(', '));
      if (!seatsOf(items[0])) console.warn('[NJAU] 未识别到余量字段，请把样例 JSON 发给作者');
    }
    refreshInfo();
    evaluate(code);
  }

  function hookNetwork() {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        let body = null;
        try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { /* ignore */ }
        const p = origFetch.apply(this, arguments);
        if (url.indexOf('availableCourseList/list') !== -1) {
          onListBody(body);
          p.then(function (resp) { return resp.clone().json().then(function (j) { onListResponse(body, j); }); }).catch(function () {});
        } else if (url.indexOf('courseSelect/select') !== -1) {
          onSelectBody(body);
        }
        return p;
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__njauUrl = String(url || '');
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const url = this.__njauUrl || '';
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { /* ignore */ }
      if (url.indexOf('availableCourseList/list') !== -1) {
        onListBody(parsed);
        const xhr = this;
        xhr.addEventListener('load', function () {
          let j = null;
          try {
            if (xhr.responseType === 'json') j = xhr.response;
            else j = JSON.parse(xhr.responseText);
          } catch (e) { /* ignore */ }
          onListResponse(parsed, j);
        });
      } else if (url.indexOf('courseSelect/select') !== -1) {
        onSelectBody(parsed);
      }
      return origSend.apply(this, arguments);
    };
  }

  // ================= 提交 =================
  function buildSelectBody(item, code) {
    const tzdId = findTzdId(item);
    if (!tzdId) return null;
    if (STATE.selectTemplate) {
      const copy = JSON.parse(JSON.stringify(STATE.selectTemplate));
      copy.tzdId = String(tzdId);
      if (code) copy.xklbCode = code;
      if (STATE.xklcId) copy.xklcId = STATE.xklcId;
      return copy;
    }
    return {
      tzdId: String(tzdId),
      xklcId: STATE.xklcId,
      xklbCode: code || (STATE.codes.values().next().value || ''),
      ecqrflag: 0,
      mtflag: '0',
    };
  }

  async function api(path, body) {
    const headers = { Accept: '*/*', dbs: 'xkxzd', 'Content-Type': 'application/json' };
    const res = await fetch(API + '/' + path, {
      method: 'POST', headers: headers, credentials: 'include', body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: res.status, json: json, text: text };
  }

  async function submit(item, code) {
    const body = buildSelectBody(item, code);
    if (!body) { log('命中课程但找不到教学班 id，请把样例 JSON 发我'); return false; }
    const r = await api('courseSelect/select', body);
    STATE.submitted++;
    STATE.lastSelect = { status: r.status, text: r.text };
    log('提交 tzdId=' + body.tzdId + ' HTTP ' + r.status + ' ' + r.text.slice(0, 90));
    if (isOk(r.json)) return true;
    if (r.json && typeof r.json.message === 'string' &&
        /(已选该课|已选此课|已选过|你已经?选|重复选课|已存在)/.test(r.json.message)) return true;
    return false;
  }

  function pendingTargets() {
    return (CFG.targets || []).filter(function (t) { return !t.done; });
  }

  async function evaluate(code) {
    const list = (code && STATE.itemsByCode[code]) ? STATE.itemsByCode[code] : (STATE.items || []);
    const targets = pendingTargets();
    if (!targets.length) return;
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      if (target.done) continue;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!matches(item, target)) continue;
        const seat = seatsOf(item);
        log('[' + target.name + '] 命中，余量=' + (seat ? seat.value : '未知'));
        if (seat && seat.value <= 0) continue;
        if (!seat && !CFG.submitWhenSeatUnknown) continue;
        if (!CFG.autoSubmit) continue;
        const ok = await submit(item, code || (STATE.codes.values().next().value || ''));
        if (ok) {
          target.done = true;
          log('[' + target.name + '] 已选上');
          if (target.group) {
            (CFG.targets || []).forEach(function (x) {
              if (x !== target && x.group === target.group && !x.done) {
                x.done = true;
                x.skipped = true;
                log('[' + x.name + '] 与「' + target.name + '」同组二选一，跳过');
              }
            });
          }
          saveSession();
        }
        break;
      }
    }
    if (!pendingTargets().length) stop('全部目标已完成');
  }

  // ================= 主动轮询（学会 code 之后） =================
  // 返回 true 表示本轮所有请求都正常完成；false 表示出现网络/服务端异常
  async function pollOnce() {
    const codes = Array.from(STATE.codes);
    if (!codes.length || !STATE.xklcId) {
      log('等待页面课程列表请求，先点开你要抢的课程分类标签');
      return true;
    }
    let ok = true;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      let body;
      if (STATE.bodyByCode[code]) {
        body = JSON.parse(JSON.stringify(STATE.bodyByCode[code]));
        body.xklbCode = code;
        if (STATE.xklcId) body.xklcId = STATE.xklcId;
      } else {
        body = {
          xklbCode: code,
          xklcId: STATE.xklcId,
          searchParams: { ct: 'true', rlymkc: 'true', kcxx: '', skjs: '', txklbCode: '', szklbCode: '', xkbqid: '' },
        };
      }
      body.pageNumber = 1;
      body.pageSize = 100;
      const r = await api('availableCourseList/list', body);
      if (r.status === 401 || r.status === 403) { log('登录态失效 ' + r.status + '，请刷新页面重新登录'); ok = false; continue; }
      if (r.status !== 200 || !r.json) {
        ok = false;
        log('轮询 code=' + code + ' HTTP ' + r.status + '，本轮请求异常');
        continue;
      }
      const items = extractItems(r.json);
      STATE.itemsByCode[code] = items;
      if (items.length) STATE.items = items;
      log('轮询 code=' + code + ' 返回 ' + items.length + ' 门');
      await evaluate(code);
    }
    return ok;
  }

  function isBurstTime() {
    const m = new Date().getMinutes();
    const w = CFG.burstWindowMinutes;
    return m >= 60 - w || m < w;
  }

  async function tick() {
    if (!STATE.running) return;
    if (Date.now() > STATE.stopAt) { stop('已到最长运行时间'); return; }
    let ok = false;
    try { ok = await pollOnce(); } catch (e) { log('出错：' + e.message); ok = false; }
    STATE.ticks++;
    STATE.failures = ok ? 0 : STATE.failures + 1;

    const burst = isBurstTime();
    if (burst !== STATE.burst) {
      STATE.burst = burst;
      log(burst ? '进入整点突刺（加快轮询）' : '退出整点突刺（恢复常规频率）');
    }
    const base = Math.max(300, burst ? CFG.burstIntervalMs : CFG.pollIntervalMs);
    const jitter = burst ? CFG.burstJitterMs : CFG.jitterMs;
    let delay = base;
    if (STATE.failures > 0) {
      delay = Math.min(CFG.maxBackoffMs, base * Math.pow(CFG.backoffFactor, STATE.failures));
    }
    STATE.interval = Math.round(delay + Math.random() * Math.max(0, jitter));
    if (STATE.failures > 0) log('退避中，下次间隔 ' + STATE.interval + 'ms');
    STATE.timer = setTimeout(tick, STATE.interval);
  }

  // ================= 会话持久化（用于手动刷新后续跑） =================
  const SS_KEY = 'njau_course_helper_session';

  function saveSession() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        running: STATE.running,
        stopAt: STATE.stopAt,
        codes: Array.from(STATE.codes),
        xklcId: STATE.xklcId,
        targets: (CFG.targets || []).map(function (t) { return { name: t.name, done: !!t.done, skipped: !!t.skipped }; }),
      }));
    } catch (e) { /* ignore */ }
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearSession() {
    try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
  }

  function restoreSession() {
    const s = loadSession();
    if (!s || !s.running || !CFG.resumeAfterReload) return false;
    if (s.stopAt && Date.now() > s.stopAt) { clearSession(); return false; }
    STATE.stopAt = s.stopAt || (Date.now() + CFG.maxDurationMs);
    (s.codes || []).forEach(function (c) { if (c) STATE.codes.add(String(c)); });
    if (s.xklcId) STATE.xklcId = String(s.xklcId);
    (s.targets || []).forEach(function (sv) {
      const t = (CFG.targets || []).find(function (x) { return x.name === sv.name; });
      if (t) { t.done = !!sv.done; t.skipped = !!sv.skipped; }
    });
    return true;
  }

  function start() {
    if (STATE.running) return;
    STATE.running = true;
    STATE.stopAt = Date.now() + CFG.maxDurationMs;
    begin();
  }

  function begin() {
    (CFG.xklbCodes || []).forEach(function (c) { if (c) STATE.codes.add(String(c)); });
    saveSession();
    log('开始轮询，类别 codes=[' + Array.from(STATE.codes).join(',') + ']');
    tick();
  }

  function stop(msg) {
    STATE.running = false;
    if (STATE.timer) clearTimeout(STATE.timer);
    clearSession();
    log('已停止' + (msg ? '：' + msg : ''));
  }

  // ================= 启动 =================
  function init() {
    buildPanel();
    if (restoreSession()) {
      STATE.running = true;
      log('检测到刷新前的运行状态，自动继续轮询');
      begin();
    } else {
      log('就绪，等待页面加载课程列表');
    }
  }

  hookNetwork();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
