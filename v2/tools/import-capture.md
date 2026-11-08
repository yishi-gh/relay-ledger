# 采集文件导入器（import-capture.mjs）

把浏览器插件产出的通用采集文件 `accounts.capture.json` 合并进 v2 的账户配置
`v2/secrets/accounts.json`。导入器只做字段映射与合并，不访问网络、不读站点库、
不拉上游余额，也不会打印任何 token / cookie / refresh_token。

## 命令

```bash
# 导入到默认位置 v2/secrets/accounts.json
node v2/tools/import-capture.mjs --input v2/secrets/accounts.capture.json

# 指定目标配置（例如先看效果、写到临时文件）
node v2/tools/import-capture.mjs \
  --input v2/secrets/accounts.capture.json \
  --config /tmp/accounts.preview.json

# 只打印报告，不落盘
node v2/tools/import-capture.mjs --input v2/secrets/accounts.capture.json --dry-run
```

| 参数 | 说明 |
| --- | --- |
| `--input, -i` | 采集文件（必填） |
| `--config, -c` | 目标配置，默认 `v2/secrets/accounts.json` |
| `--dry-run` | 只计算并打印报告，不写文件 |
| `--help, -h` | 用法 |

退出码：`0` 成功；`1` 校验/合并/写入失败；`2` 参数错误。

## 采集文件契约

导入器只接受 `schema_version === 1`：

```json
{
  "schema_version": 1,
  "captured_at": 1761000000000,
  "accounts": [
    {
      "site_name": "upstream-a",
      "site_url": "https://upstream-a.example.com",
      "site_type": "sub2api",
      "account": { "id": "123", "name": "demo", "email": null },
      "auth": {
        "mode": "bearer",
        "token": "ACCESS_TOKEN",
        "cookie": "",
        "refresh_token": "REFRESH_TOKEN",
        "expires_at": 1761003600000,
        "user_id": null
      },
      "captured_at": 1761000000000
    }
  ]
}
```

校验（任一不满足就报错，不静默跳过）：

- `schema_version` 必须为 `1`；`accounts` 必须是数组；
- 每条必须有 `site_url`（http/https，去尾斜杠后作为 `base_url`）、
  `site_type`（`newapi` / `sub2api`）、`auth`、`account`；
- `account` 的 `id` / `name` / `email` 至少要有一个，用于生成唯一 id；
- `auth.mode` 必须是 `bearer` 或 `cookie`；bearer 需要 `token`、`refresh_token`、`cookie`
  至少一个，cookie 需要 `cookie`。

缺字段或类型不对时，错误信息会指出 `accounts[n].字段`，且不会改动目标文件。
`schema_version` 仍为 `1`：`auth.cookie` 在 `bearer` 模式下也可以有值（NewAPI 就是用这种方式
把十几分钟有效的 access token 和可续期的 Cookie 一起交出来），旧文件照常可导入。

## 字段映射

| 目标字段 | 来源 / 规则 |
| --- | --- |
| `kind` | `site_type` |
| `base_url` / `site_url` | `site_url` 规范化（去尾斜杠、丢 query/hash） |
| `site_name` | `site_name`，缺失用 `site_url` 的 host |
| `id` | `slug(site_name 或 host) + ':' + account.id/name/email` |
| `name` | `site_name · 账号名`（已有账户保留原 `name`） |
| `account` | `{ id, name, email }`，缺失字段为 `null` |
| `auth` | `{ mode, token, cookie, refresh_token, expires_at, user_id }` |
| `auth.cookie` | 原样保留；**`bearer` 模式也保留 Cookie**（access token 过期后靠它续期） |
| `captured_at` | 条目采集时间（秒/毫秒 → 毫秒），缺失时用文件头的 `captured_at`；用于下次导入的新旧比较 |
| `unit` | 新账户 `USD`；已有账户保留原值 |
| `enabled` | 新账户 `true`；已有账户保留原值（除非显式 `false`） |
| `channels` | 新账户 `[]`；已有账户保留原数组 |
| `endpoints` | 新账户用默认值；已有账户保留自定义 endpoints |
| `balance_field` | 新账户 `sub2api → balance`、`newapi → quota`；已有账户保留原值 |
| `quota_per_unit` | 新账户 `newapi → 500000`、`sub2api → null`；已有账户保留原值 |

