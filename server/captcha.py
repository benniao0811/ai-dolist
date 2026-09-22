"""图形验证码：服务端生成 SVG、存库校验、一次性使用。

为什么存库而不是内存：后端生产会用 uvicorn --workers N，多进程内存不共享，
内存方案会让「换个 worker 就验证失败」。

为什么用 SVG：零额外依赖（不需要 Pillow / 系统字体），且能精确控制配色，
与站点蓝白风格保持一致。代价是 SVG 内是文本节点，抗机器识别弱于 PNG，
本地自用场景足够；若要更强的防护，可换成 Pillow 生成 PNG。
"""
import base64
import random
import uuid
from datetime import datetime, timedelta

import db

# 去掉易混淆字符：0/O、1/I/L
CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
LENGTH = 4
TTL_MINUTES = 5

WIDTH, HEIGHT = 108, 40
# 与站点主色同源的蓝白配色
COLORS = ('#2f5cb4', '#3b6fd4', '#4d7ee0', '#1f4a94')
BG = '#eef2fb'


def _svg(code):
    """把验证码画成 SVG（浅蓝底 + 干扰线 + 噪点 + 旋转字符）。"""
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
        % (WIDTH, HEIGHT, WIDTH, HEIGHT),
        '<rect width="%d" height="%d" rx="8" fill="%s"/>' % (WIDTH, HEIGHT, BG),
    ]

    # 干扰线（在字符下方）
    for _ in range(3):
        x1, y1 = random.randint(2, WIDTH - 2), random.randint(4, HEIGHT - 4)
        x2, y2 = random.randint(2, WIDTH - 2), random.randint(4, HEIGHT - 4)
        parts.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" '
                     'stroke-width="1.2" opacity=".45"/>' % (x1, y1, x2, y2, random.choice(COLORS)))

    # 噪点
    for _ in range(22):
        parts.append('<circle cx="%d" cy="%d" r="1" fill="%s" opacity=".5"/>'
                     % (random.randint(2, WIDTH - 2), random.randint(2, HEIGHT - 2),
                        random.choice(COLORS)))

    # 字符：逐个随机旋转与上下偏移
    for i, ch in enumerate(code):
        x = 15 + i * 23
        y = 28 + random.randint(-3, 3)
        rot = random.randint(-15, 15)
        parts.append(
            '<text x="%d" y="%d" font-family="Menlo,Consolas,monospace" font-size="24" '
            'font-weight="700" fill="%s" transform="rotate(%d %d %d)">%s</text>'
            % (x, y, random.choice(COLORS), rot, x, y, ch))

    parts.append('</svg>')
    return ''.join(parts)


def create():
    """生成一张验证码，返回 (id, data_uri)。顺带清理过期记录。"""
    now = datetime.now()
    db.execute('DELETE FROM captchas WHERE expires_at < %s', (now,))

    code = ''.join(random.choice(CHARS) for _ in range(LENGTH))
    cid = str(uuid.uuid4())
    db.execute(
        'INSERT INTO captchas (id, code, expires_at, used, created_at) VALUES (%s, %s, %s, 0, %s)',
        (cid, code, now + timedelta(minutes=TTL_MINUTES), now),
    )
    encoded = base64.b64encode(_svg(code).encode('utf-8')).decode('ascii')
    return cid, 'data:image/svg+xml;base64,' + encoded


def verify(cid, code):
    """校验并立即作废。返回 None 表示通过，否则返回错误文案。"""
    if not cid or not code:
        return '请填写验证码'
    row = db.one('SELECT code, expires_at, used FROM captchas WHERE id=%s', (cid,))
    if not row:
        return '验证码已失效，请点击图片刷新'
    if row['used']:
        return '验证码已使用过，请刷新'
    if row['expires_at'] < datetime.now():
        return '验证码已过期，请刷新'
    if str(row['code']).upper() != str(code).strip().upper():
        return '验证码不正确'
    db.execute('UPDATE captchas SET used=1 WHERE id=%s', (cid,))
    return None
