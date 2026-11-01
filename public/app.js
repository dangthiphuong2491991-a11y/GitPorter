'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let state = { hasToken: false, login: '', gitName: '', gitEmail: '', home: '', lastUploadDir: '', lastCloneDir: '' };
let cur = null;         // 当前文件夹的体检结果
let busy = false;
let repos = [];

/* ------------------------------------------------------------------ */
/* 通用                                                               */
/* ------------------------------------------------------------------ */

function toast(msg, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function log(text, kind = 'out') {
  const body = $('#consoleBody');
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'log-line ' + kind;
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function setBusy(v, hint) {
  busy = v;
  ['#btnUpload', '#btnReplace', '#btnDownload', '#btnUpdate'].forEach((s) => { $(s).disabled = v; });
  if (!v) syncReplaceBtn();
  const st = $('#consoleStatus');
  if (v) { st.classList.remove('ok'); st.classList.remove('bad'); st.textContent = hint || '执行中…'; }
  else if (!st.classList.contains('ok') && !st.classList.contains('bad')) st.textContent = '';
}

/** 复制到剪贴板，失败时退回老办法 */
function copyText(t) {
  const done = () => toast('链接已复制，可以直接发给别人', 'ok', 2600);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  toast(ok ? '链接已复制，可以直接发给别人' : '复制失败，请手动选中上面的地址', ok ? 'ok' : 'warn', 3000);
}

/** 操作完成后留在日志区的结果卡（不会自己消失） */
function finishOk(title, opts) {
  opts = opts || {};
  const body = $('#consoleBody');
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'result-card';

  const head = document.createElement('div');
  head.className = 'result-title';
  head.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const cap = document.createElement('span');
  cap.textContent = title;
  head.appendChild(cap);
  card.appendChild(head);

  const line = (txt) => {
    const d = document.createElement('div');
    d.className = 'result-line';
    d.textContent = txt;
    card.appendChild(d);
    return d;
  };

  if (opts.detail) line(opts.detail);
  if (opts.url) {
    const d = line('');
    d.append('仓库地址：');
    const a = document.createElement('a');
    a.href = opts.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = opts.url;
    d.appendChild(a);

    const acts = document.createElement('div');
    acts.className = 'result-actions';
    const open = document.createElement('a');
    open.className = 'btn btn-primary';
    open.href = opts.url; open.target = '_blank'; open.rel = 'noopener';
    open.textContent = '在浏览器打开';
    const copy = document.createElement('button');
    copy.className = 'btn';
    copy.textContent = '复制链接';
    copy.onclick = () => copyText(opts.url);
    acts.append(open, copy);
    card.appendChild(acts);
  }
  if (opts.note) {
    const n = line(opts.note);
    n.style.color = '#8b98a5';
    n.style.fontSize = '12px';
  }

  body.appendChild(card);
  body.scrollTop = body.scrollHeight;
  $('#console').classList.remove('collapsed');
  $('#console').classList.add('tall');
  const st = $('#consoleStatus');
  st.textContent = '✓ ' + title;
  st.classList.add('ok');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  let data = {};
  try { data = t ? JSON.parse(t) : {}; } catch (e) { data = { error: t }; }
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function postStream(url, body, onEvent) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const ctype = r.headers.get('content-type') || '';
  if (!r.ok || ctype.includes('application/json')) {
    const t = await r.text();
    let msg = t;
    try { msg = JSON.parse(t).error || t; } catch (e) {}
    throw new Error(msg || '请求失败');
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch (e) {}
    }
  }
  if (buf.trim()) { try { onEvent(JSON.parse(buf)); } catch (e) {} }
}

/* ------------------------------------------------------------------ */
/* 步骤                                                               */
/* ------------------------------------------------------------------ */

const STEP_LABELS = {
  init: '准备仓库', ignore: '整理文件', readme: 'README', commit: '记录这次改动',
  remote: '连接云端', push: '上传中', clone: '下载中', fetch: '检查更新', merge: '更新文件',
};

function resetSteps() {
  $('#steps').innerHTML = '';
  $$('.result-card').forEach((x) => x.remove());
  $('#console').classList.remove('tall');
  const st = $('#consoleStatus');
  st.classList.remove('ok');
  st.classList.remove('bad');
  st.textContent = '';
}

function setStep(id, status) {
  const box = $('#steps');
  let el = box.querySelector('[data-step="' + id + '"]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'step';
    el.dataset.step = id;
    el.innerHTML = '<span class="sdot"></span><span></span>';
    el.lastElementChild.textContent = STEP_LABELS[id] || id;
    box.appendChild(el);
  }
  el.className = 'step ' + status;
}

/* ------------------------------------------------------------------ */
/* 目录选择弹窗                                                        */
/* ------------------------------------------------------------------ */

let pickerCb = null;
let pickerCurrent = '';
let pickerParent = null;
let pickerSep = '\\';

/** 清理用户输入的路径：去掉引号/尾斜杠，展开 ~ */
function cleanPath(raw) {
  let p = String(raw || '').trim();
  if (!p) return '';
  if ((p[0] === '"' && p.endsWith('"')) || (p[0] === "'" && p.endsWith("'"))) p = p.slice(1, -1).trim();
  if (p === '~') p = state.home || p;
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = (state.home || '') + p.slice(1);
  if (!/^\\\\/.test(p)) p = p.replace(/[\\/]{2,}/g, '\\');
  p = p.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  return p;
}

function clearSuggest() {
  const box = $('#pickerSuggest');
  if (box) box.innerHTML = '';
}

/** 输入框里的路径还不是当前目录时，边框标黄提醒「要按回车才生效」 */
function markPending() {
  const input = $('#pickerPath');
  const v = cleanPath(input.value);
  const norm = (x) => String(x || '').replace(/[\\/]+$/, '').toLowerCase();
  input.classList.toggle('pending', !!v && norm(v) !== norm(pickerCurrent));
}

async function openPicker(title, start, cb) {
  pickerCb = cb;
  $('#pickerTitle').textContent = title;
  clearSuggest();
  $('#pickerOverlay').classList.add('show');
  await navPicker(start || state.home);
  const input = $('#pickerPath');
  input.focus();
  input.select();
}

async function navPicker(p, keepSuggest) {
  const target = cleanPath(p) || state.home;
  try {
    const d = await post('/api/fs/list', { path: target });
    pickerCurrent = d.path;
    pickerParent = d.parent;
    pickerSep = d.sep || '\\';
    if (!keepSuggest) clearSuggest();

    const input = $('#pickerPath');
    input.value = d.path;
    input.title = d.path;
    markPending();

    if (d.fallback) toast('没有「' + d.fallback + '」，已跳到最近存在的 ' + d.path, 'warn');

    const drives = $('#pickerDrives');
    drives.innerHTML = '';
    (d.drives || []).forEach((dr) => {
      const t = document.createElement('div');
      t.className = 'tag';
      t.textContent = dr.replace('\\', '');
      t.onclick = () => navPicker(dr);
      drives.appendChild(t);
    });

    const list = $('#pickerList');
    list.innerHTML = '';
    if (!d.dirs.length) list.innerHTML = '<div class="empty-state" style="padding:22px">没有子文件夹</div>';
    d.dirs.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'diritem' + (item.hidden ? ' hidden-dir' : '');
      row.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg><span></span>';
      row.querySelector('span').textContent = item.name;
      row.onclick = () => navPicker(item.path);
      list.appendChild(row);
    });
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

/** 输入框里的路径 → 跳过去 */
async function goTypedPath() {
  const p = cleanPath($('#pickerPath').value);
  if (!p) { toast('先输入一个路径', 'warn'); return false; }
  clearSuggest();
  const ok = await navPicker(p);
  $('#pickerPath').focus();
  return ok;
}

/** Tab 补全：唯一结果直接进，多个结果列出来点 */
async function completePath() {
  const typed = String($('#pickerPath').value || '').trim();
  if (!typed) return;
  const bare = typed.replace(/^["']|["']$/g, '');
  const raw = cleanPath(bare);
  if (!raw) return;

  let baseDir = '';
  let prefix = '';
  if (/[\\/]$/.test(bare)) {
    baseDir = raw;            // 以斜杠结尾 = 列出这个目录下的全部子目录
  } else {
    const m = /^(.*[\\/])?([^\\/]*)$/.exec(raw);
    baseDir = m[1] || pickerCurrent || state.home;
    prefix = m[1] ? m[2] : raw;
  }
  const shownBase = /[\\/]$/.test(baseDir) ? baseDir : baseDir + pickerSep;

  try {
    const d = await post('/api/fs/list', { path: baseDir });
    const kw = prefix.toLowerCase();
    const hits = d.dirs.filter((x) => x.name.toLowerCase().startsWith(kw));
    if (!hits.length) {
      if (prefix) await navPicker(raw);
      else toast('这个目录下没有子文件夹', 'warn');
      return;
    }
    if (hits.length === 1) {
      const only = hits[0].path;
      await navPicker(only, true);
      clearSuggest();
      $('#pickerPath').value = only + pickerSep;
      markPending();
      $('#pickerPath').focus();
      return;
    }
    await navPicker(baseDir, true);
    clearSuggest();
    const box = $('#pickerSuggest');
    hits.slice(0, 12).forEach((h) => {
      const chip = document.createElement('div');
      chip.className = 'suggest-chip';
      chip.textContent = h.name;
      chip.title = h.path;
      chip.onclick = () => { clearSuggest(); navPicker(h.path); };
      box.appendChild(chip);
    });
    if (hits.length > 12) {
      const more = document.createElement('div');
      more.className = 'suggest-chip';
      more.style.opacity = '.65';
      more.textContent = '还有 ' + (hits.length - 12) + ' 个…';
      box.appendChild(more);
    }
    $('#pickerPath').value = shownBase + prefix;
    markPending();
    $('#pickerPath').focus();
  } catch (e) { toast(e.message, 'err'); }
}

$('#pickerPath').addEventListener('input', () => { clearSuggest(); markPending(); });
$('#pickerPath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); goTypedPath(); }
  else if (e.key === 'Tab') { e.preventDefault(); completePath(); }
  else if (e.key === 'Escape' && $('#pickerSuggest').children.length) {
    e.preventDefault(); e.stopPropagation(); clearSuggest();
  }
});
$('#pickerGo').onclick = goTypedPath;

$('#pickerUp').onclick = () => {
  if (pickerParent) navPicker(pickerParent);
  else {
    const p = pickerCurrent.replace(/[\\/][^\\/]+[\\/]?$/, '');
    navPicker(p || pickerCurrent);
  }
};
$('#pickerCancel').onclick = () => { $('#pickerOverlay').classList.remove('show'); pickerCb = null; };
$('#pickerOk').onclick = async () => {
  const typed = cleanPath($('#pickerPath').value);
  const same = typed.replace(/[\\/]+$/, '').toLowerCase() === pickerCurrent.replace(/[\\/]+$/, '').toLowerCase();
  if (typed && !same) {
    const ok = await goTypedPath();
    if (!ok) return;
  }
  const p = pickerCurrent;
  $('#pickerOverlay').classList.remove('show');
  pickerCb && pickerCb(p);
  pickerCb = null;
};
$('#pickerOverlay').onclick = (e) => { if (e.target === $('#pickerOverlay')) { $('#pickerOverlay').classList.remove('show'); pickerCb = null; } };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#pickerOverlay').classList.remove('show');
    $('#settingsOverlay').classList.remove('show');
  }
});

