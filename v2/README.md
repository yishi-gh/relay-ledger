# v2 本地预览后端

只读站点库 `db/sites/<site>.db`，在 `127.0.0.1:8788` 提供 JSON API 与 `v2/web` 静态页面。
口径与字段以 [CONTRACT.md](./CONTRACT.md) 为准，本文只说明实现与运行。

零 npm 依赖，Node 24 原生 ESM + `node:http` + `node:sqlite`。不连接上游、不读取凭据、不写站点库。

## 运行

```bash
node v2/server.mjs                     # 127.0.0.1:8788
node v2/server.mjs --port=8791         # 指定端口（8790 留给登录服务，见「面板登录」）
PORT=8791 node v2/server.mjs           # 或用环境变量
node v2/server.mjs --site=relay --source=db/sites/relay.db
```

启动时自动创建 `v2/db/dashboard.db`（`CREATE TABLE IF NOT EXISTS`，不覆盖已有数据），并把
`v2/secrets/accounts.json`（不存在时回退 `v2/config/upstreams.json`）的账户同步进 `upstream_account`。

`--host` 默认 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到局域网。

## 目录

```text
v2/
├── server.mjs            HTTP 入口：路由、静态文件、错误封装
├── secrets/
│   ├── accounts.json     单文件账户配置：base_url + 凭据（gitignore，0600）
│   └── accounts.example.json 模板，全部占位符
├── config/upstreams.json 旧的非敏感配置（secrets 文件不存在时回退）
├── lib/
│   ├── api.mjs           查询层（所有 SQL 参数绑定）
│   ├── config.mjs        配置解析（单文件优先）、auth 归一、渠道→账户反查
│   ├── ledger.mjs        账本纯函数（consumption / margin / status）
│   └── time.mjs          北京时间分桶与默认范围
├── sources/upstream/
│   ├── http.mjs          可注入 fetch 的 HTTP 客户端（超时/重试/串行/最小间隔）
│   ├── auth.mjs          JWT 到期、Sub2API refresh_token / NewAPI cookie 换签、单文件原子写回
│   ├── common.mjs        结果规整、bearer/cookie 请求头、错误映射
│   ├── newapi.mjs        New API：余额 quota、充值/赠额分页、上报消费
│   └── sub2api.mjs       sub2api：余额、上报消费；充值 unsupported
├── jobs/
│   ├── collect-spend.mjs 采集一轮：ensureAuth + 余额 + 入账 + 上报消费 → dashboard.db
│   ├── collect-site-logs.mjs 采集本站消耗日志（默认直读站点 SQLite，可回退 HTTP 导出）→ db/sites/<site>.db
│   ├── scheduler.mjs     整点对齐延迟 nextHourDelayMs（纯函数）
│   └── run-scheduler.mjs 常驻采集入口：挂两个定时任务，供 systemd / 服务器使用
├── deploy/
│   ├── relay-*.service   systemd 示例（collector / panel / auth）
│   └── crontab.example   cron 备选（两行，与 service 二选一）
├── store/
│   ├── schema.mjs        dashboard.db 建表
│   └── dashboard.mjs     看板库打开、账户同步、余额/充值/任务读取
├── test/                 单测与集成测试（全部 mock fetch / 临时库）
└── db/dashboard.db       运行时生成（不作为源码提交）
```

## 时间与口径

- **默认范围**：终点取站点库 `MAX(t_ms) WHERE log_type = 2`（最新的充值/系统日志不参与），
  起点为该时刻北京时间自然日的 00:00 再往前 6 天，即含终点当天的 7 个自然日。
  源库为空时退回「当前时刻往前 7 个自然日」。`/api/meta` 的 `max_t` 仍是 `logs` 全表最大值。
- **本站过滤**：所有本站查询统一 `log_type = 2 AND (token_name IS NULL OR token_name <> 'Model test')`。
- **分桶**：`strftime(..., '+8 hours')`，日桶 `YYYY-MM-DD`，小时桶 `YYYY-MM-DD HH:00`；无数据的小时不补点。
- **p50/p95**：取 `latency_ms` 非空样本，JS 内排序后线性插值，结果保留 1 位小数；样本为 0 返回 `null`。
- **缓存率**：`cache_read / (cache_read + input_uncached)`，分母为 0 返回 `null`。
- **金额**：统一 6 位小数取整以消除 REAL 求和噪声；`margin_pct` 是小数（`0.11` = 11%）。

## 账本状态

`complete` 需要同时满足：期初、期末余额快照都在边界容差内、区间是**已结束的完整北京自然日**
（`00:00:00` 到 `23:59:59.999`）。credits 直接汇总区间内的 `credit_event`（半开区间
`(from, to]`，含 `source='balance_delta'` 的推断充值），无事件即为 0，不再要求
`credit_window` 覆盖区间——窗口只作为核对凭据保留。
容差口径与 `/api/profit` 一致：期初/期末必须是**贴着区间边界**的快照（±5 分钟
`SNAPSHOT_BOUNDARY_TOLERANCE_MS`，可略晚于边界，因为采集在整点 +10 秒落库）。
唯一例外是区间终点就在此刻：期末退一步取不晚于终点的最近一条，最多容忍 90 分钟。
不再按区间长度放宽到 26 小时——那会把上一期的余额当成本期期初，成本偏大甚至为负。
默认范围终点是 `MAX(t_ms)`，落在日中，因此默认永远是 `partial`。

