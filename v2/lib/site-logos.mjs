import { createHash, randomUUID } from 'node:crypto';
import { lookup as defaultLookup } from 'node:dns';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 6 * 60 * 60 * 1000;
const DISCOVERY_VERSION = 2;
const HTML_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 1024 * 1024;
const MIME_TYPES = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['image/x-icon', 'image/x-icon'],
  ['image/vnd.microsoft.icon', 'image/x-icon'],
  ['image/ico', 'image/x-icon'],
  ['image/svg+xml', 'image/svg+xml'],
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class UnsafeSourceError extends Error {}

function httpUrl(value, base) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!url.href.startsWith(`${url.origin}/`)) return null;
    if (url.port && !['80', '443', '9443'].includes(url.port)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!isIP(host)) {
      const labels = host.replace(/\.$/, '').split('.');
      if (host.length > 253 || labels.length < 2 || labels.some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
    }
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function sourceUrl(value) {
  const url = httpUrl(value);
  // 来源仅由可信 resolver 决定，用户请求不能传入 URL。
  return url ? new URL(url.origin) : null;
}

function publicAddress(address) {
  if (typeof address !== 'string') return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))
        || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      || address === '168.63.129.16');
  }
  if (family !== 6 || address.includes('%')) return false;
  // 只接受全球单播；同时排除映射地址、6to4、文档与特殊用途网段。
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  const [a, b] = words.map((part) => Number.parseInt(part, 16));
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
    && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8))
    && !(a === 0x3fff && b <= 0x0fff);
}

function addressesFor(hostname, lookup, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    const done = (error, records) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return;
      if (error) return reject(error);
      if (!Array.isArray(records) || records.length === 0 || records.some((record) =>
        !record || !publicAddress(record.address) || isIP(record.address) !== record.family)) {
        return reject(new UnsafeSourceError('网站 DNS 包含非公网地址'));
      }
      resolve(records);
    };
    try {
      lookup(hostname, { all: true, verbatim: true }, done);
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

function nativeRequest(options, callback) {
  return (options.protocol === 'https:' ? https : http).request(options, callback);
}

async function requestOnce(url, { lookup, request, signal, image, json = false }) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !publicAddress(hostname)) {
    throw new UnsafeSourceError('网站地址不是公网地址');
  }
  const records = await addressesFor(hostname, lookup, signal);
  const selected = records[0];
  if (signal.aborted) throw signal.reason;
  const limit = image ? IMAGE_LIMIT : HTML_LIMIT;
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let decoder;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      finish(signal.reason ?? new Error('网站图标请求超时'));
      response?.destroy();
      decoder?.destroy();
      req?.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      req = request({
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: {
          'User-Agent': 'RelayLedger-SiteLogo/1.0',
          Accept: image ? 'image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon,image/gif'
            : json ? 'application/json' : 'text/html',
        },
        agent: false,
        maxHeaderSize: 16 * 1024,
        family: selected.family,
        autoSelectFamily: false,
        ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
        // 连接阶段不再次使用系统 DNS，防止校验后发生 DNS rebinding。
        lookup: (_host, options, callback) => {
          if (typeof options === 'function') {
            callback = options;
            options = {};
          }
          if (options?.all) callback(null, [{ ...selected }]);
          else callback(null, selected.address, selected.family);
        },
      }, (incoming) => {
        response = incoming;
        incoming.on('error', (error) => {
          finish(error);
          decoder?.destroy();
          incoming.destroy();
        });
        if (settled || signal.aborted) {
          incoming.destroy();
          return;
        }
        const fail = () => {
          finish(new Error('网站响应无效'));
          incoming.destroy();
          decoder?.destroy();
        };
        const status = incoming.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          finish(null, { redirect: incoming.headers.location });
          incoming.destroy();
          return;
        }
        const contentType = String(incoming.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const length = incoming.headers['content-length'];
        const encoding = String(incoming.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (status !== 200 || (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limit))
          || !['identity', 'gzip', 'br', 'deflate'].includes(encoding)
          || (image ? !MIME_TYPES.has(contentType) : json ? !/^application\/(?:json|[\w.-]+\+json)$/.test(contentType)
            : !['text/html', 'application/xhtml+xml'].includes(contentType))) {
          fail();
          return;
        }
        const chunks = [];
        let size = 0;
        let wireSize = 0;
        incoming.on('data', (chunk) => {
          wireSize += chunk.length;
          if (wireSize > limit) fail();
        });
        decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress()
          : encoding === 'deflate' ? createInflate() : null;
        const decoded = decoder ?? incoming;
        if (decoder) decoder.on('error', fail);
        decoded.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > limit) fail();
          else chunks.push(buffer);
        });
        incoming.on('aborted', fail);
        decoded.on('end', () => {
          if (!settled) finish(null, { body: Buffer.concat(chunks, size), contentType, url });
        });
        incoming.on('close', () => {
          if (!incoming.complete && !settled) fail();
        });
        if (decoder) incoming.pipe(decoder);
      });
      req.on('error', (error) => finish(error));
      if (signal.aborted) abort();
      else req.end();
    } catch (error) {
      finish(error);
      response?.destroy();
      decoder?.destroy();
      req?.destroy();
    }
  });
}

