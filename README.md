# ToDoList

Vue 3 + FastAPI + MySQL 的待办应用。前端零构建（Vue 走 CDN），后端负责账号与数据落库。

## 项目结构

```
test-dolist/
├─ index.html          # 应用入口：页面模板 + 登录页 + Vue CDN 引入
├─ css/
│  └─ style.css        # 布局、任务状态、日历、登录页与响应式样式
├─ js/
│  ├─ api.js           # 后端接口封装（fetch + Bearer 令牌 + 自动续期）
│  └─ app.js           # Vue 应用逻辑（状态、筛选、日历、同步、导入导出）
├─ server/
│  ├─ main.py            # FastAPI：注册/登录/令牌 + 待办 CRUD
│  ├─ auth.py            # bcrypt 密码哈希 + JWT 签发校验（10 分钟）
│  ├─ db.py              # MySQL 连接（utf8mb4）
│  ├─ schema.sql         # 建库建表
│  ├─ migrate_times.py   # 旧库升级：补齐开始/结束/提醒三列（幂等）
│  ├─ requirements.txt
│  └─ .env               # 数据库与令牌配置（不进版本库）
└─ README.md
```

## 启动命令

需要同时跑后端和前端（两个终端）：

```bash
# 1) 后端：FastAPI，监听 127.0.0.1:8001
cd server
pip install -r requirements.txt
python main.py

# 2) 前端：静态服务，监听 8000
python -m http.server 8000
```

然后访问 http://localhost:8000 ，注册账号后即可使用。

首次使用先建库（只需一次）：

```bash
mysql -u root -p < server/schema.sql
```

已有旧库（没有时间字段）升级：

```bash
python server/migrate_times.py
```

## 账号与安全

| 项 | 实现 |
| --- | --- |
| 密码存储 | bcrypt（cost 12），库里只存 60 位哈希，不存明文 |
| 登录令牌 | JWT（HS256），**有效期 10 分钟** |
| 自动续期 | 页面打开期间，到期前 1 分钟自动换新令牌；关闭页面或离开超过 10 分钟需重新登录 |
| 用户名规则 | 3-20 位字母、数字、下划线；密码至少 6 位 |
| 越权访问 | 所有待办接口强制 `WHERE user_id = ?`，访问他人数据返回 404（不暴露资源是否存在） |

`.env` 里的 `JWT_SECRET` 请换成随机长字符串，且不要提交到版本库（已在 `.gitignore`）。

## 两种运行模式

- **在线模式（默认）**：登录后待办存 MySQL，换设备、换浏览器登录同一账号都能看到。
- **本地模式**：后端未启动时自动降级，或登录页点「不登录，用本地模式」。数据存浏览器 localStorage（key：`todolist.vue.v1`），不落库，顶部会提示当前是本地模式并给「重试连接」按钮。

在线模式下 localStorage 仍会写一份缓存（key：`todolist.cache.<用户id>`），仅用于离线兜底展示，不作为数据源。

## 接口

统一返回 `{ ok: true, data }` 或 `{ ok: false, error }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，前端据此判断是否降级为本地模式 |
| POST | `/api/auth/register` | 注册并直接登录 |
| POST | `/api/auth/login` | 登录，返回令牌 |
| POST | `/api/auth/refresh` | 用未过期的令牌换新令牌 |
| GET | `/api/todos` | 当前用户全部待办 |
| POST | `/api/todos` | 新增 `{ id, text, createdAt, startAt, endAt, remindMinutes }` |
| PATCH | `/api/todos/:id` | 改文本 / 完成状态 / 开始结束时间 / 提醒档位 |
| DELETE | `/api/todos/:id` | 删除单条 |
| DELETE | `/api/todos?done=1` | 清空已完成 |

## 功能

- 新增 / 双击编辑 / 删除 / 标记完成
- **快捷编辑**：每条右侧铅笔按钮，点击原地展开面板，可改文本 + 开始/结束时间 + 提醒档位，保存 / 取消（Esc 取消、回车保存）；打开一条会自动收起另一条
- **删除可撤销**：右侧垃圾桶图标按钮（hover 变红），点击立即删除，底部出现「已删除「xxx」· 撤销」，8 秒内一键恢复到原位置；在线模式下撤销会重新写回数据库
- 三态筛选：全部 / 进行中 / 已完成（各带数量）
- **分页**：每页 5 条，超过 5 条才出现翻页栏；切换筛选回到第一页，删空末页自动回退
- **开始 / 结束时间**：新增时可填，列表项下方显示时间区间
- **提醒**：可设开始时间前 5/10/15/20/25/30 分钟提醒，到点右下角弹窗；已完成的、未设提醒的不会弹，同一条只弹一次
- 日历：按月查看每天创建的待办数，点击日期筛选，再次点击取消
- 导出 / 导入 CSV

时间与提醒的约束（前后端都会校验）：结束时间不能早于开始时间；提醒档位只能是 5/10/15/20/25/30；设提醒必须先填开始时间。提醒弹窗只在「触发点之后 1 小时内」有效，避免隔天打开页面时被过期任务刷屏。

## CSV 导入导出

导出文件名为 `todolist-YYYY-MM-DD.csv`，带 UTF-8 BOM，Excel 打开中文不乱码。

| 列 | 说明 |
| --- | --- |
| 待办内容 | 任务文本 |
| 状态 | `是` = 已完成，`否` = 进行中 |
| 创建时间 | ISO 时间，为空则按导入当天处理 |
| 开始时间 | ISO 时间，可为空 |
| 结束时间 | ISO 时间，可为空 |
| 提前提醒分钟 | 5/10/15/20/25/30，可为空 |

导入规则：自动跳过首行表头；空行跳过；状态列识别 `是 / true / 1 / yes / 已完成`；字段用双引号包裹，内部逗号与引号按标准 CSV 转义。在线模式下导入会逐条写入数据库。

## 维护说明

- `js/api.js` 与 `js/app.js` 都是普通脚本（非 ES module），这样双击 `index.html` 也能加载；改成 `type="module"` 会在 `file://` 下被 CORS 拦截。
- 前端固定把请求发往 `http://127.0.0.1:8001`，改端口需改 `js/api.js` 顶部的 `BASE`。
- CORS 白名单在 `server/main.py`，当前放行 `localhost:8000` 与 `file://`（`null` 源）。
- 后端连库统一 `charset=utf8mb4`，否则中文会变问号。
- 数据结构：`{ id, text, done, createdAt, startAt, endAt, remindMinutes }`，前端 id 即数据库主键（UUID），新增时可立即渲染，不必等数据库返回。时间字段前端用毫秒时间戳（0 表示未设置），后端存 `DATETIME(3)`。
- 首页 logo 是内联 SVG（在 `index.html` 的 `.brand` 与 `.auth-brand` 中），与 favicon 同款：蓝色渐变圆角方块内，左侧白色清单卡片 + 右侧白色对勾，语义是「待办 → 完成」。渐变 `#4d7ee0 → #2f5cb4`，勾在加载时有一次描边动画（尊重 `prefers-reduced-motion`）。
- 底部操作栏常驻显示：无数据时隐藏统计与「清空已完成」，但「导入」始终可用、「导出」置灰。
- 列表项右侧的操作按钮（铅笔 / 垃圾桶）默认透明、hover 才显现，避免视觉噪音；**触屏设备用 `@media (hover: none)` 常驻**，否则平板上点不到。
- 删除走「立即删除 + 撤销条」而不是二次确认弹窗；撤销条固定在底部居中，出现时右下角提醒弹窗会自动上移避让（`.toasts.with-undo`）。