默认 endpoints：

```json
// sub2api
{ "balance": "/api/v1/auth/me", "usage": "/api/v1/usage/stats?period=today" }

// newapi
{ "balance": "/api/user/self", "credits": "/api/log/self", "usage": "/api/log/self/stat" }
```

`auth.expires_at` 兼容秒/毫秒，统一存毫秒；`user_id` 原样保留（cookie 模式下服务端用它发
`New-Api-User`）；新采集的 `user_id` 为空时不会清掉已有值。`captured_at` 同样统一成毫秒。

## 合并规则

1. 目标配置不存在时新建：

   ```json
   {
     "version": 2,
     "currency": "USD",
     "quota_per_unit": 500000,
     "upstream": { "timeout_ms": 20000, "min_interval_ms": 1200, "retry_delay_ms": 500,
                   "job_stale_ms": 1800000, "refresh_threshold_ms": 7200000 },
     "accounts": []
   }
   ```

2. 目标配置存在时只做增量修改：保留顶层字段（如 `version`、`currency`、自定义项）、
   保留未匹配账户、不改动 `channels`。
3. 匹配顺序：先按生成 id 匹配；未命中再按 `site_url + account.id/name/email` 匹配；
   仍未命中时，如果同 `site_url` 只有一个“没有 account 元数据”的旧配置账户，则按站点唯一匹配，
   避免早期站点级配置被重复建号。命中后更新站点字段（`site_url`/`base_url`/`site_name`/`kind`）与 `account`、`auth`，
   保留既有 `id`、`name`、`unit`、`enabled`、`channels`、`endpoints`、`balance_field`、
   `quota_per_unit`，以及 `auth` 里已有的扩展字段（如 `token_env`、`header`、`scheme`）。
4. 新账户追加，`channels` 为空数组，需要按渠道归属手工补 `channels`。
5. 同一 `site_url` 下不同账号生成不同 id（`<站点>:<账号标识>`），同站多账号互不覆盖。
6. 生成 id 在采集文件内重复、或目标配置里本来就有重复 id 时，直接报错，不写文件。

### 防降级：短命 JWT 不覆盖长效 token

浏览器采集到的 dashboard JWT 往往只有十几分钟有效期。如果 `accounts.json` 里该账户当前用的是
长效 key（非 JWT、没有 `exp`，当下可用），直接用采集条目覆盖，就会把可用凭据换成很快失效、
且没有 `refresh_token` 可续期的 JWT。

判定口径：

- **长效 token**：`auth.token` 非空，且不是可解析的 JWT（三段、payload 为 JSON 对象、能解出 `exp` 的才叫 JWT）。
- **短命 token**：`auth.token` 是可解析的 JWT，且 `auth.expires_at` 非空。

同时满足「现有账户是长效 token + 新条目是短命 token + 新条目 `refresh_token` 为空」时：

| 字段 | 处理 |
| --- | --- |
| `auth.token` | **保留**现有值，不覆盖 |
| `auth.expires_at` | **保留**现有值，不覆盖 |
| `auth.cookie` | 新条目非空时合并覆盖；为空时保留旧值 |
| `auth.session` / `auth.session_id` | 随 `auth` 合并，既有值不会被删除 |
| `auth.user_id` | 新条目非空时合并 |
| `captured_at` | 更新为本次采集时间（确实合并了 Cookie 等字段，旧 capture 不应反过来覆盖） |

该条目仍算「已更新」，报告里用 `!` 前缀并标注原因 `not_overwriting_long_lived_token`，
但输出的仍是账户 id 与站点，不含任何凭据。其余情况保持原行为：新条目有 `refresh_token`
（如 Sub2API 的 24 小时 access + refresh）正常覆盖；现有 token 也是 JWT 时正常覆盖；
目标里没有的账户正常新增。

### 拒绝导入的条目

以下两种条目不会写入配置，只在报告里列出 `跳过：<原因>`，其余条目照常导入：

