"""密码哈希（bcrypt）与登录令牌（JWT）。"""
import os
import re
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

SECRET = os.getenv('JWT_SECRET', 'dev-secret-change-me')
ALGO = 'HS256'
TTL_MINUTES = int(os.getenv('JWT_TTL_MINUTES', '10'))

USERNAME_RE = re.compile(r'^[A-Za-z0-9_]{3,20}$')
MIN_PASSWORD = 6
MAX_PASSWORD = 72  # bcrypt 只取前 72 字节，超长直接拒绝而不是静默截断


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except (ValueError, TypeError):
        return False


def issue_token(user_id: str, username: str) -> dict:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=TTL_MINUTES)
    token = jwt.encode(
        {'sub': user_id, 'username': username, 'iat': now, 'exp': exp},
        SECRET,
        algorithm=ALGO,
    )
    return {'token': token, 'expiresAt': int(exp.timestamp() * 1000)}


def parse_token(token: str):
    """校验成功返回 {'sub','username'}，失败返回 None。"""
    if not token:
        return None
    try:
        return jwt.decode(token, SECRET, algorithms=[ALGO])
    except jwt.PyJWTError:
        return None


def check_username(username: str):
    if not USERNAME_RE.match(username or ''):
        return '用户名需为 3-20 位字母、数字或下划线'
    return None


def check_password(password: str):
    if not password or len(password) < MIN_PASSWORD:
        return '密码至少 6 位'
    if len(password.encode('utf-8')) > MAX_PASSWORD:
        return '密码过长（最多 72 字节）'
    return None
