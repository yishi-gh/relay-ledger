/**
 * 渠道归属派生：显式配置优先，只对没有显式 owner 的 snapshot 渠道做自动匹配。
 *
 * 规则（纯读、纯派生，不修改 config、不写 DB）：
 * - 显式 accounts[].channels 绝对优先，多 owner 原样保留；
 * - 自动匹配只对「snapshot 中存在、且显式配置未拥有」的渠道生效；
 * - origin 归一：http(s) + 小写 host（默认端口由 URL 归一），带 userinfo 的 URL 不参与；
 * - 候选来源：账户 base_url 的 origin 相同，或该账户显式拥有的某个 snapshot 渠道 origin 相同（API 别名）；
 * - origin 无候选时，再用注册域名标签 + 名称 token 识别同品牌换域名（如 xcmapi.org / xcmapi.com）；
 * - 按 account.id 去重；恰好 1 个才自动关联，0 未匹配，>1 歧义不关联；
 * - 停用账户/渠道仍参与归属（不按 enabled/kind 过滤）；
 * - 自动结果不写回，不参与下一轮再学习。
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const GENERIC_BRAND_LABELS = new Set([
  'api', 'www', 'sub2api', 'newapi', 'oneapi', 'openai', 'claude', 'gemini',
  'chat', 'relay', 'proxy', 'ai', 'com', 'net', 'org',
]);
const MULTI_PART_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'co.uk', 'org.uk', 'com.hk', 'com.tw', 'co.jp',
  'com.au', 'co.nz', 'co.in', 'com.sg', 'com.br', 'com.mx', 'com.tr', 'co.kr',
  'dpdns.org', 'vercel.app', 'pages.dev', 'workers.dev', 'github.io', 'netlify.app',
]);
const GENERIC_NAME_TOKENS = new Set([
  ...GENERIC_BRAND_LABELS, 'sub2api', 'newapi', 'oneapi', 'gpt', 'kiro', 'kimi',
]);

/**
 * 归一为「协议 + 小写 host [+ 非默认端口]」；路径/查询/hash 丢弃。
 * 带 userinfo、非 http(s)、无法解析时返回 null。
 */
export function normalizeChannelOrigin(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  // WHATWG URL 已把 http:80 / https:443 归一为空端口
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
}

/**
 * 注册域名标签：取主机名倒数第二段（常见二级后缀时再向前一段）。
 * 只用于识别同品牌换域名，不参与财务口径；IP、userinfo、非 http(s) 返回 null。
 */
export function normalizeChannelBrand(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join('.');
  const index = MULTI_PART_SUFFIXES.has(last2) ? parts.length - 3 : parts.length - 2;
  const label = parts[index] ?? null;
  if (!label || label.length < 3 || GENERIC_BRAND_LABELS.has(label)) return null;
  return label;
}

/** 名称 token：中文连续段与 4 位以上英文词；过滤 api/www 等通用词，避免仅凭 api 误配。 */
function brandTokens(value) {
  const text = String(value ?? '').toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{3,}/g)) {
    if (!GENERIC_NAME_TOKENS.has(match[0])) tokens.add(match[0]);
  }
  return [...tokens];
}

