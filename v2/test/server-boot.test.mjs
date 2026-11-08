/**
 * 首次部署的启动行为：采集器还没跑过时，源库不存在也不能让面板起不来。
 * 面板只读，所以这里由服务端建一个只含表结构的空库，页面显示「暂无数据」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openSourceDb } from '../server.mjs';

function makeTempDir(prefix = 'v2-boot-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('源库不存在时自动建空库，面板可以零数据启动', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'db', 'sites', 'fresh.db');
  try {
    assert.equal(fs.existsSync(file), false);

    const db = openSourceDb(file);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    assert.ok(tables.includes('logs'), '空库要有 logs 表，否则所有查询都会报错');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n, 0);
    db.close();

    assert.ok(fs.existsSync(file), '库文件应落在指定路径（父目录自动创建）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重复打开已存在的空库不再重建，表结构保持不变', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'sites', 'again.db');
  try {
    openSourceDb(file).close();
    const sizeAfterFirst = fs.statSync(file).size;

    const db = openSourceDb(file);
    const columns = db.prepare('PRAGMA table_info(logs)').all().length;
    db.close();

    assert.ok(columns > 30, `logs 表应保留完整列，实际 ${columns}`);
    assert.equal(fs.statSync(file).size, sizeAfterFirst, '重复打开不应改动文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