| status | 含义 |
| --- | --- |
| `complete` | 余额新鲜、credits 完整、区间为已结束的完整自然日 |
| `partial` | 余额齐全但 credits 未知、区间非完整日、余额异常上升，或快照过期 |
| `unavailable` | 没有余额快照（配置了账户但无数据） |
| `unconfigured` | 没有配置该上游账户 |

`reason` 字段给出可展示的原因：

| reason | 含义 |
| --- | --- |
| `not_configured` | 账户未配置 |
| `missing_balance` | 期初或期末没有快照 |
| `missing_credits` | 仅账本纯函数保留：`/api/upstreams` 恒以 `credit_event` 区间求和得到数值 credits，生产路径不再产生该原因 |
| `balance_increased_without_credits` | `opening + credits - closing < 0`，余额上升超出入账 |
| `incomplete_day` | 区间不是已结束的完整北京自然日 |
| `stale_balance` | 期初/期末快照超出边界容差（旧值不当边界余额） |

缺失值一律 `null`，不写 0；`credits` 恒为数值（区间内 `credit_event` 之和，无事件为 0），
缺失只会发生在期初/期末余额上。
`consumption = opening_balance + credits - closing_balance`，为负时返回 `null`（不给负消费）。
`margin = local_revenue - consumption`；`local_revenue` 为 0 或缺失、或 `consumption` 为 `null` 时，
`margin`/`margin_pct` 均为 `null`。

渠道行：`upstream_account` 从配置的 `channels` 反查（返回账户显示名）；一个渠道被多个账户声明时取第一个并标
`margin_status = 'unallocated'`，只给账户级毛利。渠道无账户声明时为 `unconfigured`；
渠道只属于已停用账户时为 `disabled_account`（账户仍在归属里，只是没有成本和余额）。

渠道行的 `top_model` 是区间内 `SUM(cost)` 最高的模型：`{ model, revenue, tokens, per_1e8 }`。
`tokens = input_total + output`（该模型自身口径），`per_1e8 = revenue / (tokens / 1e8)`；
模型名为 NULL / 空串时归为 `(未标记)`，`tokens = 0` 时 `per_1e8 = null`。归档只有渠道粒度，
没有模型维度：整段只剩归档的渠道 `top_model = null`。前端「额度/亿Token」列展示该值。

## API

| 路径 | 说明 |
| --- | --- |
| `GET /api/meta` | 站点、源库路径、`min_t`/`max_t`、`logs` 总行数、币种、配额单位 |
| `GET /api/overview?from=&to=` | 收入、配额、请求数、token、缓存率、延迟、上游成本与毛利 |
| `GET /api/trend?granularity=day\|hour` | 按北京时间的收入/配额/请求趋势，无数据桶不补点 |
| `GET /api/profit?from=&to=&granularity=day\|hour` | 站点盈利：渠道售出、账户成本/利润/毛利率、未映射渠道与数据质量 |
| `GET /api/channels?from=&to=` | 按 `channel_id, channel_name` 聚合，含延迟分位、上游归属与 `top_model` |
| `GET /api/groups?from=&to=` | 按 `group_name` 聚合渠道数、售出、token、请求、缓存率、延迟、TPS 与 `top_model` |
| `GET /api/upstreams?from=&to=` | 账户级账本：期初期末余额、credits、consumption、毛利 |
| `GET /api/quality` | 源库最后时间、行数、error_logs 行数、job_runs、collect_errors、schema_ok |
| `GET /api/rows?from=&to=&page=&page_size=` | 逐条明细，`t_ms DESC`；`page_size` 上限 200（超限收敛到 200） |
| `GET /api/healthz` | `{ "ok": true }` |

时间参数为毫秒时间戳；缺省走默认范围，`from > to` 或非法分页返回 `400`。
错误统一为 `{ "error": { "code": "...", "message": "..." } }`。

`/api/upstreams` 的账户对象在契约字段外补充：`reason`（见上表）、`balance_delta`（原始差，
可为负，仅供排查）、`credit_events`（区间内 `credit_event` 条数，仅作证据）、
`opening_raw` / `closing_raw`（`{ balance, unit }`，未归一的原始值与单位）、
`credits_today` / `credits_today_at`（今日已确认入账及该窗口终点，未知为 `null`）、
`reported_consumption` / `reported_spend_today` / `reported_spend_range`（上游自报消费，USD，
未采集为 `null`）、`last_sync`（最新余额快照的毫秒时间戳）、`last_sync_balance`（该快照的余额与币种）、
`last_job`（最近一次 `collect-spend` 的状态）。

`/api/groups` 的 `groups[]` 每行字段：`group_name`（NULL / 空串统一为 `''`，前端显示「未分组」）、
`channels`（去重渠道数）、`channel_names`（去重渠道名，最多 8 个）、`revenue`、`tokens`、`requests`、
`cache_rate`、`p50`、`p95`、`tps`、`last_t`、`top_model`（口径同渠道行）。按 `revenue` 降序。
过滤与归档并入规则和 `/api/channels` 一致；归档没有 `group_name`，归档渠道沿用明细窗口里同渠道的分组，
找不到归属时归入 `''`，只有归档数据的分组其 `p50` / `p95` / `tps` / `top_model` 为 `null`。

`/api/quality` 额外返回 `jobs`：`{ job, last_run_at, last_status, age_ms, threshold_ms, stalled, never_run }`，
阈值取配置的 `upstream.job_stale_ms`（默认 30 分钟）。`job_runs` 只含状态与原因，不含 token。

