/**
 * 上游 HTTP 客户端（可注入 fetch）。
 *
 * - 单站串行 + 最小请求间隔（按 origin 排队，避免同站并发）
 * - 超时、401/403 认证失败、429 限流不再重试；5xx 与网络错误重试一次
 * - 错误对象只带方法、状态码与 path，绝不包含请求头或 token
 * - 不读写全局 env、不写全局配置
 */

export class UpstreamHttpError extends Error {
  constructor(kind, { status = null, url = '', method = 'GET' } = {}) {
    super(`upstream ${kind}${status ? ` ${status}` : ''} ${method} ${url}`);
    this.name = 'UpstreamHttpError';
    this.kind = kind;
    this.status = status;
    this.url = url;
    this.method = method;
  }
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

const RETRYABLE = new Set(['server', 'network']);

export function createUpstreamClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  minIntervalMs = 1000,
  retryDelayMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl 必须是函数');

  // origin -> 上一个请求的收尾 promise，保证同站串行
  const chains = new Map();
  const lastAt = new Map();

  async function schedule(origin, fn) {
    const previous = chains.get(origin) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    chains.set(origin, previous.then(() => gate));
    await previous;
    try {
      const last = lastAt.get(origin);
      if (last !== undefined) {
        const wait = minIntervalMs - (now() - last);
        if (wait > 0) await sleep(wait);
      }
      return await fn();
    } finally {
      lastAt.set(origin, now());
      release();
    }
  }

  async function attempt(url, { method = 'GET', headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { method, headers, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        throw new UpstreamHttpError('timeout', { url: safeUrl(url), method });
      }
      throw new UpstreamHttpError('network', { url: safeUrl(url), method });
    } finally {
      clearTimeout(timer);
    }

    const status = response?.status ?? 0;
    if (status === 401 || status === 403) {
      throw new UpstreamHttpError('auth', { status, url: safeUrl(url), method });
    }
    if (status === 429) {
      throw new UpstreamHttpError('rate_limited', { status, url: safeUrl(url), method });
    }
    if (status >= 500) {
      throw new UpstreamHttpError('server', { status, url: safeUrl(url), method });
    }
    if (status < 200 || status >= 300) {
      throw new UpstreamHttpError('client', { status, url: safeUrl(url), method });
    }
    return response;
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch {
      return 'invalid-origin';
    }
  }

  async function request(url, options = {}) {
    const origin = originOf(url);
    let lastError;
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      try {
        return await schedule(origin, () => attempt(url, options));
      } catch (err) {
        lastError = err;
        if (!(err instanceof UpstreamHttpError) || !RETRYABLE.has(err.kind) || attemptIndex === 1) {
          throw err;
        }
        if (retryDelayMs > 0) await sleep(retryDelayMs);
      }
    }
    throw lastError;
  }

  async function getJson(url, options = {}) {
    const response = await request(url, options);
    try {
      return await response.json();
    } catch {
      throw new UpstreamHttpError('bad_json', { status: response?.status ?? 0, url: safeUrl(url), method: options.method ?? 'GET' });
    }
  }

  return { getJson, request };
}
