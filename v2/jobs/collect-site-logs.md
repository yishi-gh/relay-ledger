# collect-site-logs：本站渠道日志采集

把中转站自己的消耗记录写进日志库 `db/sites/<site>.db` 的 `logs` 表。v2 看板只读这个库，
跑完一轮即可在 `/api/meta`、`/api/rows`、`/api/quality` 里看到新数据。

两种采集源（`--source`）：

| 源 | 默认 | 数据来源 | 适用场景 |
| --- | --- | --- | --- |
| `db` | 是 | 直读 new-api 的本地 SQLite `/home/newapi/one-api.db`（WAL） | 中转站与看板**同机**，collector 有读权限 |
| `http` | | 管理员日志导出端点 `GET {base}/api/log/export` | 跨机部署、没有读库权限、直读打不开时的回退 |

`db` 的库文件不存在或打不开时自动回退 `http`，只打一行提示，本轮退出码按 HTTP 结果。
HTTP 通道仍完整保留，跨机部署直接 `--source=http` 即可。

入库口径（37 列、`req_id` 去重、`ck` 内容指纹）来自 v1 `tools/fetch-creds.mjs` 的导出通道 + `tools/db.mjs --ingest`，在 v2 内是一份独立拷贝（不 import v1，也不读 v1 的配置）。
直读源把 `logs` 表一行映射成「导出 NDJSON 同形对象」后复用同一套归一化，两条通道落库结果一致。

## 用法

```bash
node v2/jobs/collect-site-logs.mjs                       # 增量：直读站点库（默认）
node v2/jobs/collect-site-logs.mjs --dry-run             # 只读取与统计，不写库
node v2/jobs/collect-site-logs.mjs --source=http         # 走 HTTP 导出端点
node v2/jobs/collect-site-logs.mjs --since=2026-10-19T12:31:00   # 空库回补到指定起点（北京时间）
node v2/jobs/collect-site-logs.mjs --db-file=/data/one-api.db    # 源库不在默认位置
node v2/jobs/collect-site-logs.mjs --help
```

| 参数 | 说明 |
| --- | --- |
| `--source=<db\|http>` | 采集源，默认 `db`；`http` 为原来的导出端点通道 |
| `--db-file=<path>` | 直读的源库文件，默认 `/home/newapi/one-api.db`；不存在或打不开时回退 `http` |
| `--days=<n>` | 空库时的回看天数，默认 3。库内已有日志时忽略：直读窗口是「最后一条 `t_ms` 往前 60s」 |
| `--chunk-days=<n>` | HTTP 分片长度（天，支持小数），默认 1；`0` 或负数 = 不分片、单请求。直读不分片 |
| `--timeout-ms=<n>` | HTTP 单次请求超时毫秒，默认 `300000`（300s）。直读不使用 |
| `--since=<time>` | 覆盖窗口起点（回补）：ISO8601 或 13 位毫秒时间戳，必须早于当前时间。**直读时只在空库生效** |
| `--dry-run` | 真实读取、解析与逐页去重统计，但不 INSERT；以只读方式打开站点库 |
| `--help` | 打印用法 |

`--since` 无时区的写法按北京时间解释：`2026-10-19T12:31:00` 等价于
`2026-10-19T12:31:00+08:00`；也接受 `2026-10-19`（当天 00:00）与
`1792989060000`（13 位毫秒）。带 `Z` / 偏移的按原偏移解析。

退出码：`0` 成功（含窗口内无新数据）；`1` 参数错误、令牌缺失（仅 `http`）、HTTP 失败、
接口 `success:false`、读库/写库错误。HTTP 分片失败时已入库的分片保留，错误信息写明
「第 N/M 段 + 时间范围 + 已插入行数」，后续分片不再请求。

## 两种采集源

### db（默认）：直读站点 SQLite

前提是站点 new-api 与看板在**同一台服务器**，且 collector 进程对源库有读权限
（`/home/newapi/one-api.db` 及其 `-wal` / `-shm`；实测 root 运行、165 MB WAL 库只读打开 1 ms）。