`/api/quality` 还返回 `collect_errors`：取最新一条 `collect-spend` 的 `job_runs.detail`，列出 `accounts` 里
`status !== 'ok'` 的项，结构为 `[{ account_id, name, reason, at }]`，`at` 是该轮 `started_at`（毫秒）。
没有任务、全部成功或 detail 不是合法 JSON 时返回空数组；采集器为每个账户写短 `reason`
（如 `auth_failed`、`network_error`、`http_401`），不拼接长 message。

### `/api/profit` 口径

- **分桶**：北京时间；`day` 用当日 `00:00`，`hour` 用整点。`buckets: [{ t_ms, label }]`，
  `label` 形如 `2026-01-10` / `2026-01-10 13:00`。区间首尾按 `from`/`to` 截断，序列与区间合计一致。
- **售出**：站点库 `logs` 复用 `LOCAL_FILTER`，`SUM(cost)` 按桶和 `channel_id` 聚合；
  再按配置的 `account.channels` 归到账户。一个渠道被多个账户配置时只记给第一个**启用**账户；
  停用账户仍参与归属（其渠道还在卖，售出不归入 `unmapped`），但会在 `sites[].enabled` 标 `false`，
  且不计入 `quality` 的缺快照统计。完全没配置的渠道进入 `unmapped`，不静默丢弃。
- **成本**：每账户每桶 `opening + credits − closing`。整点采集在 `HH:00:10` 左右落库，
  因此边界取「距桶起点/终点最近且偏差 ≤ 5 分钟」的快照（`SNAPSHOT_BOUNDARY_TOLERANCE_MS`，
  可晚于边界），超出容差按缺失处理；不会拿相邻小时的快照顶替。
  `credits` 为 `credit_event` 中 `[桶起点, 桶终点)` 的 `amount` 之和，包含采集器写入的
  `source='balance_delta'` 推断充值（其时间戳记在期初快照之后 1ms，落在同一桶内）。
- **进行中的桶**：最后一个桶还没走完时，期末取「不晚于 `to` 的最近快照」，最多容忍 90 分钟；
  更新时间本身就是「到目前为止」的成本，不插值。
- **缺失与负数**：缺期初或期末快照时该桶 `cost = null`，站点状态 `missing_balance`；
  计算结果为负时 `cost = null`，状态 `partial`。不用 0、不插值、不用相邻桶补值。
- **利润/毛利率**：`profit = revenue − cost`；`margin = revenue > 0 ? profit / revenue : null`，
  分母为 0 返回 `null`，不产生 `Infinity`/`NaN`。
- **字段**：`sites[]` 为区间合计；`series.revenue_by_channel` 为渠道序列（含 `account_id|null`），
  `series.{revenue,cost,profit,margin}_by_site` 以账户 id 为键。`unmapped` 含合计、序列与渠道明细，
  `quality.accounts_missing_balance` / `quality.hours_without_snapshot` 用于定位数据缺口
  （后者按小时统计各账户缺期初或期末快照的数量，与所选粒度无关）。

## 静态文件

| 请求 | 文件 |
| --- | --- |
| `/` | `v2/web/index.html` |
| `/styles.css`、`/app.js` | `v2/web/…` |
| `/vendor/echarts.min.js` | `web/vendor/echarts.min.js`（复用旧看板，不复制） |

路径先 `decodeURIComponent` 再解析，越出根目录直接 400；`v2/web` 缺文件时返回 404 文本。

## 单文件账户配置 `v2/secrets/accounts.json`

服务与采集默认读取 `v2/secrets/accounts.json`；该文件不存在时回退 `v2/config/upstreams.json`
（只读，不写回换签结果）。单文件同时放上游地址与凭据，追加账户只需往 `accounts` 里加一条。

```json
{
  "id": "123api",
  "name": "123api",
  "kind": "sub2api",
  "base_url": "https://upstream-a.example.com",
  "unit": "USD",
  "enabled": true,
  "channels": [13, 14],
  "auth": {
    "mode": "bearer",
    "token": "ACCESS_TOKEN",
    "refresh_token": "REFRESH_TOKEN",
    "cookie": "session=…; refresh=…",
    "session": "…",
    "expires_at": 1760000000000,
    "user_id": 123,
    "token_env": "RELAY_UPSTREAM_A_TOKEN",
    "header": "Authorization",
    "scheme": "Bearer",
    "headers": {}
  },
  "endpoints": { "balance": "/api/v1/auth/me", "usage": "/api/v1/usage/stats?period=today" },
  "balance_field": "balanceUsd",
  "quota_per_unit": 500000
}
```

- `mode`：`bearer`（`<header>: <scheme> <token>`）或 `cookie`（`Cookie: <cookie>`，
  有 `user_id` 时再加 `New-Api-User`）。
- `token` 优先；为空时回退 `token_env` 指定的环境变量。`refresh_token` 只从文件读，不走环境变量。
- `cookie`：站点级 Cookie 串（形如 `session=…; refresh=…`），NewAPI 用它换签；采集插件在 bearer 模式
  也会写完整 cookie，因此两种模式都能续期。Cookie 属于整站，可能是同站另一个账号的会话，见下方「账号校验」。
- `session`：NewAPI 换签返回的会话标识，存在时作为 `X-Auth-Session` 发回（也认 `session_id`）。
- `refresh_path`：NewAPI 刷新端点覆盖，默认 `/api/user/auth/refresh`；Sub2API 固定 `/api/v1/auth/refresh`。
- `expires_at` 兼容秒/毫秒，也可留空由 JWT 的 `exp` 推断；两者都没有时靠 401 触发刷新。
- `channels` 仍是静态 channel→account 映射，不参与 `meta/routes.json` 的路由。
- 根级 `upstream` 控制 HTTP 与刷新：`timeout_ms`、`min_interval_ms`、`retry_delay_ms`、
  `job_stale_ms`、`refresh_threshold_ms`（默认 2 小时）。