| 原因 | 条件 | 效果 |
| --- | --- | --- |
| `expired_without_renewal` | `auth.mode === 'bearer'`，`expires_at` 早于当前时间，且 `refresh_token`、`cookie` 都为空 | 该条不导入（新增的不建号、已有的不改），`accounts.json` 里现有的可用 token 原样保留 |
| `stale_capture` | 目标 `accounts.json` 中同一账户的 `captured_at` 比采集条目更晚 | 该条不覆盖，避免旧文件回滚新凭据（例如两次导出文件混用） |

- 过期但**有** `refresh_token` 或 `cookie` 的条目照常导入：服务端可以续期。
- cookie 模式没有 `expires_at`，不参与过期判断。
- `expired_without_renewal` 按条目粒度处理，不中断整次导入；采集文件本身被改坏仍是整次报错。

## 输出与权限

- 2 空格缩进、末尾换行；
- 临时文件 + `rename` 原子替换，失败时旧文件保持原样；
- 文件与临时文件都尽力设为 `0600`（Windows 上 chmod 可能不生效，需自行确认 ACL）。

导入报告只含账户 id、`site_url`、`kind`、`channels` 数量、新增/更新标记与跳过原因：

```text
新增 1 个，更新 1 个，跳过 1 个 → /opt/relay-ledger/v2/secrets/accounts.json
+ newapi:7  https://api.example.test  newapi  channels=0
~ upstream-a:123  https://upstream-a.example.com  sub2api  channels=2
! upstream-c:11780  https://upstream-c.example.com  newapi  跳过覆盖：not_overwriting_long_lived_token
! demo:u1  https://demo.test  newapi  跳过：expired_without_renewal
```

`+` 新增、`~` 更新、`!` 跳过或跳过覆盖（`expired_without_renewal` / `stale_capture` /
`not_overwriting_long_lived_token`；后者属于「已更新」计数，只是 token 没被覆盖）。
报告不会出现 token / cookie / refresh_token；采集文件本身仍以明文保存凭据，注意不要提交仓库。

## 与浏览器插件、服务端的关系

- 插件（`capture.user.js`）只写 `accounts.capture.json`，不碰 `accounts.json`；
- 导入器是本文件，负责写 `accounts.json`；
- v2 服务与采集 job 只读 `accounts.json`（服务启动时加载）；导入后需要重启服务才会用上新账户；
- **不要与浏览器同时写**：浏览器写的是采集文件、导入器写的是配置，两者文件不同；但导入过程中
  不要再用编辑器或另一个导入进程同时修改 `accounts.json`，避免互相覆盖。
- 服务器上建议 `accounts.json` 与 `accounts.capture.json` 都放在 `v2/secrets/`，
  目录 `700`、文件 `600`，只给服务账号读权限。

## 常见错误

| 报错 | 处理 |
| --- | --- |
| `schema_version 必须是 1` | 采集文件不是本插件当前版本产物，重新捕获或手工修正 |
| `accounts[n].site_url 缺失/非法` | 采集文件被手工改坏，补全 http/https 地址 |
| `accounts[n].site_type 必须是 newapi 或 sub2api` | 同上 |
| `accounts[n].auth ...` | bearer 的 token / refresh_token / cookie 全空，或 cookie 模式缺 cookie |
| 报告里 `跳过：expired_without_renewal` | 采集时 access token 已过期且没读到 Cookie/refresh_token；重新登录站点后再采集，不要导入过期文件 |
| 报告里 `跳过：stale_capture` | 目标配置里的凭据更新，旧采集不覆盖；确认要回滚时先手工删除目标条目再导入 |
| 报告里 `跳过覆盖：not_overwriting_long_lived_token` | 采集到的是短命 JWT、没有 `refresh_token`，现有长效 key 被保留；如果确实想换成 JWT，先删掉该账户再导入，或重新登录站点让插件同时抓到 Cookie / refresh_token |
| `采集文件里生成了重复 id` | 同一站点同一账号被写了两条，去重后重试 |
| `配置文件里账户 id 重复` | 目标配置已损坏，先修正重复 id |
| `配置文件不是合法 JSON` | 目标文件被手工改坏，导入器不会覆盖它 |

## 验证

```bash
node --check v2/tools/import-capture.mjs
node --test v2/test/import-capture.test.mjs
```

测试全部使用临时目录 fixture，不读取真实 `v2/secrets/accounts.json`，不连接任何站点。
