/**
 * 实例配置单测：默认值、文件覆盖、相对路径、非法 JSON / 缺文件回落、路径拼接、
 * 历史目录回退、令牌文件两种格式、ensureDataDirs。
 * 全部在 os.tmpdir() 下建临时目录，不读仓库里的真实配置与数据库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultInstance, ensureDataDirs, loadInstance } from '../lib/instance.mjs';
import { pickToken, readPat } from '../jobs/collect-site-logs.mjs';

function makeTempDir(prefix = 'v2-instance-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

/** 空仓库根 + 一份 config，避免真实仓库里的 db/sites 影响回退判断 */
function makeRepo() {
  return makeTempDir('v2-instance-repo-');
}

function writeConfig(repo, value) {
  const file = path.join(repo, 'instance.json');
  writeJson(file, value);
  return file;
}

test('defaultInstance：纯默认值，不读文件', () => {
  const inst = defaultInstance();
  assert.equal(inst.file, null);
  assert.deepEqual(inst.site, { id: 'relay', name: 'relay', base_url: null, log_path: '/api/log' });
  assert.deepEqual(inst.collect, { source: 'db', spendIntervalMs: 900000, logsIntervalMs: 900000 });
  assert.equal(inst.paths.relayDb, '/home/newapi/one-api.db');
  assert.ok(path.isAbsolute(inst.paths.dataDir));
  assert.ok(path.isAbsolute(inst.paths.siteDbFile));
  assert.ok(path.isAbsolute(inst.paths.dashboardFile));
  assert.ok(inst.paths.siteDbFile.endsWith(path.join('data', 'db', 'sites', 'relay.db')));
  assert.ok(inst.paths.dashboardFile.endsWith(path.join('data', 'dashboard.db')));
  assert.ok(inst.paths.tokenFile.endsWith(path.join('data', 'site_token.txt')));
  assert.ok(inst.paths.accountsFile.endsWith(path.join('data', 'accounts.json')));
});

test('loadInstance：文件覆盖 site / paths / collect 字段', () => {
  const repo = makeRepo();
  const file = writeConfig(repo, {
    site: { id: 'demo', name: 'Demo 站', base_url: 'https://example.com/', log_path: 'api/log' },
    paths: { data_dir: './mydata', relay_db: '/srv/newapi/one-api.db' },
    collect: { source: 'http', spend_interval_ms: 600000, logs_interval_ms: 1200000 },
  });
  const inst = loadInstance({ file, repoRoot: repo });

  assert.equal(inst.file, file);
  assert.deepEqual(inst.site, {
    id: 'demo',
    name: 'Demo 站',
    base_url: 'https://example.com',
    log_path: '/api/log',
  });
  assert.equal(inst.paths.dataDir, path.join(repo, 'mydata'));
  assert.equal(inst.paths.relayDb, '/srv/newapi/one-api.db');
  assert.deepEqual(inst.collect, { source: 'http', spendIntervalMs: 600000, logsIntervalMs: 1200000 });
});

test('loadInstance：相对路径按配置文件所在目录解析', () => {
  const repo = makeRepo();
  const dir = path.join(repo, 'conf');
  const file = path.join(dir, 'instance.json');
  writeJson(file, {
    site: { id: 'rel' },
    paths: { data_dir: './data', relay_db: './upstream/one-api.db', site_token: './tok.txt', accounts: './acc.json' },
  });

  const inst = loadInstance({ file, repoRoot: repo });
  assert.equal(inst.paths.dataDir, path.join(dir, 'data'));
  assert.equal(inst.paths.relayDb, path.join(dir, 'upstream', 'one-api.db'));
  assert.equal(inst.paths.tokenFile, path.join(dir, 'tok.txt'));
  assert.equal(inst.paths.accountsFile, path.join(dir, 'acc.json'));
});

test('loadInstance：非法 JSON 回落默认，不抛错且警告不含文件内容', () => {
  const repo = makeRepo();
  const file = path.join(repo, 'instance.json');
  fs.writeFileSync(file, '{ 这不是 JSON: "sk-secret-value" ', 'utf8');

  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let inst;
  try {
    inst = loadInstance({ file, repoRoot: repo });
  } finally {
    console.warn = original;
  }

  assert.equal(inst.site.id, 'relay');
  assert.equal(inst.collect.source, 'db');
  assert.equal(inst.file, file, '文件存在时仍记录路径，便于排查');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不是合法 JSON/);
  assert.ok(!warnings[0].includes('sk-secret-value'), '警告里不能带文件内容');
});

test('loadInstance：配置文件不存在时用默认值，file 为 null', () => {
  const repo = makeRepo();
  const inst = loadInstance({ file: path.join(repo, 'nope.json'), repoRoot: repo });
  assert.equal(inst.file, null);
  assert.equal(inst.site.id, 'relay');
  assert.equal(inst.paths.dataDir, path.join(repo, 'data'));

  // 显式 file: null 表示不读任何文件，不会去读环境变量指向的配置
  const pure = loadInstance({ file: null, repoRoot: repo });
  assert.equal(pure.file, null);
  assert.equal(pure.site.id, 'relay');
  assert.equal(pure.paths.dataDir, path.join(repo, 'data'));
});

