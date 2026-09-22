"""注册验证码接口测试（需后端在跑）。

用法：python tests/captcha_test.py          # 默认 http://127.0.0.1:8001
      API_BASE=http://host:port python tests/captcha_test.py
"""
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request

BASE = os.getenv('API_BASE', 'http://127.0.0.1:8001')
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
    print(('PASS' if cond else 'FAIL'), name, ('' if cond or not extra else '  -> ' + extra))


def code_from_image(data_uri):
    """测试用「识别」：SVG 里字符是文本节点，直接按渲染顺序取出。"""
    b64 = data_uri.split(',', 1)[1]
    svg = base64.b64decode(b64).decode('utf-8')
    return ''.join(re.findall(r'<text[^>]*>([^<])</text>', svg))


def new_captcha():
    status, res = call('GET', '/api/captcha')
    assert status == 200, '获取验证码失败: %s' % status
    data = res['data']
    return data['id'], code_from_image(data['image']), data['image']


username = 'cap_tester_%d' % (int(time.time() * 1000) % 1000000)

# 1. 获取验证码
cid, code, image = new_captcha()
check('获取验证码返回 id', bool(cid))
check('图片是 SVG data URI', image.startswith('data:image/svg+xml;base64,'))
check('图片可解析出 4 位字符', len(code) == 4, code)
check('字符不含易混淆的 0/O/1/I/L', not set(code) & set('0O1IL'), code)

# 2. 未填验证码 → 拒绝
status, res = call('POST', '/api/auth/register', {'username': username, 'password': 'secret123'})
check('未填验证码被拒绝', status == 400 and '请填写验证码' in res.get('error', ''), str(res.get('error')))

# 3. 验证码错误 → 拒绝，且该验证码作废
status, res = call('POST', '/api/auth/register',
                   {'username': username, 'password': 'secret123', 'captchaId': cid, 'captchaCode': 'ZZZZ'})
check('验证码错误被拒绝', status == 400 and '不正确' in res.get('error', ''), str(res.get('error')))

# 4. 验证码正确 → 注册成功
status, res = call('POST', '/api/auth/register',
                   {'username': username, 'password': 'secret123', 'captchaId': cid, 'captchaCode': code})
check('验证码正确可注册', status == 200 and res['data']['user']['username'] == username, str(res.get('error')))

# 5. 一次性：同一张验证码不能再用
status, res = call('POST', '/api/auth/register',
                   {'username': username + '_b', 'password': 'secret123', 'captchaId': cid, 'captchaCode': code})
check('验证码一次性（复用被拒绝）', status == 400 and '使用过' in res.get('error', ''), str(res.get('error')))

# 6. 不存在的 id → 拒绝
status, res = call('POST', '/api/auth/register',
                   {'username': username + '_c', 'password': 'secret123',
                    'captchaId': 'not-a-real-id', 'captchaCode': 'ABCD'})
check('伪造验证码 id 被拒绝', status == 400 and '失效' in res.get('error', ''), str(res.get('error')))

# 7. 登录不需要验证码（否则老用户无法登录）
status, res = call('POST', '/api/auth/login', {'username': username, 'password': 'secret123'})
check('登录无需验证码', status == 200 and bool(res['data'].get('token')))

passed = sum(1 for ok_, _, _ in results if ok_)
print('\n%d/%d 通过' % (passed, len(results)))
raise SystemExit(0 if passed == len(results) else 1)
