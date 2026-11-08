/**
 * 上游适配器共用的结果规整与错误映射。
 *
 * 统一结果形状：{ value, unit, status, reason, raw, events, complete }
 * - status: ok | partial | unavailable | unsupported
 * - value 只在 ok/partial 且拿到数值时给，缺失时一律 null（不写 0）
 * - raw 保留上游原始值与原始单位，读取/接口层不做二次换算
 */

export function toNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 兼容 {success, data} 与直接返回 data 两种上游响应 */
export function unwrap(json) {
  if (json && typeof json === 'object' && !Array.isArray(json) && 'data' in json) return json.data;
  return json;
}

/**
 * 构造鉴权头；只把凭据放进请求头，绝不进结果、错误或日志。
 * - bearer：`<header>: <scheme> <token>`（header 默认 Authorization，scheme 默认 Bearer）
 * - cookie：`Cookie: <cookie>`，有 user_id 时再加 `New-Api-User`
 * - 两种模式都带 `X-Auth-Session`（NewAPI 换签返回的会话标识，服务端没有该头时忽略）
 */
export function authHeaders(account, token) {
  const auth = account?.auth ?? {};
  const headers = { Accept: 'application/json', ...(auth.headers ?? {}) };

  if (auth.mode === 'cookie') {
    const cookie = auth.cookie || token || auth.token;
    if (cookie) headers.Cookie = cookie;
    if (auth.user_id !== null && auth.user_id !== undefined && auth.user_id !== '') {
      headers['New-Api-User'] = String(auth.user_id);
    }
  } else {
    const header = typeof auth.header === 'string' && auth.header ? auth.header : 'Authorization';
    const scheme = auth.scheme === undefined ? 'Bearer' : auth.scheme;
    if (token) headers[header] = scheme ? `${scheme} ${token}` : token;
  }

  const session = auth.session || auth.session_id;
  if (typeof session === 'string' && session) headers['X-Auth-Session'] = session;

  return headers;
}

const AUTH_REJECTION = /(无效的令牌|令牌无效|令牌已过期|请先登录|未登录|无权|权限不足|invalid\s*token|token\s*(is\s*)?(invalid|expired)|unauthorized)/i;

/**
 * NewAPI 鉴权失败有时是 200 + `{success:false, message:"无效的令牌"}`。
 * 只认带鉴权含义的 message，其他 success:false 仍交给字段校验，避免误判。
 */
export function isAuthRejection(json) {
  if (!json || typeof json !== 'object' || json.success !== false) return false;
  const message = [json.message, json.msg, json.error?.message, json.error]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return message ? AUTH_REJECTION.test(message) : false;
}

export function result({
  value = null,
  unit = 'USD',
  status = 'ok',
  reason = null,
  raw = null,
  events = null,
  complete = null,
  recharged = null,
} = {}) {
  const valid = status === 'ok' || status === 'partial';
  return {
    value: valid ? value : null,
    unit,
    status,
    reason,
    raw: valid ? raw : null,
    events: valid ? events : null,
    complete: valid ? complete : null,
    // 累计充值总额（sub2api 的 total_recharged）；不支持的上游为 null
    recharged: valid ? recharged : null,
  };
}

export function failed(reason, { unit = 'USD' } = {}) {
  return result({ status: 'unavailable', reason, unit });
}

const REASON_BY_KIND = {
  auth: 'auth_failed',
  timeout: 'timeout',
  network: 'network_error',
  server: 'upstream_error',
  client: 'upstream_rejected',
  bad_json: 'bad_json',
};

/**
 * 把 HTTP 错误映射成 unavailable 结果；429 属于「停止整轮」，向上抛出由 job 处理。
 * 错误信息里只有方法、状态码和 path，不含 Authorization。
 */
export function errorResult(err, { unit = 'USD' } = {}) {
  if (err?.kind === 'rate_limited') throw err;
  return failed(REASON_BY_KIND[err?.kind] ?? 'upstream_error', { unit });
}

/** 兼容 newapi 的 data / data.items / data.data 分页形状 */
export function extractLogItems(json) {
  const data = unwrap(json);
  let items = [];
  let total = null;
  if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data?.items)) {
    items = data.items;
  } else if (Array.isArray(data?.data)) {
    items = data.data;
  } else if (Array.isArray(data?.logs)) {
    items = data.logs;
  }
  total = toNum(data?.total) ?? toNum(json?.total);
  return { items, total };
}

/** 日志时间可能是秒或毫秒；无法识别返回 null */
export function eventTimeMs(item) {
  const raw = item?.created_at ?? item?.createdAt ?? item?.timestamp ?? item?.time;
  const n = toNum(raw);
  if (n === null || n <= 0) return null;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}