async function fetchVerified(start, options) {
  let url = start;
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(url, options);
    if (!Object.hasOwn(response, 'redirect')) return response;
    if (redirects >= 3 || typeof response.redirect !== 'string') {
      throw new UnsafeSourceError('网站重定向无效');
    }
    try {
      url = httpUrl(response.redirect, url);
    } catch {
      throw new UnsafeSourceError('网站重定向地址无效');
    }
    if (!url || (!options.image && url.origin !== start.origin)) {
      throw new UnsafeSourceError('网站重定向地址不允许');
    }
  }
}

function withoutComments(text) {
  const parts = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('<!--', cursor);
    if (start === -1) return [...parts, text.slice(cursor)].join('');
    const end = text.indexOf('-->', start + 4);
    if (end === -1) return null;
    parts.push(text.slice(cursor, start));
    cursor = end + 3;
  }
}

const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'symbol', 'use',
  'title', 'desc', 'text', 'tspan']);
const SVG_ATTRIBUTES = new Set(('id class version viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points '
  + 'fill fill-opacity fill-rule clip-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin '
  + 'stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color transform preserveAspectRatio '
  + 'gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr '
  + 'clip-path clipPathUnits mask maskUnits maskContentUnits patternUnits patternContentUnits patternTransform '
  + 'href xlink:href xmlns xmlns:xlink xml:space style vector-effect text-anchor dominant-baseline '
  + 'font-family font-size font-weight letter-spacing dx dy role aria-hidden aria-label focusable').split(' '));
const SVG_STYLE = new Set(('fill fill-opacity fill-rule clip-rule stroke stroke-width stroke-opacity '
  + 'stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color '
  + 'stop-color stop-opacity display visibility').split(' '));

function xmlValue(value) {
  if (/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[\da-fA-F]+);)/.test(value)) return null;
  let invalid = false;
  const decoded = value.replace(/&#(x[\da-fA-F]+|\d+);/g, (_entity, code) => {
    const point = code.startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number(code);
    if (point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
      || (point < 32 && ![9, 10, 13].includes(point))) {
      invalid = true;
      return '';
    }
    return String.fromCodePoint(point);
  }).replace(/&(amp|quot|apos|lt|gt);/g, (entity) => decodeAttribute(entity));
  return invalid ? null : decoded;
}

