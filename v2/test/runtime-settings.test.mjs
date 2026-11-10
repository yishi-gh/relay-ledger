/**
 * 运行时设置存储单测：默认值、校验边界、持久化重建、revision 冲突、原子写、
 * 采集器状态时效，以及「不假恢复、不放行 unknown 字段」。
 * 全部使用临时目录，不接触生产数据。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  COLLECTOR_STALE_MS,
  RevisionConflictError,
  RuntimeSettingsError,
  createRuntimeSettingsStore,
  revisionOf,
  SHARED_DEFAULTS,
} from '../lib/runtime-settings.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;

function defaultsOf({ logsMinutes = 15, spendMinutes = 15 } = {}) {
  return {
    monitoring: structuredClone(SHARED_DEFAULTS.monitoring),
    collection: { logsMinutes, spendMinutes },
    health: structuredClone(SHARED_DEFAULTS.health),
  };
}

function withStore(options = {}) {
  const dir = makeTempDir('v2-runtime-settings-');
  const store = createRuntimeSettingsStore({ dataDir: dir, ...options });
  return {
    dir,
    store,
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function cloneSettings(settings) {
  return structuredClone(settings);
}

// ---------------------------------------------------------------------------
// 默认值与持久化
// ---------------------------------------------------------------------------

test('缺文件：返回 instance 采集默认值，settings 与 defaults 同形且 revision 稳定', () => {
  const fx = withStore({ collectionDefaults: { logsMinutes: 2.5, spendMinutes: 3 } });
  try {
    const snapshot = fx.store.read();
    assert.deepEqual(snapshot.settings, defaultsOf({ logsMinutes: 2.5, spendMinutes: 3 }));
    assert.deepEqual(snapshot.defaults, snapshot.settings);
    assert.equal(typeof snapshot.revision, 'string');
    assert.equal(snapshot.revision.length, 64);
    assert.equal(fx.store.path, path.resolve(fx.dir, 'runtime-settings.json'));
    assert.equal(fx.store.statusPath, path.resolve(fx.dir, 'collector-settings-status.json'));
    assert.equal(fs.existsSync(fx.store.path), false, 'GET/read 不得写盘');
  } finally {
    fx.close();
  }
});

test('revision 只由三组配置决定：键顺序无关，数值变化即变化', () => {
  const a = defaultsOf();
  const b = {
    health: { failErrorRate: 0.02, minSamples: 3 },
    collection: { spendMinutes: 15, logsMinutes: 15 },
    monitoring: {
      freshness: { dangerMinutes: 120, warnMinutes: 30 },
      runway: { warnDays: 7, dangerDays: 3 },
      latencyP95: { warnMs: 60000, goodMs: 20000 },
      latencyP50: { warnMs: 15000, goodMs: 5000 },
      cacheRate: { warn: 0.5, good: 0.8 },
    },
  };
  assert.equal(revisionOf(a), revisionOf(b));
  assert.notEqual(revisionOf(a), revisionOf({ ...a, health: { ...a.health, minSamples: 4 } }));
});

test('合法边界可写入并能在新 store 中重建', () => {
  const fx = withStore();
  try {
    const snapshot = fx.store.read();
    const next = {
      monitoring: {
        cacheRate: { good: 1, warn: 0 },
        latencyP50: { goodMs: 1, warnMs: 3_600_000 },
        latencyP95: { goodMs: 1, warnMs: 3_600_000 },
        runway: { dangerDays: 0.5, warnDays: 3650 },
        freshness: { warnMinutes: 0.5, dangerMinutes: 10_080 },
      },
      collection: { logsMinutes: 1, spendMinutes: 1440 },
      health: { minSamples: 1_000_000, failErrorRate: 1 },
    };
    const updated = fx.store.update(next, snapshot.revision);
    assert.notEqual(updated.revision, snapshot.revision);
    assert.deepEqual(updated.settings, next);

    const reopened = createRuntimeSettingsStore({ dataDir: fx.dir });
    assert.deepEqual(reopened.read().settings, next);
    assert.equal(reopened.read().revision, updated.revision);
    assert.equal(JSON.parse(fs.readFileSync(fx.store.path, 'utf8')).health.minSamples, 1_000_000);
  } finally {
    fx.close();
  }
});

test('与部署默认一致的小数 collection 允许；改成其它小数则拒绝', () => {
  const fx = withStore({ collectionDefaults: { logsMinutes: 0.5, spendMinutes: 1.5 } });
  try {
    const base = fx.store.read();
    const keepCollection = cloneSettings(base.settings);
    keepCollection.monitoring.cacheRate = { good: 0.9, warn: 0.4 };
    const updated = fx.store.update(keepCollection, base.revision);
    assert.deepEqual(updated.settings.collection, { logsMinutes: 0.5, spendMinutes: 1.5 });

    const bad = cloneSettings(updated.settings);
    bad.collection = { logsMinutes: 0.5, spendMinutes: 2.5 };
    assert.throws(
      () => fx.store.update(bad, updated.revision),
      (err) => err instanceof RuntimeSettingsError && /collection\.spendMinutes 必须是整数/.test(err.message),
    );
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// 校验拒绝
// ---------------------------------------------------------------------------

test('拒绝缺字段、unknown 字段、NaN、字符串数字与 __proto__', () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    const cases = [];
    const missing = cloneSettings(base.settings);
    delete missing.health;
    cases.push([missing, /settings\.health 缺失/]);

    const unknown = cloneSettings(base.settings);
    unknown.health.extra = 1;
    cases.push([unknown, /health 包含未知字段 extra/]);

    const nan = cloneSettings(base.settings);
    nan.monitoring.cacheRate.good = Number.NaN;
    cases.push([nan, /cacheRate\.good 必须是有限数字/]);

    const str = cloneSettings(base.settings);
    str.health.minSamples = '3';
    cases.push([str, /health\.minSamples 必须是有限数字/]);

    const proto = JSON.parse(
      JSON.stringify(base.settings).replace('"health":{', '"health":{"__proto__":{"polluted":true},'),
    );
    cases.push([proto, /health 包含未知字段 __proto__/]);

    const localOnly = { ...cloneSettings(base.settings), display: { unitSystem: 'zh' } };
    cases.push([localOnly, /settings 包含未知字段 display/]);

    for (const [settings, pattern] of cases) {
      assert.throws(
        () => fx.store.update(settings, base.revision),
        (err) => err instanceof RuntimeSettingsError && pattern.test(err.message),
      );
    }
  } finally {
    fx.close();
  }
});

test('拒绝越界与跨字段相等/反转', () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    const build = (mutate) => {
      const settings = cloneSettings(base.settings);
      mutate(settings);
      return settings;
    };
    const cases = [
      [build((s) => { s.monitoring.cacheRate = { good: 0.5, warn: 0.5 }; }), /warn 必须小于 good/],
      [build((s) => { s.monitoring.cacheRate.good = 1.2; }), /cacheRate\.good/],
      [build((s) => { s.monitoring.latencyP50 = { goodMs: 0, warnMs: 5000 }; }), /latencyP50\.goodMs/],
      [build((s) => { s.monitoring.latencyP50 = { goodMs: 5000.5, warnMs: 15000 }; }), /latencyP50\.goodMs 必须是整数/],
      [build((s) => { s.health = { minSamples: 3.5, failErrorRate: 0.02 }; }), /health\.minSamples 必须是整数/],
      [build((s) => { s.monitoring.latencyP95 = { goodMs: 10, warnMs: 10 }; }), /goodMs 必须小于 warnMs/],
      [build((s) => { s.monitoring.latencyP95 = { goodMs: 1, warnMs: 3_600_001 }; }), /latencyP95\.warnMs/],
      [build((s) => { s.monitoring.runway = { dangerDays: 7, warnDays: 7 }; }), /dangerDays 必须小于 warnDays/],
      [build((s) => { s.monitoring.runway = { dangerDays: 0, warnDays: 7 }; }), /runway\.dangerDays/],
      [build((s) => { s.monitoring.freshness = { warnMinutes: 120, dangerMinutes: 120 }; }), /warnMinutes 必须小于 dangerMinutes/],
      [build((s) => { s.monitoring.freshness = { warnMinutes: 30, dangerMinutes: 10_081 }; }), /freshness\.dangerMinutes/],
      [build((s) => { s.collection = { logsMinutes: 0, spendMinutes: 15 }; }), /collection\.logsMinutes/],
      [build((s) => { s.collection = { logsMinutes: 1441, spendMinutes: 15 }; }), /collection\.logsMinutes/],
      [build((s) => { s.health = { minSamples: 0, failErrorRate: 0.02 }; }), /health\.minSamples/],
      [build((s) => { s.health = { minSamples: 3, failErrorRate: 0 }; }), /failErrorRate/],
      [build((s) => { s.health = { minSamples: 3, failErrorRate: 1.1 }; }), /failErrorRate/],
    ];
    for (const [settings, pattern] of cases) {
      assert.throws(
        () => fx.store.update(settings, base.revision),
        (err) => err instanceof RuntimeSettingsError && pattern.test(err.message),
      );
    }
  } finally {
    fx.close();
  }
});

test('collection 读取同样严格：任意分数分钟（不等于部署默认）直接报错', () => {
  const fx = withStore({ collectionDefaults: { logsMinutes: 15, spendMinutes: 15 } });
  try {
    fs.mkdirSync(fx.dir, { recursive: true });
    for (const collection of [
      { logsMinutes: 5.5, spendMinutes: 15 },
      { logsMinutes: 0.5, spendMinutes: 15 },
    ]) {
      fs.writeFileSync(fx.store.path, JSON.stringify({ ...defaultsOf(), collection }), 'utf8');
      assert.throws(
        () => fx.store.read(),
        (err) => err instanceof RuntimeSettingsError && /collection\.logsMinutes 必须是整数分钟/.test(err.message),
        `不得接受非部署默认的分数 ${collection.logsMinutes}`,
      );
    }
  } finally {
    fx.close();
  }

  // 只有与部署默认完全一致的小数才放行（例如 30000ms → 0.5 分钟）
  const fd = withStore({ collectionDefaults: { logsMinutes: 0.5, spendMinutes: 15 } });
  try {
    fs.mkdirSync(fd.dir, { recursive: true });
    fs.writeFileSync(
      fd.store.path,
      JSON.stringify({ ...defaultsOf(), collection: { logsMinutes: 0.5, spendMinutes: 15 } }),
      'utf8',
    );
    assert.deepEqual(fd.store.read().settings.collection, { logsMinutes: 0.5, spendMinutes: 15 });
  } finally {
    fd.close();
  }
});

test('revision 不匹配抛冲突；非法 revision 类型按参数错误处理', () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    assert.throws(
      () => fx.store.update(cloneSettings(base.settings), 'stale-revision'),
      (err) => err instanceof RevisionConflictError && err.code === 'revision_conflict',
    );
    assert.throws(
      () => fx.store.update(cloneSettings(base.settings), undefined),
      (err) => err instanceof RuntimeSettingsError,
    );
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// 原子写与损坏文件
// ---------------------------------------------------------------------------

test('校验失败不破坏已存在的文件，也不留下临时文件', () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    const good = cloneSettings(base.settings);
    good.health.minSamples = 7;
    const saved = fx.store.update(good, base.revision);
    const before = fs.readFileSync(fx.store.path, 'utf8');

    const bad = cloneSettings(saved.settings);
    bad.monitoring.cacheRate = { good: 0.3, warn: 0.9 };
    assert.throws(() => fx.store.update(bad, saved.revision), RuntimeSettingsError);

    assert.equal(fs.readFileSync(fx.store.path, 'utf8'), before, '失败写入不得改动原文件');
    assert.deepEqual(
      fs.readdirSync(fx.dir).filter((name) => name.endsWith('.tmp')),
      [],
      '临时文件必须清理',
    );
    assert.equal(fx.store.read().settings.health.minSamples, 7);
  } finally {
    fx.close();
  }
});

test('rename 失败时旧文件保持完整，临时文件被清理', () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    const good = cloneSettings(base.settings);
    good.health.minSamples = 5;
    fx.store.update(good, base.revision);
    const before = fs.readFileSync(fx.store.path, 'utf8');

    const next = cloneSettings(good);
    next.health.minSamples = 6;
    const originalRename = fs.renameSync;
    fs.renameSync = () => {
      throw new Error('rename boom');
    };
    try {
      assert.throws(() => fx.store.update(next, revisionOf(good)), /rename boom/);
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.readFileSync(fx.store.path, 'utf8'), before, 'rename 失败不得破坏旧文件');
    assert.equal(fx.store.read().settings.health.minSamples, 5);
    assert.deepEqual(
      fs.readdirSync(fx.dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fx.close();
  }
});

test('残留的临时文件不会阻断写入，也不会被误删', () => {
  const fx = withStore();
  try {
    fs.mkdirSync(fx.dir, { recursive: true });
    const stranger = path.join(fx.dir, '.runtime-settings.json.12345.1.tmp');
    fs.writeFileSync(stranger, 'leftover', 'utf8');

    const base = fx.store.read();
    const next = cloneSettings(base.settings);
    next.health.minSamples = 4;
    const updated = fx.store.update(next, base.revision);
    assert.equal(updated.settings.health.minSamples, 4);
    assert.equal(fs.readFileSync(stranger, 'utf8'), 'leftover', '陌生临时文件不得被删除');
    assert.equal(
      fs.readdirSync(fx.dir).filter((name) => name.endsWith('.tmp')).length,
      1,
      '本次写入不应留下自己的临时文件',
    );
  } finally {
    fx.close();
  }
});

test('文件损坏（非法 JSON / 未知字段）必须报错，不静默恢复默认', () => {
  const fx = withStore();
  try {
    fs.writeFileSync(fx.store.path, '{not json', 'utf8');
    assert.throws(() => fx.store.read(), /设置文件不是合法 JSON/);

    const base = defaultsOf();
    base.health.bogus = 1;
    fs.writeFileSync(fx.store.path, JSON.stringify(base), 'utf8');
    assert.throws(() => fx.store.read(), /health 包含未知字段 bogus/);
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// 采集器状态
// ---------------------------------------------------------------------------

test('采集器状态：缺文件 unconfirmed；写入后 active，允许小数分钟与关闭日志', () => {
  const fx = withStore();
  try {
    assert.deepEqual(fx.store.readCollectorStatus(1000), {
      state: 'unconfirmed',
      observedRevision: null,
      updatedAt: null,
      effective: { logsMinutes: null, spendMinutes: null },
      overrides: { logs: false, spend: false },
      logsEnabled: null,
    });

    const revision = fx.store.read().revision;
    fx.store.writeCollectorStatus({
      observedRevision: revision,
      updatedAt: 1000,
      effective: { logsMinutes: 1.5, spendMinutes: 0.5 },
      overrides: { logs: true, spend: true },
      logsEnabled: false,
    });
    const status = fx.store.readCollectorStatus(1000 + 30_000);
    assert.equal(status.state, 'active');
    assert.equal(status.observedRevision, revision);
    assert.deepEqual(status.effective, { logsMinutes: 1.5, spendMinutes: 0.5 });
    assert.deepEqual(status.overrides, { logs: true, spend: true });
    assert.equal(status.logsEnabled, false);
  } finally {
    fx.close();
  }
});

test('采集器状态：心跳新鲜但 revision 旧时仍是 active，只把未采用信息留在 observedRevision', () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    const next = cloneSettings(base.settings);
    next.health.minSamples = 9;
    const updated = fx.store.update(next, base.revision);

    // 采集器心跳仍是旧的：刚保存完、还没到下一次轮询
    fx.store.writeCollectorStatus({
      observedRevision: base.revision,
      updatedAt: 10_000,
      effective: { logsMinutes: 15, spendMinutes: 15 },
      overrides: { logs: false, spend: false },
      logsEnabled: true,
    });
    const status = fx.store.readCollectorStatus(10_000 + 30_000);
    assert.equal(status.state, 'active', '30s 内的心跳不能因为 revision 不同而判 stale');
    assert.equal(status.observedRevision, base.revision, '未采用的版本由 observedRevision 单独表达');
    assert.notEqual(status.observedRevision, updated.revision);

    // 90s 后仍按鲜度判 stale，与 revision 无关
    assert.equal(fx.store.readCollectorStatus(10_000 + COLLECTOR_STALE_MS).state, 'active');
    assert.equal(fx.store.readCollectorStatus(10_000 + COLLECTOR_STALE_MS + 1).state, 'stale');

    // 未来时间戳只在同一量级内被容忍，避免永久 active
    assert.equal(fx.store.readCollectorStatus(10_000 - 30_000).state, 'active');
    assert.equal(fx.store.readCollectorStatus(10_000 - 10 * COLLECTOR_STALE_MS).state, 'stale');
  } finally {
    fx.close();
  }
});

test('采集器状态：写入拒绝 unknown 字段与非法 effective；损坏状态文件报错', () => {
  const fx = withStore();
  try {
    const revision = fx.store.read().revision;
    assert.throws(
      () => fx.store.writeCollectorStatus({
        observedRevision: revision,
        updatedAt: 1,
        effective: { logsMinutes: 0, spendMinutes: 15 },
        overrides: { logs: false, spend: false },
        logsEnabled: true,
      }),
      /collector\.effective\.logsMinutes/,
    );
    assert.throws(
      () => fx.store.writeCollectorStatus({
        observedRevision: revision,
        updatedAt: 1,
        effective: { logsMinutes: 15, spendMinutes: 15 },
        overrides: { logs: false, spend: false },
        logsEnabled: true,
        state: 'active',
      }),
      /unknown|未知字段/,
    );

    fs.writeFileSync(fx.store.statusPath, '{oops', 'utf8');
    assert.throws(() => fx.store.readCollectorStatus(1), /不是合法 JSON/);
  } finally {
    fx.close();
  }
});

test('设置文件权限为 0600（Windows 跳过）', { skip: process.platform === 'win32' }, () => {
  const fx = withStore();
  try {
    const base = fx.store.read();
    fx.store.update(cloneSettings(base.settings), base.revision);
    const mode = fs.statSync(fx.store.path).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    fx.close();
  }
});