**权限与部署**：文件建议 `chmod 600`（换签写回时也会按 `0600` 重写）。仓库根 `.gitignore`
已忽略 `v2/secrets/accounts.json`、`*.env` 与写回临时文件。systemd 部署示例：

```ini
[Service]
WorkingDirectory=/opt/relay-ledger
# 只放 token，不放 refresh_token；文件本身 0600，读权限仅服务用户
EnvironmentFile=/etc/relay-ledger/v2.env
ExecStart=/usr/bin/node v2/jobs/collect-spend.mjs
# 定时执行用 systemd timer 或其他调度器；完整的 unit 见 v2/deploy/relay-collector.service
# （常驻 runner），cron 备选见 v2/deploy/crontab.example，说明见「部署到服务器」
```

```bash
# /etc/relay-ledger/v2.env
RELAY_UPSTREAM_A_TOKEN=...
RELAY_UPSTREAM_B_TOKEN=...
```

**换签流程**（`v2/sources/upstream/auth.mjs`）：

1. `ensureAuth` 先取 `auth.token`（或 `token_env`）。Sub2API 用 `refresh_token`、`POST {base_url}/api/v1/auth/refresh`；
   NewAPI 用 Cookie、`POST {base_url}/api/user/auth/refresh`（`auth.refresh_path` 可覆盖），body `{}`，
   Cookie 头等价 `credentials: include`，有 `auth.session` 时附 `X-Auth-Session`。
2. 主动换签的时机不同：Sub2API 用 `refresh_threshold_ms`（默认 2h）；NewAPI 的 access_token 寿命常只有
   15 分钟，改用「寿命的 1/4」并限制在 1 分钟到 5 分钟之间，避免固定 2h 阈值导致每轮都刷新。
   纯 cookie 配置（没有 token）不主动刷新，等 401 再换。
3. 成功要求返回的 `access_token` 是可解析 JWT（200 + `success:false`/“无效的令牌”按失败处理）；
   随后**原子写回** `auth.token`、`auth.cookie`、`auth.expires_at`、`auth.session`，保留其他账户与字段。
   响应带 `Set-Cookie` 时按同名覆盖合并进 `auth.cookie`，拿不到则保留旧 cookie。
4. **账号校验**：cookie 是站点级的，可能属于同站另一个账号。换签响应里的 `user.id` 必须与
   `auth.user_id`（或纯数字的账户 `id`）一致，`/api/user/self` 返回的 `id` 同样要核对；
   不一致记 `cookie_account_mismatch`，不采用新 token、不写余额、不改配置文件。
5. 余额请求 401/403 时强制换签一次并重试一次，仍失败才标 `auth_failed`；429 直接停止整轮。
   主动换签失败但旧 token 尚未过期时软失败：本轮继续用旧凭据，`job_runs.detail` 里记
   `refresh_error`，不把账户判成 `auth_failed`。
6. 不做 email/password 登录回退。没有 cookie 也没有 refresh_token 时明确失败（`missing_cookie` /
   `missing_token`），不伪造成功。
7. 写回是「读-改-写 + rename」，写前会把基线快照与文件当前凭据比对，期间被其他进程改过就放弃写回
   （`write_error: write_conflict`），但仍用本轮新 token；建议单实例采集。
8. token / refresh_token / cookie 不进 API、`job_runs.detail`、日志或错误信息；代码不读
   `meta/credentials.json`。

## 采集与调度

```bash
# 单轮采集：token 由 accounts.json 或对应环境变量提供
node v2/jobs/collect-spend.mjs

# 指定中转站渠道库（默认 /home/newapi/one-api.db，也可用 RELAY_DB_FILE）
node v2/jobs/collect-spend.mjs --relay-db=/home/newapi/one-api.db

# 常驻采集（服务器上就用这个；整点 +10s 采余额，每小时采站点日志）
node v2/jobs/run-scheduler.mjs

# 立即各跑一次后退出，退出码 0/1（首次验证、cron 模式）
node v2/jobs/run-scheduler.mjs --once
```

- `run-scheduler.mjs`：真正的采集入口，进程靠定时器存活，timer 不 `unref`。
  `--help` 看全部参数（`--spend-interval-ms`、`--logs-interval-ms`、`--no-logs`）。
  同一任务不重入（上一轮未结束就跳过并打一行 `skipped`，不写 `job_runs`）；
  任务异常只打一行 stderr，不退出进程；`SIGINT`/`SIGTERM` 清掉 timer 后退出 0。
  部署见「部署到服务器」。
- `scheduler.mjs`：只提供 `nextHourDelayMs(nowMs)`，即距「下一个整点 + 10 秒」的毫秒数
  （最小 1000ms，跨日跨月由时间戳自然处理）。`run-scheduler.mjs` 用它算余额采集的首轮延迟，
  常驻定时链在 `run-scheduler.mjs` 的 `createLoop` 里。
- `newapi.mjs`：`/api/user/self` 的 `quota` 按 `quota_per_unit` 折算 USD；
  `/api/log/self?type=1`（充值）与 `type=4`（赠额）分页求和；`/api/log/self/stat` 取上报消费。
  200 + `success:false` 且 message 是鉴权失败（“无效的令牌”“未登录”等）时判 `auth_failed`，
  而不是缺字段；`/api/user/self` 返回的 `id` 与配置的 user id 不一致时判 `cookie_account_mismatch`。