function safeSvgValue(name, raw) {
  const value = xmlValue(raw);
  if (value === null || /[<>\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return false;
  if (name === 'xmlns') return value === 'http://www.w3.org/2000/svg';
  if (name === 'xmlns:xlink') return value === 'http://www.w3.org/1999/xlink';
  if (name === 'href' || name === 'xlink:href') return /^#[A-Za-z_][\w:.-]*$/.test(value);
  if (/@|\/\*|\/\/|(?:javascript|data|https?|file)\s*:|expression\s*\(/i.test(value)) return false;
  // 仅允许本文件内的渐变、裁剪与形状引用，禁止 CSS 转义和外部 URL。
  const local = value.replace(/url\(\s*(?:#[A-Za-z_][\w:.-]*|'#[A-Za-z_][\w:.-]*'|"#[A-Za-z_][\w:.-]*")\s*\)/g, '');
  if (/url\s*\(/i.test(local)) return false;
  if (name === 'style') {
    return value.split(';').every((rule) => {
      if (!rule.trim()) return true;
      const colon = rule.indexOf(':');
      return colon > 0 && SVG_STYLE.has(rule.slice(0, colon).trim().toLowerCase())
        && safeSvgValue('paint', rule.slice(colon + 1));
    });
  }
  return !/[{}]/.test(value);
}

function safeSvg(body) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return false; }
  text = text.trim().replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/i, '');
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(text)) return false;
  text = withoutComments(text);
  if (text === null || text.includes('<!')) return false;
  const stack = [];
  const tags = /<(?:(\/[A-Za-z][\w.-]*)\s*|([A-Za-z][\w.-]*)([^<>]*))>/gy;
  let cursor = 0;
  let nodes = 0;
  let root = false;
  let drawing = false;
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    const plain = text.slice(cursor, start === -1 ? text.length : start);
    if (xmlValue(plain) === null || (!stack.length && plain.trim())) return false;
    if (start === -1) break;
    tags.lastIndex = start;
    const token = tags.exec(text);
    if (!token || ++nodes > 4096) return false;
    cursor = tags.lastIndex;
    if (token[1]) {
      if (stack.pop() !== token[1].slice(1)) return false;
      continue;
    }
    const name = token[2];
    if (!SVG_TAGS.has(name) || stack.length >= 64 || (!stack.length && (root || name !== 'svg'))
      || (stack.length && name === 'svg')) return false;
    const attributes = token[3].replace(/\/\s*$/, '');
    const matcher = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy;
    const seen = new Set();
    let offset = 0;
    while (offset < attributes.length && attributes.slice(offset).trim()) {
      matcher.lastIndex = offset;
      const attr = matcher.exec(attributes);
      if (!attr || seen.has(attr[1]) || !SVG_ATTRIBUTES.has(attr[1])
        || !safeSvgValue(attr[1], attr[2] ?? attr[3])) return false;
      seen.add(attr[1]);
      offset = matcher.lastIndex;
    }
    if (!root && !seen.has('xmlns')) return false;
    root = true;
    if (['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use'].includes(name)) drawing = true;
    if (!/\/\s*$/.test(token[3])) stack.push(name);
  }
  return root && drawing && stack.length === 0;
}

function imageType(body) {
  if (body.length >= 45 && body.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let offset = 8;
    let hasData = false;
    while (offset + 12 <= body.length) {
      const size = body.readUInt32BE(offset);
      const tag = body.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + size > body.length) return null;
      if (offset === 8 && (tag !== 'IHDR' || size !== 13
        || body.readUInt32BE(16) === 0 || body.readUInt32BE(20) === 0)) return null;
      if (tag === 'IDAT') hasData = true;
      offset += size + 12;
      if (tag === 'IEND') return hasData && size === 0 && offset === body.length ? 'image/png' : null;
    }
    return null;
  }
  if (body.length >= 12 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
    && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9) return 'image/jpeg';
  if (body.length >= 14 && ['GIF87a', 'GIF89a'].includes(body.toString('ascii', 0, 6))
    && body.readUInt16LE(6) > 0 && body.readUInt16LE(8) > 0
    && body[body.length - 1] === 0x3b) return 'image/gif';
  if (body.length >= 21 && body.toString('ascii', 0, 4) === 'RIFF'
    && body.readUInt32LE(4) === body.length - 8 && body.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(body.toString('ascii', 12, 16))
    && body.readUInt32LE(16) > 0 && body.readUInt32LE(16) <= body.length - 20) return 'image/webp';
  if (body.length >= 22 && body.readUInt32LE(0) === 0x00010000) {
    const count = body.readUInt16LE(4);
    if (!count || count > 256 || 6 + count * 16 > body.length) return null;
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16;
      const size = body.readUInt32LE(entry + 8);
      const offset = body.readUInt32LE(entry + 12);
      if (size < 8 || offset < 6 + count * 16 || offset + size > body.length) return null;
      if (!body.subarray(offset, offset + 8).equals(PNG_SIGNATURE)
        && !(size >= 40 && [40, 108, 124].includes(body.readUInt32LE(offset)))) return null;
    }
    return 'image/x-icon';
  }
  return safeSvg(body) ? 'image/svg+xml' : null;
}

function decodeAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    const code = lower.startsWith('&#x') ? Number.parseInt(lower.slice(3), 16) : Number.parseInt(lower.slice(2), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function iconCandidate(value, base) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw.length <= IMAGE_LIMIT * 3 + 256 ? raw : null;
  return httpUrl(raw, base)?.href ?? null;
}

function dataLogo(uri) {
  const comma = uri.indexOf(',');
  if (comma === -1 || comma > 128) return null;
  const header = /^data:([^;,]+)(?:;charset=utf-8)?(;base64)?$/i.exec(uri.slice(0, comma));
  const type = MIME_TYPES.get(header?.[1].toLowerCase());
  if (!header || !type) return null;
  const payload = uri.slice(comma + 1);
  let body;
  if (header[2]) {
    let encoded;
    try { encoded = decodeURIComponent(payload); } catch { return null; }
    if (encoded.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || encoded.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
    body = Buffer.from(encoded, 'base64');
    if (body.toString('base64') !== encoded) return null;
  } else {
    body = Buffer.alloc(Math.min(payload.length * 3, IMAGE_LIMIT + 1));
    let size = 0;
    for (let index = 0; index < payload.length;) {
      let chunk;
      if (payload[index] === '%') {
        if (!/^[\da-f]{2}$/i.test(payload.slice(index + 1, index + 3))) return null;
        chunk = Buffer.from([Number.parseInt(payload.slice(index + 1, index + 3), 16)]);
        index += 3;
      } else {
        const character = String.fromCodePoint(payload.codePointAt(index));
        chunk = Buffer.from(character);
        index += character.length;
      }
      size += chunk.length;
      if (size > IMAGE_LIMIT) return null;
      chunk.copy(body, size - chunk.length);
    }
    body = body.subarray(0, size);
  }
  return body.length <= IMAGE_LIMIT && imageType(body) === type ? { body, contentType: type } : null;
}

function iconUrls(html, pageUrl) {
  const icons = [];
  const head = (withoutComments(html) ?? '').split(/<\/head\s*>|<body\b/i)[0];
  for (const match of head.matchAll(/<link\b[^<>]*>/gi)) {
    const attrs = {};
    for (const attr of match[0].matchAll(/([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const key = attr[1].toLowerCase();
      if (!Object.hasOwn(attrs, key)) attrs[key] = decodeAttribute(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.some((value) => ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'].includes(value)) || !attrs.href) continue;
    const candidate = iconCandidate(attrs.href, pageUrl);
    if (!candidate) continue;
    const svg = attrs.type?.toLowerCase() === 'image/svg+xml' || /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(candidate);
    const touch = rel.some((value) => value.startsWith('apple-touch-icon'));
    const size = Math.max(0, ...(attrs.sizes ?? '').split(/\s+/).slice(0, 16).map((value) => {
      const dimensions = /^(\d{1,5})x(\d{1,5})$/i.exec(value);
      return dimensions ? Math.min(Number(dimensions[1]), Number(dimensions[2])) : 0;
    }));
    icons.push({ candidate, priority: svg ? 0 : touch ? 1 : 2, size });
  }
  return [...new Set(icons.sort((a, b) => a.priority - b.priority || b.size - a.size)
    .map(({ candidate }) => candidate))].slice(0, 8);
}

async function statusLogo(source, options) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('网站状态探测超时')), 1200);
  try {
    const response = await fetchVerified(new URL('/api/status', source), {
      ...options, signal: controller.signal, json: true,
    });
    const status = JSON.parse(response.body.toString('utf8'));
    if (status?.success !== true || !status.data || typeof status.data.system_name !== 'string') return null;
    return { logo: iconCandidate(status.data.logo, source), name: status.data.system_name };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}

function defaultPanelIcon(candidate, source) {
  if (/^data:/i.test(candidate)) return false;
  const url = new URL(candidate);
  return url.origin === source.origin && /^\/(?:logo\.(?:png|svg)|favicon\.(?:ico|png|svg))$/i.test(url.pathname);
}

async function fetchLogo(candidate, options) {
  if (/^data:/i.test(candidate)) return dataLogo(candidate);
  const response = await fetchVerified(new URL(candidate), { ...options, image: true });
  const contentType = imageType(response.body);
  return contentType && MIME_TYPES.get(response.contentType) === contentType
    ? { body: response.body, contentType } : null;
}

function parentSite(source) {
  // 没有 PSL 依赖时宁可少回退：只去掉 api./www.，仅接受两段通用域名。
  // 不递归、不剥离其它子域，也不触及 co.uk 等国家域名或常见托管后缀。
  const match = /^(?:api|www)\.([a-z0-9-]+\.(?:com|net|org))$/i.exec(source.hostname);
  if (!match || new Set(['appspot.com', 'blogspot.com', 'herokuapp.com', 'azurewebsites.net',
    'cloudfront.net', 'duckdns.org', 'ddns.net']).has(match[1].toLowerCase())) return null;
  const parent = new URL(source);
  parent.hostname = match[1];
  return parent;
}

async function discoverAt(source, options) {
  let panel = null;
  try {
    panel = await statusLogo(source, options);
  } catch (error) {
    if (error instanceof UnsafeSourceError || options.signal.aborted) throw error;
  }
  if (panel?.logo && !defaultPanelIcon(panel.logo, source)) {
    try {
      const logo = await fetchLogo(panel.logo, options);
      if (logo) return { logo, parent: false };
    } catch (error) {
      if (options.signal.aborted) throw error;
    }
  }
  let candidates = [];
  let pageAvailable = false;
  try {
    const page = await fetchVerified(source, options);
    const text = page.body.toString('utf8');
    pageAvailable = Boolean(text.trim());
    candidates = iconUrls(text, page.url);
  } catch (error) {
    if (error instanceof UnsafeSourceError || options.signal.aborted) throw error;
  }
  if (panel) candidates = candidates.filter((candidate) => !defaultPanelIcon(candidate, source));
  else candidates.push(new URL('/favicon.ico', source).href);
  for (const candidate of new Set(candidates)) {
    try {
      const logo = await fetchLogo(candidate, options);
      if (logo) return { logo, parent: false };
    } catch (error) {
      if (options.signal.aborted) throw error;
    }
  }
  return { logo: null, parent: !panel && !pageAvailable };
}

async function discoverLogo(source, options) {
  const result = await discoverAt(source, options);
  if (result.logo || !result.parent) return result.logo;
  const parent = parentSite(source);
  return parent ? (await discoverAt(parent, options)).logo : null;
}

async function limitedFile(path, limit) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > limit) throw new Error('网站图标缓存过大');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('网站图标缓存过大');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function readCache(directory, key, source) {
  try {
    const metadata = JSON.parse((await limitedFile(join(directory, `${key}.json`), 4096)).toString('utf8'));
    if (metadata.version !== DISCOVERY_VERSION || metadata.source !== source
      || !Number.isFinite(metadata.expires) || metadata.expires < 0) return null;
    if (metadata.contentType === null && metadata.fileName === null) return { expires: metadata.expires, logo: null };
    if (metadata.fileName !== `${key}.image` || !MIME_TYPES.has(metadata.contentType)) return null;
    const body = await limitedFile(join(directory, `${key}.image`), IMAGE_LIMIT);
    if (imageType(body) !== metadata.contentType) return null;
    return { expires: metadata.expires, logo: { body, contentType: metadata.contentType } };
  } catch {
    return null;
  }
}

async function writeCache(directory, key, metadata, logo) {
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    if (logo) {
      await writeFile(temporary, logo.body);
      await rename(temporary, join(directory, `${key}.image`));
    }
    await writeFile(temporary, JSON.stringify(metadata));
    await rename(temporary, join(directory, `${key}.json`));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * resolveSource({ kind, id }) 为同步可信 resolver，仅返回 http(s) origin 或 null。
 * lookup / request 使用 Node 原生回调签名；timeoutMs 只可缩短默认的 8 秒预算。
 * drain() 等待已接收的加载、后台刷新和缓存写入结束，供生命周期清理使用。
 */
export function createSiteLogoService({
  dataDir,
  resolveSource,
  now = Date.now,
  lookup = defaultLookup,
  request = nativeRequest,
  timeoutMs = 8000,
}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof resolveSource !== 'function') {
    throw new TypeError('网站图标服务需要 dataDir 与 resolveSource');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 8000) {
    throw new RangeError('网站图标超时必须在 0 到 8000 毫秒之间');
  }
  const directory = join(dataDir, 'site-logos');
  const inflight = new Map();
  const pending = new Set();
  const queue = [];
  let active = 0;

  function releaseSlot() {
    active -= 1;
    while (active < 4 && queue.length) {
      const entry = queue.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted || performance.now() >= entry.deadline) {
        entry.resolve(null);
        continue;
      }
      active += 1;
      entry.resolve(releaseSlot);
    }
  }

  function acquireSlot(signal, deadline) {
    if (signal.aborted || performance.now() >= deadline) return Promise.resolve(null);
    if (active < 4) {
      active += 1;
      return Promise.resolve(releaseSlot);
    }
    // 最多容纳 64 个等待 origin；同源请求仍复用同一个任务。
    if (queue.length >= 64) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = { signal, deadline, resolve, abort: () => {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        resolve(null);
      } };
      queue.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
    });
  }

  function refresh(source, key, cached, deadline) {
    if (inflight.has(source.origin)) return inflight.get(source.origin);
    const job = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('网站图标请求超时')),
        Math.max(0, deadline - performance.now()));
      let release;
      try {
        release = await acquireSlot(controller.signal, deadline);
        // 排队超时或队列已满均未尝试上游，不得写入失败缓存。
        if (!release || controller.signal.aborted || performance.now() >= deadline) return cached?.logo ?? null;
        let logo = null;
        try {
          logo = await discoverLogo(source, { lookup, request, signal: controller.signal });
        } catch {
          // 图标为可选资源，所有网络或安全校验失败均交由 UI 使用首字母回退。
        }
        const result = logo ?? cached?.logo ?? null;
        const metadata = {
          version: DISCOVERY_VERSION,
          source: source.origin,
          expires: now() + (logo ? POSITIVE_TTL : NEGATIVE_TTL),
          contentType: result?.contentType ?? null,
          fileName: result ? `${key}.image` : null,
        };
        await writeCache(directory, key, metadata, result).catch(() => {});
        return result;
      } finally {
        clearTimeout(timer);
        inflight.delete(source.origin);
        release?.();
      }
    })();
    inflight.set(source.origin, job);
    return job;
  }

  async function load(input, deadline) {
    if (!input || !['channel', 'account', 'site'].includes(input.kind)
      || typeof input.id !== 'string' || !input.id || input.id.length > 512) return null;
    if (input.kind === 'site' && input.id !== 'current') return null;
    let source;
    try {
      source = sourceUrl(resolveSource({ kind: input.kind, id: input.id }));
    } catch {
      return null;
    }
    if (!source) return null;
    const key = createHash('sha256').update(source.origin).digest('hex');
    const cached = await readCache(directory, key, source.origin);
    if (cached && cached.expires > now()) return cached.logo;
    if (performance.now() >= deadline) return cached?.logo ?? null;
    const job = refresh(source, key, cached, deadline);
    if (cached?.logo) {
      void job.catch(() => {});
      return cached.logo;
    }
    return job;
  }

  return {
    async getLogo(input) {
      const deadline = performance.now() + timeoutMs;
      const operation = load(input, deadline).catch(() => null);
      pending.add(operation);
      void operation.then(() => pending.delete(operation));
      let timer;
      try {
        // 预算包含缓存 IO；DNS 无响应或磁盘缓慢也不能无限阻塞首次 API 请求。
        return await Promise.race([
          operation,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now()));
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async drain() {
      // getLogo 的等待超时后，缓存读取或刷新写入可能仍在收尾。
      while (pending.size || inflight.size) {
        await Promise.allSettled([...pending, ...inflight.values()]);
      }
    },
  };
}