- 打开方式：`node:sqlite` 的 `DatabaseSync(file, { readOnly: true })` + `PRAGMA busy_timeout=3000`。
  WAL 下只读连接不阻塞 new-api 写入，也不改表结构、不建索引。
- 水位：读本地站点库的 `MAX(t_ms)`，`anchorSec = floor((lastT - 60s) / 1000)`；再取
  `created_at >= anchorSec` 的最小 id 行定位起点（取不到从 0 开始）。这一行若早于水位，
  说明已在库里、游标直接跳过；若是流量空档后的第一条新行，则游标退一行把它拉进来。
  60s 回看吸收秒级取整与边界写入。
- 增量：按 **id 游标**分页，`SELECT * FROM logs WHERE id > ? AND type = 2 ORDER BY id LIMIT 2000`，
  翻到某页不足 2000 行为止；每页立即幂等入库，不把整表堆在内存。走 `id` 主键（INTEGER PRIMARY KEY）
  的范围扫描，实测 165 MB 库取 1,997 行约 8 ms（HTTP 导出同量数据要秒级）。
- 空库：按 `--since` / `--days` 换算 `anchorSec`；`--since` 只在空库生效，已有水位时忽略
  （要更早回补可先用 `--source=http --since=...`）。
- 回退：**只有打不开源库**（文件不存在、不是 SQLite、没有 `logs` 表）才打一行
  `[collect-site-logs] 直读失败，回退 HTTP 导出：<原因>` 并走 HTTP，本轮退出码按 HTTP 结果。
- 不回退：打开成功后的读库错误（锁超时、`schema` 变化、缺列、写本地库失败）直接抛错、退出码 1，
  错误信息脱敏并带「第 N 页 + 已插入行数」。同一轮不混用两种源，避免计数与去重口径混乱。
- 只读连接不要求 PAT；PAT 只在回退 `http` 时使用，缺失会在回退后按 HTTP 路径报错。

### http：导出端点

跨机部署或没有读库权限时用 `--source=http`（也是直读回退时的通道），细节见下节。

## 实测量级与默认值

直读（2026-11-02，本机实测，未打印凭据）：

| 项 | 数值 |
| --- | --- |
| 源库 | `/home/newapi/one-api.db`，165 MB，WAL |
| `logs` 行数 | 88,089（id 1..88089 连续单调） |
| `WHERE id > ? AND type = 2` 取 1,997 行 | 约 8 ms |
| 只读打开 | 约 1 ms |

HTTP 导出实测（2026-11，未打印凭据）：

| 窗口 | 行数 | 响应大小 | 说明 |
| --- | --- | --- | --- |
| 1 小时 | 127 行 | 243 KB | 3.5s |
| 1 天 | ≈ 7,500 行 | ≈ 10 MB | |
| 3 天 | 17,690 行 | 31.6 MB | 首次冷启动 72.6s，第二次 16.8s |

- 单次请求超时默认 **300s**：60s 会在冷启动时被 abort（报「读取响应失败」）。
- 导出请求按 **1 天**分片：首轮回补约 7 天（水位 7 天 + 30 分钟重叠），不分片会变成几十 MB
  的单次缓冲，因此默认 7 个左右小请求，每片拉完立即入库。
- 分页端点上限 `page_size=100`（传更大也只回 100 条），仅在导出端点不可用时使用。

## 请求与窗口（HTTP）

- 主通道：`GET {base}/api/log/export?start_timestamp=<秒>&end_timestamp=<秒>&type=2`，响应是
  NDJSON（一行一条日志，末行是 `{"success":true,"data":{"count":N}}` 结果对象，丢弃）。
  导出端点确实按 `start_timestamp` 过滤，不会返回窗口外历史。
- 分片：窗口 `[since, now)` 按 `--chunk-days` 切成首尾相接、互不重叠的顺序小片，每片单独
  构造 URL 并单独请求；单片失败不影响已入库的前序分片。
