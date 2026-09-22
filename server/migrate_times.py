"""把已有 todos 表升级到带时间字段的版本，重复执行安全。

用法：python server/migrate_times.py
"""
import pymysql

import db

COLUMNS = (
    ('start_at', "DATETIME(3) NULL COMMENT '计划开始时间' AFTER text"),
    ('end_at', "DATETIME(3) NULL COMMENT '计划结束时间' AFTER start_at"),
    ('remind_minutes', "SMALLINT UNSIGNED NULL COMMENT '开始前多少分钟提醒' AFTER end_at"),
)

with db.cursor() as cur:
    cur.execute(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS '
        'WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s',
        (db.DB_CONF['database'], 'todos'),
    )
    existing = {r['COLUMN_NAME'] for r in cur.fetchall()}
    if not existing:
        raise SystemExit('todos 表不存在，请先执行 server/schema.sql')

    for name, ddl in COLUMNS:
        if name in existing:
            print('跳过（已存在）:', name)
            continue
        cur.execute('ALTER TABLE todos ADD COLUMN %s %s' % (name, ddl))
        print('已添加:', name)

    cur.execute(
        'SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS '
        'WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION',
        (db.DB_CONF['database'], 'todos'),
    )
    print('当前 todos 结构:')
    for r in cur.fetchall():
        print('  %-16s %s' % (r['COLUMN_NAME'], r['COLUMN_TYPE']))
