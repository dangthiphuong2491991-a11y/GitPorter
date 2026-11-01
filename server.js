#!/usr/bin/env node
'use strict';

/**
 * GitPorter — 本地一键把项目传到 GitHub / 从 GitHub 拉回本地
 * 零外部依赖，只依赖本机已安装的 git。
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DIR = path.join(os.homedir(), '.gitporter');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const IS_WIN = process.platform === 'win32';
const PORT_START = Number(process.env.GITPORTER_PORT || 5180);

/* ------------------------------------------------------------------ */
/* 配置存取（令牌用本机指纹派生的密钥加密，避免明文落盘）               */
/* ------------------------------------------------------------------ */

const MACHINE_SEED = [
  os.hostname(),
  (() => { try { return os.userInfo().username; } catch (e) { return 'user'; } })(),
  os.platform(),
  'gitporter',
].join('|');

let _key = null;
function machineKey() {
  if (!_key) _key = crypto.scryptSync(MACHINE_SEED, 'gitporter::v1::salt', 32);
  return _key;
}

function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const buf = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + buf.toString('base64');
}

function dec(payload) {
  if (!payload) return '';
  if (!String(payload).startsWith('v1:')) return String(payload);
  try {
    const parts = String(payload).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', machineKey(), Buffer.from(parts[1], 'base64'));
    d.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

let config = {
  token: '',
  login: '',
  avatar: '',
  gitName: '',
  gitEmail: '',
  lastUploadDir: '',
  lastCloneDir: '',
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = Object.assign(config, raw);
  } catch (e) { /* 首次运行 */ }
}

async function saveConfig() {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  try { if (!IS_WIN) await fsp.chmod(CONFIG_FILE, 0o600); } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

async function isDirEmpty(p) {
  try {
    const list = await fsp.readdir(p);
    return list.length === 0;
  } catch (e) { return true; }
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 进程执行（流式输出，用于 git 命令）                                 */
/* ------------------------------------------------------------------ */

function runStream(cmd, args, opts, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts && opts.cwd ? opts.cwd : undefined,
        env: Object.assign({}, process.env, {
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: '',
          LC_ALL: 'C',
        }, (opts && opts.env) || {}),
        windowsHide: true,
      });
    } catch (e) {
      onLine(String(e.message || e));
      return resolve(-1);
    }

    let acc = '';
    const flush = (chunk) => {
      acc += chunk.toString('utf8');
      const parts = acc.split(/\r\n|\n|\r/);
      acc = parts.pop() || '';
      for (const line of parts) {
        if (line.trim() !== '') onLine(line);
      }
    };
    child.stdout.on('data', flush);
    child.stderr.on('data', flush);
    child.on('error', (e) => { onLine(String(e.message || e)); resolve(-1); });
    child.on('close', (code) => {
      if (acc.trim() !== '') onLine(acc.trim());
      resolve(code === null ? -1 : code);
    });
  });
}

function runCapture(cmd, args, opts) {
  const lines = [];
  return runStream(cmd, args, opts, (l) => lines.push(l)).then((code) => ({
    code,
    out: lines.join('\n').trim(),
  }));
}

/* ------------------------------------------------------------------ */
/* Git 认证：令牌只通过 http.extraheader 注入，不写入 .git/config       */
/* ------------------------------------------------------------------ */

function authArgs(token) {
  if (!token) return [];
  const basic = Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
  return [
    '-c', 'credential.helper=',
    '-c', 'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + basic,
  ];
}

