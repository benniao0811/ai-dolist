"""ToDoList 后端：注册/登录（bcrypt + JWT）+ 待办 CRUD。"""
import os
import uuid
from datetime import datetime
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import auth
import captcha
import db

app = FastAPI(title='ToDoList API')

# 允许的来源：用 CORS_ORIGINS 覆盖（逗号分隔），默认只放行本地开发端口
# 例：CORS_ORIGINS=https://todo.example.com
_origins = [o.strip() for o in os.getenv(
    'CORS_ORIGINS', 'http://localhost:8000,http://127.0.0.1:8000').split(',') if o.strip()]
if os.getenv('CORS_ALLOW_NULL', '1') == '1':
    _origins.append('null')  # 'null' 对应 file:// 直接打开的场景

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=['*'],
    allow_headers=['*'],
)

MAX_TEXT = 200
REMIND_CHOICES = (5, 10, 15, 20, 25, 30)


def ok(data=None):
    return {'ok': True, 'data': data}


@app.exception_handler(HTTPException)
async def on_http_error(_request, exc):
    return JSONResponse({'ok': False, 'error': exc.detail}, exc.status_code)


@app.exception_handler(RequestValidationError)
async def on_invalid(_request, _exc):
    return JSONResponse({'ok': False, 'error': '请求参数不合法'}, 400)


def to_ms(value):
    return int(value.timestamp() * 1000) if value else 0


def to_todo(row):
    return {
        'id': row['id'],
        'text': row['text'],
        'done': bool(row['done']),
        'createdAt': to_ms(row['created_at']),
        'startAt': to_ms(row['start_at']),
        'endAt': to_ms(row['end_at']),
        'remindMinutes': row['remind_minutes'],
    }


def clean_text(text):
    text = (text or '').strip()
    if not text:
        raise HTTPException(400, '待办内容不能为空')
    if len(text) > MAX_TEXT:
        raise HTTPException(400, '待办内容不能超过 %d 字' % MAX_TEXT)
    return text


def to_dt(ms, label):
    """前端传毫秒时间戳；0 或 None 表示清空。"""
    if ms is None or ms == 0:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000)
    except (TypeError, ValueError, OSError, OverflowError):
        raise HTTPException(400, label + '格式不正确')


def clean_times(start_ms, end_ms, remind):
    start = to_dt(start_ms, '开始时间')
    end = to_dt(end_ms, '结束时间')
    if start and end and end < start:
        raise HTTPException(400, '结束时间不能早于开始时间')
    if remind is not None and remind != 0:
        remind = int(remind)
        if remind not in REMIND_CHOICES:
            raise HTTPException(400, '提醒档位只能是 %s 分钟' % '/'.join(map(str, REMIND_CHOICES)))
        if not start:
            raise HTTPException(400, '设置提醒需要先选择开始时间')
    else:
        remind = None
    return start, end, remind


def current_user(authorization: str = Header(default='')):
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, '未登录')
    payload = auth.parse_token(authorization[7:].strip())
    if not payload:
        raise HTTPException(401, '登录已过期，请重新登录')
    return payload


def patch_fields(body):
    dump = getattr(body, 'model_dump', None) or body.dict
    return dump(exclude_unset=True)


class Credentials(BaseModel):
    username: str
    password: str
    captchaId: Optional[str] = None      # 仅注册需要
    captchaCode: Optional[str] = None    # 仅注册需要


class TodoIn(BaseModel):
    id: Optional[str] = None
    text: str
    createdAt: Optional[int] = None
    startAt: Optional[int] = None
    endAt: Optional[int] = None
    remindMinutes: Optional[int] = None


class TodoPatch(BaseModel):
    text: Optional[str] = None
    done: Optional[bool] = None
    startAt: Optional[int] = None
    endAt: Optional[int] = None
    remindMinutes: Optional[int] = None


@app.get('/api/health')
def health():
    db.query('SELECT 1')
    return ok({'status': 'ok', 'tokenTtlMinutes': auth.TTL_MINUTES})


@app.get('/api/captcha')
def get_captcha():
    """返回一张新验证码：id 用于回传，image 可直接放进 img 的 src。"""
    cid, image = captcha.create()
    return ok({'id': cid, 'image': image, 'ttlMinutes': captcha.TTL_MINUTES})


@app.post('/api/auth/register')
def register(body: Credentials):
    # 顺序有讲究：格式校验（便宜）→ 验证码（一次性，通过后消耗）→ 查重
    err = auth.check_username(body.username) or auth.check_password(body.password)
    if err:
        raise HTTPException(400, err)
    err = captcha.verify(body.captchaId, body.captchaCode)
    if err:
        raise HTTPException(400, err)
    if db.one('SELECT id FROM users WHERE username=%s', (body.username,)):
        raise HTTPException(409, '该用户名已被注册')
    uid = str(uuid.uuid4())
    db.execute(
        'INSERT INTO users (id, username, password_hash, created_at) VALUES (%s, %s, %s, %s)',
        (uid, body.username, auth.hash_password(body.password), datetime.now()),
    )
    return ok({'user': {'id': uid, 'username': body.username}, **auth.issue_token(uid, body.username)})


