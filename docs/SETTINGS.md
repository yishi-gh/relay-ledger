# 运行时设置（服务端部分）

面向 `v2` 后端：哪些设置落在服务端、接口契约、校验范围与采集器状态。前端本地偏好（display / refresh）不在本文作用域内。

## 生效作用域

| 组 | 归属 | 生效点 |
|---|---|---|
| `monitoring` | 服务端 | 前端阈值展示；`health` 之外的告警渲染口径 |
| `collection` | 服务端 | `v2/jobs/run-scheduler.mjs` 的余额 / 日志采集间隔 |
| `health` | 服务端 | `/api/status` 的 `state` 分类（`minSamples`、`failErrorRate`） |
| `display` / `refresh` | 前端本地 | 不落盘、不接受 PATCH；仅经 GET 的 `defaults` 下发 |

服务端三组持久化在 `<dataDir>/runtime-settings.json`（默认 `data/runtime-settings.json`），权限 0600，写入用同目录临时文件 + rename，不写 instance、不写 DB、不存任何凭据。

## GET /api/settings

`GET` 返回 JSON 正文；`HEAD` 只返回头部、正文为空。两者均为 `Cache-Control: no-store`：

```json
{
  "settings": { "monitoring": {}, "collection": {}, "health": {} },
  "defaults": { "display": {}, "refresh": {}, "monitoring": {}, "collection": {}, "health": {} },
  "revision": "<三组配置的稳定 SHA-256>",
  "collector": {
    "state": "active | stale | unconfirmed",
    "observedRevision": "string|null",
    "updatedAt": 0,
    "effective": { "logsMinutes": 15, "spendMinutes": 15 },
    "overrides": { "logs": false, "spend": false },
    "logsEnabled": true,
    "error": "可选，仅心跳文件不可读时出现"
  }
}
```

- GET 只读，不创建文件、不触发任务。
- `defaults.collection` 取部署值 `INSTANCE.collect.logsIntervalMs/60000`、`spendIntervalMs/60000`，可以是小数（例如 30000ms → 0.5）。「恢复默认」应回填该值，不要硬编码 15 分钟。
- `runtime-settings.json` 不存在时全部取默认值；存在但非法 JSON / 字段非法时直接报错（GET 返回 500），不静默回退默认。

## PATCH /api/settings

```json
{ "settings": { "monitoring": {}, "collection": {}, "health": {} }, "revision": "<GET 返回值>" }
```

- `settings` 必须是完整三组对象：缺字段、未知字段、`display`/`refresh`、NaN、字符串数字一律 400。
- `revision` 不匹配返回 409，需重新 GET 后重试。
- 成功后返回与 GET 相同的结构，并清空 API 缓存，使 `/api/status` 立即按新 `health` 规则分类。
- 请求约束：`Content-Type: application/json`（否则 415）、正文 ≤ 16 KiB（否则 413）、`Origin` 必须与请求 `Host` 同源（否则 403；仅 loopback 反代传来的 `X-Forwarded-Proto` 可信）。不开放 CORS。
- 其它方法（POST/PUT/DELETE 等）返回 405；只有 `/api/settings` 接受 PATCH。

## 校验范围

| 字段 | 类型 | 约束 |
|---|---|---|
| `monitoring.cacheRate.good` / `warn` | 小数 | `0 ≤ warn < good ≤ 1` |
| `monitoring.latencyP50.goodMs` / `warnMs` | 整数毫秒 | `0 < goodMs < warnMs ≤ 3600000` |
| `monitoring.latencyP95.goodMs` / `warnMs` | 整数毫秒 | `0 < goodMs < warnMs ≤ 3600000` |
| `monitoring.runway.dangerDays` / `warnDays` | 小数天 | `0 < danger < warn ≤ 3650` |
| `monitoring.freshness.warnMinutes` / `dangerMinutes` | 小数分钟 | `0 < warn < danger ≤ 10080` |
| `collection.logsMinutes` / `spendMinutes` | 整数分钟 | 修改时 `1..1440`；仅与部署默认值完全一致的小数（如 0.5）放行 |
| `health.minSamples` | 整数 | `1..1000000` |
| `health.failErrorRate` | 小数 | `0 < x ≤ 1` |

跨字段一律严格小于，相等即拒绝。错误响应为 `{ "error": { "code", "message" } }`，`message` 为中文且指明字段。

## 采集器状态

`<dataDir>/collector-settings-status.json` 由调度器写入（心跳 30 秒一次），本模块只负责读写：

- 无文件 → `unconfirmed`（从未上报过）。
- 心跳在 90 秒内 → `active`；超过 90 秒 → `stale`。`state` 只表达心跳鲜度，不掺入配置是否已采用。
- 是否已采用最新配置由 `observedRevision` 单独表达：它与当前 `revision` 不同即表示「待采用」，前端据此显示 pending；刚保存后心跳还没回来时，状态仍是 `active`，不会被误报成「超过 90 秒未上报」。
- 未来时间戳只在同一量级（≤ 90 秒）内被容忍为时钟偏移，不会永久 `active`。
- 心跳文件损坏时，GET/PATCH 仍返回 200：`collector.state` 为 `unconfirmed`、各字段为空值，并带 `collector.error`（string）说明原因；不会静默当成正常。设置文件本身损坏仍然 500。
- `effective` 记录实际生效间隔（CLI 覆盖时可能是 0.5 这类小数分钟）；`overrides` 标明哪些间隔被 CLI 显式覆盖；`logsEnabled` 反映日志采集是否开启。

## 调度优先级与心跳

- CLI 显式传入 `--spend-interval-ms=` / `--logs-interval-ms=` 时优先于 `settings.collection`；未传时使用设置值。
- 调度器每 2 秒轮询一次 `runtime-settings.json`（`fs.watchFile`），配置变化后按新间隔重排采集循环并立即写一次状态。
- 心跳每 30 秒重写一次 `collector-settings-status.json`，把实际生效的 `effective`、CLI `overrides` 与已采用的 `observedRevision` 上报给面板。
- 采集循环按固定 Unix 时间网格 `n × 间隔 + 偏移` 对齐（余额偏移 10 秒，日志偏移 45 秒），不因读设置而重建任务，也不会为任意间隔额外补采北京整点或零点。

## 采集与成本口径（运维提示）

- 余额快照由 `collect-spend` 按 `settings.collection.spendMinutes` 采集，默认取实例配置（通常 15 分钟）。
- 成本按每个桶的起止边界快照差值计算：`期初余额 + 区间充值 - 期末余额`，边界快照允许 ±5 分钟容差；日粒度使用北京日界快照。
- 较长或不能整除 60 分钟的周期，可能缺少核算边界前后 5 分钟内的快照。例如 45 分钟周期可能无法覆盖完整小时，但非约数并不必然缺失边界。缺少边界时，该桶成本为 `null`，账户状态为 `missing_balance`，成本合计随之为 `null`；系统**不会插值或自动补值**。
- 用 `quality.hours_without_snapshot` 与账户的 `covered_buckets` / `bucket_count` 定位缺口；调整 `spendMinutes` 可能改变小时及日边界的覆盖，应按实际快照核对，不能只按周期长短推断。

## 反向代理与端口

- 写接口校验 `Origin` 与请求 `Host` 同源。反向代理在非标准端口时必须 `proxy_set_header Host $http_host;` 以保留端口，否则 PATCH 会返回 403。
- 标准 443 端口浏览器默认省略端口，无需额外配置；本仓库不改 nginx 配置。
