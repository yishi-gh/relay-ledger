# v2 接口契约

## 范围与数据源

- 面板以只读连接读取本地站点日志副本 `db/sites/<site>.db`，并读写看板库 `v2/db/dashboard.db`；不写中转站业务库、不改渠道状态。账户凭据不进入 API 响应、日志或 `job_runs`。
- 采集器直读中转站业务库（如 `one-api.db`）时只读打开。本地日志副本不存在且没有可回退业务库时，服务启动会按日志表结构创建空副本库并告警，只写这份本地副本；有业务库时直接只读打开。
- 面板业务 API 不访问上游。唯一例外是 `/api/site-logo`：它只从配置或路由快照解析出的来源 origin 获取图标，规则见 [SITE-LOGOS.md](../docs/SITE-LOGOS.md)。
- 根路径发布 `frontend/dist` 新版页面；旧 `v2/web` 源码暂留，不作为默认入口。

数字口径以 [METRICS.md](../docs/METRICS.md) 为唯一权威，设计约束见 [DESIGN.md](../docs/DESIGN.md)。本文只固定接口语义、参数、缓存与错误，不重复推导公式。

## 通用约定

- 所有只读接口同时接受 `GET` 与 `HEAD`；`HEAD` 返回与 `GET` 相同的状态码和响应头，正文为空。
- 时间参数 `from` / `to` 为整数毫秒时间戳，显式传入时必须成对且均非空；单边、空值、非整数或 `from > to` 返回 400。两者均缺省时以站点日志副本 `MAX(t_ms) WHERE log_type = 2` 为终点，向前 7 个北京自然日；源库为空时退回当前时刻向前 7 天。
- 分页参数为整数；`page` 最小 1，`page_size` 范围 1..200，超过 200 收敛为 200。
- API 错误响应统一为 `{"error":{"code":"...","message":"..."}}`。参数错误为 400，未知接口为 404，方法不允许为 405，服务端异常为 500；静态文件的 404 / 503 为纯文本。
- 业务 JSON 响应统一 `Cache-Control: no-store`；站点图标的 404 JSON 是例外，使用 6 小时私有负缓存。业务接口成功响应可带 `X-Cache: HIT|MISS`；未知接口和普通错误响应不缓存。
- `API_ROUTES` 中的业务接口响应有进程内缓存：key 为完整路径、查询串与渠道归属快照版本，默认 TTL 60 秒、最多 200 条，`API_CACHE_TTL_MS=0` 可关闭；`/api/healthz` 不缓存。设置 PATCH 成功后会清空缓存；设置、服务状态与站点图标不经过这张缓存表。

## 端点索引

以下共 19 个路径，覆盖 `v2/server.mjs` 的 16 个 `API_ROUTES` 与 3 个独立处理路径。

