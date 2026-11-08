// ==UserScript==
// @name         Relay Ledger 上游账户采集（通用采集文件）
// @namespace    relay-ledger.capture
// @version      1.2.9
// @description  在已登录的上游站点采集站点/账号/token/Cookie，暂存到 Tampermonkey 跨站存储；最后一次性导出 accounts.capture.json
// @author       relay-ledger
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 纯用户脚本工作流：
 * 1. 在每个已登录站点点菜单「捕获当前站点（暂存）」；
 * 2. 结果合并到 Tampermonkey 跨站点 GM 存储，不立即下载文件；
 * 3. 全部站点采集完，点「导出全部暂存账户」，一次性下载 accounts.capture.json。
 *
 * 产物是独立于 v2 配置的通用采集文件：
 *   { schema_version: 1, captured_at, accounts: [{ site_name, site_url, site_type,
 *     account: { id, name, email }, auth: { mode, token, cookie, refresh_token,
 *     expires_at, user_id }, captured_at }] }
 *
 * bearer 模式下 auth.cookie 也会尽量填完整 Cookie：上游的 access token 往往十几分钟就过期，
 * 服务端只有拿到 Cookie 才能在 token 失效后重新登录续期。
 * 插件不认识 v2 的 channels / endpoints / id 规则；这些由服务端导入器负责。
 * 不打印、不 alert 任何 token；采集文件里是明文凭据，注意文件权限。
 */
