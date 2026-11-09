/**
 * 看板独立库 v2/db/dashboard.db 的表结构。
 *
 * 与站点库分离：站点库只读，这里只存上游账户账本与任务运行记录。
 * 建表用 IF NOT EXISTS，服务启动时反复执行不会覆盖已有数据。
 * logs_daily 为聚合归档预留，当前只建表不写（明细超过保留期后仍能看历史）。
 */

export const SCHEMA_VERSION = 2;

/** 余额快照的归一化要求：balance 必须已按账户 unit 折算（newapi 的 quota / quota_per_unit） */
export const BALANCE_RAW_COLUMNS = {
  raw_balance: 'REAL',
  raw_unit: 'TEXT',
  // sub2api 的 /api/v1/auth/me 会返回累计充值总额；有了它就不必用「余额上涨」推断充值
  total_recharged: 'REAL',
};

export const DASHBOARD_SCHEMA = [
  // 上游账户（由 v2/secrets/accounts.json 同步，不含任何凭据）
  `CREATE TABLE IF NOT EXISTS upstream_account (
     id         TEXT PRIMARY KEY,
     name       TEXT,
     kind       TEXT,
     base_url   TEXT,
     unit       TEXT,
     enabled    INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER
   )`,

  // 渠道启用状态：源库 channels 的整表镜像，日志采集每轮刷新一次。
  // status=1 为启用；源库删除的渠道下一轮同步后自然消失，不做逐行对齐。
  `CREATE TABLE IF NOT EXISTS channel_state (
     channel_id INTEGER PRIMARY KEY,
     name       TEXT,
     status     INTEGER,
     base_url   TEXT,
     updated_at INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_channel_state_status ON channel_state(status)',

  // 余额快照：同一账户同一时刻只保留一条。
  // balance 必须已按账户 unit 归一；原始值与原始单位另存 raw_*，读取层不再猜换算。
  `CREATE TABLE IF NOT EXISTS balance_snapshot (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id  TEXT NOT NULL,
     t_ms        INTEGER NOT NULL,
     day         TEXT NOT NULL,
     balance     REAL NOT NULL,
     currency    TEXT,
     raw_balance REAL,
     raw_unit    TEXT,
     total_recharged REAL,
     source      TEXT,
     recorded_at INTEGER,
     UNIQUE (account_id, t_ms)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_balance_account_t ON balance_snapshot(account_id, t_ms)',
  'CREATE INDEX IF NOT EXISTS idx_balance_account_day ON balance_snapshot(account_id, day)',

  // 余额增加项明细：充值、系统赠额、退款等。单条事件只是 partial 证据，
  // 「没有事件」不等于「入账为 0」，零入账必须由 credit_window 明确声明。
  `CREATE TABLE IF NOT EXISTS credit_event (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id  TEXT NOT NULL,
     t_ms        INTEGER NOT NULL,
     amount      REAL NOT NULL,
     kind        TEXT NOT NULL,
     note        TEXT,
     source      TEXT,
     recorded_at INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_credit_account_t ON credit_event(account_id, t_ms)',

  // 区间入账汇总：采集器对某一窗口（通常是一个北京时间自然日）完成核对后写入，
  // status='complete' 表示 credits 是该窗口的确定值（可以是 0）。
  `CREATE TABLE IF NOT EXISTS credit_window (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id   TEXT NOT NULL,
     window_start INTEGER NOT NULL,
     window_end   INTEGER NOT NULL,
     credits      REAL NOT NULL,
     status       TEXT NOT NULL DEFAULT 'complete',
     source       TEXT,
     recorded_at  INTEGER,
     UNIQUE (account_id, window_start, window_end)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_credit_window_account ON credit_window(account_id, window_start, window_end)',

  // 上游侧按日用量（后续 job 写入，单位与 currency 一致）
  `CREATE TABLE IF NOT EXISTS upstream_spend_daily (
     account_id  TEXT NOT NULL,
     day         TEXT NOT NULL,
     spend       REAL,
     requests    INTEGER,
     currency    TEXT,
     source      TEXT,
     recorded_at INTEGER,
     PRIMARY KEY (account_id, day)
   )`,

  // 任务运行记录（本地预览阶段为空数组）
  `CREATE TABLE IF NOT EXISTS job_runs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     job         TEXT NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER,
     status      TEXT,
     detail      TEXT
   )`,

  // 站点日志的按日聚合归档：明细超过保留期（或 raw_json 清空）后仍能看历史。
  // 当前只建表不写；写入方按 (site, day, channel_id) UPSERT，day 为北京自然日 YYYY-MM-DD。
  `CREATE TABLE IF NOT EXISTS logs_daily (
     site         TEXT NOT NULL,
     day          TEXT NOT NULL,
     channel_id   INTEGER NOT NULL,
     channel_name TEXT,
     requests     INTEGER NOT NULL DEFAULT 0,
     cost         REAL NOT NULL DEFAULT 0,
     quota_raw    INTEGER NOT NULL DEFAULT 0,
     input_total  INTEGER NOT NULL DEFAULT 0,
     output       INTEGER NOT NULL DEFAULT 0,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (site, day, channel_id)
   )`,

  // nginx 访问日志的 4xx/5xx 按「北京整点 × 状态码 × 路径组」聚合。
  // 站点库 logs 没有状态码，错误率只能从 nginx 日志补；增量位点存 schema_meta.http_errors_offset。
  `CREATE TABLE IF NOT EXISTS http_errors_hourly (
     hour_ms    INTEGER NOT NULL,
     status     INTEGER NOT NULL,
     path_group TEXT NOT NULL,
     count      INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (hour_ms, status, path_group)
   )`,

  // 源库 logs 里 type=5（上游错误）的镜像：id 用源库 logs.id，天然幂等。
  // content 里的 status_code 单独提出；原文只留截断后的 message，供面板展示。
  `CREATE TABLE IF NOT EXISTS upstream_error (
     id           INTEGER PRIMARY KEY,
     t_ms         INTEGER NOT NULL,
     channel_id   INTEGER,
     channel_name TEXT,
     model        TEXT,
     group_name   TEXT,
     status_code  INTEGER,
     message      TEXT,
     request_id   TEXT,
     recorded_at  INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_upstream_error_t ON upstream_error(t_ms)',
  'CREATE INDEX IF NOT EXISTS idx_upstream_error_ch ON upstream_error(channel_id, t_ms)',

  // 结构元信息：只记一次，不覆盖已有值
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key        TEXT PRIMARY KEY,
     value      TEXT,
     updated_at INTEGER
   )`,
];

/** 老库补列（不重写、不删除既有数据） */
function ensureColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/** 原地建表；不删除、不改写既有行 */
export function initDashboardDb(db) {
  for (const sql of DASHBOARD_SCHEMA) db.exec(sql);
  ensureColumns(db, 'balance_snapshot', BALANCE_RAW_COLUMNS);
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run('schema_version', String(SCHEMA_VERSION), Date.now());
  return db;
}
