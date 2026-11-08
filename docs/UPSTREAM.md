# 上游账户配置

`accounts.json` 描述“你的额度是从哪里买的”：每条记录是一个上游账户，包含余额接口、凭据，以及它名下有哪些 NewAPI 渠道。看板按这份文件把渠道售出归到账户，再用账户余额算成本。

中转站自身的信息（地址、日志入口、数据目录）不在这里，见 `instance.json` 与 [DEPLOY.md](DEPLOY.md)。

## 1. 文件位置与权限

- 默认位置 `<dataDir>/accounts.json`，可用 `instance.json` 的 `paths.accounts` 改到别处。
- 权限 `0600`，属主是运行采集的用户；文件只放服务器，永不入仓库：

```bash
sudo chown relay-ledger:relay-ledger /var/lib/relay-ledger/accounts.json
sudo chmod 600 /var/lib/relay-ledger/accounts.json
```

- 换签会把新 token 原子写回本文件（同样是 `0600`），因此采集只允许单实例运行。

## 2. 结构

```json
{
  "currency": "USD",
  "quota_per_unit": 500000,
  "upstream": {
    "timeout_ms": 20000,
    "min_interval_ms": 1200,
    "retry_delay_ms": 500,
    "job_stale_ms": 1800000,
    "refresh_threshold_ms": 7200000
  },
  "accounts": []
}
```

| 字段 | 含义 |
| --- | --- |
| `accounts[]` | 上游账户列表，每项一个账户 |
| `accounts[].id` | 账户标识，渠道归属与序列键都用它，必须唯一 |
| `accounts[].name` | 显示名，缺省等于 `id` |
| `accounts[].kind` | `newapi` / `sub2api` / `external` |
| `accounts[].base_url` | 上游地址，同时用于按主机核对渠道 |
| `accounts[].enabled` | 是否采集余额；`false` 只停止采集，不解除渠道归属 |
| `accounts[].channels` | 归属到该账户的 NewAPI 渠道 id 数组 |
| `accounts[].endpoints` | 接口路径覆盖：`balance` / `credits` / `usage` |
| `accounts[].auth` | 凭据与请求头，见第 5 节 |
| `accounts[].balance_field` | 余额字段名；配置后优先于内置字段（`quota` / `balance`） |
| `accounts[].quota_per_unit` | quota 折算成 USD 的除数，NewAPI 默认 `500000` |
| `accounts[].unit` | 余额币种，默认 `USD` |
| `accounts[].session` | 可选，`false` 表示该站没有可用会话，只用渠道 key 取余额 |

## 3. 三种账户类型

| `kind` | 余额来源 | 余额公式 | 累计充值 |
| --- | --- | --- | --- |
| `newapi` | `GET /api/user/self` | `quota / quota_per_unit` | `(quota + used_quota) / quota_per_unit` |
| `sub2api` | `GET /api/v1/auth/me` | `balance`（退回 `quota`） | `total_recharged` |
| `external` | 无 | 恒为 `null` | 恒为 `null` |

### newapi

- 余额字段是 `quota`，必须除以 `quota_per_unit`（默认 500000）才是 USD；原始值与单位会另存，只用于核对。
- `quota + used_quota` 是上游自己记的“累计获得额度”，即累计充值。
- 换签走 Cookie：`POST /api/user/auth/refresh`，`auth.refresh_path` 可覆盖；`auth.session` 存在时作为 `X-Auth-Session` 回发。
- 采集器会用 `/api/user/self` 返回的 `id` 核对 `auth.user_id`，不一致判 `cookie_account_mismatch`，不写余额。

### sub2api