- 回退：某片导出返回 404/405 时，该片改走
  `GET {base}/api/log/?p=<页>&page_size=100&type=2&start_timestamp=<秒>&end_timestamp=<秒>`，
  翻到末页（本页不足一页或覆盖 `total`）为止；一旦判定为分页，整轮后续分片都直接走分页。
  上限 400 页/片，触顶会在报告里标「已截断」。
- 增量窗口：`MAX(t_ms) - 30 分钟`。留重叠是因为服务端按 `created_at` 倒序分页，窗口起点所在的页
  边界会漏行；重叠部分靠 `req_id` 去重吸收。空库时取「当前时间往前 `--days` 天」；`--since` 直接覆盖起点。
- 只收 `type=2`（消耗）日志；`type=1/4` 等非消耗记录跳过并计入报告（直读在 SQL 里就过滤掉）。
- 行时间落在分片窗口外的（例如分页端点忽略 `end_timestamp`）在客户端裁掉，不会重复入相邻片。
- 请求间隔 ≥1000ms；不读环境变量代理、不使用 curl，直接 `fetch`。
- 失败可见：HTTP 401/403/429/5xx 与 `success:false` 都会写明状态码和脱敏 message 到 stderr。

## PAT 位置（HTTP 源）

`meta/site_token.txt`，每行 `名称：值`（中文全角冒号），取名称**含** `site.id` 的
首个非空行。PAT 只进 `Authorization: Bearer` 请求头：

- 不进 stdout/stderr、不写日志、不进 `raw_json`；
- 接口返回的 `success:false` message 会先抹掉 PAT 与 `sk-` 串再输出（最多 300 字）；
- 文件本身不要提交到仓库。

## 入库与幂等

- 表结构以现有 `logs` 表为准（37 列：`req_id, ck, site, source_kind, input_format, t_ms, t_local,
  user_name, token_name, group_name, channel_id, channel_name, model, endpoint, is_stream,
  reasoning_effort, ip, input_total, input_uncached, cache_read, cache_write, output, token_semantic,
  cost, cost_original, rate_multiplier, billing_mode, currency, quota_raw, latency_ms, first_token_ms,
  log_type, content, src_file, src_mtime, ingested_at, raw_json`）。
  任务只写 `logs`，不建表、不补列、不 DROP、不碰 `error_logs` / `ingest_log` / 总库。
- 去重键：`req_id` 主键，`INSERT ... ON CONFLICT(req_id) DO NOTHING`；同一批（或同一窗口）
  跑两次第二次插入 0。记录没有 `id` 时用 `fp:<ck>`（与 v1 同字段、同 sha1 算法的内容指纹）兜底。
  带请求 ID 的行入库后，库里若有同 `ck` 的旧 `fp:` 行会被删掉（v1 ingest 的「替换」行为）。
- 每片 / 每页拉完立即在独立事务里入库（`busy_timeout=3000`），不会攒到最后一次性写；
  `--dry-run` 完全不写库，按页统计「可插入」并跨页去重。
- 字段口径与 v1 `normalizeNewApi` 一致：`type=2`、`prompt_tokens` 含缓存、
  `cost = quota / 500000`（8 位小数）、`quota_raw` 保原始 quota、`t_local` 为北京时间、
  `raw_json` 入库前对 `key` 与 `sk-` 开头的字符串掩码。
- 直读的字段映射：`id → id`、`user_id → user_id`、`created_at → created_at`（秒转毫秒）、
  `type`、`content`、`username`、`token_name`、`model_name`、`quota`、`prompt_tokens`、
  `completion_tokens`、`use_time`、`is_stream`（0/1 转布尔）、**`channel_id → channel`**、
  `channel_name`、`token_id`、`group`、`ip`、`request_id`、`other`；其余同导出通道。

## 输出

每页（直读）或每片（HTTP）一行进度，最后一行汇总，都不含日志原文与 PAT。

直读：

```text
直读 1 页 id 87093~88089 行数 997 插入 997 跳过 0
[collect-site-logs] relay · 直读 db · 读取 1 页 · 拿到 997 行 · 插入 997 行 ·
跳过重复 0 行 · 时间范围 2026-11-01 12:31:30 ~ 2026-11-02 01:10:52 · id 范围 87093~88089
```