| # | 方法与路径 | 说明 |
| --- | --- | --- |
| 1 | `GET/HEAD /api/meta` | 字段含 `site`、`source`、`min_t`、`max_t`、`rows`、`currency`、`quota_per_unit`、`site_name`、`base_url`；不含 `preview` 字段 |
| 2 | `GET/HEAD /api/overview?from=&to=` | 收入、配额、请求、token、缓存率、延迟、上游成本与毛利 |
| 3 | `GET/HEAD /api/trend?from=&to=&granularity=day\|hour` | 北京时间的收入 / 请求趋势；缺省 `day` |
| 4 | `GET/HEAD /api/profit?from=&to=&granularity=day\|hour` | 账户盈利、渠道售出、未映射渠道与数据质量；缺省 `day` |
| 5 | `GET/HEAD /api/channels?from=&to=` | 渠道聚合：售出、token、TPS、缓存率、延迟分位、归属与 `top_model` |
| 6 | `GET/HEAD /api/groups?from=&to=` | 分组聚合：渠道数、售出、token、请求、缓存率、延迟与 `top_model` |
| 7 | `GET/HEAD /api/users?from=&to=` | 用户聚合：售出、token、请求与占比 |
| 8 | `GET/HEAD /api/models?from=&to=` | 模型聚合：售出、请求、token、占比、额度/亿 Token 与上游账户 |
| 9 | `GET/HEAD /api/capital?from=&to=` | 账户余额、区间成本 / 充值、7 日日均与续航 |
| 10 | `GET/HEAD /api/upstreams?from=&to=` | 账户级账本：期初 / 期末余额、credits、consumption、毛利 |
| 11 | `GET/HEAD /api/quality` | 源库最后时间、行数、任务记录、采集错误、缺快照账户与 schema 状态 |
| 12 | `GET/HEAD /api/errors?from=&to=` | nginx 4xx/5xx 按北京整点分桶、状态码 Top 8、路径组 Top 6；区间上限 31 天 |
| 13 | `GET/HEAD /api/status?from=&to=&level=channel\|group&bucket=15m\|1h` | 渠道或分组健康；缺省 `level=channel`，桶宽按区间跨度选择 |
| 14 | `GET/HEAD /api/routes` | 渠道路由与归属快照、abilities、最近 1 小时健康；只读看板库与源库 |
| 15 | `GET/HEAD /api/rows?from=&to=&page=&page_size=` | 逐条明细，按 `t_ms DESC`；`page_size` 超限收敛到 200 |
| 16 | `GET/HEAD /api/healthz` | 存活检查，返回 `{"ok":true}` |
| 17 | `GET/HEAD/PATCH /api/settings` | 运行时设置读取与更新；字段、校验区间与采集器状态见 [SETTINGS.md](../docs/SETTINGS.md) |
| 18 | `GET/HEAD /api/services` | 采集服务健康时序；支持 `range=24h\|7d` 或成对 `from`/`to` |
| 19 | `GET/HEAD /api/site-logo` | 站点 / 渠道 / 账户图标；`kind=channel\|account\|site`，`id` 按类型校验，`v` 只接受 2 |