- `sub2api.mjs`：`/api/v1/auth/me` 的 `balanceUsd`（退回 `quota`），
  `/api/v1/usage/stats?period=today` 的 `total_actual_cost`；充值明确 `unsupported`，不写 0。
  另导出 `fetchBalanceByKey`：用中转站渠道 key 请求 `GET /v1/usage`，key 只进请求头。
- `collect-spend.mjs`：sub2api 账户配置了 `channels` 时，先按顺序从 `--relay-db`（默认
  `/home/newapi/one-api.db`，环境变量 `RELAY_DB_FILE`）的 `channels.key` / `channels.base_url`
  请求 `GET {base_url}/v1/usage`，第一个成功即作为余额，`job_runs.detail` 记 `balance_source='channel_key'`；
  全部失败或 relay 库不存在时静默退回会话采集（`ensureAuth` + 上面的会话余额接口，
  `balance_source='session'`）。NewAPI 账户仍只走会话。每账户的 `status` / `reason` 写进
  `job_runs.detail`，供 `/api/quality.collect_errors` 使用；key 不进 detail、日志或错误信息。
  账户配置 `"session": false` 表示该站只有永久 API Key、没有可用会话（例如只发长期 PAT 的上游），
  采集器只用渠道 key 取余额，入账与上报消费记 `unconfigured` / `not_configured`——
  没有数据源不算采集失败，整轮仍是 `ok`，也不会出现在 `collect_errors` 里。
  余额确定后仍会对每个账户 `ensureAuth`（到期换签、401 强制换签一次并重试一次，NewAPI 用 cookie），
  再写 `balance_snapshot`、`credit_event`、`credit_window`（昨日完整日 + 今日进行中）、
  `upstream_spend_daily`、`job_runs`；每轮用 `evaluateLedger` 复核（日账本边界用日粒度容差，
  仅作采集器自检，面板口径以 `/api/profit` 的 ±5 分钟边界为准），
  今日不是完整自然日，最多为 `partial`。auth / 缺 token / 账号不匹配 / unsupported / 缺字段一律不写数值。
  若本次余额高于上一条快照，先减去该区间内已记录的 `credit_event`，剩余部分补一条
  `source='balance_delta'` 的 `topup`（`note='inferred from balance rise'`）；余额下降或不变不记，
  同一 `(account_id, source, t_ms)` 不重复插入。
- `sources/upstream/http.mjs`：按 origin 串行 + 最小间隔；401/403 与 429 不重试（429 让整轮停止），
  5xx 与网络错误重试一次，超时直接失败；错误信息只含方法、状态码、path。
- `newapi.mjs` / `sub2api.mjs` 只接收 `headers`，不复制认证逻辑；认证头由 `auth.mjs` 生成。

测试全部通过注入的 mock fetch 与临时库，不访问网络、不写站点库。

## 数据保留

两个任务分工：`v2/jobs/prune-logs.mjs` 管列级清理（`raw_json`、`job_runs`），
`v2/jobs/rollup-logs.mjs` 管明细归档（90 天前的整天聚合进看板库 `logs_daily` 后删除明细）。
两者都由常驻调度每天跑一次（启动后 10 分钟首轮，之后每 24 小时）。

| 数据 | 保留 | 理由 |
| --- | --- | --- |
| `logs.raw_json` | 7 天 | 原始响应体只用于排障与回溯；到期只清空该列、行保留，不影响任何查询与聚合（读取层不依赖它） |
| `logs` 明细行 | 90 天 | 到期按北京自然日聚合进 `logs_daily` 后删除；更早的小时/模型/分位数明细不再保留 |
| `logs_daily` | 永久 | 每站点每渠道每自然日一行，只存 `requests`/`cost`/`quota_raw`/`input_total`/`output` |
| `job_runs` | 30 天 | 只服务「最近运行」展示，旧记录没有核算价值 |
| `balance_snapshot` / `credit_event` / `credit_window` | 永久 | 体积小（每账户每小时一行），是成本核算与入账核对的依据 |
| `upstream_spend_daily` | 永久 | 每账户每自然日一行，上游消费口径的唯一留存 |

实测（2026-11-02，`db/sites/<site>.db` 的临时副本，83,134 行）：

- 文件 256.0 MB；`logs` 表体 227.5 MB、索引 28.4 MB；
- `raw_json` 合计 123.3 MB，平均 1.5 KB/行，占表体 54%；`content` 只有 24 KB；
- 7 天口径 `--dry-run`：33,626 行过期、预计释放约 44.9 MB；
- 副本上实跑 `--vacuum`：文件 256.0 → 167.4 MB（VACUUM 1.6 s、全流程 2.4 s），再跑一次影响 0 行。

```bash
node v2/jobs/prune-logs.mjs --dry-run                    # 只统计，不改库
node v2/jobs/prune-logs.mjs                              # 清 7 天前的 raw_json、30 天前的 job_runs
node v2/jobs/prune-logs.mjs --raw-days=14 --jobs-days=60 # 临时调整保留期
node v2/jobs/prune-logs.mjs --vacuum                     # 手动回收磁盘（建议月度低峰）

node v2/jobs/rollup-logs.mjs --dry-run                   # 只统计将归档/删除的天数与行数
node v2/jobs/rollup-logs.mjs                             # 归档 90 天前的整天并删除明细
node v2/jobs/rollup-logs.mjs --keep-days=180 --vacuum    # 放宽保留期并回收磁盘
```