function explainGitError(text) {
  const t = String(text || '');
  if (/could not read Username|Authentication failed|terminal prompts disabled|403/i.test(t)) {
    return '认证失败：令牌无效、已过期，或没有该仓库的写入权限。请到「设置」重新粘贴一个有 repo 权限的令牌。';
  }
  if (/non-fast-forward|rejected|fetch first/i.test(t)) {
    return '远程仓库已有你本地没有的提交。请先在「上传」页点「拉取最新」，再重新上传。';
  }
  if (/Repository not found|not found/i.test(t)) {
    return '找不到仓库：名字拼错了，或该令牌没有访问权限。';
  }
  if (/exceeds GitHub.s file size limit|large file|GH001/i.test(t)) {
    return '有文件超过 GitHub 的大小限制（单文件 100MB）。请把大文件加进 .gitignore 后重试。';
  }
  if (/index\.lock|another git process/i.test(t)) {
    return '另一个 git 进程正在占用这个仓库，关掉其他 Git 工具后重试。';
  }
  if (/Please tell me who you are|empty ident/i.test(t)) {
    return '缺少提交者信息。请在「设置」里填写你的 Git 用户名和邮箱。';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

async function ghApi(token, method, endpoint, body) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitPorter/1.0',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch('https://api.github.com' + endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text }; }
  if (!r.ok) {
    const err = new Error((data && data.message) || ('HTTP ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* 令牌解析顺序：请求体 > 本地配置 > gh CLI（若已登录） */
let _ghTokenCache = { value: null, at: 0 };

async function ghCliToken() {
  if (_ghTokenCache.value && Date.now() - _ghTokenCache.at < 60000) return _ghTokenCache.value;
  const r = await runCapture('gh', ['auth', 'token'], {});
  const v = r.code === 0 && /^gh[opsu]_/.test(r.out) ? r.out : '';
  _ghTokenCache = { value: v, at: Date.now() };
  return v;
}

async function effectiveToken(bodyToken) {
  if (bodyToken) return String(bodyToken).trim();
  const saved = dec(config.token);
  if (saved) return saved;
  return await ghCliToken();
}

/* ------------------------------------------------------------------ */
/* 目录扫描（体积 / 大文件 / 可疑目录）                                */
/* ------------------------------------------------------------------ */

const HEAVY_DIRS = ['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.nuxt', 'vendor', 'Pods', '.gradle', '.idea'];

async function scanDir(root) {
  let files = 0, bytes = 0, heavy = [], big = [];
  const deadline = Date.now() + 2500;
  const stack = [root];
  let guard = 0;

  while (stack.length) {
    if (Date.now() > deadline || guard > 40000) break;
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      guard++;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (cur === root && HEAVY_DIRS.includes(e.name) && !heavy.includes(e.name)) heavy.push(e.name);
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          files++; bytes += st.size;
          if (st.size > 20 * 1024 * 1024) {
            big.push({ name: path.relative(root, full), size: st.size });
          }
        } catch (e2) {}
      }
    }
  }
  big.sort((a, b) => b.size - a.size);
  return { files, bytes, heavy, big: big.slice(0, 8) };
}

/* ------------------------------------------------------------------ */
/* .gitignore 模板                                                     */
/* ------------------------------------------------------------------ */

const GITIGNORE_TEMPLATES = {
  common: `# 依赖
node_modules/
vendor/

# 构建产物
dist/
build/
out/
target/
*.exe
*.dll
*.so
*.dylib

# 环境与密钥
.env
.env.*
!.env.example
*.pem
*.key

# 日志与缓存
*.log
.cache/
tmp/
temp/

# 编辑器 / 系统
.DS_Store
Thumbs.db
desktop.ini
.idea/
.vscode/
*.swp
`,
  node: `node_modules/
npm-debug.log*
yarn-error.log*
.pnpm-store/
.npm/
.next/
.nuxt/
coverage/
*.tsbuildinfo
`,
  python: `__pycache__/
*.py[cod]
.venv/
venv/
env/
*.egg-info/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.ipynb_checkpoints/
`,
  java: `target/
build/
*.class
*.jar
.gradle/
.idea/
*.iml
`,
  go: `bin/
vendor/
*.test
*.out
`,
  rust: `target/
Cargo.lock.bak
`,
  dotnet: `bin/
obj/
*.user
.vs/
`,
  cpp: `build/
cmake-build-*/
*.o
*.obj
*.exe
`,
  unity: `[Ll]ibrary/
[Tt]emp/
[Oo]bj/
[Bb]uild/
*.csproj
*.sln
*.userprefs
`,
};

function buildGitignore(keys) {
  const picked = (keys && keys.length ? keys : ['common']).filter((k) => GITIGNORE_TEMPLATES[k]);
  const parts = [];
  for (const k of picked) {
    parts.push('# —— ' + k + ' ——\n' + GITIGNORE_TEMPLATES[k].trim());
  }
  return parts.join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* 流式响应封装                                                        */
/* ------------------------------------------------------------------ */

function streamHead(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function makeEmitter(res) {
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    send(obj) {
      if (closed) return;
      try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {}
    },
    log(text, kind) { this.send({ type: 'log', text: String(text), kind: kind || 'out' }); },
    cmd(text) { this.send({ type: 'log', text: String(text), kind: 'cmd' }); },
    step(id, status, note) { this.send({ type: 'step', id, status, note: note || '' }); },
    done(payload) { this.send(Object.assign({ type: 'done' }, payload || {})); },
    fail(message, hint) { this.send({ type: 'error', message, hint: hint || '' }); },
    end() { if (!closed) { try { res.end(); } catch (e) {} } },
  };
}

/* ------------------------------------------------------------------ */
/* 上传流程                                                            */
/* ------------------------------------------------------------------ */

/* 把每次动作的结果追加到 ~/.gitporter/activity.log，出事能倒查 */
const ACTIVITY_FILE = path.join(os.homedir(), '.gitporter', 'activity.log');
async function logEvent(tag, data) {
  try {
    await fsp.mkdir(path.dirname(ACTIVITY_FILE), { recursive: true });
    const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    await fsp.appendFile(ACTIVITY_FILE, `${t} [${tag}] ${payload}\n`, 'utf8');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

/* 仓库名清洗：空格转连字符，去掉 GitHub 不接受的符号，保留中文 */
function sanitizeRepoName(raw) {
  let n = String(raw || '').trim();
  n = n.replace(/\s+/g, '-');
  n = n.replace(/[~^:?*\[\]\\/|"'<>#%{}`]/g, '');
  n = n.replace(/^[.\-_]+|[.\-_]+$/g, '');
  return n.slice(0, 100);
}

async function handlePush(req, res, body) {
  const em = makeEmitter(res);
  streamHead(res);

  let repoUrl = '';
  await logEvent('push:start', {
    dir: body.dir, mode: body.mode, repoName: body.repoName || '', force: !!body.force,
  });
  try {
    const dir = path.resolve(String(body.dir || '').trim());
    if (!body.dir) throw new Error('请先选择要上传的项目文件夹');
    if (!(await exists(dir))) throw new Error('文件夹不存在：' + dir);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error('这不是一个文件夹：' + dir);

    const token = await effectiveToken(body.token);
    if (!token) throw new Error('没有可用的 GitHub 令牌，请先在「设置」里配置');
    const gitName = (body.gitName || config.gitName || '').trim();
    const gitEmail = (body.gitEmail || config.gitEmail || '').trim();

    /* 1. 检查 / 初始化仓库 */
    em.step('init', 'running');
    const isRepo = await exists(path.join(dir, '.git'));
    if (!isRepo) {
      em.cmd('git init -b main');
      const r = await runStream('git', ['init', '-b', 'main'], { cwd: dir }, (l) => em.log(l, 'out'));
      if (r !== 0) throw new Error('初始化 git 仓库失败');
      em.log('已在本地初始化仓库', 'ok');
    } else {
      em.log('本地已经是 git 仓库，跳过初始化', 'ok');
    }

    /* 2. 提交者身份（只写到本仓库，不动全局配置） */
    if (gitName && gitEmail) {
      await runCapture('git', ['config', 'user.name', gitName], { cwd: dir });
      await runCapture('git', ['config', 'user.email', gitEmail], { cwd: dir });
    } else {
      const gName = await runCapture('git', ['config', 'user.name'], { cwd: dir });
      const gEmail = await runCapture('git', ['config', 'user.email'], { cwd: dir });
      if (!gName.out || !gEmail.out) {
        throw new Error('缺少提交者信息：请在「设置」里填写 Git 用户名和邮箱');
      }
    }
    em.step('init', 'done');

    /* 3. 忽略规则 */
    if (body.gitignore && body.gitignore.length) {
      em.step('ignore', 'running');
      const giPath = path.join(dir, '.gitignore');
      const content = buildGitignore(body.gitignore);
      if (await exists(giPath)) {
        const old = await fsp.readFile(giPath, 'utf8');
        const missing = content.split('\n').filter((line) => {
          const t = line.trim();
          if (!t || t.startsWith('#')) return false;
          return !old.split('\n').some((o) => o.trim() === t);
        });
        if (missing.length) {
          await fsp.appendFile(giPath, '\n# —— GitPorter 追加 ——\n' + missing.join('\n') + '\n', 'utf8');
          em.log('已向现有 .gitignore 追加 ' + missing.length + ' 条规则', 'ok');
        } else {
          em.log('.gitignore 已包含所需规则', 'ok');
        }
      } else {
        await fsp.writeFile(giPath, content, 'utf8');
        em.log('已生成 .gitignore（' + body.gitignore.join(', ') + '）', 'ok');
      }
      em.step('ignore', 'done');
    }

    /* 4. README */
    if (body.readme) {
      em.step('readme', 'running');
      const rdPath = path.join(dir, 'README.md');
      if (await exists(rdPath)) {
        em.log('README.md 已存在，保留原文件', 'ok');
      } else {
        const title = body.repoName || path.basename(dir);
        const desc = (body.description || '').trim();
        const lines = ['# ' + title, ''];
        if (desc) lines.push(desc, '');
        lines.push('## 说明', '', '本项目由 GitPorter 初始化并上传到 GitHub。', '');
        await fsp.writeFile(rdPath, lines.join('\n'), 'utf8');
        em.log('已生成 README.md', 'ok');
      }
      em.step('readme', 'done');
    }

    /* 5. 暂存与提交 */
    em.step('commit', 'running');
    em.cmd('git add -A');
    await runStream('git', ['add', '-A'], { cwd: dir }, (l) => em.log(l, 'out'));

    const staged = await runCapture('git', ['diff', '--cached', '--quiet'], { cwd: dir });
    const hasCommits = (await runCapture('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir })).code === 0;

    if (staged.code === 1) {
      const msg = (body.commitMessage || '').trim() || '通过 GitPorter 上传项目';
      em.cmd('git commit -m "' + msg + '"');
      const c = await runStream('git', ['commit', '-m', msg], { cwd: dir }, (l) => em.log(l, 'out'));
      if (c !== 0) throw new Error('提交失败');
      em.log('已生成提交', 'ok');
    } else if (!hasCommits) {
      em.log('没有可提交的文件（文件夹可能是空的，或全部被 .gitignore 排除）', 'warn');
    } else {
      em.log('没有新的改动，直接同步到远程', 'ok');
    }
    em.step('commit', 'done');

    /* 6. 创建 / 绑定远程仓库 */
    em.step('remote', 'running');
    let fullName = '';
    if (body.mode === 'current') {
      const cur = await runCapture('git', ['remote', 'get-url', 'origin'], { cwd: dir });
      if (cur.code !== 0 || !cur.out) {
        throw new Error('这个文件夹还没关联远程仓库，请先用「上传到 GitHub」新建一个');
      }
      const m0 = cur.out.replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/);
      if (!m0) throw new Error('当前远程仓库不是 GitHub 地址：' + cur.out);
      fullName = m0[1] + '/' + m0[2];
      em.log('目标仓库：' + fullName, 'ok');
    } else if (body.mode === 'existing') {
      const raw = String(body.repoUrl || '').trim();
      if (!raw) throw new Error('请填写已有仓库的地址');
      const m = raw.replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/) || raw.replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)$/);
      if (!m) throw new Error('仓库地址格式不对，示例：https://github.com/用户名/仓库名');
      fullName = m[1] + '/' + m[2];
      em.log('使用已有仓库：' + fullName, 'ok');
    } else {
      const rawName = String(body.repoName || '').trim();
      if (!rawName) throw new Error('请填写仓库名');
      const repoName = sanitizeRepoName(rawName);
      if (!repoName) throw new Error('仓库名不能全是符号，请换一个');
      if (!/^[\p{L}\p{N}._-]+$/u.test(repoName)) {
        throw new Error('仓库名里不能有这些符号：空格 ~ ^ : ? * [ ] \\ / | " \' < > ，换一个名字或从文件夹名里挑几个字');
      }
      if (repoName !== rawName) em.log('仓库名按 GitHub 规则整理为 ' + repoName, 'warn');
      em.log('正在 GitHub 上创建仓库 ' + repoName + ' …', 'info');
      try {
        const me = await ghApi(token, 'GET', '/user');
        const owner = (body.owner || '').trim() || me.login;
        const endpoint = body.owner && body.owner !== me.login ? '/orgs/' + owner + '/repos' : '/user/repos';
        const repo = await ghApi(token, 'POST', endpoint, {
          name: repoName,
          description: (body.description || '').trim() || undefined,
          private: !!body.private,
          auto_init: false,
          has_issues: true,
          has_wiki: false,
        });
        fullName = repo.full_name;
        repoUrl = repo.html_url;
        em.log('仓库已创建：' + repoUrl, 'ok');
      } catch (e) {
        await logEvent('push:create-repo-fail', {
          repoName, status: e.status || 0, message: e.message,
          endpoint, owner: (body.owner || '') || 'self',
        });
        if (e.status === 422) {
          throw new Error('仓库名 "' + repoName + '" 已存在（或名称不合法）。换个名字，或改用「替换远程版本」推到已有仓库。');
        }
        if (e.status === 401) throw new Error('令牌无效或已过期，请到「设置」重新配置');
        if (e.status === 403) throw new Error('令牌权限不足（需要在 Settings → Developer settings 中勾选 repo 权限）');
        throw new Error('创建仓库失败：' + e.message);
      }
    }

    if (!repoUrl) repoUrl = 'https://github.com/' + fullName;

    const remoteUrl = 'https://github.com/' + fullName + '.git';
    const cur = await runCapture('git', ['remote', 'get-url', 'origin'], { cwd: dir });
    if (cur.code === 0 && cur.out) {
      if (cur.out !== remoteUrl) {
        em.log('原 origin 指向 ' + cur.out + '，已改为 ' + remoteUrl, 'warn');
        await runCapture('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: dir });
      } else {
        em.log('远程仓库已关联：' + remoteUrl, 'ok');
      }
    } else {
      await runCapture('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
      em.log('已关联远程仓库 origin', 'ok');
    }
    em.step('remote', 'done');

    /* 7. 推送 */
    em.step('push', 'running');
    const br = await runCapture('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir });
    const branch = (br.out || 'main').trim();
    const pushArgs = authArgs(token).concat(['push', '-u', 'origin', branch]);
    if (body.force) pushArgs.push('--force');
    em.cmd('git push -u origin ' + branch + (body.force ? ' --force' : ''));

    let pErr = [];
    const pCode = await runStream('git', pushArgs, { cwd: dir }, (l) => {
      pErr.push(l);
      em.log(l, /error|fatal|rejected/i.test(l) ? 'err' : 'out');
    });

    if (pCode !== 0) {
      const hint = explainGitError(pErr.join('\n'));
      await logEvent('push:git-fail', { dir, fullName, code: pCode, tail: pErr.slice(-6).join(' | ') });
      em.fail('推送失败', hint);
      em.end();
      return;
    }
    em.step('push', 'done');
    em.log('上传完成 ✓', 'ok');

    config.lastUploadDir = dir;
    await saveConfig();

    await logEvent('push:ok', { dir, fullName, repoUrl, branch });
    em.done({ repoUrl, fullName, branch, dir });
    em.end();
  } catch (e) {
    await logEvent('push:fail', {
      dir: body.dir, mode: body.mode, repoName: body.repoName || '',
      message: e.message || String(e), status: e.status || 0,
    });
    em.fail(e.message || String(e), explainGitError(e.message));
    em.end();
  }
}

/* ------------------------------------------------------------------ */
/* 下载（clone）流程                                                   */
/* ------------------------------------------------------------------ */

async function handleClone(req, res, body) {
  const em = makeEmitter(res);
  streamHead(res);
  try {
    let raw = String(body.url || '').trim();
    if (!raw) throw new Error('请填写仓库地址');
    if (/^[\w.-]+\/[\w.-]+$/.test(raw)) raw = 'https://github.com/' + raw;

    let url = raw;
    if (/^git@github\.com:/.test(url)) {
      url = 'https://github.com/' + url.replace(/^git@github\.com:/, '');
    }
    if (!/^https?:\/\//.test(url)) throw new Error('地址格式不对，示例：https://github.com/用户名/仓库名');

    let name = String(body.name || '').trim();
    if (!name) {
      name = url.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop();
    }
    const parent = path.resolve(String(body.parentDir || '').trim() || path.join(os.homedir(), 'gitprojects'));
    const target = path.join(parent, name);

    if (await exists(target)) {
      if (!(await isDirEmpty(target))) {
        throw new Error('目标位置已存在同名文件夹：' + target + '（请换个名字或换一个父目录）');
      }
    }
    await fsp.mkdir(parent, { recursive: true });

    const token = await effectiveToken(body.token);
    const args = authArgs(token).concat(['clone', '--progress']);
    if (body.depth === '1') args.push('--depth', '1');
    if (body.branch) args.push('-b', String(body.branch).trim());
    args.push(url, name);

    em.step('clone', 'running');
    em.cmd('git clone ' + url + ' → ' + target);

    const errs = [];
    const code = await runStream('git', args, { cwd: parent }, (l) => {
      errs.push(l);
      const clean = l.replace(/\s+/g, ' ').trim();
      em.log(clean, /error|fatal/i.test(clean) ? 'err' : 'out');
    });

    if (code !== 0) {
      const joined = errs.join('\n');
      let hint = explainGitError(joined);
      if (/already exists and is not an empty directory/i.test(joined)) hint = '目标文件夹已存在，请换一个名字';
      if (/Remote branch .* not found/i.test(joined)) hint = '指定的分支不存在，换个分支名试试';
      em.fail('下载失败', hint);
      em.end();
      return;
    }

    em.step('clone', 'done');
    em.log('下载完成 ✓', 'ok');
    config.lastCloneDir = parent;
    await saveConfig();
    em.done({ dir: target, name });
    em.end();
  } catch (e) {
    em.fail(e.message || String(e), explainGitError(e.message));
    em.end();
  }
}

/* ------------------------------------------------------------------ */
/* 拉取最新（pull）                                                    */
/* ------------------------------------------------------------------ */

async function handlePull(req, res, body) {
  const em = makeEmitter(res);
  streamHead(res);
  try {
    const dir = path.resolve(String(body.dir || '').trim());
    if (!(await exists(path.join(dir, '.git')))) throw new Error('这个文件夹不是 git 仓库');
    const token = await effectiveToken(body.token);
    const errs = [];

    em.step('fetch', 'running');
    em.cmd('git fetch --all --prune');
    let code = await runStream('git', authArgs(token).concat(['fetch', '--all', '--prune']), { cwd: dir }, (l) => {
      errs.push(l); em.log(l, /error|fatal/i.test(l) ? 'err' : 'out');
    });
    if (code !== 0) { em.fail('拉取失败', explainGitError(errs.join('\n'))); em.end(); return; }
    em.step('fetch', 'done');

    em.step('merge', 'running');
    em.cmd('git pull --ff-only');
    code = await runStream('git', authArgs(token).concat(['pull', '--ff-only']), { cwd: dir }, (l) => {
      errs.push(l); em.log(l, /error|fatal/i.test(l) ? 'err' : 'out');
    });
    if (code !== 0) {
      em.fail('更新失败', '本地有改动或与远程分叉，无法快进合并。请先提交本地改动，或手动处理冲突。');
      em.end();
      return;
    }
    em.step('merge', 'done');
    em.log('已是最新 ✓', 'ok');
    em.done({ dir });
    em.end();
  } catch (e) {
    em.fail(e.message || String(e), explainGitError(e.message));
    em.end();
  }
}

/* ------------------------------------------------------------------ */
/* 目录浏览                                                            */
/* ------------------------------------------------------------------ */

function winDrives() {
  const out = [];
  for (let i = 67; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\';
    try { if (fs.existsSync(d)) out.push(d); } catch (e) {}
  }
  return out;
}

async function listDir(input) {
  let dir = String(input || '').trim();
  if (!dir) dir = os.homedir();
  dir = path.resolve(dir);

  let fallback = null;
  if (!(await exists(dir))) {
    // 输入了不存在的路径：逐级向上找最近的已存在目录，并告诉前端跳到了哪
    const asked = dir;
    let cur = dir;
    for (let i = 0; i < 16; i++) {
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
      if (await exists(cur)) { fallback = asked; dir = cur; break; }
    }
    if (!fallback) throw new Error('路径不存在：' + asked);
  }
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) { fallback = dir; dir = path.dirname(dir); }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    dirs.push({ name: e.name, path: path.join(dir, e.name), hidden: e.name.startsWith('.') || e.name.startsWith('$') });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const parent = path.dirname(dir);
  return {
    path: dir,
    requested: String(input || '').trim(),
    fallback,
    parent: parent === dir ? null : parent,
    isGitRepo: await exists(path.join(dir, '.git')),
    empty: dirs.length === 0 && entries.length === 0,
    dirs: dirs.slice(0, 500),
    drives: IS_WIN ? winDrives() : [],
    home: os.homedir(),
    sep: path.sep,
  };
}

/* ------------------------------------------------------------------ */
/* 本地项目体检                                                        */
/* ------------------------------------------------------------------ */

async function inspectDir(input) {
  const dir = path.resolve(String(input || '').trim() || os.homedir());
  if (!(await exists(dir))) return { ok: false, error: '路径不存在' };

  const isRepo = await exists(path.join(dir, '.git'));
  const result = {
    ok: true, dir, isRepo, name: path.basename(dir),
    branch: '', remote: '', changes: 0, untracked: 0, lastCommit: '',
  };

  if (isRepo) {
    result.branch = (await runCapture('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir })).out;
    result.remote = (await runCapture('git', ['remote', 'get-url', 'origin'], { cwd: dir })).out;
    const m = (result.remote || '').replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/);
    if (m) result.remoteFullName = m[1] + '/' + m[2];
    const st = (await runCapture('git', ['status', '--porcelain'], { cwd: dir })).out;
    const lines = st ? st.split('\n') : [];
    result.untracked = lines.filter((l) => l.startsWith('??')).length;
    result.changes = lines.length - result.untracked;
    result.lastCommit = (await runCapture('git', ['log', '-1', '--pretty=%s|%cr'], { cwd: dir })).out;
    const ahead = (await runCapture('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: dir }));
    if (ahead.code === 0) result.ahead = Number(ahead.out || 0);
  }

  const scan = await scanDir(dir);
  result.files = scan.files;
  result.bytes = scan.bytes;
  result.heavy = scan.heavy;
  result.big = scan.big;
  result.suggest = await suggestIgnores(dir, scan.heavy);
  return result;
}

/* 根据项目里的标志性文件，自动决定该忽略什么 */
async function suggestIgnores(dir, heavy) {
  const keys = ['common'];
  const has = async (f) => exists(path.join(dir, f));
  if ((await has('package.json')) || (await has('node_modules'))) keys.push('node');
  if ((await has('requirements.txt')) || (await has('pyproject.toml')) || (await has('setup.py')) || (await has('.venv'))) keys.push('python');
  if ((await has('pom.xml')) || (await has('build.gradle')) || (await has('build.gradle.kts'))) keys.push('java');
  if (await has('go.mod')) keys.push('go');
  if (await has('Cargo.toml')) keys.push('rust');
  if ((await has('Assets')) && (await has('ProjectSettings'))) keys.push('unity');
  const dotnet = (await fsp.readdir(dir).catch(() => [])).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
  if (dotnet) keys.push('dotnet');
  for (const h of heavy || []) {
    if (h === 'build' || h === 'dist' || h === '.next') { /* common 已覆盖 */ }
  }
  return Array.from(new Set(keys));
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const file = path.join(PUBLIC_DIR, rel);
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

let _gitVer = '';
async function gitVersion() {
  if (_gitVer) return _gitVer;
  const r = await runCapture('git', ['--version'], {});
  _gitVer = r.code === 0 ? r.out.replace(/^git version\s*/i, '').trim() : '';
  return _gitVer;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p === '/api/state') {
      const savedToken = dec(config.token);
      const ghTok = await ghCliToken();
      return json(res, 200, {
        hasToken: !!(savedToken || ghTok),
        tokenSource: savedToken ? 'saved' : (ghTok ? 'gh' : ''),
        login: config.login || '',
        avatar: config.avatar || '',
        gitName: config.gitName || '',
        gitEmail: config.gitEmail || '',
        lastUploadDir: (await exists(config.lastUploadDir || '')) ? config.lastUploadDir : '',
        lastCloneDir: (await exists(config.lastCloneDir || '')) ? config.lastCloneDir : '',
        home: os.homedir(),
        platform: process.platform,
        gitVersion: await gitVersion(),
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.gitName !== undefined) config.gitName = String(b.gitName).trim();
      if (b.gitEmail !== undefined) config.gitEmail = String(b.gitEmail).trim();
      if (b.token !== undefined) {
        const t = String(b.token).trim();
        if (!t) {
          config.token = ''; config.login = ''; config.avatar = '';
        } else {
          try {
            const me = await ghApi(t, 'GET', '/user');
            config.token = enc(t);
            config.login = me.login;
            config.avatar = me.avatar_url;
          } catch (e) {
            return json(res, 400, { ok: false, error: e.status === 401 ? '令牌无效或已过期' : ('校验失败：' + e.message) });
          }
        }
      }
      await saveConfig();
      return json(res, 200, { ok: true, login: config.login, hasToken: !!dec(config.token) });
    }

    if (p === '/api/fs/list' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        return json(res, 200, await listDir(b.path));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/inspect' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, await inspectDir(b.path));
    }

    if (p === '/api/repos' && req.method === 'POST') {
      const b = await readBody(req);
      const token = await effectiveToken(b.token);
      if (!token) return json(res, 400, { error: '请先在「设置」里配置 GitHub 令牌' });
      try {
        const page = Number(b.page || 1);
        const list = await ghApi(token, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=' + page);
        return json(res, 200, {
          total: list.length,
          repos: list.map((r) => ({
            name: r.name,
            fullName: r.full_name,
            url: r.html_url,
            cloneUrl: r.clone_url,
            private: r.private,
            updatedAt: r.updated_at,
            description: r.description || '',
            language: r.language || '',
            owner: r.owner.login,
          })),
        });
      } catch (e) {
        return json(res, 400, { error: e.status === 401 ? '令牌无效或已过期' : e.message });
      }
    }

    if (p === '/api/push' && req.method === 'POST') {
      const b = await readBody(req);
      return handlePush(req, res, b);
    }

    if (p === '/api/clone' && req.method === 'POST') {
      const b = await readBody(req);
      return handleClone(req, res, b);
    }

    if (p === '/api/pull' && req.method === 'POST') {
      const b = await readBody(req);
      return handlePull(req, res, b);
    }

    if (p === '/api/quit' && req.method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (req.method === 'GET') return serveStatic(res, p);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { error: e.message || String(e) });
    try { res.end(); } catch (e2) {}
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function openBrowser(url) {
  if (process.env.GITPORTER_NO_OPEN === '1') return;
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

loadConfig();

let port = PORT_START;
let attempts = 0;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && attempts < 20) {
    attempts++;
    port++;
    server.listen(port, '127.0.0.1');
  } else {
    console.error('启动失败：', e.message);
    process.exit(1);
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + port;
  console.log('');
  console.log('  GitPorter 已启动');
  console.log('  ' + url);
  console.log('  关闭这个窗口即可停止服务');
  console.log('');
  openBrowser(url);
});
