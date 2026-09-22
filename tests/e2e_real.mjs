/* 真后端端到端验证：jsdom 加载真实页面，直连 127.0.0.1:8001 的 FastAPI + MySQL。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..');
export const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8001';

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
let html = fs.readFileSync(path.join(PROJ, 'index.html'), 'utf8');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/, () => `<script>${vueSrc}</script>`);
html = html.replace(/<script src="js\/api\.js"><\/script>/, () => `<script>${apiSrc}</script>`);
html = html.replace(/<script src="js\/app\.js"><\/script>/, () => `<script>${appSrc}</script>`);
html = html.replace(/<link rel="stylesheet" href="css\/style\.css">/, '');

const results = [];
const check = (name, cond, extra = '') => {
  results.push(cond);
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra ? '  -> ' + extra : ''));
};

function createDom(storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8000/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.API_BASE = API_BASE; // 让 js/api.js 指向被测后端
      window.confirm = () => true;
      window.alert = () => {};
      window.fetch = (url, opts = {}) => {
        const { signal, ...rest } = opts; // jsdom 的 signal 不是 Node 的 AbortSignal
        return fetch(String(url), rest);
      };
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    }
  });
  return { dom, doc: dom.window.document, errors, tick: (ms = 60) => new Promise(r => setTimeout(r, ms)) };
}

// 每次运行换一个用户名，避免重复运行时撞上已注册账号
const USER = 'e2e_user_' + Date.now().toString().slice(-8);
const PASS = 'e2e123456';

const a = createDom();
const q = sel => a.doc.querySelector(sel);
const qa = sel => [...a.doc.querySelectorAll(sel)];
await a.tick(500);

check('真实后端健康检查通过，进入登录页', !!q('.auth'), q('.auth') ? '' : '未显示登录页');

qa('.auth-tabs button')[1].click();          // 切到注册
await a.tick();
const inputs = qa('.auth input');
for (const el of inputs) {
  el.value = el.type === 'password' ? PASS : USER;
  el.dispatchEvent(new a.dom.window.Event('input', { bubbles: true }));
}
await a.tick();
q('.auth form button[type=submit]').click();
await a.tick(600);

check('注册并登录成功（真实接口）', !!q('.todo-list') && q('.user-name')?.textContent === USER, q('.auth-error')?.textContent || q('.user-name')?.textContent);

async function addTodo(text) {
  const input = q('.add-row input');
  input.value = text;
  input.dispatchEvent(new a.dom.window.Event('input', { bubbles: true }));
  await a.tick();
  q('.btn-add').click();
  await a.tick(400);
}
await addTodo('E2E 中文测试');
await addTodo('E2E second task');

const items = () => qa('.todo-item').filter(li => !/leave/.test(li.className));
check('两条待办已渲染', items().length === 2, String(items().length));

// 带开始/结束时间与提醒的待办
function inLocal(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
const START = Date.now() + 45 * 60000;
const END = Date.now() + 105 * 60000;
async function addTodoWithTime(text, start, end, remind) {
  const input = q('.add-row input');
  input.value = text;
  input.dispatchEvent(new a.dom.window.Event('input', { bubbles: true }));
  const fields = qa('.add-extra input[type=datetime-local]');
  fields[0].value = inLocal(start);
  fields[0].dispatchEvent(new a.dom.window.Event('input', { bubbles: true }));
  fields[1].value = inLocal(end);
  fields[1].dispatchEvent(new a.dom.window.Event('input', { bubbles: true }));
  const sel = q('.add-extra select');
  sel.value = String(remind);
  sel.dispatchEvent(new a.dom.window.Event('change', { bubbles: true }));
  await a.tick();
  q('.btn-add').click();
  await a.tick(400);
}
await addTodoWithTime('E2E 带时间的任务', START, END, 20);

const timed = items().find(li => li.textContent.includes('E2E 带时间的任务'));
check('带时间待办已渲染', !!timed, items().map(li => li.textContent.trim()).join('|'));
check('列表显示时间区间', /\d{2}-\d{2} \d{2}:\d{2}/.test(timed?.querySelector('.item-meta')?.textContent || ''),
  timed?.querySelector('.item-meta')?.textContent);
check('列表显示提醒标签', /提前 20 分钟提醒/.test(timed?.textContent || ''), timed?.textContent);

const token = a.dom.window.localStorage.getItem('todolist.token');
const userJson = a.dom.window.localStorage.getItem('todolist.user');

// 直接查接口，确认时间字段真的写进了 MySQL
const apiList = await (await fetch(API_BASE + '/api/todos', {
  headers: { Authorization: 'Bearer ' + token }
})).json();
const row = (apiList.data || []).find(t => t.text === 'E2E 带时间的任务');
check('开始时间已写入 MySQL', !!row && Math.abs(row.startAt - START) < 60000, JSON.stringify(row));
check('结束时间已写入 MySQL', !!row && Math.abs(row.endAt - END) < 60000, JSON.stringify(row));
check('提醒档位已写入 MySQL', row?.remindMinutes === 20, String(row?.remindMinutes));
check('开始时间早于结束时间', row && row.startAt < row.endAt);

check('令牌已写入本地存储', !!token && token.split('.').length === 3);

// 重新打开页面，应自动登录并从 MySQL 载入
const b = createDom({ 'todolist.token': token, 'todolist.user': userJson });
await b.tick(700);
const itemsB = [...b.doc.querySelectorAll('.todo-item')].filter(li => !/leave/.test(li.className));
check('重开页面自动登录', !!b.doc.querySelector('.todo-list') && b.doc.querySelector('.user-name')?.textContent === USER);
check('待办从 MySQL 载入（3 条）', itemsB.length === 3, String(itemsB.length));
check('中文内容完整保留', itemsB.some(li => li.textContent.includes('E2E 中文测试')), itemsB.map(li => li.textContent).join('|'));
const timedReloaded = itemsB.find(li => li.textContent.includes('E2E 带时间的任务'));
check('重开后时间区间仍在', /\d{2}-\d{2} \d{2}:\d{2}/.test(timedReloaded?.querySelector('.item-meta')?.textContent || ''),
  timedReloaded?.querySelector('.item-meta')?.textContent);
check('重开后提醒档位仍在', /提前 20 分钟提醒/.test(timedReloaded?.textContent || ''), timedReloaded?.textContent);

// 勾选 → 写库
itemsB[0].querySelector('input[type=checkbox]').click();
await b.tick(600);
const c = createDom({ 'todolist.token': token, 'todolist.user': userJson });
await c.tick(700);
const doneItems = [...c.doc.querySelectorAll('.todo-item.done')];
check('勾选完成后重新载入仍为已完成', doneItems.length === 1, String(doneItems.length));

const errs = [...a.errors, ...b.errors, ...c.errors].filter(e => !/Not implemented: navigation|Error: Not implemented/.test(e));
check('运行期无 JS 报错', errs.length === 0, errs.join(' | '));

a.dom.window.close();
b.dom.window.close();
c.dom.window.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