- 常驻调度参数：`--prune-days-raw`、`--prune-days-jobs`、`--no-prune`；`--once` 不跑清理，
  手动清理直接用上面的命令。清理是独立定时链，与两个采集任务同样防重入、异常不退出进程，
  日志只有一行 `[run-scheduler] prune ok Xms`。
- 现存站点库的 `logs.raw_json` 声明为 `NOT NULL`，清理写空串 `''`（与 `fp:` 行既有的「无原文」写法一致）；
  列可空时写 `NULL`。两者都表示无原文，判断条件为 `length(raw_json) > 0`，所以重复跑影响 0 行。
- `--vacuum` 在事务外执行，需要约一份库大小的空闲磁盘；不 VACUUM 时页内空闲会被后续写入复用，
  空间不会立刻还给文件系统。看板库只有几百 KB，不做 VACUUM。
- 写库遇到 `SQLITE_BUSY` / `SQLITE_LOCKED` 重试 3 次、退避 500ms（500/1000/1500），仍失败则退出码 1；
  输出只含行数、体积与耗时，不含任何日志内容或凭据。
- 归档口径与 API 一致：`log_type = 2` 且排除 `token_name = 'Model test'`；`channel_id` 为空的行归到渠道 0。
- 保留期按北京日界算：`day < 今天 − keep-days` 的整天归档，今天永远不动（还在增长）。
  每天一个事务：`logs_daily` 按 `(site, day, channel_id)` 覆盖式 UPSERT（重跑结果不变）并删除该天
  `logs` 的全部行；站点库为主库、看板库以 `archive` 附加，同事务提交。中途失败整天回滚，下次重跑自愈。
  `--dry-run` 不创建看板库、不写库、不删除。
- 归档后**无法再出**这段时间的小时粒度趋势、模型/端点/Token 维度、延迟分位数与缓存命中率。
  `/api/overview`、`/api/trend?granularity=day`、`/api/channels`、`/api/profit?granularity=day`
  （以及 `/api/upstreams` 的账户本地售出）会把归档并入，响应顶层多一个
  `archive: { from_day, to_day, days, available, partial_fields }`；`partial_fields` 列出归档给不出的字段，
  这些字段仍只覆盖明细窗口，整段只有归档的渠道行带 `archive_only: true`。
- 归档只并入「完整落在查询区间内」且「早于明细最早一天」的整天：边界日无法按日折算到小时，
  宁可少算也不与明细重复计数。

## 部署到服务器

### 前置

- **Node ≥ 22.13**（`node:sqlite` 从 22.13.0 / 23.4.0 起可用且不再需要 `--experimental-sqlite`；
  更早版本必须加该 flag 才能 `import 'node:sqlite'`），`node --version` 确认；
  建议直接用生产环境的 node 跑 `node --check v2/server.mjs` 验证一次。
- 项目根目录（下文以 `/opt/relay-ledger` 为例）结构：

  ```text
  relay-ledger/
  ├── v2/                       后端与采集代码
  ├── db/sites/<site>.db        站点库（采集只读，服务只读）
  ├── meta/site_token.txt       中转站管理员 PAT（名称含 site.id 的行）
  └── web/vendor/echarts.min.js 面板图表依赖（必须存在，否则图表空白）
  ```

  `v2/db/dashboard.db` 与 `logs/` 由程序/运维创建，不需要从仓库带过去。
- 权限：`v2/secrets/accounts.json` 与 `meta/site_token.txt` 必须 `chmod 600`，
  属主是运行采集/服务的用户；换签写回也按 `0600` 重写。不要把它们放进代码仓库。

  ```bash
  chmod 600 v2/secrets/accounts.json meta/site_token.txt
  ```

### 运行方式（二选一）

**A. 常驻 runner（推荐）**：一个进程管两个采集任务，余额对齐整点 +10 秒，站点日志每 1 小时。

```bash
node v2/jobs/run-scheduler.mjs                          # 余额每小时 + 站点日志每 1 小时
node v2/jobs/run-scheduler.mjs --no-logs                # 只采余额
node v2/jobs/run-scheduler.mjs --spend-interval-ms=1800000
```

systemd 示例：`v2/deploy/relay-collector.service`（`Restart=always`、`RestartSec=10`）。
复制到 `/etc/systemd/system/` 后改三处占位：`WorkingDirectory`/`ExecStart` 的目录、
`User`/`Group`、node 路径，再 `systemctl daemon-reload && systemctl enable --now relay-collector`。

**B. cron**：`v2/deploy/crontab.example`，两行分别每小时跑 `collect-spend.mjs`、
每小时跑 `collect-site-logs.mjs`（错开整点）。与 A **二选一**，同时启用会重复采集（数据幂等，但白费请求）。

站点日志默认 `--source=db`：直读 new-api 的本地 SQLite `/home/newapi/one-api.db`（只读、按 id 游标增量），
要求 new-api 与看板同机、运行用户能读该文件及 `-wal`/`-shm`；库文件不存在或打不开时自动回退 HTTP 导出。
跨机部署（或没有读库权限）用 `--source=http`，并保证 `meta/site_token.txt` 存在。
两种源写的是同一张 `logs` 表、同一套幂等口径，详见 `v2/jobs/collect-site-logs.md`。

两种方式都建议让 HTTP 面板单独起一个进程：

```bash
node v2/server.mjs --host=127.0.0.1 --port=8788
```

`--host=0.0.0.0` 只在内网或已有带鉴权的反向代理（Nginx/Caddy）后面使用——`v2/server.mjs` 本身没有登录；
公网访问请按「面板登录」一节在 nginx 上加 `auth_request`。