/* ------------------------------------------------------------------ */
/* 状态                                                               */
/* ------------------------------------------------------------------ */

async function loadState() {
  try { state = await post('/api/state', {}); }
  catch (e) { toast('连不上本地服务，请确认启动窗口还开着', 'err', 6000); return; }

  const chip = $('#accountChip');
  if (state.hasToken) {
    chip.className = 'chip ok';
    $('#accountText').textContent = state.login ? ('已连接 · ' + state.login) : '已连接 GitHub';
  } else {
    chip.className = 'chip bad';
    $('#accountText').textContent = '未连接 GitHub';
  }
  $('#tokenState').textContent = state.hasToken
    ? (state.tokenSource === 'gh' ? '令牌已内置（来自本机 gh 登录）' : (state.login ? '已保存 · ' + state.login : '已保存'))
    : '还没有配置令牌';
  $('#setGitName').value = state.gitName || '';
  $('#setGitEmail').value = state.gitEmail || '';
  if (!$('#pullParent').value) {
    $('#pullParent').value = state.lastCloneDir || (state.home ? state.home + '\\gitprojects' : '');
  }
  if (!$('#dirInput').value && state.lastUploadDir) {
    $('#dirInput').value = state.lastUploadDir;
    inspectDir();
  }
}

async function loadRepos() {
  if (!state.hasToken) return;
  try {
    const d = await post('/api/repos', {});
    repos = d.repos || [];
    const sel = $('#pullRepoSelect');
    sel.innerHTML = '<option value="">— 选择仓库 —</option>';
    repos.forEach((r) => {
      const o = document.createElement('option');
      o.value = r.cloneUrl;
      o.textContent = r.fullName + (r.private ? '（私有）' : '');
      sel.appendChild(o);
    });
  } catch (e) { /* 静默 */ }
}