/** 两个名称至少有一个有效 token 互相包含；只用于多账户同品牌时消歧。 */
function brandNameMatches(left, right) {
  const leftTokens = brandTokens(left);
  const rightTokens = brandTokens(right);
  for (const a of leftTokens) {
    for (const b of rightTokens) {
      if (a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

function channelIdOf(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * @param {{accounts?: object[], channels?: object[]}} input
 *   accounts：配置里的账户数组（原样读取，不修改）
 *   channels：route snapshot 的 channels（可能为 null/空）
 */
export function buildChannelAssociations({ accounts = [], channels = [] } = {}) {
  const accountList = Array.isArray(accounts) ? accounts : [];
  const snapshotChannels = Array.isArray(channels) ? channels : [];

  const explicit = new Map(); // channelId -> accountId[]（配置顺序）
  for (const account of accountList) {
    const accountId = String(account?.id ?? '');
    if (!accountId) continue;
    for (const value of Array.isArray(account?.channels) ? account.channels : []) {
      const channelId = channelIdOf(value);
      if (channelId === null) continue;
      const list = explicit.get(channelId) ?? [];
      uniquePush(list, accountId);
      explicit.set(channelId, list);
    }
  }

  const originById = new Map(); // snapshot channelId -> origin|null
  const brandById = new Map(); // snapshot channelId -> 注册域名标签|null
  const nameById = new Map(); // snapshot channelId -> 当前渠道名
  for (const channel of snapshotChannels) {
    const channelId = channelIdOf(channel?.id);
    if (channelId === null || originById.has(channelId)) continue;
    originById.set(channelId, normalizeChannelOrigin(channel?.base_url));
    brandById.set(channelId, normalizeChannelBrand(channel?.base_url));
    nameById.set(channelId, channel?.name == null ? '' : String(channel.name));
  }

  // 账户 base_url 的 origin
  const baseOriginByAccount = new Map();
  // 该账户「显式拥有」的 snapshot 渠道的 origin 集合（API 别名）
  const aliasOriginsByAccount = new Map();
  // 账户 base_url / website 的注册域名标签，用于同品牌换域名
  const brandsByAccount = new Map();
  for (const account of accountList) {
    const accountId = String(account?.id ?? '');
    if (!accountId) continue;
    const baseOrigin = normalizeChannelOrigin(account?.base_url);
    if (baseOrigin) baseOriginByAccount.set(accountId, baseOrigin);
    const aliasOrigins = new Set();
    for (const value of Array.isArray(account?.channels) ? account.channels : []) {
      const channelId = channelIdOf(value);
      if (channelId === null) continue;
      const origin = originById.get(channelId) ?? null;
      if (origin) aliasOrigins.add(origin);
    }
    if (aliasOrigins.size > 0) aliasOriginsByAccount.set(accountId, aliasOrigins);

    const brands = new Set();
    for (const value of [account?.base_url, account?.website]) {
      const brand = normalizeChannelBrand(value);
      if (brand) brands.add(brand);
    }
    if (brands.size > 0) brandsByAccount.set(accountId, brands);
  }

  const owners = new Map();
  const sources = new Map();
  const autoByAccount = new Map();

  for (const [channelId, accountIds] of explicit) {
    owners.set(channelId, [...accountIds]);
    sources.set(channelId, { source: 'explicit', candidates: [] });
  }

  for (const [channelId, origin] of originById) {
    if (explicit.has(channelId)) continue;
    const originCandidates = [];
    for (const account of accountList) {
      const accountId = String(account?.id ?? '');
      if (!accountId) continue;
      const baseMatch = origin
        && baseOriginByAccount.get(accountId) === origin;
      const aliasMatch = origin
        && aliasOriginsByAccount.get(accountId)?.has(origin);
      if (baseMatch || aliasMatch) uniquePush(originCandidates, accountId);
    }

    let candidates = originCandidates;
    let unmatchedCandidates = [];
    let reason = 'origin';
    if (originCandidates.length === 0) {
      const brand = brandById.get(channelId);
      const brandCandidates = [];
      if (brand) {
        for (const account of accountList) {
          const accountId = String(account?.id ?? '');
          if (!accountId) continue;
          if (brandsByAccount.get(accountId)?.has(brand)) uniquePush(brandCandidates, accountId);
        }
      }
      const named = brandCandidates.filter((accountId) => {
        const account = accountList.find((item) => String(item?.id ?? '') === accountId);
        return brandNameMatches(account?.name, nameById.get(channelId));
      });
      candidates = named;
      reason = 'brand';
      // 单个同品牌账户但名称对不上时不自动；两个以上同品牌账户仍按歧义暴露候选
      if (named.length === 0 && brandCandidates.length > 1) candidates = brandCandidates;
      if (named.length === 0 && brandCandidates.length === 1) unmatchedCandidates = brandCandidates;
    }

    if (candidates.length === 1) {
      const accountId = candidates[0];
      owners.set(channelId, [accountId]);
      sources.set(channelId, { source: 'auto', reason, candidates: [accountId] });
      const list = autoByAccount.get(accountId) ?? [];
      list.push(channelId);
      autoByAccount.set(accountId, list);
    } else if (candidates.length === 0) {
      owners.set(channelId, []);
      sources.set(channelId, { source: 'unmatched', candidates: unmatchedCandidates });
    } else {
      // 歧义不自动关联，也不新增多 owner；候选原样暴露给 UI 待确认
      owners.set(channelId, []);
      sources.set(channelId, { source: 'ambiguous', candidates });
    }
  }

  const effectiveAccounts = accountList.map((account) => {
    const accountId = String(account?.id ?? '');
    const explicitChannels = (Array.isArray(account?.channels) ? account.channels : [])
      .map(channelIdOf)
      .filter((value) => value !== null);
    const autoChannels = [...(autoByAccount.get(accountId) ?? [])].sort((a, b) => a - b);
    const channels = [...explicitChannels];
    for (const channelId of autoChannels) uniquePush(channels, channelId);
    return {
      ...account,
      channels,
      auto_channels: autoChannels,
    };
  });

  return {
    accounts: effectiveAccounts,
    owners,
    sources,
    autoByAccount,
    channelOrigins: originById,
    channelBrands: brandById,
    hasSnapshot: snapshotChannels.length > 0,
  };
}