### 首次验证

```bash
node v2/jobs/run-scheduler.mjs --help      # 参数说明，不连网络
node v2/jobs/run-scheduler.mjs --once      # 各跑一次后退出：0 成功 / 1 失败
curl -s http://127.0.0.1:8788/api/healthz
curl -s http://127.0.0.1:8788/api/quality     # 看 jobs / 源库行数 / schema_ok
curl -s http://127.0.0.1:8788/api/upstreams   # 看余额与 last_job
```

`--once` 会连真实上游和站点库，首次用它确认凭据可用、站点日志回补完成，
之后交给常驻 runner 或 cron。

### 日志

- systemd：`journalctl -u relay-collector -f`；cron：重定向到 `logs/*.log`。
- runner 每轮一行：`[run-scheduler] collect-spend ok 348ms`；
  异常为 `[run-scheduler] collect-site-logs failed 1204ms: <message>`，只一行、不退出进程。
- 凭据、token、cookie、日志原文都不进输出；排查数据缺口看 `/api/quality` 的 `job_runs`
  （`collect-spend` 自己写，`skipped` 轮次不写）。

## 面板登录

面板前的登录不再用 nginx `auth_basic`（Basic Auth 在 Edge 里不会弹「保存密码」，也无法保持登录态），
改为独立的小服务 `v2/tools/panel-auth.mjs`（零依赖，只用 node 内置模块）+ nginx `auth_request`。

```text
浏览器 ──https──> nginx ──auth_request /verify──> panel-auth (127.0.0.1:8790)
                    │                                     │
                    └── proxy_pass ──> 面板 (127.0.0.1:8788)
```

### 凭据文件

程序只读文件，不自动生成、不打印内容：

| 环境变量 | 默认路径 | 内容 |
| --- | --- | --- |
| `PANEL_PASSWORD_FILE` | `/root/relay-ledger-panel-password` | 明文密码，读取后 `trim()` |
| `PANEL_SESSION_SECRET_FILE` | `/root/relay-ledger-session-secret` | HMAC 签名密钥，读取后 `trim()` |

`/root` 是 0700，systemd 里的运行用户读不到，所以 `v2/deploy/relay-auth.service` 用
`Environment=` 改到 `/etc/relay-ledger/`（`root:<运行用户>`，`0640`，目录 `0750`）：

```bash
sudo install -d -m 0750 -o root -g usage /etc/relay-ledger
printf '%s\n' '换成你的密码' | sudo tee /etc/relay-ledger/panel-password >/dev/null
head -c 32 /dev/urandom | base64 | sudo tee /etc/relay-ledger/session-secret >/dev/null
sudo chown root:usage /etc/relay-ledger/panel-password /etc/relay-ledger/session-secret
sudo chmod 640 /etc/relay-ledger/panel-password /etc/relay-ledger/session-secret
```

密钥文件不存在或为空时服务**直接退出**（不生成随机密钥）：否则每次重启密钥都变，
所有会话静默失效。换密钥等于让所有人重新登录。

### 运行

```bash
node v2/tools/panel-auth.mjs                 # 127.0.0.1:8790
node v2/tools/panel-auth.mjs --port=8791     # 或用 PORT 环境变量
PANEL_PASSWORD_FILE=/path/pw PANEL_SESSION_SECRET_FILE=/path/secret node v2/tools/panel-auth.mjs
```

systemd：`v2/deploy/relay-auth.service`（`Restart=always`，`SIGTERM` 后正常退出），
复制后改 `User`/`Group`、目录与 node 路径，再 `systemctl enable --now relay-auth`。

### nginx 接线

模板：`v2/deploy/nginx.conf.example`。核心是四个 location：

```nginx
location = /login  { proxy_pass http://127.0.0.1:8790; }                 # 公开：登录页 + 表单
location = /verify { internal; proxy_pass http://127.0.0.1:8790;
                     proxy_pass_request_body off;
                     proxy_set_header Content-Length "";
                     proxy_set_header Cookie $http_cookie; }             # 只给 auth_request
location = /logout { proxy_pass http://127.0.0.1:8790; }                 # 公开：清 Cookie
location / { auth_request /verify; error_page 401 = @login;
             proxy_pass http://127.0.0.1:8788; }                         # 面板本体
location @login { return 302 /login?next=$request_uri; }
```

`location = /login` 上**不要**加 `proxy_pass_request_body off`（POST 表单需要 body）；
`/verify` 上必须显式 `proxy_set_header Cookie $http_cookie;`，`auth_request` 子请求
默认不继承原请求头，不转发 Cookie 会永远 401、登录后立刻被打回登录页。

### Cookie 与签名

- 成功登录下发 `rl_session=<payload>.<sig>`，`payload` 是 base64url 的 `{"u":"admin","exp":<ms>}`，
  `sig` 是 `HMAC-SHA256(secret, payload)` 的 base64url；
  属性 `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`（30 天）。
- `/verify` 用 `timingSafeEqual` 比对签名，再检查 `u` 与 `exp`，有效回 `204`（无 body），否则 `401`。
- 登录页的 `<input type="password" autocomplete="current-password">` 与
  `autocomplete="username"` 是 Edge「保存密码」的前提；用户名预填 `admin`，可以保存。
- 密码用 SHA-256 定长摘要后 `timingSafeEqual` 比较；`next` 只接受 `/` 开头且非 `//` 的站内路径，
  其余回落到 `/`。
- 同一 IP 连续 5 次失败后锁 60 秒，锁定期内即使密码正确也返回 `429`（内存 Map，重启清零，
  按 `X-Real-IP` 区分，nginx 模板已设置该头）。
