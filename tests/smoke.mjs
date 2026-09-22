import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

// 路径基于脚本自身位置推导，不依赖任何本机绝对路径（CI 也能跑）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..');
const KEY = 'todolist.vue.v1';

// Vue 运行时：优先用 tests/vendor 里的缓存，缺失时从 CDN 下载并缓存
const VUE_CACHE = path.join(HERE, 'vendor', 'vue.global.prod.js');
async function loadVue() {
  if (fs.existsSync(VUE_CACHE)) return fs.readFileSync(VUE_CACHE, 'utf8');
  const res = await fetch('https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js');
  if (!res.ok) throw new Error('无法获取 Vue 运行时，HTTP ' + res.status);
  const src = await res.text();
  fs.mkdirSync(path.dirname(VUE_CACHE), { recursive: true });
  fs.writeFileSync(VUE_CACHE, src);
  return src;
}
const vueSrc = await loadVue();
const apiSrc = fs.readFileSync(path.join(PROJ, 'js', 'api.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(PROJ, 'js', 'app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(PROJ, 'css', 'style.css'), 'utf8');
let html = fs.readFileSync(path.join(PROJ, 'index.html'), 'utf8');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/, () => `<script>${vueSrc}</script>`);
html = html.replace(/<script src="js\/api\.js"><\/script>/, () => `<script>${apiSrc}</script>`);
html = html.replace(/<script src="js\/app\.js"><\/script>/, () => `<script>${appSrc}</script>`);
html = html.replace(/<link rel="stylesheet" href="css\/style\.css">/, () => `<style>${cssSrc}</style>`);
for (const leftover of ['cdn.jsdelivr.net', 'js/api.js', 'js/app.js', 'css/style.css']) {
  if (html.includes(leftover)) throw new Error('资源未内联: ' + leftover);
}

