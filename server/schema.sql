-- ToDoList 建库建表（utf8mb4，支持中文与 emoji）
-- 首次安装：mysql -u root -p < server/schema.sql
-- 旧库升级：只需新增的三列，脚本会自动跳过已存在的列（见下方 migrate 说明）

CREATE DATABASE IF NOT EXISTS todolist
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE todolist;

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     NOT NULL COMMENT 'UUID',
  username      VARCHAR(50)  NOT NULL COMMENT '登录名',
  password_hash CHAR(60)     NOT NULL COMMENT 'bcrypt',
  created_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS todos (
  id             CHAR(36)          NOT NULL COMMENT 'UUID，与前端 id 一致',
  user_id        CHAR(36)          NOT NULL,
  text           VARCHAR(200)      NOT NULL,
  start_at       DATETIME(3)       NULL     COMMENT '计划开始时间',
  end_at         DATETIME(3)       NULL     COMMENT '计划结束时间',
  remind_minutes SMALLINT UNSIGNED NULL     COMMENT '开始前多少分钟提醒（5/10/15/20/25/30）',
  done           TINYINT(1)        NOT NULL DEFAULT 0,
  created_at     DATETIME(3)       NOT NULL,
  updated_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_user_created (user_id, created_at),
  CONSTRAINT fk_todos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 图形验证码（注册时用）：一次性，5 分钟有效，用完即作废
CREATE TABLE IF NOT EXISTS captchas (
  id         CHAR(36)     NOT NULL COMMENT 'UUID，返回给前端用于回传',
  code       VARCHAR(8)   NOT NULL COMMENT '验证码明文（4 位，已去掉易混淆字符）',
  expires_at DATETIME(3)  NOT NULL,
  used       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '已校验作废',
  created_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 已有旧表（无时间字段）升级用，重复执行安全：
-- ALTER TABLE todos
--   ADD COLUMN start_at       DATETIME(3)       NULL COMMENT '计划开始时间' AFTER text,
--   ADD COLUMN end_at         DATETIME(3)       NULL COMMENT '计划结束时间' AFTER start_at,
--   ADD COLUMN remind_minutes SMALLINT UNSIGNED NULL COMMENT '开始前多少分钟提醒' AFTER end_at;