test('路径拼接：站点库与看板库都在实例数据目录下', () => {
  const repo = makeRepo();
  const file = writeConfig(repo, {
    site: { id: 'demo' },
    paths: { data_dir: './var/data' },
  });
  const inst = loadInstance({ file, repoRoot: repo });
  assert.equal(inst.paths.siteDbFile, path.join(repo, 'var', 'data', 'db', 'sites', 'demo.db'));
  assert.equal(inst.paths.dashboardFile, path.join(repo, 'var', 'data', 'dashboard.db'));
  assert.equal(inst.paths.tokenFile, path.join(repo, 'var', 'data', 'site_token.txt'));
  assert.equal(inst.paths.accountsFile, path.join(repo, 'var', 'data', 'accounts.json'));
});

test('历史回退②：新数据目录没有站点库时用仓库内 db/sites/<id>.db', () => {
  const repo = makeRepo();
  const legacy = path.join(repo, 'db', 'sites', 'relay.db');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '');

  const file = writeConfig(repo, { site: { id: 'relay' }, paths: { data_dir: './data' } });
  const inst = loadInstance({ file, repoRoot: repo });
  assert.equal(inst.paths.siteDbFile, legacy);
  assert.equal(inst.site.id, 'relay');
});

test('历史回退③：仓库内只有一个站点库且未配 site.id 时，站点名跟着文件名推断', () => {
  const repo = makeRepo();
  const legacy = path.join(repo, 'db', 'sites', 'foo.db');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '');

  const file = writeConfig(repo, { site: {}, paths: { data_dir: './data' } });
  const inst = loadInstance({ file, repoRoot: repo });
  assert.equal(inst.paths.siteDbFile, legacy);
  assert.equal(inst.site.id, 'foo');
  assert.equal(inst.site.name, 'foo', '没配 name 时跟着推断出的站点名');
});

test('历史回退③：显式配了 site.id 就不认领目录里的其它库', () => {
  const repo = makeRepo();
  const other = path.join(repo, 'db', 'sites', 'someone-else.db');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '');

  const file = writeConfig(repo, { site: { id: 'fresh' }, paths: { data_dir: './data' } });
  const inst = loadInstance({ file, repoRoot: repo });
  // 新实例若认领了别人的库，面板会显示不属于它的数据；宁可空着等采集写入。
  assert.equal(inst.site.id, 'fresh');
  assert.equal(inst.paths.siteDbFile, path.join(repo, 'data', 'db', 'sites', 'fresh.db'));
});

test('历史回退③：仓库里有两个站点库时不猜，仍用数据目录下的新路径', () => {
  const repo = makeRepo();
  for (const name of ['a.db', 'b.db']) {
    const file = path.join(repo, 'db', 'sites', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  const file = writeConfig(repo, { site: { id: 'relay' }, paths: { data_dir: './data' } });
  const inst = loadInstance({ file, repoRoot: repo });
  assert.equal(inst.paths.siteDbFile, path.join(repo, 'data', 'db', 'sites', 'relay.db'));
  assert.equal(inst.site.id, 'relay');
});

test('历史回退：看板库 / 令牌 / 账户配置用仓库内旧路径', () => {
  const repo = makeRepo();
  const dashboard = path.join(repo, 'v2', 'db', 'dashboard.db');
  const token = path.join(repo, 'meta', 'site_token.txt');
  const accounts = path.join(repo, 'v2', 'secrets', 'accounts.json');
  for (const target of [dashboard, token, accounts]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }

  const file = writeConfig(repo, { site: { id: 'relay' }, paths: { data_dir: './data' } });
  const inst = loadInstance({ file, repoRoot: repo });
  assert.equal(inst.paths.dashboardFile, dashboard);
  assert.equal(inst.paths.tokenFile, token);
  assert.equal(inst.paths.accountsFile, accounts);
});

test('令牌文件：单行纯 token 与多行「名称：token」都能读到', () => {
  const dir = makeTempDir('v2-instance-token-');
  try {
    const single = path.join(dir, 'single.txt');
    fs.writeFileSync(single, 'sk-single-token\n', 'utf8');
    assert.equal(readPat(single, 'relay'), 'sk-single-token');

    const multi = path.join(dir, 'multi.txt');
    fs.writeFileSync(multi, ['other：sk-other', 'relay：sk-relay', 'third：sk-third'].join('\n'), 'utf8');
    assert.equal(readPat(multi, 'relay'), 'sk-relay');
    // 找不到同名行时取第一行
    assert.equal(readPat(multi, 'missing'), 'sk-other');
    // 纯函数同口径
    assert.equal(pickToken('sk-plain', 'relay'), 'sk-plain');
    assert.equal(pickToken('a：1\nb：2', 'b'), '2');
    assert.equal(pickToken('', 'relay'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDataDirs：建出数据目录与站点目录，重复调用幂等', () => {
  const dir = makeTempDir('v2-instance-dirs-');
  try {
    const inst = {
      paths: { dataDir: path.join(dir, 'data') },
    };
    ensureDataDirs(inst);
    assert.ok(fs.statSync(path.join(dir, 'data')).isDirectory());
    assert.ok(fs.statSync(path.join(dir, 'data', 'db', 'sites')).isDirectory());

    ensureDataDirs(inst);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'data', 'db', 'sites')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