/* ------------------------------------------------------------------ */
/* 体检                                                               */
/* ------------------------------------------------------------------ */

let inspectTimer = null;
function inspectDir() {
  const dir = $('#dirInput').value.trim();
  if (!dir) return;
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(async () => {
    try {
      const d = await post('/api/inspect', { path: dir });
      if (!d.ok) {
        $('#diag').innerHTML = '<span class="chip bad"><span class="dot"></span>' + d.error + '</span>';
        cur = null;
        return;
      }
      cur = d;
      const chips = [];
      chips.push('<span class="chip ' + (d.isRepo ? 'ok' : 'info') + '"><span class="dot"></span>' + (d.isRepo ? '是个 git 项目' : '普通文件夹') + '</span>');
      chips.push('<span class="chip"><span class="dot"></span>' + d.files + ' 个文件 · ' + fmtBytes(d.bytes) + '</span>');
      if (d.remoteFullName) chips.push('<span class="chip info"><span class="dot"></span>已绑定 ' + d.remoteFullName + '</span>');
      if (d.changes) chips.push('<span class="chip warn"><span class="dot"></span>' + d.changes + ' 处改动没保存</span>');
      $('#diag').innerHTML = chips.join('');
      $('#dirHint').textContent = d.name;

      const alerts = [];
      if (d.heavy && d.heavy.length) {
        alerts.push('<div class="alert warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg><div>里面有 <b>' + d.heavy.join('、') + '</b>，这类文件夹体积大而且能重新生成，上传时会自动忽略。</div></div>');
      }
      if (d.big && d.big.length) {
        const names = d.big.slice(0, 3).map((b) => b.name + '（' + fmtBytes(b.size) + '）').join('、');
        alerts.push('<div class="alert bad"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><div>有超过 20MB 的大文件：' + names + '。GitHub 单个文件上限 100MB，这两个建议先移除或加进忽略。</div></div>');
      }
      $('#dirAlerts').innerHTML = alerts.join('');

      // 自动勾选忽略规则
      const keys = d.suggest || ['common'];
      $$('#ignoreTags .tag').forEach((t) => t.classList.toggle('on', keys.includes(t.dataset.key)));

      // 上传面板：已绑定 vs 新建
      if (d.remoteFullName) {
        $('#upNew').style.display = 'none';
        $('#upExisting').style.display = '';
        $('#upExistingName').textContent = d.remoteFullName;
        $('#upTarget').textContent = '→ ' + d.remoteFullName;
        $('#btnUploadText').textContent = '上传这次改动';
      } else {
        $('#upNew').style.display = '';
        $('#upExisting').style.display = 'none';
        $('#upTarget').textContent = '会新建一个仓库';
        $('#btnUploadText').textContent = '创建仓库并上传';
        if (!$('#repoName').value) {
          // 中文名现在 GitHub 也认，直接沿用文件夹名，只清理非法符号
          const base = d.name
            .replace(/\s+/g, '-')
            .replace(/[~^:?*\[\]\\/|"'<>#%{}`]/g, '')
            .replace(/^[.\-_]+|[.\-_]+$/g, '');
          $('#repoName').value = base || 'my-project';
        }
      }

      // 替换面板
      if (d.remoteFullName) {
        $('#repBound').style.display = '';
        $('#repUnbound').style.display = 'none';
        $('#repBoundName').textContent = d.remoteFullName;
        $('#repTarget').textContent = '→ ' + d.remoteFullName;
      } else {
        $('#repBound').style.display = 'none';
        $('#repUnbound').style.display = '';
        $('#repTarget').textContent = '需要填写仓库地址';
      }

      // 拉取-更新面板
      $('#pullUpdateHint').textContent = d.isRepo
        ? (d.remoteFullName ? '把 ' + d.remoteFullName + ' 的最新内容拉到这个文件夹。' : '这个文件夹是 git 项目，但还没绑定云端仓库。')
        : '这个文件夹还不是 git 项目，先去「下载一个新项目」。';
    } catch (e) {
      $('#diag').innerHTML = '<span class="chip bad"><span class="dot"></span>' + e.message + '</span>';
    }
  }, 220);
}

$('#dirInput').addEventListener('input', inspectDir);

// 仓库名边打边清理：空格自动变连字符，GitHub 不认的符号直接去掉，中文保留
$('#repoName').addEventListener('input', () => {
  const el = $('#repoName');
  const before = el.value;
  const cleaned = before.replace(/\s+/g, '-').replace(/[~^:?*\[\]\\/|"'<>#%{}`]/g, '');
  if (cleaned !== before) {
    const pos = Math.max(0, (el.selectionStart || 0) - (before.length - cleaned.length));
    el.value = cleaned;
    try { el.setSelectionRange(pos, pos); } catch (e) {}
  }
});
$('#btnBrowse').onclick = () => openPicker('选择项目文件夹', $('#dirInput').value.trim() || state.home, (p) => {
  $('#dirInput').value = p;
  inspectDir();
});
$('#btnPullBrowse').onclick = () => openPicker('下载到哪个目录', $('#pullParent').value.trim() || state.home, (p) => {
  $('#pullParent').value = p;
});

/* ------------------------------------------------------------------ */
/* 动作切换                                                           */
/* ------------------------------------------------------------------ */

let currentAct = '';
$$('.action-card').forEach((card) => {
  card.onclick = () => {
    const act = card.dataset.act;
    if (currentAct === act) {
      currentAct = '';
      card.classList.remove('active');
      $$('.panel').forEach((p) => p.classList.remove('show'));
      return;
    }
    currentAct = act;
    $$('.action-card').forEach((c) => c.classList.toggle('active', c === card));
    $$('.panel').forEach((p) => p.classList.toggle('show', p.id === 'panel-' + act));
    $('#panel-' + act).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
});

$$('#pullMode button').forEach((b) => {
  b.onclick = () => {
    $$('#pullMode button').forEach((x) => x.classList.toggle('active', x === b));
    const dl = b.dataset.m === 'download';
    $('#pullDownload').style.display = dl ? '' : 'none';
    $('#pullUpdate').style.display = dl ? 'none' : '';
  };
});

$('#pullRepoSelect').onchange = (e) => {
  if (e.target.value) $('#pullUrl').value = e.target.value;
};
$('#repConfirm').onchange = syncReplaceBtn;

function syncReplaceBtn() {
  $('#btnReplace').disabled = busy || !$('#repConfirm').checked;
}

/* ------------------------------------------------------------------ */
/* 执行：公共事件处理                                                 */
/* ------------------------------------------------------------------ */

/** 失败时也留一张结果卡，避免提示条一闪而过让人以为成功了 */
function finishFail(message, hint) {
  const body = $('#consoleBody');
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'result-card fail';

  const head = document.createElement('div');
  head.className = 'result-title';
  head.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const cap = document.createElement('span');
  cap.textContent = '没有成功';
  head.appendChild(cap);
  card.appendChild(head);

  const line = (txt, color) => {
    const d = document.createElement('div');
    d.className = 'result-line';
    d.textContent = txt;
    if (color) d.style.color = color;
    card.appendChild(d);
    return d;
  };
  if (message) line(message);
  if (hint) line('可以试试：' + hint, '#8b98a5');
  line('上面每一步都记着，红色那行就是出错的地方。', '#8b98a5');

  body.appendChild(card);
  body.scrollTop = body.scrollHeight;
  $('#console').classList.remove('collapsed');
  $('#console').classList.add('tall');
  const st = $('#consoleStatus');
  st.textContent = '✗ 没有成功';
  st.classList.remove('ok');
  st.classList.add('bad');
}

function handleEvent(ev) {
  if (ev.type === 'log') log(ev.text, ev.kind);
  else if (ev.type === 'step') setStep(ev.id, ev.status);
  else if (ev.type === 'error') {
    log('✗ ' + ev.message, 'err');
    if (ev.hint) log('提示：' + ev.hint, 'warn');
    toast(ev.message + (ev.hint ? '｜' + ev.hint : ''), 'err', 9000);
    $$('.step.running').forEach((s) => s.classList.add('fail'));
    finishFail(ev.message, ev.hint);
  }
}

function requireDir() {
  const dir = $('#dirInput').value.trim();
  if (!dir) { toast('先选一个项目文件夹', 'warn'); window.scrollTo({ top: 0, behavior: 'smooth' }); return ''; }
  return dir;
}

/* ------------------------------------------------------------------ */
/* 上传                                                               */
/* ------------------------------------------------------------------ */

$('#btnUpload').onclick = async () => {
  if (busy) return;
  const dir = requireDir();
  if (!dir) return;
  if (!state.hasToken) { toast('还没有连接 GitHub', 'err'); $('#settingsOverlay').classList.add('show'); return; }

  const bound = cur && cur.remoteFullName;
  if (!bound && !$('#repoName').value.trim()) { toast('给仓库起个名字', 'warn'); $('#repoName').focus(); return; }

  const gitName = (state.gitName || '').trim();
  const gitEmail = (state.gitEmail || '').trim();
  if (!gitName || !gitEmail) {
    toast('先填一下提交用的名字和邮箱', 'warn', 5000);
    $('#settingsOverlay').classList.add('show');
    return;
  }

  resetSteps();
  setBusy(true, '正在上传…');
  log('=== 上传：' + dir + ' ===', 'info');

  const body = {
    dir,
    mode: bound ? 'current' : 'create',
    gitName, gitEmail,
    repoName: $('#repoName').value.trim(),
    description: $('#repoDesc').value.trim(),
    private: $('#repoVisible').value === 'private',
    gitignore: $$('#ignoreTags .tag.on').map((t) => t.dataset.key),
    readme: $('#genReadme').checked,
    commitMessage: $('#commitMsg').value.trim(),
  };

  try {
    await postStream('/api/push', body, (ev) => {
      handleEvent(ev);
      if (ev.type === 'done') {
        finishOk('上传成功', {
          detail: '已经传到 ' + ev.fullName + (ev.branch ? '，分支 ' + ev.branch : '') + '。点开网页就能看到代码。',
          url: ev.repoUrl,
          note: '本地文件夹已经和云端关联，以后再改这个文件夹，直接点「上传到 GitHub」就会更新同一个仓库。',
        });
        toast('上传成功：' + ev.fullName, 'ok', 6000);
        log('完成 → ' + ev.repoUrl, 'ok');
        $('#dirAlerts').innerHTML =
          '<div class="alert ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg><div>已经传到 <a href="' + ev.repoUrl + '" target="_blank">' + ev.fullName + '</a>，点开就能看到。</div></div>';
        inspectDir();
        loadRepos();
      }
    });
  } catch (e) { log('✗ ' + e.message, 'err'); toast(e.message, 'err', 6000); }
  finally { setBusy(false); }
};

/* ------------------------------------------------------------------ */
/* 替换远程版本                                                       */
/* ------------------------------------------------------------------ */

$('#btnReplace').onclick = async () => {
  if (busy || !$('#repConfirm').checked) return;
  const dir = requireDir();
  if (!dir) return;
  const bound = cur && cur.remoteFullName;
  const url = $('#repUrl').value.trim();
  if (!bound && !url) { toast('填一下要替换的仓库地址', 'warn'); return; }

  if (!confirm('确定要用这个文件夹的内容覆盖云端仓库吗？\n云端的旧提交会被丢弃，这个操作没法撤销。')) return;

  resetSteps();
  setBusy(true, '正在替换…');
  log('=== 替换远程版本：' + dir + ' ===', 'info');

  const body = {
    dir,
    mode: bound ? 'current' : 'existing',
    repoUrl: url,
    force: true,
    gitName: state.gitName, gitEmail: state.gitEmail,
    gitignore: $$('#ignoreTags .tag.on').map((t) => t.dataset.key),
    readme: false,
    commitMessage: $('#commitMsg').value.trim() || '用本地内容替换远程版本',
  };

  try {
    await postStream('/api/push', body, (ev) => {
      handleEvent(ev);
      if (ev.type === 'done') {
        finishOk('云端已替换', {
          detail: '云端现在就是本地这份内容：' + ev.fullName + '。',
          url: ev.repoUrl,
          note: '旧提交已经被覆盖，无法撤销。',
        });
        toast('云端已替换为本地版本', 'ok', 6000);
        log('完成 → ' + ev.repoUrl, 'ok');
        $('#repConfirm').checked = false;
        syncReplaceBtn();
        inspectDir();
      }
    });
  } catch (e) { log('✗ ' + e.message, 'err'); toast(e.message, 'err', 6000); }
  finally { setBusy(false); }
};

/* ------------------------------------------------------------------ */
/* 拉取                                                               */
/* ------------------------------------------------------------------ */

$('#btnDownload').onclick = async () => {
  if (busy) return;
  const url = $('#pullUrl').value.trim();
  const parent = $('#pullParent').value.trim();
  if (!url) { toast('填一下仓库地址，或从上面选一个', 'warn'); return; }
  if (!parent) { toast('选一下保存到哪个目录', 'warn'); return; }

  resetSteps();
  setBusy(true, '正在下载…');
  log('=== 下载：' + url + ' ===', 'info');

  try {
    await postStream('/api/clone', { url, parentDir: parent }, (ev) => {
      handleEvent(ev);
      if (ev.type === 'done') {
        finishOk('下载完成', {
          detail: '项目已经保存到：' + ev.dir,
          note: '想接着改这个项目，就把这个文件夹拖进第 1 步，之后可以直接上传更新。',
        });
        toast('下载完成：' + ev.dir, 'ok', 6000);
        log('保存到 ' + ev.dir, 'ok');
        $('#pullUrl').value = '';
        $('#dirAlerts').innerHTML =
          '<div class="alert ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg><div>已经下载到 <span class="mono">' + ev.dir + '</span></div></div>';
      }
    });
  } catch (e) { log('✗ ' + e.message, 'err'); toast(e.message, 'err', 6000); }
  finally { setBusy(false); }
};

$('#btnUpdate').onclick = async () => {
  if (busy) return;
  const dir = requireDir();
  if (!dir) return;
  if (!cur || !cur.isRepo) { toast('这个文件夹还不是 git 项目', 'warn'); return; }

  resetSteps();
  setBusy(true, '正在更新…');
  log('=== 拉取最新：' + dir + ' ===', 'info');

  try {
    await postStream('/api/pull', { dir }, (ev) => {
      handleEvent(ev);
      if (ev.type === 'done') {
        finishOk('同步完成', { detail: '这个文件夹已经和云端对齐：' + ev.dir });
        toast('已经是最新版本', 'ok');
        inspectDir();
      }
    });
  } catch (e) { log('✗ ' + e.message, 'err'); toast(e.message, 'err', 6000); }
  finally { setBusy(false); }
};

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

$('#btnSettings').onclick = () => $('#settingsOverlay').classList.add('show');
$('#settingsOverlay').onclick = (e) => { if (e.target === $('#settingsOverlay')) $('#settingsOverlay').classList.remove('show'); };

$('#btnSaveToken').onclick = async () => {
  const t = $('#tokenInput').value.trim();
  if (!t) { toast('先粘贴令牌', 'warn'); return; }
  const btn = $('#btnSaveToken');
  btn.disabled = true; btn.textContent = '校验中…';
  try {
    const d = await post('/api/settings', { token: t });
    toast('令牌有效' + (d.login ? '：' + d.login : ''), 'ok');
    $('#tokenInput').value = '';
    await loadState();
    loadRepos();
  } catch (e) { toast(e.message, 'err', 6000); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
};

$('#btnSaveIdentity').onclick = async () => {
  const gitName = $('#setGitName').value.trim();
  const gitEmail = $('#setGitEmail').value.trim();
  if (!gitName || !gitEmail) { toast('名字和邮箱都要填', 'warn'); return; }
  try {
    await post('/api/settings', { gitName, gitEmail });
    toast('已保存', 'ok');
    await loadState();
    $('#settingsOverlay').classList.remove('show');
  } catch (e) { toast(e.message, 'err'); }
};

$('#btnQuit').onclick = async () => {
  try { await post('/api/quit', {}); } catch (e) {}
  document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#8695a6;font-family:sans-serif">GitPorter 已退出，可以关掉这个页面了</div>';
};

/* ------------------------------------------------------------------ */
/* 控制台                                                             */
/* ------------------------------------------------------------------ */

$('#consoleHead').onclick = (e) => {
  if (e.target.id === 'btnClearLog') return;
  $('#console').classList.toggle('collapsed');
};
$('#btnClearLog').onclick = (e) => {
  e.stopPropagation();
  $('#consoleBody').innerHTML = '<div class="log-empty">还没有开始操作</div>';
  $('#console').classList.remove('tall');
  const st = $('#consoleStatus');
  st.classList.remove('ok');
  st.classList.remove('bad');
  st.textContent = '';
};

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

(async function init() {
  await loadState();
  loadRepos();
  const act = new URLSearchParams(location.search).get('act');
  if (act) {
    const card = document.querySelector('.action-card[data-act="' + act + '"]');
    if (card) card.click();
  }
  if (!state.hasToken) {
    log('还没有连接 GitHub，点右上角「设置」粘贴一个令牌。', 'warn');
  } else {
    log('准备好了。先选一个项目文件夹。', 'dim');
  }
})();