@app.post('/api/auth/login')
def login(body: Credentials):
    user = db.one('SELECT id, username, password_hash FROM users WHERE username=%s', (body.username,))
    if not user or not auth.verify_password(body.password, user['password_hash']):
        raise HTTPException(401, '用户名或密码错误')
    return ok({
        'user': {'id': user['id'], 'username': user['username']},
        **auth.issue_token(user['id'], user['username']),
    })


@app.post('/api/auth/refresh')
def refresh(user=Depends(current_user)):
    """令牌 10 分钟较短，活跃用户可凭未过期的旧令牌换取新令牌。"""
    return ok(auth.issue_token(user['sub'], user['username']))


@app.get('/api/todos')
def list_todos(user=Depends(current_user)):
    rows = db.query(
        'SELECT id, text, done, start_at, end_at, remind_minutes, created_at '
        'FROM todos WHERE user_id=%s ORDER BY created_at, id',
        (user['sub'],),
    )
    return ok([to_todo(r) for r in rows])


@app.post('/api/todos')
def create_todo(body: TodoIn, user=Depends(current_user)):
    text = clean_text(body.text)
    todo_id = body.id or str(uuid.uuid4())
    ts = to_dt(body.createdAt, '创建时间') or datetime.now()
    start, end, remind = clean_times(body.startAt, body.endAt, body.remindMinutes)
    db.execute(
        'INSERT INTO todos (id, user_id, text, start_at, end_at, remind_minutes, done, created_at) '
        'VALUES (%s, %s, %s, %s, %s, %s, 0, %s)',
        (todo_id, user['sub'], text, start, end, remind, ts),
    )
    return ok({
        'id': todo_id, 'text': text, 'done': False,
        'createdAt': to_ms(ts), 'startAt': to_ms(start),
        'endAt': to_ms(end), 'remindMinutes': remind,
    })


@app.patch('/api/todos/{todo_id}')
def update_todo(todo_id: str, body: TodoPatch, user=Depends(current_user)):
    row = db.one(
        'SELECT id, start_at, end_at, remind_minutes FROM todos WHERE id=%s AND user_id=%s',
        (todo_id, user['sub']),
    )
    if not row:
        raise HTTPException(404, '待办不存在')

    fields = patch_fields(body)
    if not fields:
        raise HTTPException(400, '没有需要更新的内容')

    # 时间相关字段与库中现有值合并后再整体校验，避免只改一半导致起止时间矛盾
    if {'startAt', 'endAt', 'remindMinutes'} & set(fields):
        start, end, remind = clean_times(
            fields.get('startAt', to_ms(row['start_at'])),
            fields.get('endAt', to_ms(row['end_at'])),
            fields.get('remindMinutes', row['remind_minutes']),
        )
    else:
        start = end = remind = None

    sets, args = [], []
    if 'text' in fields:
        sets.append('text=%s')
        args.append(clean_text(fields['text']))
    if 'done' in fields:
        sets.append('done=%s')
        args.append(1 if fields['done'] else 0)
    if start is not None or 'startAt' in fields:
        sets.append('start_at=%s')
        args.append(start)
    if end is not None or 'endAt' in fields:
        sets.append('end_at=%s')
        args.append(end)
    if remind is not None or 'remindMinutes' in fields:
        sets.append('remind_minutes=%s')
        args.append(remind)
    if not sets:
        raise HTTPException(400, '没有需要更新的内容')

    args += [todo_id, user['sub']]
    db.execute('UPDATE todos SET ' + ', '.join(sets) + ' WHERE id=%s AND user_id=%s', args)
    row = db.one(
        'SELECT id, text, done, start_at, end_at, remind_minutes, created_at FROM todos WHERE id=%s',
        (todo_id,),
    )
    return ok(to_todo(row))


@app.delete('/api/todos/{todo_id}')
def delete_todo(todo_id: str, user=Depends(current_user)):
    # 越权与不存在都返回 404，不暴露资源是否存在
    affected = db.execute('DELETE FROM todos WHERE id=%s AND user_id=%s', (todo_id, user['sub']))
    if not affected:
        raise HTTPException(404, '待办不存在')
    return ok({'id': todo_id})


@app.delete('/api/todos')
def delete_done(done: int = Query(default=0), user=Depends(current_user)):
    if done != 1:
        raise HTTPException(400, '缺少 done=1 参数')
    affected = db.execute('DELETE FROM todos WHERE user_id=%s AND done=1', (user['sub'],))
    return ok({'removed': affected})


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='127.0.0.1', port=8001, log_level='info')