const results = [];
const check = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? '  -> ' + extra : ''}`);
};

// 毫秒时间戳 → datetime-local 输入框的值
function inLocal(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- 假后端（内存实现，模拟 FastAPI 接口） ----------
function makeBackend() {
  const users = [];
  const todos = [];
  const calls = [];

  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
  const unb64 = s => { try { return JSON.parse(Buffer.from(s, 'base64').toString()); } catch { return null; } };
  const expSec = () => Math.floor(Date.now() / 1000) + 600;
  const tokenFor = (id, username, exp = expSec()) => 'h.' + b64({ sub: id, username, exp }) + '.s';
  const ok = (data, status = 200) => Promise.resolve({ ok: status < 300, status, json: async () => ({ ok: status < 300, data }) });
  const fail = (status, error) => Promise.resolve({ ok: false, status, json: async () => ({ ok: false, error }) });

  const REMIND_CHOICES = [5, 10, 15, 20, 25, 30];
  // 与真实后端一致的校验：区间不倒挂、提醒档位合法、设提醒必须有开始时间
  function timeError(start, end, remind) {
    if (start && end && end < start) return '结束时间不能早于开始时间';
    if (remind) {
      if (REMIND_CHOICES.indexOf(remind) < 0) return '提醒档位只能是 5/10/15/20/25/30 分钟';
      if (!start) return '设置提醒需要先选择开始时间';
    }
    return null;
  }
  const shape = t => ({
    id: t.id, text: t.text, done: !!t.done, createdAt: t.created_at,
    startAt: t.start_at || 0, endAt: t.end_at || 0, remindMinutes: t.remind_minutes || null
  });

  function userOf(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const p = unb64(authHeader.slice(7).split('.')[1] || '');
    if (!p || !p.sub || p.exp * 1000 < Date.now()) return null;
    return users.find(u => u.id === p.sub) || null;
  }

  function handle(url, opts = {}) {
    const method = opts.method || 'GET';
    const p = String(url).replace('http://127.0.0.1:8001', '').split('?')[0];
    const query = String(url).split('?')[1] || '';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const auth = (opts.headers && opts.headers.Authorization) || '';
    calls.push({ method, path: p, body });

    if (p === '/api/health') return ok({ status: 'ok', tokenTtlMinutes: 10 });

    if (p === '/api/auth/register' || p === '/api/auth/login') {
      const isReg = p.endsWith('register');
      const username = (body.username || '').trim();
      const password = body.password || '';
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail(400, '用户名需为 3-20 位字母、数字或下划线');
      if (password.length < 6) return fail(400, '密码至少 6 位');
      let user = users.find(u => u.username === username);
      if (isReg) {
        if (user) return fail(409, '该用户名已被注册');
        user = { id: 'u' + (users.length + 1), username, hash: 'mock:' + password };
        users.push(user);
      } else if (!user || user.hash !== 'mock:' + password) {
        return fail(401, '用户名或密码错误');
      }
      return ok({ user: { id: user.id, username: user.username }, token: tokenFor(user.id, user.username), expiresAt: expSec() * 1000 });
    }

    if (p === '/api/auth/refresh') {
      const u = userOf(auth);
      if (!u) return fail(401, '登录已过期，请重新登录');
      return ok({ token: tokenFor(u.id, u.username), expiresAt: expSec() * 1000 });
    }

    if (p.startsWith('/api/todos')) {
      const u = userOf(auth);
      if (!u) return fail(401, '登录已过期，请重新登录');
      const mine = () => todos.filter(t => t.user_id === u.id);
      if (p === '/api/todos' && method === 'GET') {
        return ok(mine().map(shape));
      }
      if (p === '/api/todos' && method === 'POST') {
        const err = timeError(body.startAt || 0, body.endAt || 0, body.remindMinutes || 0);
        if (err) return fail(400, err);
        const t = {
          id: body.id, user_id: u.id, text: body.text, done: 0,
          created_at: body.createdAt || Date.now(),
          start_at: body.startAt || null, end_at: body.endAt || null,
          remind_minutes: body.remindMinutes || null
        };
        todos.push(t);
        return ok(shape(t));
      }
      if (p === '/api/todos' && method === 'DELETE') {
        if (!query.includes('done=1')) return fail(400, '缺少 done=1 参数');
        const removed = mine().filter(t => t.done).length;
        for (let i = todos.length - 1; i >= 0; i--) if (todos[i].user_id === u.id && todos[i].done) todos.splice(i, 1);
        return ok({ removed });
      }
      const id = decodeURIComponent(p.replace('/api/todos/', ''));
      const t = todos.find(x => x.id === id && x.user_id === u.id);
      if (!t) return fail(404, '待办不存在');
      if (method === 'PATCH') {
        if (body.text !== undefined) t.text = body.text;
        if (body.done !== undefined) t.done = body.done ? 1 : 0;
        if ('startAt' in body) t.start_at = body.startAt || null;
        if ('endAt' in body) t.end_at = body.endAt || null;
        if ('remindMinutes' in body) t.remind_minutes = body.remindMinutes || null;
        const err = timeError(t.start_at || 0, t.end_at || 0, t.remind_minutes || 0);
        if (err) return fail(400, err);
        return ok(shape(t));
      }
      if (method === 'DELETE') {
        todos.splice(todos.indexOf(t), 1);
        return ok({ id });
      }
    }
    return fail(404, 'not found');
  }

  return { handle, users, todos, calls };
}

// ---------- 构建页面 ----------
function createDom({ backendUp = true, storage = {}, backend = null } = {}) {
  const be = backend || makeBackend();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.com/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      if (!window.AbortController) {
        window.AbortController = class { constructor() { this.signal = {}; } abort() {} };
      }
      window.fetch = backendUp
        ? (url, opts) => be.handle(url, opts || {})
        : () => Promise.reject(new Error('Failed to fetch'));
      const OrigBlob = window.Blob;
      window.blobText = '';
      window.Blob = function (parts, opts) { window.blobText = parts.join(''); return new OrigBlob(parts, opts); };
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.downloadName = '';
      window.HTMLAnchorElement.prototype.click = function () { window.downloadName = this.download; };
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    }
  });

  const doc = dom.window.document;
  const api = {
    dom,
    window: dom.window,
    doc,
    backend: be,
    errors,
    q: sel => doc.querySelector(sel),
    qa: sel => [...doc.querySelectorAll(sel)],
    tick: (ms = 40) => new Promise(r => setTimeout(r, ms)),
    items: () => [...doc.querySelectorAll('.todo-item')].filter(li => !/leave/.test(li.className)),
    tab: t => [...doc.querySelectorAll('.tabs button')].find(el => el.textContent.trim().startsWith(t)),
    actionBtn: t => [...doc.querySelectorAll('.actions button')].find(el => el.textContent.trim() === t),
    setVal(el, value) {
      el.value = value;
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    type(sel, value) {
      const el = doc.querySelector(sel);
      el.value = value;
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    key(el, k, isComposing = false) {
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, isComposing }));
    },
    store(key = KEY) {
      try { return JSON.parse(dom.window.localStorage.getItem(key)) || []; } catch { return null; }
    },
    toasts: () => [...doc.querySelectorAll('.toast')].filter(t => !/leave/.test(t.className)),
    async add(text) {
      api.type('.add-row input', text);
      await api.tick();
      doc.querySelector('.btn-add').click();
      await api.tick();
    },
    async addWithTime(text, start, end, remind) {
      api.type('.add-row input', text);
      const fields = [...doc.querySelectorAll('.add-extra input[type=datetime-local]')];
      // 失败的新增会保留已填内容，所以测试里必须显式清空
      api.setVal(fields[0], start || '');
      api.setVal(fields[1], end || '');
      if (remind) {
        const sel = doc.querySelector('.add-extra select');
        sel.value = String(remind);
        sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await api.tick();
      doc.querySelector('.btn-add').click();
      await api.tick();
    }
  };
  return api;
}

// ================= 阶段 A：后端不可用 → 本地模式（原有功能回归） =================
{
  const app = createDom({ backendUp: false });
  const { q, qa, tick, items, tab, actionBtn, type, key, store, dom } = app;
  await tick(200);

  check('后端不可用时降级为本地模式', !!q('.add-row') && /本地模式/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);
  check('挂载成功，标题渲染', q('.title')?.textContent === 'ToDoList');
  check('初始空状态文案', /还没有待办/.test(q('.empty')?.textContent || ''));
  check('初始显示底部栏（可导入）', !!q('.footer') && !!q('.actions input[type=file]'));
  check('无数据时导出按钮禁用', actionBtn('导出').disabled === true);
  check('无数据时隐藏清空按钮', !actionBtn('清空已完成'));

  check('无数据时 tab 栏仍显示', qa('.tabs button').length === 3);
  check('tab 含全部/进行中/已完成', ['全部', '进行中', '已完成'].every(t => !!tab(t)));
  check('无数据时日历仍显示', !!q('.calendar') && qa('.cal-cell').length > 27);

  type('.add-row input', '   ');
  q('.btn-add').click();
  await tick();
  check('空/纯空格输入被拦截', items().length === 0);

  const addInput = q('.add-row input');
  addInput.value = '输入法选词中';
  addInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  key(addInput, 'Enter', true);
  await tick();
  check('中文输入法回车不误提交', items().length === 0);

  type('.add-row input', '买牛奶');
  key(q('.add-row input'), 'Enter');
  await tick();
  await app.add('写周报');
  check('新增两条（回车 + 按钮）', items().length === 2, `实际 ${items().length}`);
  check('输入框已清空', q('.add-row input').value === '');
  check('统计显示 2 项未完成', /2 项未完成/.test(q('.footer').textContent));
  check('已写入本地存储', store()?.length === 2, JSON.stringify(store()));
  check('tab 数量显示正确', tab('全部').textContent.includes('2') && tab('进行中').textContent.includes('2'));

  items()[0].querySelector('input[type=checkbox]').click();
  await tick();
  check('勾选后加上完成样式', qa('.todo-item.done').length === 1);
  check('统计更新为 1 项未完成', /1 项未完成/.test(q('.footer').textContent));

  tab('已完成').click();
  await tick();
  check('筛选：已完成 = 1 条', items().length === 1 && items()[0].textContent.includes('买牛奶'));
  tab('进行中').click();
  await tick();
  check('筛选：进行中 = 1 条', items().length === 1 && items()[0].textContent.includes('写周报'));
  check('筛选高亮生效', tab('进行中').classList.contains('on'));
  tab('全部').click();
  await tick();

  const target = items().find(li => li.textContent.includes('写周报'));
  target.querySelector('.text').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  check('双击进入编辑态', !!q('.is-editing'));
  app.type('.is-editing', '写周报（周五前）');
  key(q('.is-editing'), 'Enter');
  await tick();
  check('编辑保存生效', store()?.some(t => t.text === '写周报（周五前）'), JSON.stringify(store()));

  const t2 = items().find(li => li.textContent.includes('写周报'));
  t2.querySelector('.text').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  app.type('.is-editing', '');
  key(q('.is-editing'), 'Enter');
  await tick();
  check('编辑清空视为删除', store()?.length === 1, JSON.stringify(store()));

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  check('日历格子数 = 占位 + 当月天数', qa('.cal-cell').length >= daysInMonth, `${qa('.cal-cell').length} vs ${daysInMonth}`);
  const todayCell = q('.cal-cell.today');
  check('今天格子被标记且有数据', !!todayCell && todayCell.classList.contains('has'));
  check('今天格子计数为 1', todayCell?.querySelector('i')?.textContent === '1', todayCell?.textContent);

  todayCell.click();
  await tick();
  check('点击日期出现筛选条', /只看/.test(q('.date-bar')?.textContent || ''));
  check('按日期筛选后列表 = 1 条', items().length === 1);
  q('.cal-cell.on').click();
  await tick();
  check('再次点击取消日期筛选', !q('.date-bar'));

  const headBefore = q('.cal-head span').textContent;
  q('.cal-head button:last-child').click();
  await tick();
  check('切换到下个月', q('.cal-head span').textContent !== headBefore, q('.cal-head span').textContent);
  q('.cal-head button:first-child').click();
  await tick();
  check('切回本月', q('.cal-head span').textContent === headBefore);

  actionBtn('导出').click();
  await tick();
  check('导出文件名为 csv', /^todolist-\d{4}-\d{2}-\d{2}\.csv$/.test(dom.window.downloadName), dom.window.downloadName);
  check('导出含 BOM 与中文表头', dom.window.blobText.startsWith('\ufeff"待办内容","状态","创建时间"'), JSON.stringify(dom.window.blobText.slice(0, 40)));
  check('导出行状态为是/否', /"买牛奶","是","\d{4}-\d{2}-\d{2}T/.test(dom.window.blobText), dom.window.blobText);

  q('.clear').click();
  await tick();
  check('清空已完成生效', store()?.length === 0, JSON.stringify(store()));
  check('清空后回到空状态', /还没有待办/.test(q('.empty')?.textContent || ''));

  await app.add('临时任务');
  q('.del').click();
  await tick();
  check('单项删除生效', items().length === 0 && store()?.length === 0);

  check('首页 logo 已渲染', !!q('.brand .logo') && q('.brand .logo').getAttribute('viewBox') === '0 0 40 40');
  check('logo 含清单卡片与勾', qa('.logo rect').length === 2 && !!q('.logo .logo-tick'));
  check('标题位于品牌区', q('.brand .title')?.textContent === 'ToDoList');
  check('标题 List 分色', q('.title-accent')?.textContent === 'List');

  const csv = '\ufeff待办内容,状态,创建时间\r\n'
    + '"导入项A","否","2026-01-02T03:04:05.000Z"\r\n'
    + '"导入项B, 含逗号","是",""';
  const file = new dom.window.File([csv], 't.csv', { type: 'text/csv' });
  const fileInput = q('.actions input[type=file]');
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new dom.window.Event('change'));
  await tick(300);
  check('导入 CSV 条数正确（跳过表头）', store()?.length === 2, JSON.stringify(store()));
  check('导入解析含逗号的字段', store()?.some(t => t.text === '导入项B, 含逗号' && t.done === true), JSON.stringify(store()));
  check('导入解析未完成项', store()?.some(t => t.text === '导入项A' && t.done === false));
  check('导入时间缺失时降级为今天', store()?.some(t => t.text === '导入项B, 含逗号' && t.createdAt > 0));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('本地模式运行期无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  dom.window.close();
}

// ================= 阶段 B：后端可用 → 登录页与账号流程 =================
let savedToken = '';
let savedUser = null;
const shared = makeBackend(); // 跨阶段共享，模拟同一个 MySQL 实例
{
  const app = createDom({ backendUp: true, backend: shared });
  const { q, qa, tick, items, doc, dom, backend, type, key } = app;
  await tick(200);

  check('后端可用且未登录时显示登录页', !!q('.auth') && !q('.todo-list'));
  check('登录页含登录/注册切换', qa('.auth-tabs button').length === 2);
  check('登录页含用户名与密码框', !!q('.auth input[type=text]') && !!q('.auth input[type=password]'));
  check('登录页含本地模式入口', /本地模式/.test(q('.link-btn')?.textContent || ''));

  // 错误密码
  app.type('.auth input[type=text]', 'alice');
  app.type('.auth input[type=password]', 'wrongpass');
  q('.auth form button[type=submit]').click();
  await tick(120);
  check('错误密码登录被拒并提示', /用户名或密码错误/.test(q('.auth-error')?.textContent || ''), q('.auth-error')?.textContent);

  // 切到注册并注册
  qa('.auth-tabs button')[1].click();
  await tick();
  check('切换到注册页', /注册并登录/.test(q('.auth form button[type=submit]').textContent));
  app.type('.auth input[type=text]', 'alice');
  app.type('.auth input[type=password]', 'secret123');
  q('.auth form button[type=submit]').click();
  await tick(150);
  check('注册并登录成功，进入待办页', !!q('.todo-list') && !q('.auth'));
  check('顶栏显示用户名', q('.user-name')?.textContent === 'alice', q('.user-name')?.textContent);
  check('注册写入后端用户表', backend.users.length === 1 && backend.users[0].username === 'alice');

  // 重复注册提示
  const user = backend.users[0];
  const dup = await backend.handle('http://127.0.0.1:8001/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret123' })
  });
  check('重复注册返回 409', dup.status === 409);

  await app.add('写周报');
  check('新增后列表出现 1 条', items().length === 1);
  check('新增已同步到后端', backend.todos.length === 1 && backend.todos[0].text === '写周报');
  check('新增调用 POST /api/todos', backend.calls.some(c => c.method === 'POST' && c.path === '/api/todos'));
  check('在线模式写入用户缓存', app.store('todolist.cache.' + user.id)?.length === 1);

  items()[0].querySelector('input[type=checkbox]').click();
  await tick(120);
  check('勾选同步到后端', backend.todos[0].done === 1);
  check('勾选调用 PATCH', backend.calls.some(c => c.method === 'PATCH' && c.path === '/api/todos/' + backend.todos[0].id));

  items()[0].querySelector('.del').click();
  await tick(120);
  check('删除同步到后端', backend.todos.length === 0);

  await app.add('买牛奶');
  check('后端重新有 1 条', backend.todos.length === 1);

  savedToken = dom.window.localStorage.getItem('todolist.token');
  savedUser = dom.window.localStorage.getItem('todolist.user');
  check('令牌已保存到本地存储', !!savedToken && savedToken.split('.').length === 3);
  check('用户信息已保存', !!savedUser && JSON.parse(savedUser).username === 'alice');

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('在线模式运行期无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  dom.window.close();
}

// ================= 阶段 C：带令牌重新打开 → 自动登录并载入后端数据 =================
{
  const app = createDom({ backendUp: true, backend: shared, storage: { 'todolist.token': savedToken, 'todolist.user': savedUser } });
  const { q, tick, items, dom, backend } = app;
  await tick(200);

  check('带令牌打开自动进入待办页', !!q('.todo-list') && !q('.auth'));
  check('自动登录显示用户名', q('.user-name')?.textContent === 'alice');
  check('待办从后端载入', items().length === 1 && items()[0].textContent.includes('买牛奶'), items()[0]?.textContent);

  q('.link').click();
  await tick(150);
  check('退出登录回到登录页', !!q('.auth') && !q('.todo-list'));
  check('退出后清除令牌', !dom.window.localStorage.getItem('todolist.token'));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('自动登录阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  dom.window.close();
}

// ================= 阶段 D：令牌过期 → 回到登录页并提示 =================
{
  const expired = 'h.' + Buffer.from(JSON.stringify({
    sub: JSON.parse(savedUser).id, username: 'alice', exp: Math.floor(Date.now() / 1000) - 10
  })).toString('base64') + '.s';
  const app = createDom({ backendUp: true, backend: shared, storage: { 'todolist.token': expired, 'todolist.user': savedUser } });
  const { q, tick, dom } = app;
  await tick(250);

  check('令牌过期回到登录页', !!q('.auth'));
  check('提示登录已过期', /登录已过期/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);
  check('过期后清除本地令牌', !dom.window.localStorage.getItem('todolist.token'));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('过期阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  dom.window.close();
}

// ================= 阶段 E：后端可用时手动选择本地模式 =================
{
  const app = createDom({ backendUp: true });
  const { q, tick, items, dom, backend } = app;
  await tick(200);

  q('.link-btn').click();
  await tick();
  check('本地模式入口可用', !!q('.add-row') && !!q('.auth') === false);
  check('本地模式有提示条', /本地模式/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);

  await app.add('本地任务');
  check('本地模式新增不调用后端', items().length === 1 && backend.todos.length === 0);
  check('本地模式数据写入本地键', app.store()?.length === 1, JSON.stringify(app.store()));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('本地模式（后端在线）无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  dom.window.close();
}

// ================= 阶段 F：分页（每页 5 条） =================
{
  const app = createDom({ backendUp: false });
  const { q, qa, tick, items, tab } = app;
  await tick(200);

  check('少于 5 条时不显示分页栏', !q('.pager'));
  await app.add('任务1');
  check('刚好 5 条内仍不分页', !q('.pager'));

  for (let i = 2; i <= 7; i++) await app.add('任务' + i);
  await tick();

  check('超过 5 条时出现分页栏并统计总数', !!q('.pager') && /共 7 条/.test(q('.pager').textContent), q('.pager')?.textContent);
  check('新增后跳到末页，能看到刚添加的那条', /第 2 \/ 2 页/.test(q('.pager').textContent)
    && items().length === 2 && items()[1].textContent.includes('任务7'), q('.pager')?.textContent);

  qa('.pager button')[0].click();
  await tick();
  check('第一页只渲染 5 条', items().length === 5, `实际 ${items().length}`);
  check('第一页内容是任务 1-5', items().map(i => i.textContent.trim().replace(/\s+/g, '').split('×')[0]).join(',') === '任务1,任务2,任务3,任务4,任务5',
    items().map(i => i.textContent.trim()).join('|'));
  check('第一页「上一页」禁用', qa('.pager button')[0].disabled === true);
  check('第一页「下一页」可用', qa('.pager button')[1].disabled === false);
  check('第一页页码显示 1 / 2', /第 1 \/ 2 页/.test(q('.pager').textContent), q('.pager')?.textContent);

  qa('.pager button')[1].click();
  await tick();
  check('第二页显示剩余 2 条', items().length === 2, `实际 ${items().length}`);
  check('第二页内容为最后两条', items()[0].textContent.includes('任务6') && items()[1].textContent.includes('任务7'),
    items().map(i => i.textContent.trim()).join('|'));
  check('第二页「下一页」禁用', qa('.pager button')[1].disabled === true);
  check('第二页页码显示 2 / 2', /第 2 \/ 2 页/.test(q('.pager').textContent));

  qa('.pager button')[0].click();
  await tick();
  check('返回第一页', items()[0].textContent.includes('任务1'));

  qa('.pager button')[1].click();
  await tick();
  tab('进行中').click();
  await tick();
  check('切换筛选回到第一页', /第 1 \//.test(q('.pager').textContent), q('.pager')?.textContent);
  tab('全部').click();
  await tick();

  qa('.pager button')[1].click();
  await tick();
  items()[0].querySelector('.del').click();
  await tick();
  items()[0].querySelector('.del').click();
  await tick();
  check('删到 5 条后分页栏消失', !q('.pager'));
  check('删空末页后回退到第一页', items()[0].textContent.includes('任务1'), items()[0]?.textContent);

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('分页阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  app.dom.window.close();
}

// ================= 阶段 G：开始/结束时间与提醒弹窗 =================
{
  const app = createDom({ backendUp: false });
  const { q, qa, tick, items, store, toasts } = app;
  await tick(200);

  check('新增区含开始与结束时间输入', qa('.add-extra input[type=datetime-local]').length === 2);
  check('提醒下拉含不提醒 + 6 个档位', qa('.add-extra select option').length === 7,
    String(qa('.add-extra select option').length));
  check('提醒档位为 5/10/15/20/25/30', qa('.add-extra select option').slice(1).map(o => o.value).join(',') === '5,10,15,20,25,30',
    qa('.add-extra select option').slice(1).map(o => o.value).join(','));

  const startAt = Date.now() + 120 * 60000;
  const endAt = Date.now() + 180 * 60000;
  await app.addWithTime('带时间的任务', inLocal(startAt), inLocal(endAt), 15);
  await tick();

  const saved = store()?.find(t => t.text === '带时间的任务');
  check('开始时间已写入数据', !!saved && saved.startAt > 0, JSON.stringify(saved));
  check('结束时间已写入数据', !!saved && saved.endAt > saved.startAt, JSON.stringify(saved));
  check('提醒档位已写入数据', saved?.remindMinutes === 15, String(saved?.remindMinutes));

  const li = items().find(x => x.textContent.includes('带时间的任务'));
  check('列表项显示时间区间', /\d{2}-\d{2} \d{2}:\d{2}/.test(li.querySelector('.item-meta')?.textContent || ''),
    li.querySelector('.item-meta')?.textContent);
  check('列表项显示提醒标签', /提前 15 分钟提醒/.test(li.querySelector('.remind-tag')?.textContent || ''),
    li.querySelector('.remind-tag')?.textContent);
  check('新增后时间输入被重置', qa('.add-extra input[type=datetime-local]').every(i => i.value === '')
    && q('.add-extra select').value === '0', q('.add-extra select')?.value);

  await app.addWithTime('倒挂任务', inLocal(endAt), inLocal(startAt), 0);
  await tick();
  check('结束早于开始被拦截', !store()?.some(t => t.text === '倒挂任务'), JSON.stringify(store()?.map(t => t.text)));
  check('倒挂时给出提示', /结束时间不能早于开始时间/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);

  await app.addWithTime('无开始提醒', '', '', 10);
  await tick();
  check('无开始时间设提醒被拦截', !store()?.some(t => t.text === '无开始提醒'));
  check('提示需先选择开始时间', /设置提醒需要先选择开始时间/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);
  check('被拦截时列表未增加', items().length === 1, `实际 ${items().length}`);

  // 提醒弹窗：2 分钟后开始 + 提前 30 分钟提醒 → 当前已在提醒窗口内
  await app.addWithTime('马上开始的任务', inLocal(Date.now() + 2 * 60000), '', 30);
  await tick();
  check('进入提醒窗口时弹出右下角提醒', toasts().length === 1, String(toasts().length));
  check('弹窗含待办内容', /马上开始的任务/.test(q('.toast')?.textContent || ''), q('.toast')?.textContent);
  check('弹窗含倒计时描述', /分钟后开始|已开始/.test(q('.toast-meta')?.textContent || ''), q('.toast-meta')?.textContent);
  check('弹窗容器固定在右下角', !!q('.toasts'));

  q('.toast-close').click();
  await tick();
  check('点击关闭后弹窗消失', toasts().length === 0, String(toasts().length));

  await app.addWithTime('三小时后的任务', inLocal(Date.now() + 180 * 60000), '', 5);
  await tick();
  check('未到提醒时间不弹窗', toasts().length === 0, String(toasts().length));
  check('已提醒过的待办不重复弹', !toasts().some(t => /马上开始的任务/.test(t.textContent)));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('时间与提醒阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  app.dom.window.close();
}

// ================= 阶段 H：已完成 / 未设提醒的待办不应弹窗 =================
{
  const seeded = [
    { id: 'done-1', text: '已完成的任务', done: true, createdAt: Date.now(), startAt: Date.now() + 2 * 60000, endAt: 0, remindMinutes: 30 },
    { id: 'active-1', text: '待办的任务', done: false, createdAt: Date.now(), startAt: Date.now() + 2 * 60000, endAt: 0, remindMinutes: 30 },
    { id: 'plain-1', text: '没设提醒的任务', done: false, createdAt: Date.now(), startAt: Date.now() + 2 * 60000, endAt: 0, remindMinutes: 0 }
  ];
  const app = createDom({ backendUp: false, storage: { [KEY]: JSON.stringify(seeded) } });
  const { q, tick, toasts } = app;
  await tick(250);

  const text = toasts().map(t => t.textContent).join('|');
  check('只有未完成的待办会提醒', toasts().length === 1 && /待办的任务/.test(text), text);
  check('已完成的待办不提醒', !/已完成的任务/.test(text), text);
  check('未设提醒的待办不提醒', !/没设提醒的任务/.test(text), text);

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('提醒过滤阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  app.dom.window.close();
}

// ================= 阶段 I：快捷编辑面板 =================
{
  const app = createDom({ backendUp: false });
  const { q, qa, tick, items, store, dom } = app;
  await tick(200);

  await app.add('任务A');
  await app.addWithTime('任务B', inLocal(Date.now() + 60 * 60000), '', 10);
  await tick();

  check('每条待办都有铅笔与删除按钮', items().every(li => !!li.querySelector('.edit-btn') && !!li.querySelector('.del')),
    String(items().length));
  check('按钮是 SVG 图标而非文字符号', !!q('.edit-btn svg') && !!q('.del svg')
    && q('.edit-btn').textContent.trim() === '' && q('.del').textContent.trim() === '', q('.del')?.textContent);
  check('默认不展开编辑面板', !q('.quick-edit'));

  items()[0].querySelector('.edit-btn').click();
  await tick();
  check('点铅笔展开行内面板', !!q('.quick-edit'));
  check('面板预填当前文本', q('.quick-edit .edit-input').value === '任务A', q('.quick-edit .edit-input')?.value);
  check('面板含开始与结束时间', qa('.quick-edit input[type=datetime-local]').length === 2);
  check('面板含提醒下拉与保存取消', !!q('.quick-edit select') && qa('.quick-actions button').length === 2);

  items()[1].querySelector('.edit-btn').click();
  await tick();
  check('打开另一条时前一条自动收起', qa('.quick-edit').length === 1
    && !!items()[1].querySelector('.quick-edit') && !items()[0].querySelector('.quick-edit'),
    String(qa('.quick-edit').length));
  check('面板预填已设的提醒档位', q('.quick-edit select').value === '10', q('.quick-edit select')?.value);

  app.setVal(q('.quick-edit .edit-input'), '改了又取消');
  q('.quick-actions button:last-child').click();
  await tick();
  check('取消后面板关闭', !q('.quick-edit'));
  check('取消不改动数据', store()[1].text === '任务B', JSON.stringify(store()?.map(t => t.text)));

  items()[1].querySelector('.edit-btn').click();
  await tick();
  app.setVal(q('.quick-edit .edit-input'), '改好的任务B');
  const qf = qa('.quick-edit input[type=datetime-local]');
  app.setVal(qf[0], inLocal(Date.now() + 200 * 60000));
  app.setVal(qf[1], inLocal(Date.now() + 260 * 60000));
  const qsel = q('.quick-edit select');
  qsel.value = '25';
  qsel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick();
  q('.quick-actions button:first-child').click();
  await tick();

  check('保存后面板关闭', !q('.quick-edit'));
  const saved = store()?.find(t => t.text === '改好的任务B');
  check('快捷编辑保存文本生效', !!saved, JSON.stringify(store()?.map(t => t.text)));
  check('快捷编辑保存时间生效', saved && saved.endAt > saved.startAt && saved.startAt > 0, JSON.stringify(saved));
  check('快捷编辑保存提醒档位生效', saved?.remindMinutes === 25, String(saved?.remindMinutes));
  check('列表同步显示新提醒标签', /提前 25 分钟提醒/.test(items()[1].textContent), items()[1].textContent);

  items()[0].querySelector('.edit-btn').click();
  await tick();
  app.setVal(q('.quick-edit .edit-input'), '   ');
  q('.quick-actions button:first-child').click();
  await tick();
  check('清空内容保存被拦截', !!q('.quick-edit') && /待办内容不能为空/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);
  check('被拦截时数据未变', store()[0].text === '任务A', JSON.stringify(store()?.map(t => t.text)));

  app.setVal(q('.quick-edit .edit-input'), '任务A');
  const bf = qa('.quick-edit input[type=datetime-local]');
  app.setVal(bf[0], inLocal(Date.now() + 300 * 60000));
  app.setVal(bf[1], inLocal(Date.now() + 240 * 60000));
  await tick();
  q('.quick-actions button:first-child').click();
  await tick();
  check('倒挂时间保存被拦截', !!q('.quick-edit') && /结束时间不能早于开始时间/.test(q('.warn')?.textContent || ''), q('.warn')?.textContent);

  q('.quick-actions button:last-child').click();
  await tick();
  check('关闭后回到只读态', !q('.quick-edit') && !!q('.todo-item .text'));

  // 删除 + 撤销（本地模式）
  items()[0].querySelector('.del').click();
  await tick();
  check('删除后列表少一条', items().length === 1, String(items().length));
  check('删除后出现撤销条', !!q('.undo-bar'));
  check('撤销条显示被删内容', /任务A/.test(q('.undo-bar')?.textContent || ''), q('.undo-bar')?.textContent);
  q('.undo-btn').click();
  await tick();
  check('撤销恢复到原位置', store()?.length === 2 && store()[0].text === '任务A', JSON.stringify(store()?.map(t => t.text)));
  check('撤销后撤销条消失', !q('.undo-bar'));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('快捷编辑阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  app.dom.window.close();
}

// ================= 阶段 J：在线模式下删除与撤销同步后端 =================
{
  const app = createDom({ backendUp: true });
  const { q, qa, tick, items, backend } = app;
  await tick(200);

  qa('.auth-tabs button')[1].click();
  await tick();
  app.type('.auth input[type=text]', 'undo_user');
  app.type('.auth input[type=password]', 'secret123');
  q('.auth form button[type=submit]').click();
  await tick(200);
  check('注册并登录成功', !!q('.todo-list'));

  await app.add('待删除任务');
  await app.add('保留任务');
  check('后端已有 2 条', backend.todos.length === 2, String(backend.todos.length));

  items()[0].querySelector('.del').click();
  await tick(200);
  check('删除同步到后端', backend.todos.length === 1 && backend.todos[0].text === '保留任务',
    JSON.stringify(backend.todos.map(t => t.text)));
  check('删除后列表剩 1 条', items().length === 1);
  check('出现撤销条', !!q('.undo-bar') && /待删除任务/.test(q('.undo-bar').textContent), q('.undo-bar')?.textContent);

  q('.undo-btn').click();
  await tick(200);
  check('撤销后列表恢复 2 条', items().length === 2, String(items().length));
  check('撤销恢复到原位置', items()[0].textContent.includes('待删除任务'), items().map(i => i.textContent.trim()).join('|'));
  check('撤销重新写入后端', backend.todos.length === 2 && backend.todos.some(t => t.text === '待删除任务'),
    JSON.stringify(backend.todos.map(t => t.text)));
  check('撤销记录保留原有时间字段', backend.todos.some(t => t.text === '待删除任务' && 'start_at' in t));
  check('撤销后撤销条消失', !q('.undo-bar'));

  const realErrors = app.errors.filter(e => !/Not implemented: navigation/.test(e));
  check('在线撤销阶段无 JS 报错', realErrors.length === 0, realErrors.join(' | '));
  app.dom.window.close();
}

const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