(function () {
  'use strict';

  const DB_NAME = 'relay-ledger-capture';
  const DB_STORE = 'handles';
  const HANDLE_KEY = 'accounts-dir';
  const FILE_NAME = 'accounts.capture.json';
  const SHARED_KEY = 'accounts-capture-shared-v1';
  const SCHEMA_VERSION = 1;
  const PICKER_OPTIONS = { id: 'relay-ledger-capture', mode: 'readwrite' };
  const ACCESS_TOKEN_KEYS = ['access_token', 'accessToken', 'token'];
  const REFRESH_TOKEN_KEYS = ['refresh_token', 'refreshToken'];
  const EXPIRES_KEYS = ['tokenExpiresAt', 'tokenExpiresAtMs', 'expires_at', 'expiresAt'];
  const AUTH_JSON_KEYS = ['sub2apiAuth', 'sub2api_auth', 'auth'];

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // 浮层状态：host/root 是 DOM，busy 防止并发采集
  const panelState = {
    host: null,
    status: null,
    action: null,
    close: null,
    busy: false,
    dismissed: false,
    hideTimer: null,
  };

  class CaptureError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'CaptureError';
      this.code = code;
    }
  }

  function alertUser(message) {
    try {
      (page.alert || window.alert).call(page, message);
    } catch {
      // 弹窗失败不额外抛错，避免掩盖原始问题
    }
  }

  function askUser(message) {
    try {
      return (page.prompt || window.prompt).call(page, message);
    } catch {
      return null;
    }
  }

  function unwrap(json) {
    if (json && typeof json === 'object' && !Array.isArray(json) && 'data' in json) return json.data;
    return json;
  }

  async function safeJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function toNum(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  /** 秒/毫秒时间戳统一成毫秒；无法识别返回 null */
  function toAbsoluteMs(value) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  function storageGet(key) {
    try {
      return page.localStorage ? page.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function storageKeys() {
    try {
      return page.localStorage ? Object.keys(page.localStorage) : [];
    } catch {
      return [];
    }
  }

  function storageEntries() {
    const entries = [];
    const areas = [];
    try {
      if (page.localStorage) areas.push(['local', page.localStorage]);
    } catch {
      // 存储不可读
    }
    try {
      if (page.sessionStorage) areas.push(['session', page.sessionStorage]);
    } catch {
      // 存储不可读
    }
    for (const [area, storage] of areas) {
      try {
        const length = storage.length;
        for (let i = 0; i < length; i += 1) {
          const key = storage.key(i);
          if (!key) continue;
          const value = storage.getItem(key);
          if (value) entries.push({ area, key, value });
        }
      } catch {
        // 某些沙箱下存储不可读，忽略该区域
      }
    }
    return entries;
  }

  function isTokenLike(value) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v || v.length < 8) return false;
    if (/\s/.test(v)) return false;
    return true;
  }

  function deepScan(value, visit, depth = 0) {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) deepScan(item, visit, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      visit(value);
      for (const child of Object.values(value)) deepScan(child, visit, depth + 1);
    }
  }

  /**
   * 扫描 localStorage / sessionStorage 全部键与嵌套 JSON（Zustand persist、auth-storage 等），
   * 提取 Sub2API 的 access token / refresh token / user / expires_at。
   */
  function scanSub2ApiStorage() {
    const result = { accessToken: null, refreshToken: null, user: null, expiresAt: null };
    for (const entry of storageEntries()) {
      const { key, value } = entry;
      if (!value) continue;
      const keyLower = key.toLowerCase();
      const trimmed = value.trim();

      if (!result.refreshToken && /refresh[_-]?token/i.test(keyLower) && isTokenLike(trimmed)) {
        result.refreshToken = trimmed;
      }
      if (
        !result.accessToken
        && !/refresh/i.test(keyLower)
        && /(^|[_-])access[_-]?token$|^token$|^(auth[_-])?token$/i.test(keyLower)
        && isTokenLike(trimmed)
      ) {
        result.accessToken = trimmed;
      }
      if (!result.expiresAt && /expire|expiry/i.test(keyLower)) {
        result.expiresAt = toAbsoluteMs(trimmed) ?? result.expiresAt;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      if (!result.user && /(^|_)user$|userinfo|user_info|^account$|^profile$/i.test(keyLower)) {
        const candidate = identityFromUserObject(parsed.user ?? parsed.account ?? parsed);
        if (candidate) result.user = candidate;
      }

      deepScan(parsed, (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v !== 'string' || !v.trim()) continue;
          const kl = k.toLowerCase();
          if (
            !result.accessToken
            && !/refresh/i.test(kl)
            && (kl === 'access_token' || kl === 'accesstoken' || kl === 'token' || kl === 'auth_token' || kl === 'authtoken')
            && isTokenLike(v)
          ) {
            result.accessToken = v.trim();
          }
          if (!result.refreshToken && (kl === 'refresh_token' || kl === 'refreshtoken') && isTokenLike(v)) {
            result.refreshToken = v.trim();
          }
          if (!result.expiresAt && /expire|expiry/i.test(kl)) {
            result.expiresAt = toAbsoluteMs(v) ?? result.expiresAt;
          }
        }
        if (!result.user) {
          const candidate = identityFromUserObject(obj.user)
            || identityFromUserObject(obj.account)
            || identityFromUserObject(obj.profile);
          if (candidate) result.user = candidate;
        }
      });
    }
    return result;
  }

  /** 解析 JWT payload.exp（毫秒）；失败返回 null */
  function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const payload = JSON.parse(page.atob ? page.atob(b64) : atob(b64));
      return payload && typeof payload === 'object' ? payload : null;
    } catch {
      return null;
    }
  }

  function jwtExpiryMs(token) {
    const payload = decodeJwtPayload(token);
    const exp = Number(payload && payload.exp);
    return Number.isFinite(exp) && exp > 0 ? Math.round(exp * 1000) : null;
  }

  // ---------------------------------------------------------------- IndexedDB

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, 1);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
    });
  }

  function idbGet(key) {
    return openHandleDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).get(key);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error || new Error('indexeddb_read_failed'));
          tx.oncomplete = () => db.close();
        }),
    );
  }

  function idbPut(key, value) {
    return openHandleDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(value, key);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error || new Error('indexeddb_write_failed'));
        }),
    );
  }

  function idbDelete(key) {
    return openHandleDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).delete(key);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error || new Error('indexeddb_delete_failed'));
        }),
    );
  }

  // ------------------------------------------------------------ 目录与文件

  function fsaSupported() {
    return typeof page.showDirectoryPicker === 'function';
  }

  function isSecureContextPage() {
    const host = location.hostname;
    return location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function isTopFrame() {
    try {
      return window.top === window.self;
    } catch {
      return false;
    }
  }

  /**
   * 必须在 DOM 按钮 click handler 里同步调用（第一个异步操作）。
   * 老版本 Chromium 不认识 options 时同步重试一次。
   */
  function invokeDirectoryPicker() {
    if (!fsaSupported()) {
      throw new CaptureError(
        'fsa_unsupported',
        '当前浏览器不支持 File System Access API。请用 Chrome / Edge，并确认页面是 HTTPS。',
      );
    }
    try {
      return page.showDirectoryPicker(PICKER_OPTIONS);
    } catch (err) {
      if (err && err.name === 'TypeError') return page.showDirectoryPicker();
      throw err;
    }
  }

  function describePickerError(err) {
    const name = err && err.name ? err.name : '未知错误';
    if (name === 'SecurityError') {
      return '浏览器拒绝了目录选择（SecurityError）。请确认：① 当前是顶层 HTTPS 页面（不是内嵌 iframe）；' +
        '② 直接点击页面右下角浮层里的按钮，而不是只点 Tampermonkey 菜单；' +
        '③ 使用 Chrome / Edge，并在地址栏文件访问提示里允许；④ 浏览器设置里未禁止该站点的文件系统访问。' +
        '若仍失败，刷新页面后重试。';
    }
    if (name === 'AbortError') return '已取消目录选择。点击下方按钮可重试。';
    if (name === 'NotAllowedError') {
      return '目录访问被拒绝：请在浏览器提示中允许文件读写；若已被永久拒绝，请在站点设置里恢复，或重新选择目录。';
    }
    if (name === 'NotFoundError') return '目录不存在或已被移动，请重新选择目录。';
    return `无法选择目录（${name}）。请确认是 Chrome/Edge 的 HTTPS 顶层页面，并重试。`;
  }

  // ------------------------------------------------------------------ 浮层

  const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';

  function clearHideTimer() {
    if (panelState.hideTimer) {
      clearTimeout(panelState.hideTimer);
      panelState.hideTimer = null;
    }
  }

  function closePanel() {
    clearHideTimer();
    if (panelState.host && panelState.host.parentNode) panelState.host.parentNode.removeChild(panelState.host);
    panelState.host = null;
    panelState.status = null;
    panelState.action = null;
    panelState.close = null;
    panelState.dismissed = true;
  }

  function ensurePanel() {
    if (panelState.host && panelState.host.isConnected) return true;
    if (panelState.dismissed) return false;
    closePanel();
    panelState.dismissed = false;

    const host = document.createElement('div');
    host.id = 'relay-ledger-capture-panel';
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'right: 16px',
      'bottom: 16px',
      'z-index: 2147483647',
      'box-sizing: border-box',
      'width: min(380px, calc(100vw - 32px))',
      'padding: 12px',
      'display: flex',
      'flex-direction: column',
      'gap: 8px',
      'border: 1px solid #334155',
      'border-radius: 10px',
      'background: #0f172a',
      'color: #e2e8f0',
      `font: 13px/1.5 ${PANEL_FONT}`,
      'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)',
      'pointer-events: auto',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Relay Ledger 采集';
    title.style.cssText = [
      'all: initial',
      'display: block',
      'font-weight: 600',
      'font-size: 13px',
      'color: #f8fafc',
      `font-family: ${PANEL_FONT}`,
    ].join(';');

    const status = document.createElement('div');
    status.textContent = '';
    status.style.cssText = [
      'all: initial',
      'display: block',
      'white-space: pre-wrap',
      'word-break: break-word',
      'font-size: 12px',
      'line-height: 1.6',
      'color: #cbd5e1',
      `font-family: ${PANEL_FONT}`,
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'all: initial; display: flex; gap: 8px; align-items: center;';

    const action = document.createElement('button');
    action.type = 'button';
    action.style.cssText = [
      'all: initial',
      'display: none',
      'cursor: pointer',
      'padding: 6px 12px',
      'border-radius: 6px',
      'border: 1px solid #2563eb',
      'background: #2563eb',
      'color: #ffffff',
      'font-size: 12px',
      'font-weight: 600',
      `font-family: ${PANEL_FONT}`,
      'line-height: 1.4',
    ].join(';');

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.style.cssText = [
      'all: initial',
      'display: inline-block',
      'cursor: pointer',
      'padding: 6px 10px',
      'border-radius: 6px',
      'border: 1px solid #475569',
      'background: transparent',
      'color: #cbd5e1',
      'font-size: 12px',
      `font-family: ${PANEL_FONT}`,
      'line-height: 1.4',
    ].join(';');
    close.onclick = () => closePanel();

    actions.appendChild(action);
    actions.appendChild(close);
    host.appendChild(title);
    host.appendChild(status);
    host.appendChild(actions);

    (document.body || document.documentElement).appendChild(host);
    panelState.host = host;
    panelState.status = status;
    panelState.action = action;
    panelState.close = close;
    return true;
  }

  function setPanelStatus(text, tone = 'info') {
    if (!ensurePanel() || !panelState.status) return;
    const colors = { info: '#cbd5e1', success: '#4ade80', warn: '#fbbf24', error: '#f87171' };
    panelState.status.textContent = text;
    panelState.status.style.color = colors[tone] || colors.info;
  }

  /** handler 必须是同步函数，picker/requestPermission 要在其中第一个异步操作 */
  function setPanelAction(label, handler) {
    if (!ensurePanel() || !panelState.action) return;
    panelState.action.textContent = label;
    panelState.action.style.display = 'inline-block';
    panelState.action.disabled = false;
    panelState.action.onclick = (event) => {
      if (event) event.preventDefault();
      handler();
    };
  }

  function hidePanelAction() {
    if (!panelState.action) return;
    panelState.action.style.display = 'none';
    panelState.action.onclick = null;
    panelState.action.disabled = true;
  }

  function scheduleClose(ms) {
    clearHideTimer();
    panelState.hideTimer = setTimeout(() => closePanel(), ms);
  }

  const WARNING_TEXT = {
    cookie_empty: '未读到 Cookie（导入后 access token 过期将无法续期）',
    cookie_read_failed: 'Cookie 读取失败（GM_cookie 报错）',
    gm_cookie_unavailable: 'GM_cookie 不可用（可能只拿到非 HttpOnly Cookie）',
    account_identity_unavailable: '未能确认账号身份',
  };

  /** 凭据摘要：只显示“已保存（N 字符）/为空”和 warning，绝不回显 token/cookie 内容 */
  function credentialStatus(entry) {
    const auth = entry.auth || {};
    const mark = (value) => (typeof value === 'string' && value ? `已保存（${value.length} 字符）` : '为空');
    const lines = [
      `认证方式：${auth.mode}`,
      `Bearer token：${mark(auth.token)}`,
      `Cookie：${mark(auth.cookie)}`,
      `refresh_token：${mark(auth.refresh_token)}`,
    ];
    if (auth.expires_at) lines.push(`access token 过期：${new Date(auth.expires_at).toLocaleString()}`);
    if (auth.user_id !== null && auth.user_id !== undefined) lines.push(`user_id：${auth.user_id}`);
    const warnings = Array.isArray(entry.warnings) ? entry.warnings : [];
    if (warnings.length) {
      lines.push(`提示：${warnings.map((code) => WARNING_TEXT[code] || code).join('；')}`);
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------- 暂存与导出入口

  async function openCapturePanel({ mode = 'stage' } = {}) {
    panelState.dismissed = false;
    ensurePanel();
    clearHideTimer();
    hidePanelAction();

    if (panelState.busy) {
      setPanelStatus('正在采集中，请稍候…');
      return;
    }

    if (mode === 'view') {
      showStagedSummary();
      return;
    }

    await runStageCapture();
  }

  function showStagedSummary() {
    const json = readSharedCapture();
    if (!json.accounts.length) {
      setPanelStatus('暂存为空。先在各个已登录站点执行「捕获当前站点（暂存）」。', 'warn');
      setPanelAction('捕获当前站点（暂存）', () => {
        void openCapturePanel({ mode: 'stage' });
      });
      return;
    }
    const lines = json.accounts.map((item) => {
      const account = item.account || {};
      const who = account.email || account.name || account.id || '未知账号';
      const cookieMark = item.auth && item.auth.cookie ? 'Cookie 已保存' : 'Cookie 为空';
      return `· ${item.site_url} — ${who}（${cookieMark}）`;
    });
    setPanelStatus(
      `已暂存 ${json.accounts.length} 个账号：\n${lines.join('\n')}\n\n点下方按钮一次性导出 ${FILE_NAME}。`,
      'info',
    );
    setPanelAction('导出全部暂存', () => {
      void runExportAll();
    });
  }

  // ------------------------------------------------------------ 读取/写入

  async function readCaptureJson(fileHandle) {
    const file = await fileHandle.getFile();
    const text = (await file.text()).trim();
    if (!text) {
      return { schema_version: SCHEMA_VERSION, captured_at: Date.now(), accounts: [] };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CaptureError('json_parse_failed', `${FILE_NAME} 不是合法 JSON，未做任何修改。`);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new CaptureError('json_parse_failed', `${FILE_NAME} 顶层不是对象，未做任何修改。`);
    }
    if (!Array.isArray(json.accounts)) {
      throw new CaptureError('json_invalid', `${FILE_NAME} 缺少 accounts 数组，未做任何修改。`);
    }
    return json;
  }

  async function writeCaptureJson(fileHandle, json) {
    if (!Array.isArray(json.accounts)) {
      throw new CaptureError('json_invalid', 'accounts 不是数组，未写入。');
    }
    const payload = `${JSON.stringify(json, null, 2)}\n`;
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(payload);
      await writable.close();
    } catch (err) {
      try {
        await writable.abort();
      } catch {
        // abort 失败也只能保留原文件
      }
      throw err;
    }
  }

  // -------------------------------------------------------------- 站点类型

  function storageTypeHint() {
    const keys = storageKeys().map((k) => k.toLowerCase());
    if (keys.some((k) => k.includes('sub2api'))) return 'sub2api';
    return null;
  }

  async function detectSiteType() {
    // Sub2API 优先：/api/v1/auth/me 存在时应返回 JSON；未带 token 的 401 同样说明是 Sub2API
    try {
      const response = await fetch('/api/v1/auth/me', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response) {
        if (response.status === 200) {
          const data = unwrap(await safeJson(response));
          if (data && typeof data === 'object') return { type: 'sub2api', systemName: null };
        } else if (response.status === 401 || response.status === 403) {
          return { type: 'sub2api', systemName: null };
        }
      }
    } catch {
      // 继续判断
    }

    // NewAPI：必须拿到 JSON 的 version / system_name 才认
    try {
      const response = await fetch('/api/status', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response && response.ok) {
        const data = unwrap(await safeJson(response));
        if (data && typeof data === 'object' && (data.version !== undefined || data.system_name !== undefined)) {
          return { type: 'newapi', systemName: typeof data.system_name === 'string' ? data.system_name : null };
        }
      }
    } catch {
      // 继续尝试下一类
    }

    const hint = storageTypeHint();
    if (hint) return { type: hint, systemName: null };

    // 两个接口都判不出来时，若存储里有 Sub2API 风格的 token/user，也倾向 Sub2API
    try {
      const scanned = scanSub2ApiStorage();
      if (scanned.accessToken || scanned.refreshToken || scanned.user) {
        return { type: 'sub2api', systemName: null };
      }
    } catch {
      // 扫描失败继续弹窗
    }

    const answer = askUser('无法自动判断站点类型。请输入 newapi 或 sub2api：');
    if (answer === null) throw new CaptureError('site_type_unknown', '已取消，未判断站点类型。');
    const type = answer.trim().toLowerCase();
    if (type === 'newapi' || type === 'sub2api') return { type, systemName: null };
    throw new CaptureError('site_type_unknown', '站点类型只能是 newapi 或 sub2api。');
  }

  // ------------------------------------------------------------------ 账号

  async function readNewApiSelf({ cookie = null, token = null, sessionId = null } = {}) {
    try {
      const headers = { Accept: 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (token) headers.Authorization = `Bearer ${token}`;
      if (sessionId) headers['X-Auth-Session'] = sessionId;
      let response;
      try {
        response = await fetch('/api/user/self', { credentials: 'include', headers });
      } catch (err) {
        // 浏览器可能把 Cookie 当 forbidden header 直接拒绝；退回不带 Cookie 头的请求
        if (!cookie) throw err;
        const fallbackHeaders = { Accept: 'application/json' };
        if (token) fallbackHeaders.Authorization = `Bearer ${token}`;
        if (sessionId) fallbackHeaders['X-Auth-Session'] = sessionId;
        response = await fetch('/api/user/self', {
          credentials: 'include',
          headers: fallbackHeaders,
        });
      }
      if (!response || !response.ok) return null;
      const data = unwrap(await safeJson(response));
      if (!data || typeof data !== 'object') return null;
      const id = data.id ?? data.user_id ?? null;
      const username = data.username ?? data.user_name ?? null;
      const name = data.display_name ?? data.displayName ?? data.name ?? username ?? null;
      const email = data.email ?? null;
      if (id === null && !username && !email) return null;
      return {
        id: id === null ? null : String(id),
        username: typeof username === 'string' ? username : null,
        name: typeof name === 'string' ? name : null,
        email: typeof email === 'string' ? email : null,
        quota: toNum(data.quota),
        usedQuota: toNum(data.used_quota),
      };
    } catch {
      return null;
    }
  }

  async function readSub2ApiSelf(accessToken, { cookie = null } = {}) {
    const headers = { Accept: 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (cookie) headers.Cookie = cookie;
    try {
      let response;
      try {
        response = await fetch('/api/v1/auth/me', { credentials: 'include', headers });
      } catch (err) {
        if (!cookie) throw err;
        const fallbackHeaders = { Accept: 'application/json' };
        if (accessToken) fallbackHeaders.Authorization = `Bearer ${accessToken}`;
        response = await fetch('/api/v1/auth/me', { credentials: 'include', headers: fallbackHeaders });
      }
      if (!response || !response.ok) return null;
      const data = unwrap(await safeJson(response));
      if (!data || typeof data !== 'object') return null;
      const id = data.user_id ?? data.id ?? null;
      const username = data.username ?? data.user_name ?? null;
      const name = data.display_name ?? data.displayName ?? data.name ?? username ?? null;
      const email = data.email ?? null;
      return {
        id: id === null ? null : String(id),
        username: typeof username === 'string' ? username : null,
        name: typeof name === 'string' ? name : null,
        email: typeof email === 'string' ? email : null,
        quota: toNum(data.quota),
        balanceUsd: toNum(data.balanceUsd ?? data.balance_usd),
      };
    } catch {
      return null;
    }
  }

  /** 无身份时的站点兜底（NewAPI/Sub2API 共用），带指纹去重所需的标记 */
  function siteFallbackIdentity(site) {
    const host = location.hostname;
    return {
      id: `site:${host}`,
      username: null,
      name: (site && site.systemName) || host,
      email: null,
      identity_source: 'site_fallback',
      warnings: ['account_identity_unavailable'],
    };
  }

  /** Sub2API refresh：POST /api/v1/auth/refresh，body {refresh_token} */
  async function refreshSub2ApiSession(refreshToken) {
    if (!refreshToken) return null;
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!response || !response.ok) return null;
      const json = await safeJson(response);
      if (!json || typeof json !== 'object') return null;
      const payload = json.data && typeof json.data === 'object' ? json.data : json;
      const token = firstString(payload, ['access_token', 'accessToken']);
      if (!token) return null;
      const expiresIn = toNum(payload.expires_in);
      return {
        token,
        refreshToken: firstString(payload, ['refresh_token', 'refreshToken']) || refreshToken,
        expiresAt: expiresIn !== null
          ? Date.now() + Math.round(expiresIn * 1000)
          : (toAbsoluteMs(payload.expires_at ?? payload.expiresAt) ?? jwtExpiryMs(token)),
      };
    } catch {
      return null;
    }
  }

  /**
   * Sub2API 身份：扫描 storage 的 token → /auth/me → refresh → /auth/me
   * → Cookie 重试 → storage.user → JWT → site:<host>。全程不弹窗。
   */
  async function readSub2ApiIdentity(site) {
    const storage = scanSub2ApiStorage();
    let session = null;
    let account = await readSub2ApiSelf(storage.accessToken);

    if (!account && storage.refreshToken) {
      const refreshed = await refreshSub2ApiSession(storage.refreshToken);
      if (refreshed) {
        session = refreshed;
        account = await readSub2ApiSelf(refreshed.token);
      }
    }

    if (!account) {
      let cookie = null;
      try {
        cookie = await sessionCookieHeader();
      } catch {
        cookie = null;
      }
      if (cookie) account = await readSub2ApiSelf(null, { cookie });
    }

    if (!account && storage.user) account = storage.user;
    if (!account && storage.accessToken) account = identityFromJwt(storage.accessToken);
    if (!account) account = siteFallbackIdentity(site);

    return { account, storage, session };
  }

  function firstString(source, keys) {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  }

  /** 从 localStorage 的 user/userInfo/user_info/account/access_token 里找身份（JSON） */
  function readIdentityFromStorage() {
    for (const key of ['user', 'userInfo', 'user_info', 'account', 'access_token']) {
      const raw = storageGet(key);
      if (!raw) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      const candidate = obj.user && typeof obj.user === 'object' ? obj.user : obj;
      const id = firstString(candidate, ['id', 'user_id', 'userId', 'uid']);
      const username = firstString(candidate, ['username', 'user_name', 'userName', 'name', 'display_name', 'displayName']);
      const email = firstString(candidate, ['email']);
      const name = firstString(candidate, ['display_name', 'displayName', 'name']) || username;
      if (id || username || email) {
        return { id, username, name, email, source: `localStorage:${key}` };
      }
    }
    return null;
  }

  /** 从 JWT payload 里找身份 */
  function identityFromJwt(token) {
    const payload = decodeJwtPayload(token);
    if (!payload) return null;
    const id = firstString(payload, ['sub', 'id', 'user_id', 'userId']);
    const username = firstString(payload, ['username', 'preferred_username', 'name']);
    const email = firstString(payload, ['email']);
    const name = firstString(payload, ['name', 'display_name', 'displayName']) || username;
    if (!id && !username && !email) return null;
    return { id, username, name, email, source: 'jwt' };
  }

  /** 从 refresh 返回的 user 对象取身份 */
  function identityFromUserObject(user) {
    if (!user || typeof user !== 'object') return null;
    const id = firstString(user, ['id', 'user_id', 'userId', 'uid']);
    const username = firstString(user, ['username', 'user_name', 'userName', 'name', 'display_name', 'displayName']);
    const email = firstString(user, ['email']);
    const name = firstString(user, ['display_name', 'displayName', 'name']) || username;
    if (!id && !username && !email) return null;
    return { id, username, name, email, source: 'refresh:user' };
  }

  /**
   * NewAPI 前端登录态刷新：POST /api/user/auth/refresh，body {}。
   * 成功返回 { token, user, session, expires_at }；失败返回 reason，不抛错、不打印凭据。
   */
  async function refreshNewApiSession() {
    try {
      const response = await fetch('/api/user/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response) return { session: null, reason: 'no_response' };
      const json = await safeJson(response);
      if (!response.ok) return { session: null, reason: `http_${response.status}` };
      if (!json || typeof json !== 'object') return { session: null, reason: 'bad_json' };

      const payload = json.data && typeof json.data === 'object' ? json.data : json;
      const token = firstString(payload, ['access_token', 'accessToken'])
        || firstString(json, ['access_token', 'accessToken']);
      if (!token) return { session: null, reason: 'missing_access_token' };

      const user = payload.user && typeof payload.user === 'object'
        ? payload.user
        : (json.user && typeof json.user === 'object' ? json.user : null);
      const rawSession = payload.session ?? json.session ?? null;
      const sessionId = typeof rawSession === 'string'
        ? rawSession
        : (rawSession && typeof rawSession === 'object'
          ? firstString(rawSession, ['id', 'session_id', 'sessionId'])
          : null);
      const expiresRaw = payload.access_expires_at ?? json.access_expires_at ?? null;

      return {
        session: {
          token,
          user,
          session: sessionId,
          expires_at: toAbsoluteMs(expiresRaw) ?? jwtExpiryMs(token),
        },
        reason: null,
      };
    } catch (err) {
      return { session: null, reason: (err && err.name) || 'network' };
    }
  }

  /**
   * NewAPI 账号身份：self → refresh → Bearer 重试 → refresh.user → 全 Cookie
   * → localStorage → JWT → 站点兜底。任何一步失败都不弹窗。
   */
  async function readNewApiIdentity(site) {
    const direct = await readNewApiSelf();
    if (direct) return { account: direct, loggedIn: true, source: 'api', session: null };

    const refreshed = await refreshNewApiSession();
    const session = refreshed.session;
    const refreshReason = refreshed.reason;

    if (session) {
      const viaToken = await readNewApiSelf({ token: session.token, sessionId: session.session });
      if (viaToken) {
        const fromUser = identityFromUserObject(session.user);
        const merged = fromUser
          ? {
              ...viaToken,
              id: viaToken.id ?? fromUser.id,
              username: viaToken.username ?? fromUser.username,
              name: viaToken.name ?? fromUser.name,
              email: viaToken.email ?? fromUser.email,
            }
          : viaToken;
        return { account: merged, loggedIn: true, source: 'refresh', session };
      }
      const fromUser = identityFromUserObject(session.user);
      if (fromUser) return { account: fromUser, loggedIn: true, source: 'refresh:user', session };
    } else if (refreshReason) {
      // 只记原因，不含任何凭据
      console.warn(`[relay-ledger-capture] NewAPI refresh 未成功：${refreshReason}`);
    }

    // 有些 NewAPI 前端只把 access token 存在 localStorage（没有 refresh 会话），
    // 先验证再用，避免把无效 token 写进采集结果。
    const storedToken = findAccessToken();
    if (storedToken) {
      const viaStored = await readNewApiSelf({ token: storedToken });
      if (viaStored) {
        return {
          account: viaStored,
          loggedIn: true,
          source: 'storage-token',
          session: null,
          storedToken,
        };
      }
    }

    let cookie = null;
    try {
      cookie = await sessionCookieHeader();
    } catch {
      cookie = null;
    }

    if (cookie) {
      const viaCookie = await readNewApiSelf({ cookie });
      if (viaCookie) return { account: viaCookie, loggedIn: true, source: 'api+cookie', session };
    }

    const stored = readIdentityFromStorage();
    if (stored) return { account: stored, loggedIn: true, source: stored.source, session };

    const jwt = identityFromJwt(findAccessToken());
    if (jwt) return { account: jwt, loggedIn: true, source: 'jwt', session };

    return {
      account: siteFallbackIdentity(site),
      loggedIn: Boolean(cookie),
      source: 'site_fallback',
      session,
    };
  }

  // ----------------------------------------------------------------- token

  function findStorageValue(keys) {
    for (const key of keys) {
      const value = storageGet(key);
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  function findJsonStorageValue(fields) {
    for (const key of AUTH_JSON_KEYS) {
      const raw = storageGet(key);
      if (!raw) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      for (const field of fields) {
        const value = obj[field];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return null;
  }

  function findAccessToken() {
    return findStorageValue(ACCESS_TOKEN_KEYS) || findJsonStorageValue(['accessToken', 'access_token', 'token']);
  }

  function findRefreshToken() {
    return findStorageValue(REFRESH_TOKEN_KEYS) || findJsonStorageValue(['refreshToken', 'refresh_token']);
  }

  function findExpiresAt() {
    const raw = findStorageValue(EXPIRES_KEYS);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  async function fetchNewApiToken({ sessionId = null } = {}) {
    try {
      const headers = { Accept: 'application/json' };
      if (sessionId) headers['X-Auth-Session'] = sessionId;
      const response = await fetch('/api/user/token', {
        credentials: 'include',
        headers,
      });
      if (!response || !response.ok) return null;
      const data = unwrap(await safeJson(response));
      if (typeof data === 'string' && data.trim()) return data.trim();
      if (data && typeof data === 'object') {
        const token = data.token ?? data.access_token ?? data.key;
        if (typeof token === 'string' && token.trim()) return token.trim();
      }
    } catch {
      return null;
    }
    return null;
  }

  function gmCookieAvailable() {
    return typeof GM_cookie !== 'undefined' && GM_cookie !== null && typeof GM_cookie.list === 'function';
  }

  function gmCookieList(details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(value);
        else reject(value);
      };
      try {
        const maybe = GM_cookie.list(details, (cookies, error) => {
          if (error) finish(false, error);
          else finish(true, cookies || []);
        });
        if (maybe && typeof maybe.then === 'function') {
          maybe.then((value) => finish(true, value || []), (err) => finish(false, err));
        }
      } catch (err) {
        finish(false, err);
      }
    });
  }

  /** 读取 document.cookie（非 HttpOnly 部分） */
  function documentCookies() {
    const out = new Map();
    try {
      const raw = document.cookie || '';
      for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (name && value) out.set(name, value);
      }
    } catch {
      // 某些沙箱下不可读，忽略
    }
    return out;
  }

  /**
   * 读取完整 Cookie 头：GM_cookie 的全部非空 Cookie + document.cookie（同名以 GM 为准）。
   * 不按名字过滤：New API 各 fork 的会话 Cookie 名不固定。
   * 返回 { cookie, warnings }；cookie 为空串表示没读到，warnings 只放原因码，不含 Cookie 内容。
   */
  async function collectCookieHeader() {
    const merged = new Map();
    const warnings = [];
    for (const [name, value] of documentCookies()) merged.set(name, value);

    if (gmCookieAvailable()) {
      try {
        const cookies = await gmCookieList({ url: location.origin });
        if (Array.isArray(cookies)) {
          for (const cookie of cookies) {
            if (!cookie || typeof cookie.name !== 'string' || !cookie.name) continue;
            const value = typeof cookie.value === 'string' ? cookie.value : '';
            if (!value) continue;
            merged.set(cookie.name, value);
          }
        }
      } catch {
        // 权限被拒或接口异常：继续用 document.cookie，但要明确告诉用户不全
        warnings.push('cookie_read_failed');
      }
    } else {
      warnings.push('gm_cookie_unavailable');
    }

    if (merged.size === 0) {
      warnings.push('cookie_empty');
      return { cookie: '', warnings };
    }
    return {
      cookie: [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      warnings,
    };
  }

  /** 只要 Cookie 头（读不到返回 null）；warning 由 collectCookieHeader 决定 */
  async function sessionCookieHeader() {
    try {
      const { cookie } = await collectCookieHeader();
      return cookie || null;
    } catch {
      return null;
    }
  }

  function numericAccountId(account) {
    const rawId = account?.id;
    return rawId !== null && rawId !== undefined && /^\d+$/.test(String(rawId)) ? Number(rawId) : null;
  }

  function bearerAuth(token, refreshToken, expiresAt, userId, cookie = '') {
    return {
      mode: 'bearer',
      token: token || '',
      // bearer 模式也保存完整 Cookie：服务端靠它在 access token 过期后重新登录续期
      cookie: cookie || '',
      refresh_token: refreshToken || '',
      expires_at: expiresAt || null,
      user_id: userId === null || userId === undefined || userId === '' ? null : userId,
    };
  }

  function cookieAuth(cookie, userId) {
    return {
      mode: 'cookie',
      token: '',
      cookie,
      refresh_token: '',
      expires_at: null,
      user_id: userId === null || userId === undefined || userId === '' ? null : userId,
    };
  }

  /**
   * 返回 { auth, warnings }。NewAPI 的 access token 通常只有 15 分钟，
   * 所以无论走哪条 token 路径都同时保存完整 Cookie；Cookie 读不到只记 warning，不弹窗。
   */
  async function buildNewApiAuth(account, { loggedIn = false, session = null, storedToken = null } = {}) {
    const numericId = numericAccountId(account);
    const { cookie, warnings } = await collectCookieHeader();

    // 优先使用 refresh 拿到的 access token（内存 token 也适用）
    if (session && session.token) {
      return {
        auth: bearerAuth(
          session.token,
          null,
          session.expires_at ?? jwtExpiryMs(session.token),
          numericId,
          cookie,
        ),
        warnings,
      };
    }

    // localStorage 里的 access token（已由 readNewApiIdentity 验证可用）
    if (storedToken) {
      return { auth: bearerAuth(storedToken, null, jwtExpiryMs(storedToken), numericId, cookie), warnings };
    }

    const token = await fetchNewApiToken({ sessionId: session?.session ?? null });
    if (token) {
      return { auth: bearerAuth(token, null, jwtExpiryMs(token), numericId, cookie), warnings };
    }

    // /api/user/token 不可用：直接用全量 Cookie 走 cookie 模式，不弹手动 token
    if (cookie) {
      // user_id 只从已读到的身份里取；取不到就留空，不再弹窗阻塞采集
      return { auth: cookieAuth(cookie, numericId), warnings };
    }

    if (loggedIn) {
      throw new CaptureError(
        'cookie_permission_denied',
        '已登录但 Tampermonkey 未授权读取 Cookie；请在 Tampermonkey 设置中允许 Cookie 访问后重试',
      );
    }
    throw new CaptureError(
      'cookie_unavailable',
      '未能获取 New API 凭据：没有可用的 Cookie。请确认已登录，并允许 Tampermonkey 读取 Cookie 后重试',
    );
  }

  async function buildSub2ApiAuth(account, { storage = null, session = null } = {}) {
    const accessToken = (session && session.token) || (storage && storage.accessToken) || findAccessToken();
    const refreshToken = (session && session.refreshToken) || (storage && storage.refreshToken) || findRefreshToken();
    const expiresAt = (session && session.expiresAt)
      ?? (storage && storage.expiresAt)
      ?? findExpiresAt()
      ?? jwtExpiryMs(accessToken);
    if (!accessToken) {
      throw new CaptureError('token_not_found', '没有可用的 sub2api access token；请重新登录后重试。');
    }
    // Sub2API 有 refresh_token 就能续期；顺手把 Cookie 也带上（有就带，没有只记 warning）
    const { cookie, warnings } = await collectCookieHeader();
    return {
      auth: bearerAuth(accessToken, refreshToken, expiresAt, numericAccountId(account), cookie),
      warnings,
    };
  }

  // -------------------------------------------------------------- 合并与写入

  /** 凭据指纹（token 或 cookie 的 SHA-256 前 12 位十六进制），仅用于无身份时的去重辅助 */
  async function authFingerprint(auth) {
    const source = auth && (auth.mode === 'cookie' ? auth.cookie : auth.token);
    if (typeof source !== 'string' || !source) return null;
    try {
      const cryptoObj = page.crypto || (typeof crypto !== 'undefined' ? crypto : null);
      if (!cryptoObj || !cryptoObj.subtle || typeof TextEncoder !== 'function') return null;
      const digest = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return Array.from(new Uint8Array(digest).slice(0, 6))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return null;
    }
  }

  function accountKey(account) {
    const raw = account?.id || account?.name || account?.email || '';
    return String(raw).trim().toLowerCase();
  }

  function buildEntry({ siteType, systemName, account, auth, capturedAt, identitySource = null, warnings = null, fingerprint = null }) {
    const entry = {
      site_name: systemName || location.hostname,
      site_url: location.origin,
      site_type: siteType,
      account: {
        id: account.id ?? null,
        name: account.name || account.username || account.id || account.email || 'account',
        email: account.email ?? null,
      },
      auth,
      captured_at: capturedAt,
    };
    if (identitySource) entry.identity_source = identitySource;
    if (Array.isArray(warnings) && warnings.length) entry.warnings = warnings;
    if (fingerprint) entry.auth_fingerprint = fingerprint;
    return entry;
  }

  function mergeKey(entry) {
    if (entry.identity_source === 'site_fallback') {
      // 无法确认账号身份时，同一站点的兜底条目按站点合并；重复采集只更新凭据。
      return `${entry.site_url}|site_fallback|${accountKey(entry.account) || entry.auth_fingerprint || 'no-fingerprint'}`;
    }
    return `${entry.site_url}|account|${accountKey(entry.account)}`;
  }

  function mergeEntry(json, entry) {
    const key = mergeKey(entry);
    const index = json.accounts.findIndex((item) => item && mergeKey(item) === key);
    if (index === -1) {
      json.accounts.push(entry);
      return { created: true, entry };
    }
    const existing = json.accounts[index];
    const existingAt = Number(existing && existing.captured_at) || 0;
    const incomingAt = Number(entry && entry.captured_at) || 0;
    if (existingAt > incomingAt) {
      // 目录文件 / 跨站累积里已有更新的同账号条目，不用旧数据覆盖
      return { created: false, entry: existing };
    }
    // 同一站点同一账号以较新的采集为准；不混入任何 v2 配置字段
    json.accounts[index] = entry;
    return { created: false, entry };
  }

  function emptyCapture() {
    return { schema_version: SCHEMA_VERSION, captured_at: 0, accounts: [] };
  }

  function normalizeCapture(raw) {
    if (!raw) return emptyCapture();
    let value = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return emptyCapture();
      }
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.accounts)) {
      return emptyCapture();
    }
    return {
      schema_version: SCHEMA_VERSION,
      captured_at: Number(value.captured_at) || 0,
      accounts: value.accounts.filter((item) => item && typeof item === 'object'),
    };
  }

  /** Tampermonkey 存储跨站点共享；用它保存累积采集结果，下载模式不会每次只剩当前站点。 */
  function readSharedCapture() {
    try {
      if (typeof GM_getValue === 'function') return normalizeCapture(GM_getValue(SHARED_KEY, null));
    } catch {
      // 存储不可用时退化为单次采集，不阻塞下载
    }
    return emptyCapture();
  }

  function writeSharedCapture(json) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(SHARED_KEY, JSON.stringify(json));
    } catch {
      // 存储失败不影响本次文件写出
    }
  }

  function mergeCaptureJson(target, source) {
    const src = normalizeCapture(source);
    for (const item of src.accounts) mergeEntry(target, item);
    return target;
  }

  // ------------------------------------------------------------------ 主流程

  /** 采集当前站点的身份与凭据（目录/下载两种模式共用） */
  async function collectCapture() {
    setPanelStatus('正在判断站点类型…');
    const site = await detectSiteType();

    setPanelStatus('正在读取账号信息…');
    let account;
    let loggedIn = false;
    let identitySource = null;
    let warnings = null;
    let session = null;
    let storedToken = null;
    let storageAuth = null;
    if (site.type === 'newapi') {
      const identity = await readNewApiIdentity(site);
      account = identity.account;
      loggedIn = identity.loggedIn;
      session = identity.session || null;
      storedToken = identity.storedToken || null;
    } else {
      const identity = await readSub2ApiIdentity(site);
      account = identity.account;
      storageAuth = identity.storage;
      session = identity.session;
    }
    identitySource = account.identity_source || null;
    warnings = Array.isArray(account.warnings) ? account.warnings : null;

    setPanelStatus('正在读取凭据…');
    const built = site.type === 'newapi'
      ? await buildNewApiAuth(account, { loggedIn, session, storedToken })
      : await buildSub2ApiAuth(account, { storage: storageAuth, session });
    const auth = built.auth;
    const allWarnings = [...(warnings || []), ...(built.warnings || [])];

    const capturedAt = Date.now();
    const fingerprint = identitySource === 'site_fallback' ? await authFingerprint(auth) : null;
    const entry = buildEntry({
      siteType: site.type,
      systemName: site.systemName,
      account,
      auth,
      capturedAt,
      identitySource,
      warnings: allWarnings.length ? allWarnings : null,
      fingerprint,
    });
    return { site, entry };
  }

  /** 写目录模式：合并进 v2/secrets/accounts.capture.json */
  async function runDirectoryCapture(directory) {
    if (panelState.busy) return;
    panelState.busy = true;
    clearHideTimer();
    hidePanelAction();
    const host = location.hostname;

    try {
      setPanelStatus('正在读取 accounts.capture.json…');
      let fileHandle;
      try {
        fileHandle = await directory.getFileHandle(FILE_NAME, { create: true });
      } catch (err) {
        if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
          await idbDelete(HANDLE_KEY).catch(() => {});
          setPanelStatus('目录句柄不可用（被移动/删除或权限被收回）。可改用暂存模式。', 'error');
          setPanelAction('改用暂存模式', () => {
            void runStageCapture();
          });
          return;
        }
        throw err;
      }

      const json = await readCaptureJson(fileHandle);
      const { site, entry } = await collectCapture();

      // 目录文件 + Tampermonkey 跨站累积合并；同一站点同一账号由 mergeEntry 覆盖更新
      mergeCaptureJson(json, readSharedCapture());
      const { created } = mergeEntry(json, entry);
      json.schema_version = SCHEMA_VERSION;
      json.captured_at = entry.captured_at;

      setPanelStatus('正在写入 accounts.capture.json…');
      await writeCaptureJson(fileHandle, json);
      writeSharedCapture(json);

      console.info(`[relay-ledger-capture] ${created ? '新增' : '更新'} ${entry.site_url} (${site.type})`);
      setPanelStatus(
        `已${created ? '新增' : '更新'}到目录文件（写目录模式）：\n${entry.site_url}\n` +
          `账号：${entry.account.id || entry.account.name}\n站点类型：${site.type}\n` +
          `${credentialStatus(entry)}\n` +
          `文件：v2/secrets/${FILE_NAME}`,
        'success',
      );
      scheduleClose(5000);
    } catch (err) {
      if (err && err.name === 'CaptureError' && err.code === 'cancelled') {
        setPanelStatus('已取消。', 'warn');
        scheduleClose(3000);
        return;
      }
      const message = err && err.name === 'CaptureError' ? err.message : `未知错误（${(err && err.name) || 'Error'}）`;
      setPanelStatus(`捕获失败（${host}，写目录模式）：\n${message}`, 'error');
      setPanelAction('改用暂存模式', () => {
        void runStageCapture();
      });
    } finally {
      panelState.busy = false;
    }
  }

  /** 暂存模式：只合并进 Tampermonkey 跨站存储，不下载文件 */
  async function runStageCapture() {
    if (panelState.busy) return;
    panelState.busy = true;
    clearHideTimer();
    hidePanelAction();
    const host = location.hostname;

    try {
      const { site, entry } = await collectCapture();
      const json = readSharedCapture();
      const { created } = mergeEntry(json, entry);
      json.schema_version = SCHEMA_VERSION;
      json.captured_at = entry.captured_at;
      writeSharedCapture(json);

      console.info(`[relay-ledger-capture] ${created ? '新增' : '更新'}暂存 ${entry.site_url} (${site.type})`);
      setPanelStatus(
        `已${created ? '新增' : '更新'}暂存：\n${entry.site_url}\n` +
          `账号：${entry.account.id || entry.account.name || '未知'}\n` +
          `${credentialStatus(entry)}\n` +
          `当前共 ${json.accounts.length} 个账号。\n` +
          `继续采集其他站点；全部完成后点「导出全部暂存」。`,
        'success',
      );
      setPanelAction('导出全部暂存', () => {
        void runExportAll();
      });
    } catch (err) {
      if (err && err.name === 'CaptureError' && err.code === 'cancelled') {
        setPanelStatus('已取消。', 'warn');
        scheduleClose(3000);
        return;
      }
      const message = err && err.name === 'CaptureError' ? err.message : `未知错误（${(err && err.name) || 'Error'}）`;
      setPanelStatus(`暂存失败（${host}）：\n${message}`, 'error');
      setPanelAction('重试暂存', () => {
        void runStageCapture();
      });
    } finally {
      panelState.busy = false;
    }
  }

  /** 一次性导出全部暂存账号为一个 accounts.capture.json */
  async function runExportAll() {
    if (panelState.busy) return;
    panelState.busy = true;
    clearHideTimer();
    hidePanelAction();

    try {
      const json = readSharedCapture();
      if (!json.accounts.length) {
        setPanelStatus('暂存为空，没有可导出的账号。', 'warn');
        setPanelAction('捕获当前站点（暂存）', () => {
          void openCapturePanel({ mode: 'stage' });
        });
        return;
      }

      setPanelStatus(`正在导出 ${FILE_NAME}（${json.accounts.length} 个账号）…`);
      const result = await triggerDownload(FILE_NAME, json);
      if (!result.ok) {
        throw new CaptureError('download_failed', `下载失败（${result.reason}）。`);
      }
      setPanelStatus(
        `已导出 ${FILE_NAME}，共 ${json.accounts.length} 个账号。\n` +
          `请把文件放到 v2/secrets/ 后运行导入器。\n` +
          `浏览器若已存在同名文件，可能自动加 (1)，导入最新文件即可。`,
        'success',
      );
      scheduleClose(10000);
    } catch (err) {
      const message = err && err.name === 'CaptureError' ? err.message : `未知错误（${(err && err.name) || 'Error'}）`;
      setPanelStatus(`导出失败：\n${message}`, 'error');
      setPanelAction('重试导出', () => {
        void runExportAll();
      });
    } finally {
      panelState.busy = false;
    }
  }

  /** 优先用页面 <a download> 触发下载；GM_download 仅作兜底。
   *  Tampermonkey 的 GM_download 对 blob/data URL 常无回调，不能把“无回调”当成成功。 */
  function triggerDownload(fileName, json) {
    return new Promise((resolve) => {
      const text = `${JSON.stringify(json, null, 2)}\n`;
      const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
      let blobUrl = '';
      try {
        blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      } catch {
        blobUrl = '';
      }

      const anchorDownload = (href) => {
        try {
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.download = fileName;
          anchor.rel = 'noopener';
          anchor.style.display = 'none';
          (document.body || document.documentElement).appendChild(anchor);
          anchor.click();
          anchor.remove();
          return true;
        } catch {
          return false;
        }
      };

      if (blobUrl && anchorDownload(blobUrl)) {
        setTimeout(() => {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            // 忽略
          }
        }, 30000);
        resolve({ ok: true, method: 'anchor' });
        return;
      }

      if (anchorDownload(dataUrl)) {
        resolve({ ok: true, method: 'anchor_data' });
        return;
      }

      if (typeof GM_download === 'function') {
        try {
          GM_download({
            url: dataUrl,
            name: fileName,
            saveAs: false,
            onload: () => resolve({ ok: true, method: 'gm_download' }),
            onerror: () => resolve({ ok: false, reason: 'gm_download_failed' }),
            ontimeout: () => resolve({ ok: false, reason: 'gm_download_timeout' }),
          });
          return;
        } catch {
          // 继续走失败分支
        }
      }

      resolve({ ok: false, reason: 'download_unsupported' });
    });
  }

  function runClearStaged() {
    const json = readSharedCapture();
    if (!json.accounts.length) {
      alertUser('暂存为空，没有可清空的账号。');
      return;
    }
    if (!window.confirm(`清空 ${json.accounts.length} 个暂存账号？该操作不可撤销。`)) return;
    writeSharedCapture(emptyCapture());
    closePanel();
    alertUser(`已清空 ${json.accounts.length} 个暂存账号。`);
  }

  function register() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('捕获当前站点（暂存）', () => {
      void openCapturePanel({ mode: 'stage' });
    });
    GM_registerMenuCommand('导出全部暂存账户', () => {
      void runExportAll();
    });
    GM_registerMenuCommand('查看暂存账户', () => {
      void openCapturePanel({ mode: 'view' });
    });
    GM_registerMenuCommand('清空暂存（需确认）', () => {
      runClearStaged();
    });
  }

  register();
})();
