# v2 本地预览契约

## 范围

- 只读 `db/sites/<site>.db`（中转站日志库副本），不连接上游、不读取 `meta/credentials.json`、不写旧库。
- 新看板独立运行在 `127.0.0.1:8788`，旧看板保持原样。
- 上游账户账本没有数据时显示 `unconfigured`/`unavailable`，不写 0，不造演示数字。

## 本站收入口径

- 数据源：`logs` 表。
- 只统计 `log_type = 2`，排除 `token_name = 'Model test'`。
- 本站售出金额：`SUM(cost)`，单位 USD。
- 配额：`SUM(quota_raw)`。
- 请求数：`COUNT(*)`。
- 缓存率：`SUM(cache_read) / (SUM(cache_read) + SUM(input_uncached))`；分母为 0 时返回 `null`。
- 延迟：`latency_ms` 非空值的 p50 / p95；样本为 0 时返回 `null`。
- 时间桶：北京时间（UTC+8）整点/自然日。
- 默认范围：以中转站日志库 `MAX(t_ms)` 为终点，向前 7 个自然日；不是以当前时刻为终点。

## 上游账户账本

按上游账户、按北京时间自然日：

```text
consumption = opening_balance + credits - closing_balance
margin = local_revenue - consumption
margin_pct = margin / local_revenue
```

- `credits` 包含充值、系统赠额、退款等余额增加项，分列存储。
- `status`：
  - `complete`：期初/期末余额、credits 完整，且自然日已结束。
  - `partial`：余额齐全但 credits 缺失，或当日未结束。
  - `unavailable`：没有余额快照。
  - `unconfigured`：没有配置上游账户。
- 缺失值一律返回 `null`，不返回 0。
- 共享上游账户只做账户级毛利；本地渠道级只在 1:1 映射时给值，否则 `unallocated`。

## API

所有时间参数为毫秒时间戳 `from`/`to`，缺省用默认范围。

### `GET /api/meta`

```json
{
  "site": "relay",
  "source": "db/sites/relay.db",
  "min_t": 0,
  "max_t": 0,
  "rows": 0,
  "currency": "USD",
  "quota_per_unit": 500000,
  "preview": true
}
```

### `GET /api/overview?from=&to=`

```json
{
  "range": { "from": 0, "to": 0 },
  "revenue": 0,
  "quota": 0,
  "requests": 0,
  "tokens": {
    "input_total": 0,
    "input_uncached": 0,
    "cache_read": 0,
    "cache_write": 0,
    "output": 0
  },
  "cache_rate": null,
  "latency": { "p50": null, "p95": null, "count": 0 },
  "upstream_cost": null,
  "margin": null,
  "margin_status": "unconfigured"
}
```

### `GET /api/trend?from=&to=&granularity=day|hour`

```json
{
  "granularity": "day",
  "points": [
    { "bucket": "2026-10-20", "revenue": 0, "quota": 0, "requests": 0 }
  ]
}
```

### `GET /api/channels?from=&to=`

```json
{
  "rows": [
    {
      "channel_id": 13,
      "channel_name": "国模 | 渠道一",
      "revenue": 0,
      "quota": 0,
      "requests": 0,
      "cache_rate": null,
      "latency_p50": null,
      "latency_p95": null,
      "last_t": 0,
      "upstream_account": "upstream-a",
      "margin_status": "unallocated"
    }
  ]
}
```

### `GET /api/upstreams?from=&to=`

```json
{
  "accounts": [
    {
      "id": "upstream-a",
      "name": "Example Upstream A",
      "kind": "sub2api",
      "base_url": "https://upstream-a.example.com",
      "status": "unconfigured",
      "opening_balance": null,
      "closing_balance": null,
      "credits": null,
      "consumption": null,
      "unit": "USD",
      "local_revenue": 0,
      "margin": null,
      "margin_pct": null,
      "channels": [13, 14, 15]
    }
  ]
}
```

### `GET /api/quality`

```json
{
  "source_last_t": 0,
  "source_rows": 0,
  "error_rows": 0,
  "job_runs": [],
  "schema_ok": true,
  "checked_at": 0
}
```

### `GET /api/rows?from=&to=&page=1&page_size=50`

```json
{
  "total": 0,
  "page": 1,
  "page_size": 50,
  "rows": [
    {
      "t_ms": 0,
      "t_local": "2026-10-20 12:00:00",
      "channel_name": "",
      "model": "",
      "token_name": "",
      "cost": 0,
      "quota_raw": 0,
      "input_total": 0,
      "output": 0,
      "cache_read": 0,
      "latency_ms": null,
      "first_token_ms": null
    }
  ]
}
```

### `GET /api/healthz`

```json
{ "ok": true }
```

## 静态文件

- `/` -> `v2/web/index.html`
- `/styles.css` -> `v2/web/styles.css`
- `/app.js` -> `v2/web/app.js`
- `/vendor/echarts.min.js` -> `web/vendor/echarts.min.js`（只读复用，不复制）

## 不做

- 不拉上游逐条 usage 日志。
- 不做逐条配对、缺口五分、可比窗口。
- 不把 quota 当现金收入；页面同时显示 USD 与配额。
- 不在本地预览中伪造上游余额或充值。