- `GET /api/v1/auth/me` 返回 `balance`（美元）与 `total_recharged`（累计充值）；没有 `balance` 时退回 `quota`。
- 换签走 `refresh_token`：`POST /api/v1/auth/refresh`。
- 可选：给账户配了 `channels` 时，采集器会从中转站渠道表取 key，请求该渠道的 `GET /v1/usage` 取余额；全部失败才回退会话。只做余额，不提供累计充值。
- 这类站没有充值流水接口时，充值只能靠余额上涨推断，并打标 `balance_delta`；看板会与真实流水区分显示。

### external

- 没有上游账户、也没有余额来源，只把渠道售出统计进来，成本与毛利率恒为 `null`（「无成本源」）。
- 适用于包月订阅、赠送额度、或你根本拿不到余额的线路：`enabled: true`、`channels` 照常映射即可。
- 把这类渠道写进 `external` 而不是留空，页面会把它们与「未映射」区分开，毛利率分母也不会被它们污染。

## 4. 充值必须用累计计数器

```text
充值 = 累计计数器(期末) − 累计计数器(期初)
```

余额上涨是 `充值 − 消耗` 的混合结果：同一小时里充 5、消耗 2.5，余额只涨 2.5，用差额反推会把成本算成 0，毛利率虚高到 100%。累计计数器不受消耗影响——消耗时 `quota` 降、`used_quota` 升，两者之和不变。因此：

- NewAPI 用 `quota + used_quota`，Sub2API 用 `total_recharged`，优先于任何推断。
- 计数器两端都要有值才可用；期末小于期初（换账号、上游重置）判为不可用。
- 余额上涨推断只在计数器与充值流水都缺失时兜底，且必须打标；两端计数器都有值时禁止推断，否则同一笔充值会记两遍。

完整取舍见 [DECISIONS.md](DECISIONS.md) D2。

## 5. 凭据字段

```json
{
  "auth": {
    "mode": "bearer",
    "token": "<REDACTED>",
    "refresh_token": "<REDACTED>",
    "cookie": "<REDACTED>",
    "user_id": 10001,
    "session": "<REDACTED>",
    "expires_at": 1760000000000,
    "refresh_path": "/api/user/auth/refresh",
    "token_env": "RELAY_UPSTREAM_TOKEN",
    "header": "Authorization",
    "scheme": "Bearer",
    "headers": {}
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `mode` | `bearer`（默认）或 `cookie`（发 `Cookie`，有 `user_id` 时再加 `New-Api-User`） |
| `token` | 访问令牌，优先于 `token_env` |
| `token_env` | 从环境变量读令牌，`token` 为空时生效 |
| `cookie` | 上游站点级 Cookie 串，NewAPI 换签必需（可同时配 `token`） |
| `refresh_token` | Sub2API 的刷新令牌，只从文件读，不走环境变量 |
| `user_id` | 账户 id，用于核对换签返回的 `user.id` |
| `session` | NewAPI 换签返回的会话标识，存在时随请求回发 |
| `expires_at` | 令牌过期时间，兼容秒与毫秒；留空由 JWT 的 `exp` 推断 |
| `refresh_path` | 刷新端点覆盖路径 |
| `header` / `scheme` | `bearer` 模式下拼成 `<header>: <scheme> <token>` |
| `headers` | 额外请求头 |

约定：

- `cookie` 是上游站点级凭据，可能属于同站另一个账号，所以必须配 `user_id` 做账号校验。
- 换签成功后会原子写回 `accounts.json`，保留其它账户与字段；期间被其他进程改过则放弃写回。
- 令牌、Cookie、刷新令牌不进日志、不进错误信息、不进 API 响应。

## 6. 渠道归属

```json
{
  "id": "upstream-a",
  "kind": "newapi",
  "base_url": "https://upstream-a.example.com",
  "channels": [13, 15, 27]
}
```

- 映射是人工维护的：打开 NewAPI 的渠道列表，看每条渠道的 `base_url` 主机属于哪个上游账户，把渠道 id 填进 `channels`。
- 一个渠道只能属于一个账户。重复配置时以第一条为准，并在数据质量区告警。
- **停用账户也要保留映射。** `enabled: false` 只表示不再采集余额，账户名下的渠道仍可能在销售；删掉映射会让这些售出掉进「未映射」，毛利率随之失真。历史教训是两个停用账户名下 56.43 USD 的售出被误判为未映射（约 14%）。
- 找不到归属的渠道归入「未映射」单列，不丢弃、不按比例摊到其它账户。
- 没有上游账户的渠道用 `kind: "external"` 建一条只做映射的记录，成本显示 `—`，不参与成本合计。

## 7. 最小示例

```json
{
  "currency": "USD",
  "quota_per_unit": 500000,
  "accounts": [
    {
      "id": "upstream-a",
      "name": "Upstream A",
      "kind": "newapi",
      "base_url": "https://upstream-a.example.com",
      "enabled": true,
      "channels": [13, 15],
      "auth": {
        "mode": "cookie",
        "cookie": "<REDACTED>",
        "user_id": 10001
      },
      "endpoints": {
        "balance": "/api/user/self",
        "credits": "/api/log/self",
        "usage": "/api/log/self/stat"
      },
      "balance_field": "quota",
      "quota_per_unit": 500000
    },
    {
      "id": "upstream-b",
      "name": "Upstream B",
      "kind": "sub2api",
      "base_url": "https://upstream-b.example.com",
      "enabled": true,
      "channels": [21],
      "auth": {
        "mode": "bearer",
        "token": "<REDACTED>",
        "refresh_token": "<REDACTED>",
        "user_id": 10002
      },
      "endpoints": {
        "balance": "/api/v1/auth/me",
        "usage": "/api/v1/usage/stats?period=today"
      },
      "balance_field": "balanceUsd",
      "quota_per_unit": null
    },
    {
      "id": "subscription-lines",
      "name": "包月线路",
      "kind": "external",
      "enabled": true,
      "channels": [31]
    }
  ]
}
```

## 8. 校验与常见错误

改完配置后跑一轮采集，再看质量接口：

```bash
sudo -u relay-ledger env RELAY_LEDGER_INSTANCE=/etc/relay-ledger/instance.json \
  node /opt/relay-ledger/v2/jobs/collect-spend.mjs