HTTP（2026-11-02 全窗口 dry-run 的真实输出）：

```text
分片 1/9 2026-10-24 12:31:30 ~ 2026-10-25 12:31:30 行数 3890 插入 0 跳过 3890（可插入 0）
...
分片 9/9 2026-11-01 12:31:30 ~ 2026-11-02 01:10:52 行数 5450 插入 0 跳过 0（可插入 5450）
[collect-site-logs] relay · 导出 · 9 段 · 请求 9 页 · 拿到 58985 行 ·
[dry-run] 未写库，可插入 50749 行 · 跳过重复 8233 行 ·
时间范围 2026-10-24 12:31:30 ~ 2026-11-02 01:10:52
```

直读报告额外带 `id 范围 <min>~<max>`，用来核对本轮拉取区间。

## 首次回补

直读源从本地水位起算，空库时按 `--days`（默认 3 天）或 `--since` 取起点。首次部署建议先跑
`--dry-run` 确认行数与 id 区间，再正式入库：

```bash
# 先看最近 3 天会插入多少（不写库）
node v2/jobs/collect-site-logs.mjs --dry-run

# 正式回补到指定起点（只在空库时生效）
node v2/jobs/collect-site-logs.mjs --since=2026-10-17T12:31:00
```

库内已有水位但要补更早的数据，用 HTTP 通道显式覆盖起点（直读忽略已有水位下的 `--since`）：

```bash
node v2/jobs/collect-site-logs.mjs --source=http --since=2026-10-17T12:31:00 --timeout-ms=300000
```

回补与日常增量共用同一套幂等写入，重复跑不会产生重复行。

## 服务器 cron

每小时一次（推荐；增量通常只有 1–3 个分片）：

```cron
7 * * * * cd /opt/relay-ledger && /usr/bin/node v2/jobs/collect-site-logs.mjs >> /var/log/relay-ledger/collect-site.log 2>&1
```

每 6 小时一次（低流量可选；面板的小时视图会滞后最多 6 小时）：

```cron
17 */6 * * * cd /opt/relay-ledger && /usr/bin/node v2/jobs/collect-site-logs.mjs >> /var/log/relay-ledger/collect-site.log 2>&1
```

- 直读要求 cron 与 new-api 同机，且运行用户能读 `/home/newapi/one-api.db`；
  跨机部署改成 `--source=http` 并确认 PAT 文件存在。
- cron 不会替你建目录，先 `mkdir -p /var/log/relay-ledger`；日志按天切分可用 logrotate。
- 单实例运行即可；不要与手工执行的同一任务叠跑（脚本没有加锁）。
- systemd timer 同理，`WorkingDirectory=/opt/relay-ledger`、`ExecStart=/usr/bin/node v2/jobs/collect-site-logs.mjs`。

## 已知限制

- 只采中转站自身日志，不采上游站点；上游逐条 usage 由 v1 通道处理。
- **与 new-api 的表结构耦合**：直读依赖 `logs` 表的列名与语义（`created_at` 为秒、`type=2`、
  `channel_id`、`quota` 等）以及 `id` 单调递增。new-api 升级若改列名、改时间单位或重建表，
  任务会在读库时报错退出（不会静默写错），需要同步调整 `sourceRowToItem` 与分页 SQL。
- 直读只在源库打不开时回退 HTTP；读库中途失败不回退，避免同一轮混用两种源。
- 直读按 `id` 游标推进，假定 `id` 与 `created_at` 同向单调（new-api 现状如此）；若源库出现
  倒序写入，60s 回看窗口内的行仍会被覆盖，更早的缺口需要手工回补。
- 导出端点的响应整段读进内存：单请求内存峰值取决于单片窗口，默认 1 天约 10 MB；
  用 `--chunk-days=0` 跑超大窗口需要自己承担内存。
- 分页回退时若服务端忽略 `end_timestamp`，会多翻页并在客户端裁掉窗口外的行。
- 不改 `logs` 表结构；若现有库缺列，任务会以 SQLite 报错失败，不会自动补列。
