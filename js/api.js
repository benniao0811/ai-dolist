/* 后端接口封装。挂在 window.API 上（非 ES module，保证 file:// 下也能加载）。 */
window.API = (function () {
  // 后端地址：默认本地 8001。部署到其他域名/端口时，在 index.html 的 Vue 之前
  // 加一行全局赋值即可覆盖（注意：源码里不要出现 script 闭合标签，会截断内联脚本）：
  //   window.API_BASE = 'https://api.example.com'
  const DEFAULT_BASE = 'http://127.0.0.1:8001';
  // 判断用 !== undefined：空字符串是合法的（同源反代时前端应请求相对路径 /api）
  const BASE = window.API_BASE !== undefined && window.API_BASE !== null
    ? window.API_BASE
    : DEFAULT_BASE;
  const TOKEN_KEY = 'todolist.token';
  const USER_KEY = 'todolist.user';
  const REFRESH_AHEAD = 60 * 1000; // 到期前 1 分钟自动续期

  let token = '';
  let user = null;
  let expiresAt = 0;
  let refreshTimer = null;
  let onExpired = null;

  function readKey(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function writeKey(key, value) {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) { /* 存储不可用时降级为纯内存 */ }
  }

  function decodeExp(t) {
    try {
      const seg = t.split('.')[1];
      const b64 = seg + '='.repeat((4 - (seg.length % 4)) % 4);
      return JSON.parse(atob(b64)).exp * 1000;
    } catch (e) {
      return 0;
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!token) return;
    const wait = Math.max(expiresAt - Date.now() - REFRESH_AHEAD, 5000);
    refreshTimer = setTimeout(() => {
      refresh().catch(() => { if (onExpired) onExpired(); });
    }, wait);
  }

  function setSession(data) {
    token = data.token;
    expiresAt = data.expiresAt || decodeExp(data.token);
    user = data.user || user;
    writeKey(TOKEN_KEY, token);
    writeKey(USER_KEY, JSON.stringify(user));
    scheduleRefresh();
  }

  function clearSession() {
    token = '';
    user = null;
    expiresAt = 0;
    clearTimeout(refreshTimer);
    writeKey(TOKEN_KEY, '');
    writeKey(USER_KEY, '');
  }

  try {
    token = readKey(TOKEN_KEY);
    user = JSON.parse(readKey(USER_KEY) || 'null');
    expiresAt = decodeExp(token);
  } catch (e) {
    token = '';
    user = null;
  }

  async function request(path, options) {
    const opt = options || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opt.timeout || 8000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (opt.auth !== false && token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch(BASE + path, {
        method: opt.method || 'GET',
        headers: headers,
        body: opt.body ? JSON.stringify(opt.body) : undefined,
        signal: ctrl.signal
      });
      let payload = null;
      try { payload = await res.json(); } catch (e) { /* 非 JSON 响应 */ }

      if (res.status === 401) {
        clearSession();
        const err = new Error((payload && payload.error) || '登录已过期，请重新登录');
        err.code = 401;
        throw err;
      }
      if (!res.ok || !payload || !payload.ok) {
        throw new Error((payload && payload.error) || '请求失败（' + res.status + '）');
      }
      return payload.data;
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error('请求超时');
        err.code = 'timeout';
        throw err;
      }
      if (!e.code) e.code = 'network';
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function authCall(path, username, password, extra) {
    return request(path, {
      method: 'POST',
      body: Object.assign({ username: username, password: password }, extra || {}),
      auth: false
    }).then(data => {
      setSession(data);
      return data.user;   // 返回用户对象，令牌由 setSession 保存
    });
  }

  function refresh() {
    return request('/api/auth/refresh').then(data => {
      setSession({ token: data.token, expiresAt: data.expiresAt, user: user });
      return data;
    });
  }

  return {
    session: () => ({ token: token, user: user, expiresAt: expiresAt }),
    setSession: setSession,
    clearSession: clearSession,
    onExpired: cb => { onExpired = cb; },
    health: () => request('/api/health', { auth: false, timeout: 3000 }),
    login: (username, password) => authCall('/api/auth/login', username, password),
    register: (username, password, captchaId, captchaCode) =>
      authCall('/api/auth/register', username, password, { captchaId, captchaCode }),
    refresh: refresh,
    // 注册用的图形验证码：{ id, image(data URI), ttlMinutes }
    getCaptcha: () => request('/api/captcha'),
    listTodos: () => request('/api/todos'),
    createTodo: todo => request('/api/todos', {
      method: 'POST',
      body: {
        id: todo.id,
        text: todo.text,
        createdAt: todo.createdAt,
        startAt: todo.startAt || 0,
        endAt: todo.endAt || 0,
        remindMinutes: todo.remindMinutes || 0
      }
    }),
    updateTodo: (id, patch) => request('/api/todos/' + encodeURIComponent(id), { method: 'PATCH', body: patch }),
    removeTodo: id => request('/api/todos/' + encodeURIComponent(id), { method: 'DELETE' }),
    clearDone: () => request('/api/todos?done=1', { method: 'DELETE' })
  };
})();
