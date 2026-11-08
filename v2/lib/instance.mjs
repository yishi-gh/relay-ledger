/**
 * 实例配置（instance.json）：站点标识、上游地址、数据目录、采集间隔。
 *
 * 为什么配置要外置：仓库要能公开，每个人部署的站点名、上游域名、数据库路径都不一样；
 * 写死在代码里既暴露具体站点，也让别人没法直接部署自己的实例。
 *
 * 定位顺序：`--config=<path>` → 环境变量 `RELAY_LEDGER_INSTANCE` → `<repo>/instance.json`。
 * 文件不存在是正常的首次启动：全部取默认值，不抛错。只有文件存在但读不出合法 JSON 时
 * 才向 stderr 打一行中文警告（只含路径与错误类型，不含文件内容）。
 *
 * 路径解析：`paths.*` 的相对路径相对于 instance.json 所在目录；没有配置文件时相对于仓库根。
 * 历史目录回退：老部署的数据在 `<repo>/db`、`<repo>/v2/db`、`<repo>/meta`，
 * 新目录没有文件时按下面的顺序找旧路径，保证升级后不改配置也能读到原来的库。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.dirname(HERE);
const REPO_ROOT = path.dirname(V2_DIR);

const DEFAULT_SITE_ID = 'relay';
const DEFAULT_LOG_PATH = '/api/log';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_RELAY_DB = '/home/newapi/one-api.db';

const asObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const asText = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
};

const asPositiveInt = (value, fallback) =>
  Number.isInteger(value) && value > 0 ? value : fallback;

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** 相对路径按 baseDir 解析；缺省或空串用 fallback（已是绝对路径） */
function toAbs(value, baseDir, fallback) {
  const text = asText(value);
  if (!text) return fallback;
  // 绝对路径原样保留：配置里写的是 POSIX 路径时不要在 Windows 上改写分隔符
  return path.isAbsolute(text) ? text : path.resolve(baseDir, text);
}

/** stdout 之外的一份提示：配置文件本身不打印，只给路径与错误类型 */
function warnConfig(reason, file) {
  console.warn(`[instance] 配置文件${reason}，已使用默认配置：${file}`);
}

/** 命令行里的 --config=<path>；其它参数留给各脚本自己解析 */
function configFromArgv() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length).trim();
      if (value) return value;
    }
  }
  return null;
}
function locateConfigFile(repoRoot) {
  const picked = configFromArgv() ?? asText(process.env.RELAY_LEDGER_INSTANCE)
    ?? path.join(repoRoot, 'instance.json');
  return path.resolve(picked);
}

/** 站点库候选：新数据目录 → 仓库旧目录；老部署只有一个 *.db 时连站点名一起认下来 */
function listSiteDbs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function buildInstance({ file, repoRoot, raw }) {
  const siteRaw = asObject(raw.site);
  const pathsRaw = asObject(raw.paths);
  const collectRaw = asObject(raw.collect);

  const baseDir = file ? path.dirname(file) : repoRoot;
  const dataDir = toAbs(pathsRaw.data_dir, baseDir, path.resolve(repoRoot, 'data'));

  const explicitId = asText(siteRaw.id);
  let siteId = explicitId ?? DEFAULT_SITE_ID;
  const siteName = asText(siteRaw.name);
  const baseUrl = asText(siteRaw.base_url);
  const logPath = asText(siteRaw.log_path) ?? DEFAULT_LOG_PATH;

  const primarySiteDb = path.join(dataDir, 'db', 'sites', `${siteId}.db`);
  const legacySiteDb = path.join(repoRoot, 'db', 'sites', `${siteId}.db`);
  let siteDbFile;
  if (isFile(primarySiteDb)) {
    siteDbFile = primarySiteDb;
  } else if (isFile(legacySiteDb)) {
    siteDbFile = legacySiteDb;
  } else {
    const legacyDbs = listSiteDbs(path.join(repoRoot, 'db', 'sites'));
    // 只有配置里没写 site.id 时才认领唯一的旧库（升级场景）；显式写了 id 就按 id 走，
    // 否则新实例会被目录里其它库「顶包」，读到的不是自己的数据。
    if (!explicitId && legacyDbs.length === 1) {
      // 单站点老部署：库里只有一个库文件，站点名跟着它走，配置里没写 id 也不用改
      siteDbFile = legacyDbs[0];
      siteId = path.basename(legacyDbs[0], '.db');
    } else {
      siteDbFile = primarySiteDb;
    }
  }

  const primaryDashboard = path.join(dataDir, 'dashboard.db');
  const legacyDashboard = path.join(repoRoot, 'v2', 'db', 'dashboard.db');
  const dashboardFile = isFile(primaryDashboard)
    ? primaryDashboard
    : isFile(legacyDashboard) ? legacyDashboard : primaryDashboard;

  const primaryToken = path.join(dataDir, 'site_token.txt');
  const legacyToken = path.join(repoRoot, 'meta', 'site_token.txt');
  const tokenFile = asText(pathsRaw.site_token)
    ? toAbs(pathsRaw.site_token, baseDir, primaryToken)
    : isFile(primaryToken) ? primaryToken : isFile(legacyToken) ? legacyToken : primaryToken;

  const primaryAccounts = path.join(dataDir, 'accounts.json');
  const legacyAccounts = path.join(repoRoot, 'v2', 'secrets', 'accounts.json');
  const accountsFile = asText(pathsRaw.accounts)
    ? toAbs(pathsRaw.accounts, baseDir, primaryAccounts)
    : isFile(primaryAccounts)
      ? primaryAccounts
      : isFile(legacyAccounts) ? legacyAccounts : primaryAccounts;

  return {
    file: file ?? null,
    site: {
      id: siteId,
      name: siteName ?? siteId,
      base_url: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
      log_path: logPath.startsWith('/') ? logPath : `/${logPath}`,
    },
    paths: {
      dataDir,
      siteDbFile,
      dashboardFile,
      relayDb: toAbs(pathsRaw.relay_db, baseDir, DEFAULT_RELAY_DB),
      tokenFile,
      accountsFile,
    },
    collect: {
      source: collectRaw.source === 'http' ? 'http' : 'db',
      spendIntervalMs: asPositiveInt(collectRaw.spend_interval_ms, DEFAULT_INTERVAL_MS),
      logsIntervalMs: asPositiveInt(collectRaw.logs_interval_ms, DEFAULT_INTERVAL_MS),
    },
  };
}

