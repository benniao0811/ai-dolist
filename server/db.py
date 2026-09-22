import os
import pymysql
from contextlib import contextmanager
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

DB_CONF = {
    'host': os.getenv('DB_HOST', '127.0.0.1'),
    'port': int(os.getenv('DB_PORT', '3306')),
    'user': os.getenv('DB_USER', 'root'),
    'password': os.getenv('DB_PASSWORD', ''),
    'database': os.getenv('DB_NAME', 'todolist'),
    'charset': 'utf8mb4',
    'autocommit': True,
    'cursorclass': pymysql.cursors.DictCursor,
}


@contextmanager
def cursor():
    """每次请求开一个连接（本地自用场景，够用且不易泄漏状态）。"""
    conn = pymysql.connect(**DB_CONF)
    try:
        with conn.cursor() as cur:
            yield cur
    finally:
        conn.close()


def query(sql, args=None):
    with cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


def one(sql, args=None):
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql, args=None):
    with cursor() as cur:
        return cur.execute(sql, args)
