/**
 * Trang HTML của `local-ui.ts`: một file, không tải gì từ ngoài (máy worker có thể không ra Internet). Hỏi
 * `/api/status` và `/api/log` mỗi 2 giây; log JSON của worker hiện thành `giờ mức lời {thêm}`.
 */
export const LOCAL_UI_PAGE = String.raw`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ag-farm worker</title>
<style>
:root { --bg:#f6f7f9; --panel:#fff; --text:#1d2330; --muted:#667085; --line:#e4e7ec; --ok:#12805c; --warn:#b54708;
  --bad:#c01048; --accent:#2f6fde; --bar:#e8eefc; --mono:ui-monospace, Consolas, "Cascadia Mono", monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --panel:#171a21; --text:#e6e8ec; --muted:#98a2b3;
  --line:#2a2f3a; --ok:#3ccb8f; --warn:#f5a524; --bad:#f2557a; --accent:#6c9cff; --bar:#22304d; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, "Segoe UI", sans-serif; }
header { padding:12px 20px; background:var(--panel); border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap;
  gap:6px 18px; align-items:center; }
h1 { font-size:17px; margin:0; }
.pill { padding:1px 10px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid currentColor; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .muted { color:var(--muted); }
main { padding:16px 20px; display:grid; gap:16px; max-width:1400px; margin:0 auto; }
section { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
h2 { font-size:14px; margin:0; padding:10px 14px; border-bottom:1px solid var(--line); display:flex; gap:10px; align-items:baseline; }
h2 span { font-weight:400; font-size:12px; }
.scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:7px 14px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
td.wrap { white-space:normal; min-width:240px; }
th { font-size:12px; color:var(--muted); font-weight:600; }
tr:last-child td { border-bottom:0; }
.empty { padding:14px; color:var(--muted); }
.mono { font-family:var(--mono); font-size:12px; }
.bar { height:6px; width:140px; background:var(--bar); border-radius:3px; overflow:hidden; display:inline-block; vertical-align:middle; margin-right:6px; }
.bar > i { display:block; height:100%; background:var(--accent); }
button.link { font:inherit; font-family:var(--mono); font-size:12px; background:none; border:0; padding:0; color:var(--accent); cursor:pointer; }
.tools { display:flex; flex-wrap:wrap; gap:8px 12px; padding:10px 14px; border-bottom:1px solid var(--line); align-items:center; }
select, input[type=search] { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); max-width:100%; }
input[type=search] { width:240px; }
#log { margin:0; height:58vh; overflow:auto; padding:8px 14px; font-family:var(--mono); font-size:12px; white-space:pre-wrap; word-break:break-word; }
.l-warn { color:var(--warn); } .l-error { color:var(--bad); } .l-debug { color:var(--muted); }
a { color:var(--accent); }
#offline { display:none; background:var(--bad); color:#fff; padding:6px 20px; }
@media (max-width:700px) { header, main { padding-left:12px; padding-right:12px; } th, td { padding:6px 8px; } input[type=search] { width:100%; } }
</style>
</head>
<body>
<div id="offline">Mất kết nối tới worker (đang khởi động lại hoặc cập nhật?). Trang tự thử lại.</div>
<header>
  <h1 id="name">ag-farm worker</h1>
  <span id="claim" class="pill muted">...</span>
  <span id="hub" class="muted"></span>
  <span id="meta" class="muted"></span>
  <span id="peers"></span>
</header>
<main>
  <section><h2>Đang chạy <span id="running-count" class="muted"></span></h2><div id="running" class="scroll"></div></section>
  <section><h2>Vừa xong <span class="muted">từ lúc worker khởi động, mới nhất trước</span></h2><div id="recent" class="scroll"></div></section>
  <section>
    <h2>Log</h2>
    <div class="tools">
      <select id="file" aria-label="File log"></select>
      <select id="level" aria-label="Mức log">
        <option value="">Mọi mức</option>
        <option value="info">info trở lên</option>
        <option value="warn">warn trở lên</option>
        <option value="error">Chỉ error</option>
      </select>
      <input id="q" type="search" placeholder="Lọc theo chữ, vd job id" aria-label="Lọc log">
      <label><input id="follow" type="checkbox" checked> Tự cuộn xuống</label>
      <span id="log-note" class="muted"></span>
    </div>
    <pre id="log"></pre>
  </section>
</main>
<script>
(function () {
  'use strict';
  var CLAIM = {
    claiming: ['Đang nhận việc', 'ok'],
    disabled: ['Hub đã tắt máy này', 'warn'],
    outside_schedule: ['Ngoài lịch chạy', 'warn'],
    updating: ['Chờ việc xong để cập nhật', 'warn'],
    stopping: ['Đang dừng', 'bad']
  };
  var OUTCOME = {
    completed: ['Xong', 'ok'],
    failed: ['Lỗi', 'bad'],
    aborted: ['Bị huỷ / mất lease', 'warn'],
    handed_back: ['Trả lại hub để cập nhật', 'warn']
  };
  var LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  var MAX_LINES = 5000;
  var log = { file: null, from: null, lines: [] };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + ' giờ ' + m + ' phút';
    if (m) return m + ' phút ' + (s % 60) + ' giây';
    return s + ' giây';
  }
  function clock(iso) { return new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }); }
  function jobButton(id) {
    var b = el('button', 'link', id.slice(0, 8));
    b.type = 'button';
    b.title = id + ' (bấm để lọc log theo job này)';
    b.onclick = function () { $('q').value = id; renderLog(); $('log').scrollIntoView({ behavior: 'smooth' }); };
    return b;
  }
  function table(target, cols, rows, empty) {
    var box = $(target);
    if (!rows.length) { box.replaceChildren(el('div', 'empty', empty)); return; }
    var t = el('table'), head = el('tr');
    cols.forEach(function (c) { head.appendChild(el('th', null, c)); });
    t.appendChild(el('thead')).appendChild(head);
    var body = t.appendChild(el('tbody'));
    rows.forEach(function (cells) {
      var tr = body.appendChild(el('tr'));
      cells.forEach(function (c) {
        var td = tr.appendChild(el('td', c && c.cls));
        if (c && c.node) td.appendChild(c.node); else td.textContent = c && c.text !== undefined ? c.text : (c === null ? '' : String(c));
      });
    });
    box.replaceChildren(t);
  }
  function progress(j) {
    var wrap = el('span');
    if (j.percent !== null) {
      var bar = wrap.appendChild(el('span', 'bar')), fill = bar.appendChild(el('i'));
      fill.style.width = Math.max(0, Math.min(100, j.percent)) + '%';
      wrap.appendChild(document.createTextNode(Math.round(j.percent) + '%'));
    } else {
      wrap.appendChild(el('span', 'muted', '-'));
    }
    return wrap;
  }

  function renderStatus(s) {
    var now = Date.parse(s.now);
    document.title = s.name + ' · ag-farm';
    $('name').textContent = s.name;
    var c = CLAIM[s.claim] || [s.claim, 'muted'];
    $('claim').textContent = c[0];
    $('claim').className = 'pill ' + c[1];

    var hb = s.heartbeat, hub = $('hub');
    if (hb.error && (!hb.last_ok_at || Date.parse(hb.error.at) > Date.parse(hb.last_ok_at))) {
      hub.textContent = 'Hub: lỗi kết nối, ' + hb.error.message;
      hub.className = 'bad';
    } else if (hb.last_ok_at) {
      hub.textContent = 'Hub: kết nối tốt (' + dur(now - Date.parse(hb.last_ok_at)) + ' trước)';
      hub.className = 'ok';
    } else {
      hub.textContent = 'Hub: chưa kết nối';
      hub.className = 'muted';
    }
    var meta = 'v' + s.version + ' · chạy được ' + dur(now - Date.parse(s.started_at));
    if (s.free_slots) meta += ' · slot rảnh: CPU ' + s.free_slots.cpu + ', GPU ' + s.free_slots.gpu;
    if (s.update && s.update.state && s.update.state !== 'idle') {
      meta += ' · cập nhật: ' + s.update.state + (s.update.target_version ? ' ' + s.update.target_version : '');
    }
    $('meta').textContent = meta;

    var peers = $('peers');
    peers.replaceChildren();
    (s.peers || []).forEach(function (p) {
      var a = el('a', null, p.name);
      a.href = p.url;
      peers.appendChild(document.createTextNode(peers.childNodes.length ? ' · ' : 'Worker khác: '));
      peers.appendChild(a);
    });

    $('running-count').textContent = s.running.length ? '(' + s.running.length + ')' : '';
    table('running', ['Loại', 'Bước', 'Tiến độ', 'Đã chạy', 'Lane', 'Lần', 'Ứng dụng', 'Job'], s.running.map(function (j) {
      return [j.type, j.stage || '-', { node: progress(j) }, dur(now - Date.parse(j.started_at)), j.lane, j.attempt, j.owner,
        { node: jobButton(j.id) }];
    }), 'Không có việc nào đang chạy.');
    table('recent', ['Kết quả', 'Loại', 'Lỗi', 'Xong lúc', 'Thời gian', 'Ứng dụng', 'Job'], s.recent.map(function (j) {
      var o = OUTCOME[j.outcome] || [j.outcome, 'muted'];
      var err = j.error ? j.error.code + ': ' + j.error.message : '';
      return [{ node: el('span', o[1], o[0]) }, j.type, { text: err, cls: 'wrap' }, clock(j.finished_at),
        dur(Date.parse(j.finished_at) - Date.parse(j.started_at)), j.owner, { node: jobButton(j.id) }];
    }), 'Chưa có việc nào xong.');
  }

  function pollStatus() {
    fetch('/api/status').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (s) {
      $('offline').style.display = 'none';
      renderStatus(s);
    }).catch(function () { $('offline').style.display = 'block'; });
  }

  function parseLine(line) {
    if (line.charAt(0) === '{') {
      try {
        var o = JSON.parse(line);
        if (o && typeof o.msg === 'string') {
          var rest = {}, extra = false;
          Object.keys(o).forEach(function (k) {
            if (k !== 'level' && k !== 'time' && k !== 'msg' && k !== 'worker' && k !== 'version') { rest[k] = o[k]; extra = true; }
          });
          var level = LEVELS.hasOwnProperty(o.level) ? o.level : 'info';
          return { level: level, raw: line,
            text: (o.time ? clock(o.time) : '') + ' ' + (level + '    ').slice(0, 5) + ' ' + o.msg + (extra ? ' ' + JSON.stringify(rest) : '') };
        }
      } catch (e) { /* dòng thường */ }
    }
    var lv = /\b(error|exception|fatal)\b/i.test(line) ? 'error' : /\bwarn(ing)?\b/i.test(line) ? 'warn' : 'info';
    return { level: lv, raw: line, text: line };
  }

  function renderLog() {
    var min = $('level').value ? LEVELS[$('level').value] : -1;
    var q = $('q').value.trim().toLowerCase();
    var frag = document.createDocumentFragment(), shown = 0;
    log.lines.forEach(function (l) {
      if (LEVELS[l.level] < min) return;
      if (q && l.raw.toLowerCase().indexOf(q) < 0) return;
      frag.appendChild(el('div', 'l-' + l.level, l.text));
      shown++;
    });
    var box = $('log');
    box.replaceChildren(frag);
    $('log-note').textContent = shown + ' / ' + log.lines.length + ' dòng' + (log.lines.length >= MAX_LINES ? ' (giữ ' + MAX_LINES + ' dòng cuối)' : '');
    if ($('follow').checked) box.scrollTop = box.scrollHeight;
  }

  function pollLog() {
    if (!log.file) return;
    var url = '/api/log?file=' + encodeURIComponent(log.file) + (log.from !== null ? '&from=' + log.from : '');
    var file = log.file;
    fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (c) {
      if (file !== log.file) return;
      if (c.reset) log.lines = [];
      log.from = c.next;
      if (c.text) {
        var parts = c.text.split(/\r?\n/);
        if (parts[parts.length - 1] === '') parts.pop();
        parts.forEach(function (p) { log.lines.push(parseLine(p)); });
        if (log.lines.length > MAX_LINES) log.lines = log.lines.slice(log.lines.length - MAX_LINES);
      }
      if (c.reset || c.text) renderLog();
    }).catch(function () { /* thử lại vòng sau */ });
  }

  function loadFiles() {
    fetch('/api/log-files').then(function (r) { return r.json(); }).then(function (d) {
      var sel = $('file'), keep = log.file;
      sel.replaceChildren();
      d.files.forEach(function (f) {
        var o = el('option', null, f.path + ' (' + Math.round(f.size / 1024) + ' KB)');
        o.value = f.id;
        sel.appendChild(o);
      });
      if (!d.files.length) { sel.appendChild(el('option', null, 'Không có file log')); return; }
      var ids = d.files.map(function (f) { return f.id; });
      var pick = ids.indexOf(keep) >= 0 ? keep : (ids.filter(function (id) { return /:worker\.log$/i.test(id); })[0] || ids[0]);
      sel.value = pick;
      if (pick !== log.file) { log.file = pick; log.from = null; log.lines = []; pollLog(); }
    }).catch(function () { /* thử lại vòng sau */ });
  }

  $('file').onchange = function () { log.file = this.value; log.from = null; log.lines = []; renderLog(); pollLog(); };
  $('level').onchange = renderLog;
  $('q').oninput = renderLog;
  $('follow').onchange = function () { if (this.checked) renderLog(); };

  pollStatus();
  loadFiles();
  setInterval(pollStatus, 2000);
  setInterval(pollLog, 2000);
  setInterval(loadFiles, 30000);
})();
</script>
</body>
</html>
`;
