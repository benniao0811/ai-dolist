const { createApp, reactive, computed, watch, nextTick, toRefs, onMounted, onUnmounted } = Vue;
const LOCAL_KEY = 'todolist.vue.v1';
const PAGE_SIZE = 5;
const REMIND_OPTIONS = [5, 10, 15, 20, 25, 30];
const REMIND_WINDOW = 60 * 60 * 1000; // 触发点之后 1 小时内才算有效提醒，避免过期任务反复弹窗

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function fmtTime(ts) {
  const d = new Date(ts);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// datetime-local 的值（YYYY-MM-DDTHH:mm）与毫秒时间戳互转
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fromLocalInput(value) {
  const ts = Date.parse(value || '');
  return isNaN(ts) ? 0 : ts;
}

function normalize(todo) {
  return {
    id: String(todo.id || uid()),
    text: todo.text,
    done: !!todo.done,
    createdAt: Number(todo.createdAt) || Date.now(),
    startAt: Number(todo.startAt) || 0,
    endAt: Number(todo.endAt) || 0,
    remindMinutes: REMIND_OPTIONS.indexOf(Number(todo.remindMinutes)) >= 0 ? Number(todo.remindMinutes) : 0
  };
}

function loadLocal() {
  try {
    const data = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (!Array.isArray(data)) return [];
    return data
      .filter(item => item && typeof item.text === 'string')
      .map(normalize);
  } catch (e) {
    return [];
  }
}

function saveTodos(key, todos) {
  try {
    localStorage.setItem(key, JSON.stringify(todos));
    return true;
  } catch (e) {
    return false;
  }
}

function csvCell(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

createApp({
  setup() {
    const now = new Date();
    const state = reactive({
      booting: true,
      mode: 'local',            // local = 浏览器本地存储；online = MySQL
      user: null,
      authMode: 'login',
      authForm: { username: '', password: '', captcha: '' },
      captcha: { id: '', image: '' },
      authError: '',
      authBusy: false,
      notice: '',
      todos: [],
      newText: '',
      newStart: '',
      newEnd: '',
      newRemind: 0,
      editText: '',
      editingId: null,
      quickEditId: null,
      quickForm: { text: '', start: '', end: '', remind: 0 },
      undo: null,
      filter: 'all',
      selectedDate: '',
      page: 1,
      viewYear: now.getFullYear(),
      viewMonth: now.getMonth(),
      storageOk: true,
      toasts: []
    });

    const notified = new Set();   // 已弹过提醒的待办 id，避免重复打扰
    let toastSeq = 0;
    const toastTimers = {};
    let remindTimer = null;
    let undoTimer = null;

    const online = computed(() => state.mode === 'online' && !!state.user);
    const showAuth = computed(() => !state.booting && state.mode === 'online' && !state.user);

    function storeKey() {
      return online.value ? 'todolist.cache.' + state.user.id : LOCAL_KEY;
    }

    function notify(message) {
      state.notice = message;
    }

    watch(() => state.todos, todos => {
      if (state.booting) return;
      state.storageOk = saveTodos(storeKey(), todos);
    }, { deep: true });

    // 启动时：后端可用则走账号体系，不可用则降级为本地模式
    async function boot() {
      state.booting = true;
      state.notice = '';
      const alive = await API.health().then(() => true).catch(() => false);
      if (!alive) {
        state.mode = 'local';
        state.user = null;
        state.todos = loadLocal();
        state.booting = false;
        return;
      }
      const session = API.session();
      if (!session.token || !session.user) {
        state.mode = 'online';
        state.user = null;
        state.todos = [];
        state.booting = false;
        return;
      }
      try {
        const list = await API.listTodos();
        state.todos = list.map(normalize);
        state.user = session.user;
        state.mode = 'online';
      } catch (e) {
        if (e.code === 401) {
          state.mode = 'online';
          state.user = null;
          notify(e.message || '登录已过期，请重新登录');
        } else {
          state.mode = 'local';
          state.user = null;
          state.todos = loadLocal();
          notify('连接服务失败，已切换到本地模式');
        }
      }
      state.booting = false;
    }

    API.onExpired(() => {
      state.user = null;
      state.mode = 'online';
      notify('登录已过期，请重新登录');
    });

    function switchAuth(mode) {
      state.authMode = mode;
      state.authError = '';
      state.authForm.captcha = '';
      // 切到注册才需要验证码，且每次进入都换一张
      if (mode === 'register' && !state.captcha.id) loadCaptcha();
    }

    async function submitAuth() {
      const username = state.authForm.username.trim();
      const password = state.authForm.password;
      if (!username || !password) {
        state.authError = '请填写用户名和密码';
        return;
      }
      if (state.authMode === 'register' && !state.authForm.captcha.trim()) {
        state.authError = '请填写右侧图片中的验证码';
        return;
      }
      state.authBusy = true;
      state.authError = '';
      try {
        state.user = state.authMode === 'login'
          ? await API.login(username, password)
          : await API.register(username, password, state.captcha.id, state.authForm.captcha.trim());
        state.todos = (await API.listTodos()).map(normalize);
        state.authForm.password = '';
        state.authForm.captcha = '';
        state.notice = '';
      } catch (e) {
        state.authError = e.message || '操作失败';
        // 验证码无论对错都会被作废，失败一律换一张
        if (state.authMode === 'register') {
          state.authForm.captcha = '';
          loadCaptcha();
        }
      } finally {
        state.authBusy = false;
      }
    }

    async function loadCaptcha() {
      try {
        const data = await API.getCaptcha();
        state.captcha = { id: data.id || '', image: data.image || '' };
      } catch (e) {
        state.captcha = { id: '', image: '' };
      }
    }

    function logout() {
      API.clearSession();
      state.user = null;
      state.todos = [];
      state.mode = 'online';
    }

    function useLocalMode() {
      API.clearSession();
      state.mode = 'local';
      state.user = null;
      state.todos = loadLocal();
    }

    const activeCount = computed(() => state.todos.filter(t => !t.done).length);
    const doneCount = computed(() => state.todos.length - activeCount.value);

    // 始终返回新数组：否则「全部」筛选下返回的是 state.todos 本身，
    // 原地 push 后引用不变，依赖它的 watch 不会触发（提醒检查会漏跑）
    const filteredTodos = computed(() => {
      let list = state.todos;
      if (state.filter === 'active') list = list.filter(t => !t.done);
      else if (state.filter === 'done') list = list.filter(t => t.done);
      if (state.selectedDate) list = list.filter(t => dayKey(t.createdAt) === state.selectedDate);
      return list.slice();
    });

    const totalPages = computed(() => Math.max(1, Math.ceil(filteredTodos.value.length / PAGE_SIZE)));
    const pagedTodos = computed(() => {
      const page = Math.min(Math.max(state.page, 1), totalPages.value);
      const from = (page - 1) * PAGE_SIZE;
      return filteredTodos.value.slice(from, from + PAGE_SIZE);
    });

    function goPage(delta) {
      const target = Math.min(Math.max(state.page + delta, 1), totalPages.value);
      state.page = target;
    }

    // 切换筛选条件回到第一页；删空当前页时自动回退
    watch([() => state.filter, () => state.selectedDate], () => { state.page = 1; });
    watch(totalPages, max => { if (state.page > max) state.page = max; });

    const emptyText = computed(() => {
      if (state.selectedDate) return state.selectedDate + ' 没有符合条件的待办';
      return {
        all: '还没有待办，先添加一项吧',
        active: '没有进行中的待办',
        done: '还没有已完成的待办'
      }[state.filter];
    });

    const calendar = computed(() => {
      const y = state.viewYear;
      const m = state.viewMonth;
      const counts = {};
      state.todos.forEach(t => {
        const k = dayKey(t.createdAt);
        counts[k] = (counts[k] || 0) + 1;
      });
      const pad2 = (new Date(y, m, 1).getDay() + 6) % 7;
      const days = new Date(y, m + 1, 0).getDate();
      const cells = new Array(pad2).fill(null);
      for (let d = 1; d <= days; d++) {
        const key = y + '-' + pad(m + 1) + '-' + pad(d);
        cells.push({ key: key, day: d, count: counts[key] || 0 });
      }
      return cells;
    });

    function timeRange(todo) {
      if (!todo.startAt && !todo.endAt) return '';
      if (todo.startAt && todo.endAt) {
        if (dayKey(todo.startAt) === dayKey(todo.endAt)) {
          const e = new Date(todo.endAt);
          return fmtTime(todo.startAt) + '–' + pad(e.getHours()) + ':' + pad(e.getMinutes());
        }
        return fmtTime(todo.startAt) + ' → ' + fmtTime(todo.endAt);
      }
      return (todo.startAt ? '开始 ' : '截止 ') + fmtTime(todo.startAt || todo.endAt);
    }

    function remindCountdown(todo) {
      const diff = todo.startAt - Date.now();
      if (diff <= 0) return '已开始';
      const minutes = Math.max(1, Math.round(diff / 60000));
      return minutes >= 60 ? '约 ' + Math.round(minutes / 60) + ' 小时后开始' : minutes + ' 分钟后开始';
    }

    function dismissToast(id) {
      state.toasts = state.toasts.filter(t => t.id !== id);
      clearTimeout(toastTimers[id]);
      delete toastTimers[id];
    }

    function pushToast(todo) {
      const id = ++toastSeq;
      state.toasts.push({
        id: id,
        text: todo.text,
        time: timeRange(todo) || fmtTime(todo.startAt),
        countdown: remindCountdown(todo)
      });
      toastTimers[id] = setTimeout(() => dismissToast(id), 10000);
    }

    function checkReminders() {
      const ts = Date.now();
      state.todos.forEach(todo => {
        if (todo.done || !todo.startAt || !todo.remindMinutes || notified.has(todo.id)) return;
        const trigger = todo.startAt - todo.remindMinutes * 60000;
        if (ts >= trigger && ts - trigger <= REMIND_WINDOW) {
          notified.add(todo.id);
          pushToast(todo);
        }
      });
    }

    watch(filteredTodos, () => checkReminders());

    async function addTodo(e) {
      if (e && e.isComposing) return;
      const text = state.newText.trim();
      if (!text) return;
      const startAt = fromLocalInput(state.newStart);
      const endAt = fromLocalInput(state.newEnd);
      if (startAt && endAt && endAt < startAt) {
        notify('结束时间不能早于开始时间');
        return;
      }
      if (state.newRemind && !startAt) {
        notify('设置提醒需要先选择开始时间');
        return;
      }
      const todo = {
        id: uid(),
        text: text,
        done: false,
        createdAt: Date.now(),
        startAt: startAt,
        endAt: endAt,
        remindMinutes: Number(state.newRemind) || 0
      };
      state.todos.push(todo);
      state.newText = '';
      state.newStart = '';
      state.newEnd = '';
      state.newRemind = 0;
      notify('');
      nextTick(() => { state.page = totalPages.value; });
      if (!online.value) return;
      try {
        await API.createTodo(todo);
      } catch (err) {
        state.todos = state.todos.filter(t => t.id !== todo.id);
        notify('新增失败：' + err.message);
      }
    }

    async function toggleDone(todo) {
      const prev = todo.done;
      todo.done = !prev;
      if (!online.value) return;
      try {
        await API.updateTodo(todo.id, { done: todo.done });
      } catch (err) {
        todo.done = prev;
        notify('更新失败：' + err.message);
      }
    }

    // 删除后可撤销：先本地移除并记住原位置，8 秒内可一键恢复
    async function removeTodo(id) {
      const index = state.todos.findIndex(t => t.id === id);
      if (index < 0) return;
      const todo = state.todos[index];
      state.todos.splice(index, 1);
      state.undo = { todo: todo, index: index };
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => { state.undo = null; }, 8000);
      if (!online.value) return;
      try {
        await API.removeTodo(id);
      } catch (err) {
        state.todos.splice(index, 0, todo);
        state.undo = null;
        notify('删除失败：' + err.message);
      }
    }

    async function undoDelete() {
      const item = state.undo;
      if (!item) return;
      clearTimeout(undoTimer);
      state.undo = null;
      state.todos.splice(Math.min(item.index, state.todos.length), 0, item.todo);
      if (!online.value) return;
      try {
        await API.createTodo(item.todo); // 后端那条已真删，恢复即重新创建
      } catch (err) {
        state.todos = state.todos.filter(t => t.id !== item.todo.id);
        notify('撤销失败：' + err.message);
      }
    }

    async function clearDone() {
      if (!doneCount.value) return;
      if (!confirm('确定清空已完成的 ' + doneCount.value + ' 项待办？')) return;
      const backup = state.todos;
      const removed = backup.filter(t => t.done).map(t => t.id);
      state.todos = backup.filter(t => !t.done);
      if (!online.value) return;
      try {
        await API.clearDone();
      } catch (err) {
        state.todos = backup;
        notify('清空失败：' + err.message + '（' + removed.length + ' 项已恢复）');
      }
    }

    function startEdit(todo) {
      state.editingId = todo.id;
      state.editText = todo.text;
      nextTick(() => {
        const el = document.querySelector('.is-editing');
        if (el) el.focus();
      });
    }

    async function saveEdit(e) {
      if (e && e.isComposing) return;
      const todo = state.todos.find(t => t.id === state.editingId);
      state.editingId = null;
      if (!todo) return;
      const text = state.editText.trim();
      if (!text) {
        await removeTodo(todo.id);
        return;
      }
      if (text === todo.text) return;
      const prev = todo.text;
      todo.text = text;
      if (!online.value) return;
      try {
        await API.updateTodo(todo.id, { text: text });
      } catch (err) {
        todo.text = prev;
        notify('保存失败：' + err.message);
      }
    }

    function cancelEdit() {
      state.editingId = null;
    }

    // 快捷编辑：点铅笔按钮展开行内面板，文本与时间、提醒一起改
    function openQuickEdit(todo) {
      state.editingId = null;
      state.quickEditId = todo.id;
      state.quickForm = {
        text: todo.text,
        start: toLocalInput(todo.startAt),
        end: toLocalInput(todo.endAt),
        remind: todo.remindMinutes || 0
      };
    }

    function cancelQuickEdit() {
      state.quickEditId = null;
    }

    async function saveQuickEdit(todo) {
      const text = state.quickForm.text.trim();
      if (!text) {
        notify('待办内容不能为空');
        return;
      }
      const startAt = fromLocalInput(state.quickForm.start);
      const endAt = fromLocalInput(state.quickForm.end);
      if (startAt && endAt && endAt < startAt) {
        notify('结束时间不能早于开始时间');
        return;
      }
      const remindMinutes = Number(state.quickForm.remind) || 0;
      if (remindMinutes && !startAt) {
        notify('设置提醒需要先选择开始时间');
        return;
      }

      const prev = {
        text: todo.text, startAt: todo.startAt,
        endAt: todo.endAt, remindMinutes: todo.remindMinutes
      };
      const patch = { text: text, startAt: startAt, endAt: endAt, remindMinutes: remindMinutes };
      Object.assign(todo, patch);
      state.quickEditId = null;
      notify('');
      if (!online.value) return;
      try {
        await API.updateTodo(todo.id, patch);
      } catch (err) {
        Object.assign(todo, prev);
        notify('保存失败：' + err.message);
      }
    }

    function shiftMonth(delta) {
      let m = state.viewMonth + delta;
      let y = state.viewYear;
      if (m < 0) { m = 11; y -= 1; }
      if (m > 11) { m = 0; y += 1; }
      state.viewMonth = m;
      state.viewYear = y;
    }

    function pickDate(cell) {
      if (!cell.count) return;
      state.selectedDate = state.selectedDate === cell.key ? '' : cell.key;
    }

    function exportTodos() {
      const head = ['待办内容', '状态', '创建时间', '开始时间', '结束时间', '提前提醒分钟'];
      const rows = [head.map(csvCell).join(',')];
      const iso = ts => (ts ? new Date(ts).toISOString() : '');
      state.todos.forEach(t => {
        rows.push([t.text, t.done ? '是' : '否', iso(t.createdAt), iso(t.startAt), iso(t.endAt),
          t.remindMinutes || ''].map(csvCell).join(','));
      });
      const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'todolist-' + dayKey(Date.now()) + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    function readItems(readerResult) {
      return String(readerResult).replace(/^\ufeff/, '').split(/\r?\n/).filter(l => l.trim())
        .reduce((acc, line, i) => {
          const cells = parseCsvLine(line);
          if (i === 0 && /(待办内容|^text$)/i.test(cells[0].trim())) return acc;
          const text = (cells[0] || '').trim();
          if (!text) return acc;
          const ts = Date.parse(cells[2]);
          const start = Date.parse(cells[3]);
          const end = Date.parse(cells[4]);
          const remind = Number(cells[5]);
          acc.push(normalize({
            id: uid(),
            text: text,
            done: /^(是|true|1|yes|已完成)$/i.test((cells[1] || '').trim()),
            createdAt: isNaN(ts) ? Date.now() : ts,
            startAt: isNaN(start) ? 0 : start,
            endAt: isNaN(end) ? 0 : end,
            remindMinutes: REMIND_OPTIONS.indexOf(remind) >= 0 ? remind : 0
          }));
          return acc;
        }, []);
    }

    async function importTodos(e) {
      const input = e.target;
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const items = readItems(reader.result);
        if (!items.length) {
          alert('没有解析到可导入的待办');
          input.value = '';
          return;
        }
        if (!online.value) {
          state.todos.push(...items);
          alert('成功导入 ' + items.length + ' 项待办');
        } else {
          let okCount = 0;
          for (const item of items) {
            try {
              await API.createTodo(item);
              state.todos.push(item);
              okCount++;
            } catch (err) {
              notify('导入中断：' + err.message);
              break;
            }
          }
          alert('成功导入 ' + okCount + ' 项待办');
        }
        input.value = '';
      };
      reader.readAsText(file, 'utf-8');
    }

    onMounted(() => {
      boot().then(checkReminders);
      remindTimer = setInterval(checkReminders, 30000);
    });

    onUnmounted(() => {
      clearInterval(remindTimer);
      clearTimeout(undoTimer);
      Object.keys(toastTimers).forEach(id => clearTimeout(toastTimers[id]));
    });

    return {
      ...toRefs(state),
      weekNames: ['一', '二', '三', '四', '五', '六', '日'],
      remindOptions: REMIND_OPTIONS,
      pageSize: PAGE_SIZE,
      todayKey: dayKey(Date.now()),
      showAuth, online,
      boot, switchAuth, submitAuth, logout, useLocalMode, loadCaptcha,
      addTodo, toggleDone, removeTodo, undoDelete, clearDone, startEdit, saveEdit, cancelEdit,
      openQuickEdit, cancelQuickEdit, saveQuickEdit,
      shiftMonth, pickDate, exportTodos, importTodos,
      filteredTodos, pagedTodos, totalPages, goPage,
      activeCount, doneCount, emptyText, calendar,
      timeRange, dismissToast, checkReminders
    };
  }
}).mount('#app');
