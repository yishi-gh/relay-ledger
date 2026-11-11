/**
 * 渠道归属派生：显式配置优先，只对没有显式 owner 的 snapshot 渠道做自动匹配。
 *
 * 规则（纯读、纯派生，不修改 config、不写 DB）：
 * - 显式 accounts[].channels 绝对优先，多 owner 原样保留；
 * - 自动匹配只对「snapshot 中存在、且显式配置未拥有」的渠道生效；
 * - origin 归一：http(s) + 小写 host（默认端口由 URL 归一），带 userinfo 的 URL 不参与；
 * - 候选来源：账户 base_url 的 origin 相同，或该账户显式拥有的某个 snapshot 渠道 origin 相同（API 别名）；
 * - 按 account.id 去重；恰好 1 个才自动关联，0 未匹配，>1 歧义不关联；
 * - 停用账户/渠道仍参与归属（不按 enabled/kind 过滤）；
 * - 自动结果不写回，不参与下一轮再学习。
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

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
  for (const channel of snapshotChannels) {
    const channelId = channelIdOf(channel?.id);
    if (channelId === null || originById.has(channelId)) continue;
    originById.set(channelId, normalizeChannelOrigin(channel?.base_url));
  }

  // 账户 base_url 的 origin
  const baseOriginByAccount = new Map();
  // 该账户「显式拥有」的 snapshot 渠道的 origin 集合（API 别名）
  const aliasOriginsByAccount = new Map();
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
    const candidates = [];
    for (const account of accountList) {
      const accountId = String(account?.id ?? '');
      if (!accountId) continue;
      const baseMatch = origin
        && baseOriginByAccount.get(accountId) === origin;
      const aliasMatch = origin
        && aliasOriginsByAccount.get(accountId)?.has(origin);
      if (baseMatch || aliasMatch) uniquePush(candidates, accountId);
    }
    if (candidates.length === 1) {
      const accountId = candidates[0];
      owners.set(channelId, [accountId]);
      sources.set(channelId, { source: 'auto', candidates: [accountId] });
      const list = autoByAccount.get(accountId) ?? [];
      list.push(channelId);
      autoByAccount.set(accountId, list);
    } else if (candidates.length === 0) {
      owners.set(channelId, []);
      sources.set(channelId, { source: 'unmatched', candidates: [] });
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
    hasSnapshot: snapshotChannels.length > 0,
  };
}
