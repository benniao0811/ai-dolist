"""初始化数据库：按环境变量连接 MySQL，执行 server/schema.sql。

本地：  DB_PASSWORD=123456 python tests/init_db.py
CI：    由 workflow 注入 DB_* 环境变量后执行（无需 mysql 客户端）
"""
import os
import pymysql
from contextlib import suppress

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, '..', 'server', 'schema.sql')

CONF = {
    'host': os.getenv('DB_HOST', '127.0.0.1'),
    'port': int(os.getenv('DB_PORT', '3306')),
    'user': os.getenv('DB_USER', 'root'),
    'password': os.getenv('DB_PASSWORD', ''),
    'charset': 'utf8mb4',
    'autocommit': True,
}

with open(SCHEMA, encoding='utf-8') as f:
    sql = f.read()

# 按分号拆分语句，去掉整行注释（schema.sql 里的 ALTER 说明是注释，不执行）
statements = []
for chunk in sql.split(';'):
    body = '\n'.join(
        line for line in chunk.splitlines() if not line.strip().startswith('--')
    ).strip()
    if body:
        statements.append(body)

conn = pymysql.connect(**CONF)
try:
    with conn.cursor() as cur:
        for stmt in statements:
            cur.execute(stmt)
        # 幂等检查：确认两张表都在
        cur.execute('SELECT COUNT(*) FROM information_schema.TABLES '
                    'WHERE TABLE_SCHEMA=%s AND TABLE_NAME IN (%s, %s)',
                    (os.getenv('DB_NAME', 'todolist'), 'users', 'todos'))
        count = cur.fetchone()[0]
finally:
    with suppress(Exception):
        conn.close()

print('建表完成：执行 %d 条语句，目标库表数 %d/2' % (len(statements), count))
if count != 2:
    raise SystemExit('建表失败：users / todos 未全部创建')