/** 纯默认值：不读文件、不判断目录，供测试与文档对照用 */
export function defaultInstance({ repoRoot = REPO_ROOT } = {}) {
  const dataDir = path.resolve(repoRoot, 'data');
  return {
    file: null,
    site: {
      id: DEFAULT_SITE_ID,
      name: DEFAULT_SITE_ID,
      base_url: null,
      log_path: DEFAULT_LOG_PATH,
    },
    paths: {
      dataDir,
      siteDbFile: path.join(dataDir, 'db', 'sites', `${DEFAULT_SITE_ID}.db`),
      dashboardFile: path.join(dataDir, 'dashboard.db'),
      relayDb: DEFAULT_RELAY_DB,
      tokenFile: path.join(dataDir, 'site_token.txt'),
      accountsFile: path.join(dataDir, 'accounts.json'),
    },
    collect: {
      source: 'db',
      spendIntervalMs: DEFAULT_INTERVAL_MS,
      logsIntervalMs: DEFAULT_INTERVAL_MS,
    },
  };
}

/**
 * 解析实例配置，永不抛错。
 * @param {{file?: string|null, repoRoot?: string}} [options] file 显式指定配置文件（null = 不读文件，
 *   省略 = 按 --config / 环境变量 / 仓库根 instance.json 定位）；repoRoot 只给测试注入临时仓库根。
 */
export function loadInstance({ file, repoRoot = REPO_ROOT } = {}) {
  const root = path.resolve(repoRoot);
  const target = file === undefined
    ? locateConfigFile(root)
    : file === null ? null : path.resolve(String(file));

  const exists = target !== null && isFile(target);
  let raw = {};
  if (exists) {
    try {
      raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      warnConfig(
        err instanceof SyntaxError ? '不是合法 JSON' : `读取失败（${err?.code ?? err?.name ?? 'unknown'}）`,
        target,
      );
      raw = {};
    }
  }

  return buildInstance({ file: exists ? target : null, repoRoot: root, raw });
}

/** 写库前建数据目录；重复调用无副作用 */
export function ensureDataDirs(inst = INSTANCE) {
  const dataDir = inst?.paths?.dataDir;
  if (!dataDir) return null;
  const sitesDir = path.join(dataDir, 'db', 'sites');
  fs.mkdirSync(sitesDir, { recursive: true });
  return { dataDir, sitesDir };
}

/** 进程启动时解析一次的实例；各入口模块直接 import 这个常量 */
export const INSTANCE = loadInstance();
/** 实际用到的配置文件绝对路径，没有配置文件时为 null */
export const INSTANCE_FILE = INSTANCE.file;
