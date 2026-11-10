/**
 * 运行时设置的持久化与校验。
 *
 * 作用域：monitoring / collection / health 三组是「服务端设置」，落在 dataDir 下，
 * 由面板 PATCH 写入、调度器读取后调整采集间隔；display / refresh 只属于前端本地偏好，
 * 服务端不存（HTTP GET 仍把它们作为 defaults 一并下发）。
 *
 * 文件语义：
 * - runtime-settings.json 不存在 = 全部取默认值；存在但读不出/校验不过 = 抛错，不假装恢复默认。
 * - 写入一律 0600 + 同目录临时文件 + rename，避免读到半个文件。
 * - revision 是完整三组配置的稳定 hash，调度器据此判断是否需要重新采用设置。
 * - collector-settings-status.json 是采集器心跳快照，仅记录「它实际用了什么」；
 *   state 由读取方按时效推导，不落盘。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 共享默认值（display / refresh / monitoring / collection / health） */
export const SHARED_DEFAULTS = JSON.parse(
  fs.readFileSync(new URL('../../shared/settings-defaults.json', import.meta.url), 'utf8'),
);

/** 服务端真正持久化的三组 */
export const SERVER_GROUP_KEYS = Object.freeze(['monitoring', 'collection', 'health']);

export const SETTINGS_FILE_NAME = 'runtime-settings.json';
export const STATUS_FILE_NAME = 'collector-settings-status.json';

/** 心跳超过该时长未更新即视为 stale */
export const COLLECTOR_STALE_MS = 90_000;

/** 采集间隔的合法区间（分钟）：PATCH 修改时必须落在这里 */
export const COLLECTION_MINUTES_MIN = 1;
export const COLLECTION_MINUTES_MAX = 1440;

export class RuntimeSettingsError extends Error {
  constructor(message, code = 'invalid_settings') {
    super(message);
    this.name = 'RuntimeSettingsError';
    this.code = code;
  }
}

export class RevisionConflictError extends RuntimeSettingsError {
  constructor(message = '设置版本不匹配，请刷新后重试') {
    super(message, 'revision_conflict');
    this.name = 'RevisionConflictError';
  }
}

const invalid = (message) => new RuntimeSettingsError(message);

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function expectObject(value, label) {
  if (!isPlainObject(value)) throw invalid(`${label} 必须是对象`);
  return value;
}

/** 严格键集合：拒绝缺字段之外的 unknown 字段，也顺带挡住 __proto__ 一类键 */
function expectKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${label} 包含未知字段 ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw invalid(`${label}.${key} 缺失`);
  }
}

function expectFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${label} 必须是有限数字`);
  }
  return value;
}

function expectInteger(value, label) {
  expectFiniteNumber(value, label);
  if (!Number.isInteger(value)) throw invalid(`${label} 必须是整数`);
  return value;
}

function expectRange(value, min, max, label, { inclusiveMin = true, inclusiveMax = true } = {}) {
  const lowOk = inclusiveMin ? value >= min : value > min;
  const highOk = inclusiveMax ? value <= max : value < max;
  if (!lowOk || !highOk) {
    const low = `${inclusiveMin ? '≥' : '>'} ${min}`;
    const high = `${inclusiveMax ? '≤' : '<'} ${max}`;
    throw invalid(`${label} 必须在 ${low} 且 ${high} 之间`);
  }
  return value;
}

function validateCacheRate(value) {
  expectObject(value, 'monitoring.cacheRate');
  expectKeys(value, ['good', 'warn'], 'monitoring.cacheRate');
  const good = expectFiniteNumber(value.good, 'monitoring.cacheRate.good');
  const warn = expectFiniteNumber(value.warn, 'monitoring.cacheRate.warn');
  expectRange(good, 0, 1, 'monitoring.cacheRate.good');
  expectRange(warn, 0, 1, 'monitoring.cacheRate.warn');
  if (!(warn < good)) throw invalid('monitoring.cacheRate.warn 必须小于 good');
  return { good, warn };
}

function validateLatency(value, label) {
  expectObject(value, label);
  expectKeys(value, ['goodMs', 'warnMs'], label);
  const goodMs = expectInteger(value.goodMs, `${label}.goodMs`);
  const warnMs = expectInteger(value.warnMs, `${label}.warnMs`);
  expectRange(goodMs, 0, 3_600_000, `${label}.goodMs`, { inclusiveMin: false });
  expectRange(warnMs, 0, 3_600_000, `${label}.warnMs`, { inclusiveMin: false });
  if (!(goodMs < warnMs)) throw invalid(`${label}.goodMs 必须小于 warnMs`);
  return { goodMs, warnMs };
}

function validateRunway(value) {
  expectObject(value, 'monitoring.runway');
  expectKeys(value, ['dangerDays', 'warnDays'], 'monitoring.runway');
  const dangerDays = expectFiniteNumber(value.dangerDays, 'monitoring.runway.dangerDays');
  const warnDays = expectFiniteNumber(value.warnDays, 'monitoring.runway.warnDays');
  expectRange(dangerDays, 0, 3650, 'monitoring.runway.dangerDays', { inclusiveMin: false });
  expectRange(warnDays, 0, 3650, 'monitoring.runway.warnDays', { inclusiveMin: false });
  if (!(dangerDays < warnDays)) throw invalid('monitoring.runway.dangerDays 必须小于 warnDays');
  return { dangerDays, warnDays };
}

function validateFreshness(value) {
  expectObject(value, 'monitoring.freshness');
  expectKeys(value, ['warnMinutes', 'dangerMinutes'], 'monitoring.freshness');
  const warnMinutes = expectFiniteNumber(value.warnMinutes, 'monitoring.freshness.warnMinutes');
  const dangerMinutes = expectFiniteNumber(value.dangerMinutes, 'monitoring.freshness.dangerMinutes');
  expectRange(warnMinutes, 0, 10_080, 'monitoring.freshness.warnMinutes', { inclusiveMin: false });
  expectRange(dangerMinutes, 0, 10_080, 'monitoring.freshness.dangerMinutes', { inclusiveMin: false });
  if (!(warnMinutes < dangerMinutes)) throw invalid('monitoring.freshness.warnMinutes 必须小于 dangerMinutes');
  return { warnMinutes, dangerMinutes };
}

function validateMonitoring(value) {
  expectObject(value, 'monitoring');
  expectKeys(
    value,
    ['cacheRate', 'latencyP50', 'latencyP95', 'runway', 'freshness'],
    'monitoring',
  );
  return {
    cacheRate: validateCacheRate(value.cacheRate),
    latencyP50: validateLatency(value.latencyP50, 'monitoring.latencyP50'),
    latencyP95: validateLatency(value.latencyP95, 'monitoring.latencyP95'),
    runway: validateRunway(value.runway),
    freshness: validateFreshness(value.freshness),
  };
}

/**
 * collection：只有「与部署默认值完全一致」的值可以不是 1..1440 的整数
 * （instance 的毫秒换算可能是 30000ms → 0.5 分钟）。其余值一律严格校验，
 * 避免人工写入任意正小数后，前端按 defaults 比较永远报错。
 */
function validateCollection(value, defaultsCollection) {
  expectObject(value, 'collection');
  expectKeys(value, ['logsMinutes', 'spendMinutes'], 'collection');
  const out = {};
  for (const key of ['logsMinutes', 'spendMinutes']) {
    const minutes = expectFiniteNumber(value[key], `collection.${key}`);
    if (!(minutes > 0)) throw invalid(`collection.${key} 必须大于 0`);
    const isDeploymentDefault = defaultsCollection != null && defaultsCollection[key] === minutes;
    if (!isDeploymentDefault) {
      if (!Number.isInteger(minutes)) throw invalid(`collection.${key} 必须是整数分钟`);
      expectRange(minutes, COLLECTION_MINUTES_MIN, COLLECTION_MINUTES_MAX, `collection.${key}`);
    }
    out[key] = minutes;
  }
  return out;
}

function validateHealth(value) {
  expectObject(value, 'health');
  expectKeys(value, ['minSamples', 'failErrorRate'], 'health');
  const minSamples = expectInteger(value.minSamples, 'health.minSamples');
  expectRange(minSamples, 1, 1_000_000, 'health.minSamples');
  const failErrorRate = expectFiniteNumber(value.failErrorRate, 'health.failErrorRate');
  expectRange(failErrorRate, 0, 1, 'health.failErrorRate', { inclusiveMin: false });
  return { minSamples, failErrorRate };
}

/** 校验并归一化三组设置；collection 的豁免只对部署默认值生效 */
function validateSettings(value, { defaultsCollection } = {}) {
  expectObject(value, 'settings');
  expectKeys(value, SERVER_GROUP_KEYS, 'settings');
  return {
    monitoring: validateMonitoring(value.monitoring),
    collection: validateCollection(value.collection, defaultsCollection),
    health: validateHealth(value.health),
  };
}

/** 稳定序列化：键排序后拼 JSON，保证同一份配置得到同一个 revision */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function revisionOf(settings) {
  return crypto.createHash('sha256').update(canonical(settings)).digest('hex');
}

function normalizeDefaultsCollection(collectionDefaults) {
  if (collectionDefaults == null) return clone(SHARED_DEFAULTS.collection);
  expectObject(collectionDefaults, 'collectionDefaults');
  expectKeys(collectionDefaults, ['logsMinutes', 'spendMinutes'], 'collectionDefaults');
  const out = {};
  for (const key of ['logsMinutes', 'spendMinutes']) {
    const minutes = expectFiniteNumber(collectionDefaults[key], `collectionDefaults.${key}`);
    if (!(minutes > 0)) throw invalid(`collectionDefaults.${key} 必须大于 0`);
    out[key] = minutes;
  }
  return out;
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`设置文件不是合法 JSON：${file}`);
  }
}

let tempSeq = 0;

/** 原子写：同目录临时文件 + fsync + rename，权限 0600；失败时只清自己创建的临时文件 */
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  tempSeq += 1;
  // 进程内序号防同毫秒重名，UUID 防跨进程/异常退出后的残留撞名（wx 会 EEXIST）
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${tempSeq}.${crypto.randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖原始错误 */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw err;
  }
}

const STATUS_KEYS = ['observedRevision', 'updatedAt', 'effective', 'overrides', 'logsEnabled'];

function validateEffective(value) {
  expectObject(value, 'collector.effective');
  expectKeys(value, ['logsMinutes', 'spendMinutes'], 'collector.effective');
  const out = {};
  for (const key of ['logsMinutes', 'spendMinutes']) {
    const minutes = value[key];
    if (minutes === null) {
      out[key] = null;
      continue;
    }
    expectFiniteNumber(minutes, `collector.effective.${key}`);
    if (!(minutes > 0)) throw invalid(`collector.effective.${key} 必须大于 0 或为 null`);
    out[key] = minutes;
  }
  return out;
}

function validateOverrides(value) {
  expectObject(value, 'collector.overrides');
  expectKeys(value, ['logs', 'spend'], 'collector.overrides');
  for (const key of ['logs', 'spend']) {
    if (typeof value[key] !== 'boolean') throw invalid(`collector.overrides.${key} 必须是布尔值`);
  }
  return { logs: value.logs, spend: value.spend };
}

function validateStatus(value, { requireUpdatedAt = false } = {}) {
  expectObject(value, 'collector');
  expectKeys(value, STATUS_KEYS, 'collector');
  const observedRevision = value.observedRevision;
  if (observedRevision !== null && typeof observedRevision !== 'string') {
    throw invalid('collector.observedRevision 必须是字符串或 null');
  }
  let updatedAt = value.updatedAt;
  if (updatedAt === null) {
    if (requireUpdatedAt) throw invalid('collector.updatedAt 缺失');
  } else {
    updatedAt = expectFiniteNumber(updatedAt, 'collector.updatedAt');
  }
  const logsEnabled = value.logsEnabled;
  if (logsEnabled !== null && typeof logsEnabled !== 'boolean') {
    throw invalid('collector.logsEnabled 必须是布尔值或 null');
  }
  return {
    observedRevision,
    updatedAt,
    effective: validateEffective(value.effective),
    overrides: validateOverrides(value.overrides),
    logsEnabled,
  };
}

/**
 * @param {{dataDir: string, collectionDefaults?: {logsMinutes: number, spendMinutes: number}}} options
 */
export function createRuntimeSettingsStore({ dataDir, collectionDefaults } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw invalid('dataDir 不能为空');
  }
  const settingsPath = path.resolve(dataDir, SETTINGS_FILE_NAME);
  const statusPath = path.resolve(dataDir, STATUS_FILE_NAME);
  const defaults = {
    monitoring: clone(SHARED_DEFAULTS.monitoring),
    collection: normalizeDefaultsCollection(collectionDefaults),
    health: clone(SHARED_DEFAULTS.health),
  };

  function read() {
    const raw = readJsonFile(settingsPath);
    // 文件里的 collection 同样严格校验：只有等于部署默认值的分数分钟才放行
    const settings = raw === null
      ? clone(defaults)
      : validateSettings(raw, { defaultsCollection: defaults.collection });
    return {
      settings,
      defaults: clone(defaults),
      revision: revisionOf(settings),
    };
  }

  function update(nextSettings, expectedRevision) {
    const current = read();
    if (typeof expectedRevision !== 'string') {
      throw invalid('revision 必须是字符串');
    }
    if (expectedRevision !== current.revision) {
      throw new RevisionConflictError();
    }
    const settings = validateSettings(nextSettings, { defaultsCollection: defaults.collection });
    writeJsonAtomic(settingsPath, settings);
    return {
      settings,
      defaults: clone(defaults),
      revision: revisionOf(settings),
    };
  }

  function writeCollectorStatus(status) {
    const normalized = validateStatus(status);
    const payload = {
      observedRevision: normalized.observedRevision,
      updatedAt: normalized.updatedAt ?? Date.now(),
      effective: normalized.effective,
      overrides: normalized.overrides,
      logsEnabled: normalized.logsEnabled,
    };
    writeJsonAtomic(statusPath, payload);
    return payload;
  }

  function readCollectorStatus(now = Date.now()) {
    const raw = readJsonFile(statusPath);
    if (raw === null) {
      return {
        state: 'unconfirmed',
        observedRevision: null,
        updatedAt: null,
        effective: { logsMinutes: null, spendMinutes: null },
        overrides: { logs: false, spend: false },
        logsEnabled: null,
      };
    }
    const status = validateStatus(raw, { requireUpdatedAt: true });
    // state 只表达心跳鲜度：新鲜即 active，超过 90s 即 stale。
    // 是否已采用最新 revision 由 observedRevision 单独表达（pending 由前端展示），
    // 不能把「刚保存、心跳还没回来」误报成「超过 90s 未上报」。
    const elapsed = now - status.updatedAt;
    const fresh = Number.isFinite(elapsed)
      && elapsed <= COLLECTOR_STALE_MS
      && elapsed >= -COLLECTOR_STALE_MS; // 容忍同量级的时钟偏移，不无限相信未来时间戳
    return {
      state: fresh ? 'active' : 'stale',
      ...status,
    };
  }

  return { read, update, path: settingsPath, statusPath, readCollectorStatus, writeCollectorStatus };
}