各业务接口的响应字段、推导规则与归档并入行为见 [v2/README.md](./README.md#api)；本文只补充跨接口语义与独立端点。

## 端点语义补充

### `/api/settings`

- `GET` / `HEAD` 只读，不创建文件、不触发任务；设置文件损坏时返回 500，不静默回退。
- `PATCH` 请求体为 `{settings, revision}`，必须是完整三组 `monitoring` / `collection` / `health`；`display` / `refresh` 只经 GET 的 `defaults` 下发，不接受写入。
- 请求必须为 `application/json`，否则 415；正文上限 16 KiB，否则 413；`Origin` 必须与请求 `Host` 及协议同源，否则 403；不开放 CORS。
- `revision` 不匹配返回 409，需重新 GET 后重试；字段缺失、未知字段、类型或范围错误返回 400；POST / PUT / DELETE 等返回 405。
- 成功后返回与 GET 相同的结构，并立即清空 API 缓存，使 `/api/status` 按新的 `health` 规则分类。

字段清单、精确区间与采集器心跳语义以 [SETTINGS.md](../docs/SETTINGS.md) 为准。

### `/api/services`

- 查询参数只接受 `range`、`from`、`to`。缺省 `range=24h`，也可取 `7d`；`from`/`to` 必须成对提供且不能与 `range` 同时出现，`from < to`，跨度不超过 31 天。
- 响应为 `{generated_at, from, to, bucket_ms, collector, services[]}`。`services[]` 每项含 `id`、`label`、`enabled`、`interval_minutes`、`state`、`reason`、最近运行时间与状态，以及按桶统计的 `runs` / `failures` / `partial`。
- 设置文件损坏返回 500；采集器心跳损坏降级为 `collector.state=unconfirmed` 并带 `collector.error`。

### `/api/site-logo`

- 成功返回图片二进制，`Cache-Control: private, max-age=86400`，并带 `X-Content-Type-Options: nosniff` 与沙箱 CSP。
- `kind` 只接受 `channel` / `account` / `site`；`channel` 的 `id` 为 1..12 位数字，`account` 的 `id` 为 1..128 位安全字符，`site` 的 `id` 固定为 `current`。`v` 缺省兼容旧 URL，出现时只接受 `2`。
- 参数不支持或形态非法返回 400；没有可用图标返回 404 JSON，缓存 6 小时；图标服务未启用返回 503。上游抓取、DNS / 重定向限制、SVG 校验与缓存生命周期见 [SITE-LOGOS.md](../docs/SITE-LOGOS.md)。

### `/api/routes`

- 只读取看板库中的路由快照与源库日志，不调用上游接口。
- 顶层含快照可用性、同步时间、错误、`channels`、`accounts`、`abilities` 与 `near_1h`。渠道项含 `id`、`name`、`status`、`state`、`endpoint`、`account_ids`、`owner_source`、`owner_candidates`、`model_mapping`、`mapping_error`；账户项含 `id`、`name`、`website`、`channel_ids`、`auto_channels`。
- `near_1h` 使用最近 1 小时日志与 `upstream_error` 聚合，返回每渠道请求数、错误数、尝试数、可用率与状态，以及当前 `health` 阈值。

### `/api/status`

- `level` 只接受 `channel` / `group`；`bucket` 只接受 `15m` / `1h`。缺省按区间跨度选择：不超过 36 小时用 `15m`，否则 `1h`；响应顶层带实际使用的 `bucket`。
- 只保留启用渠道；`channel_state` 为空（首次部署、首轮采集前）时退化为不过滤。分桶状态与可用率口径见 [v2/README.md](./README.md#api)。

## 静态发布

| 请求 | 行为 |
| --- | --- |
| `/`、`/index.html` | 返回 `frontend/dist/index.html`，`Cache-Control: no-cache` |
| `/assets/*-<hash>.js`、`.css`、字体、图片 | 返回构建文件；匹配 Vite 内容 hash 时 `public, max-age=31536000, immutable` |
| 其它实际存在的构建文件 | 返回 `frontend/dist` 下文件；HTML 与无 hash 的 JS / CSS 为 `no-cache`，其余 `max-age=300` |
| 未知路径 | 404 文本，不做 SPA 回退 |
| `/` 或 `/index.html` 缺少构建入口 | 503 文本，提示执行 `npm --prefix frontend ci` 与 `npm --prefix frontend run build`；API 仍可用 |
| 旧 `/vendor/...`、`/vendor-tabler.css` | 404，旧静态依赖路由已移除 |

静态路径先 `decodeURIComponent` 再解析；越界、包含反斜杠或 NUL、非法编码返回 400 `bad_path`。非 GET / HEAD 的静态请求返回 405。

## 字段与口径文档

| 文档 | 内容 |
| --- | --- |
| [v2/README.md](./README.md#api) | 各业务接口响应字段、归档并入、渠道过滤与账本状态 |
| [SETTINGS.md](../docs/SETTINGS.md) | 运行时设置字段、校验区间、采集器状态与反向代理要求 |
| [SITE-LOGOS.md](../docs/SITE-LOGOS.md) | 图标发现顺序、抓取安全限制、格式与缓存 |
| [METRICS.md](../docs/METRICS.md) | 售出、充值、成本、利润、毛利率的唯一统计口径 |
| [DESIGN.md](../docs/DESIGN.md) | 只读边界、数据流与设计约束 |

## 不做

- 不拉上游逐条 usage 日志，不做逐条配对、缺口五分、可比窗口。
- 不把 quota 当现金收入；页面同时显示 USD 与配额。
- 不在缺失数据时伪造上游余额或充值；缺失值返回 `null`，不写 0。
- 不通过面板 API 写中转站业务库、改渠道状态或修改上游配置。
