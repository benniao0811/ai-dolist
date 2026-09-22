"""验证待办的开始/结束时间与提醒档位接口。

用法：先启动后端（默认 http://127.0.0.1:8001），再执行本脚本。
地址可用环境变量 API_BASE 覆盖，例如 CI 中：API_BASE=http://127.0.0.1:8001 python tests/api_test.py
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = os.getenv('API_BASE', 'http://127.0.0.1:8001')
MIN = 60 * 1000
results = []


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def check(name, cond, extra=''):
    results.append((cond, name, extra))
    print(('PASS' if cond else 'FAIL'), name, extra)


now_ms = int(time.time() * 1000)
username = 'time_tester_%d' % (now_ms % 100000)

status, res = call('POST', '/api/auth/register', {'username': username, 'password': 'secret123'})
check('注册测试账号', status == 200, str(status))
token = res['data']['token']

# 1. 带完整时间新增
status, res = call('POST', '/api/todos', {
    'text': '写周报',
    'startAt': now_ms + 120 * MIN,
    'endAt': now_ms + 180 * MIN,
    'remindMinutes': 15,
}, token)
todo = res.get('data') or {}
check('新增带时间待办', status == 200 and todo.get('remindMinutes') == 15, str(status))
check('返回开始时间（毫秒）', todo.get('startAt') == now_ms + 120 * MIN, str(todo.get('startAt')))
check('返回结束时间（毫秒）', todo.get('endAt') == now_ms + 180 * MIN, str(todo.get('endAt')))
todo_id = todo.get('id')

# 2. 列表回读
status, res = call('GET', '/api/todos', token=token)
rows = res.get('data') or []
check('列表回读时间字段', len(rows) == 1 and rows[0]['startAt'] == now_ms + 120 * MIN
      and rows[0]['endAt'] == now_ms + 180 * MIN and rows[0]['remindMinutes'] == 15, str(rows[:1]))

# 3. 不带时间的待办仍可用（旧数据兼容）
status, res = call('POST', '/api/todos', {'text': '无时间待办'}, token)
plain = res.get('data') or {}
check('不带时间也能新增', status == 200 and plain.get('startAt') == 0 and plain.get('remindMinutes') is None,
      str(plain))

# 4. 结束早于开始
status, res = call('POST', '/api/todos', {
    'text': '倒挂时间', 'startAt': now_ms + 180 * MIN, 'endAt': now_ms + 60 * MIN,
}, token)
check('结束早于开始被拒绝', status == 400 and '结束时间' in (res.get('error') or ''), str(status) + ' ' + str(res.get('error')))

# 5. 无开始时间却设提醒
status, res = call('POST', '/api/todos', {'text': '空提醒', 'remindMinutes': 15}, token)
check('无开始时间设提醒被拒绝', status == 400 and '开始时间' in (res.get('error') or ''), str(res.get('error')))

# 6. 非法提醒档位
status, res = call('POST', '/api/todos', {
    'text': '非法档位', 'startAt': now_ms + 60 * MIN, 'remindMinutes': 7,
}, token)
check('非法提醒档位被拒绝', status == 400, str(res.get('error')))

# 7. 合法档位全部可存
for m in (5, 10, 15, 20, 25, 30):
    s, r = call('POST', '/api/todos', {
        'text': '档位%d' % m, 'startAt': now_ms + 60 * MIN, 'remindMinutes': m,
    }, token)
    check('提醒档位 %d 分钟可保存' % m, s == 200 and r['data']['remindMinutes'] == m, str(s))

# 8. 局部更新：只改结束时间
status, res = call('PATCH', '/api/todos/' + todo_id, {'endAt': now_ms + 240 * MIN}, token)
check('只改结束时间', status == 200 and res['data']['startAt'] == now_ms + 120 * MIN, str(res.get('data')))

# 9. 局部更新把结束时间改到开始之前（与库中开始时间冲突）
status, res = call('PATCH', '/api/todos/' + todo_id, {'endAt': now_ms + 30 * MIN}, token)
check('改出倒挂区间被拒绝', status == 400, str(res.get('error')))

# 10. 清除时间
status, res = call('PATCH', '/api/todos/' + todo_id, {'startAt': 0, 'endAt': 0, 'remindMinutes': 0}, token)
check('清除时间与提醒', status == 200 and res['data']['startAt'] == 0
      and res['data']['remindMinutes'] is None, str(res.get('data')))

# 11. 完成状态与时间互不干扰
status, res = call('PATCH', '/api/todos/' + todo_id, {'done': True}, token)
check('勾选完成不影响时间', status == 200 and res['data']['done'] is True, str(res.get('data')))

passed = sum(1 for ok_, _, _ in results if ok_)
print('\n%d/%d 通过' % (passed, len(results)))
raise SystemExit(0 if passed == len(results) else 1)