- 日志只有「登录成功 / 登录失败 / 登录限速」+ ISO 时间，不含密码、Cookie、密钥。

### 验证

```bash
node --test v2/test/panel-auth.test.mjs    # 纯函数与处理函数，不监听端口
curl -i http://127.0.0.1:8790/login        # 200 + 登录页
```

## 看板库

`v2/db/dashboard.db` 表：`upstream_account`、`balance_snapshot`、`credit_event`、`credit_window`、
`upstream_spend_daily`、`job_runs`、`schema_meta`。
写入前上游卡片显示 `unavailable`，`job_runs` 为空数组；`collect-spend` 跑过一轮后才有余额与入账数据。

写入约定（读取层不做任何换算与推断）：

- `balance_snapshot.balance` **必须已由采集器按账户 `unit` 归一**。newapi 返回的 `quota` 要先除以
  账户的 `quota_per_unit`（配置里默认 500000）再写入；原始值和原始单位写进 `raw_balance` / `raw_unit`，
  只用于核对。读取层不把 `quota` 当 USD，也不会二次换算。
- `credit_window` 记录一次区间入账核对结果（`account_id, window_start, window_end, credits, status, source`），
  `status='complete'` 表示该窗口的 `credits` 是确定值，**可以是 0**。它是核对凭据：
  `/api/upstreams` 与 `/api/profit` 的 `credits` 都直接汇总 `credit_event`（含 `source='balance_delta'`
  的推断充值），不再要求窗口覆盖查询区间，因此以「现在」为终点的区间也能算出成本。
  采集器每轮仍写昨日完整日窗口，今日窗口随采集推进（同一天只保留最新一条）。
- 余额快照与区间边界的偏差不得超过 `SNAPSHOT_BOUNDARY_TOLERANCE_MS`（5 分钟，允许略晚于边界：
  采集在整点 +10s 落库）。`/api/upstreams` 与 `/api/profit` 同一口径，超差即视为该边界没有快照，
  成本返回 null 而不是拿相邻时点顶替；只有「终点就在此刻」的区间，期末才退一步取最近一条（≤ 90 分钟）。

## 验证

```bash
node --test v2/test/*.test.mjs
node v2/server.mjs --port=8791
curl.exe -s "http://127.0.0.1:8791/api/upstreams"
curl.exe -s "http://127.0.0.1:8791/api/profit?granularity=day"
curl.exe -s "http://127.0.0.1:8791/api/quality"
```

## 已知限制

- 不拉上游逐条 usage，不做逐条配对、缺口分析、可比窗口。
- 上游余额/充值没有数据时不显示 0，也不造演示值；`complete` 只在数据齐全且区间完整时出现。
- 账户级 `local_revenue` 按配置渠道求和；若两个账户共用渠道，该渠道收入会在两个账户各计一次，仅作账户级参考。
- `upstream_spend_daily` 只存按北京自然日汇总的上报消费；`reported_spend_range` 只覆盖已采集到的日期，
  历史日期没有采集过时为 `null`。
- `/api/profit` 的账户收入按「渠道归第一个配置账户」分配，与 `/api/upstreams` 的账户级
  `local_revenue`（共用渠道会重复计）口径不同；站点盈利以不重复计算的这套为准。
- `/api/profit` 区间合计只在所有桶都能算出成本时给值，任一桶缺快照或成本为负则合计为 `null`
  （状态 `missing_balance` / `partial`），以保证合计与序列一致，不用 0 补洞。
- sub2api 没有充值流水接口，账户级 `credits` 只来自 `balance_delta` 推断（余额上涨且无对应上游
  事件时补记一笔）；没有推断事件时为 0，此时无法区分「确认零入账」与「上游确实没有该能力」。
- 换签写回只发生在 `v2/secrets/accounts.json`（`writable=true`）；回退到 `config/upstreams.json` 时不写回。
- NewAPI 换签依赖 Cookie；没有 cookie 又没有 refresh_token 时只能手工更新，失败标
  `missing_cookie` / `auth_failed`，不做密码登录回退。
- 换签写回是「读-改-写 + rename」，写前会比对基线凭据，期间被其他进程改过就放弃写回
  （`write_conflict`）；比对到 rename 之间仍有极窄窗口，建议单实例采集。
- 以 WAL 模式打开源库的只读连接时，SQLite 会更新 `-shm` 的修改时间（共享内存索引，非数据库内容）；
  站点库文件本身与 `-wal` 不会被写入。

## sub2api 的真实充值额（total_recharged）

`GET /api/v1/auth/me` 会返回 `total_recharged`（累计充值总额）。采集时写入 `balance_snapshot.total_recharged`；
`/api/profit` 与 `/api/upstreams` 在两端快照都带该字段时，直接用差值作为充值额，不再用「余额上涨」推断——
这样同一小时内的充值与消费不会互相抵消，成本不会被算成 0。没有该字段的上游（newapi）仍走 `credit_event` 汇总；
`recordInferredCredits` 在两端都有累计值时跳过推断，避免同一笔充值被记两遍。

New API 侧同样有累计充值：`GET /api/user/self` 的 `data.quota + data.used_quota`（剩余 + 已用）除以 `quota_per_unit`
就是该账户的累计充值总额（cc-switch 的 NewAPI 模板用同一算法）。适配器把它作为 `recharged` 返回，采集器写入
`balance_snapshot.total_recharged`，因此 newapi 账户也优先用累计值差额算充值；只有两端都不带累计值时才回退到余额差推断。