curl -s http://127.0.0.1:8788/api/quality | jq '.collect_errors'
```

| reason | 含义 | 处理 |
| --- | --- | --- |
| `missing_token` | bearer 模式没有可用令牌 | 补 `token` 或设置 `token_env` |
| `missing_cookie` | NewAPI 换签需要 Cookie 但没有 | 补 `auth.cookie` 与 `auth.user_id` |
| `cookie_account_mismatch` | Cookie 属于同站另一个账号 | 换对应账号的 Cookie，或改用该账号的 `user_id` |
| `auth_failed` | 401 / 403，或上游判定令牌无效 | 更新令牌，确认账号未被封禁 |
| `http_429` | 渠道 key 取余额被限流 | 停一轮再试，不要加大频率；采集间隔默认 15 分钟 |
| `timeout` / `network_error` | 网络或上游超时 | 检查出网、代理与上游可用性 |

`external` 账户没有余额源，采集器记 `unsupported_kind`，属预期状态，不算采集失败。

## 9. 安全约定

- 凭据只放服务器，权限 `0600`，永不入仓库，也不要写进 systemd 单元或命令行参数。
- 本地配置绝不整文件覆盖生产。历史事故：本地 `accounts.json` 覆盖服务器后，三个站同时掉线且没有备份。变更只允许按账户补字段，逐条验证（[DECISIONS.md](DECISIONS.md) D13）。
- 轮换令牌时只动一个账户的一个字段，重启采集后看 `/api/upstreams` 的 `last_sync` 是否更新。
- 发现某个账户的余额单位不对（例如把 `quota` 当成了美元），先停该账户（`enabled: false`），核对 `quota_per_unit` 再恢复；不要靠改历史快照修补。
