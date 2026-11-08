# 上游账户采集用户脚本（capture.user.js）

纯用户脚本工作流：在已登录的上游站点逐个点 Tampermonkey 菜单
「捕获当前站点（暂存）」，结果只写入 Tampermonkey 的跨站点 GM 存储，不立即下载文件；
全部站点采集完后，点「导出全部暂存账户」，一次性下载 `accounts.capture.json`。
文件是**独立于 v2 配置的通用采集文件**；同一站点同一账号重复采集会覆盖更新该条目，新站点追加。

插件只负责采集，不认识 v2 的 `channels` / `endpoints` / `balance_field` / `quota_per_unit` /
账户 id 规则；这些由服务端导入器负责映射，并把采集文件合并进 `v2/secrets/accounts.json`。
插件不读取、不写入任何 v2 配置文件，也不依赖浏览器目录授权或本地接收器。

## 安装

1. Chrome / Edge 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 打开 Tampermonkey 面板 → 「添加新脚本」，把 `v2/tools/capture.user.js` 全文粘贴保存；
   或把该文件拖进浏览器，按提示安装。
3. 打开已登录的上游站点标签页，Tampermonkey 菜单里会出现：
   - **捕获当前站点（暂存）**
   - **导出全部暂存账户**
   - **查看暂存账户**
   - **清空暂存（需确认）**

不依赖 File System Access API，所以 HTTP 站点（只要能注入用户脚本）也能暂存；
导出仍然只是普通下载，不需要安全上下文。

## 使用

1. 在第一个已登录的上游站点页面点菜单「捕获当前站点（暂存）」。
2. 浮层显示“已暂存 N 个账号”，并保留「导出全部暂存」按钮；不要在这里导出，
   继续打开下一个站点重复捕获。
3. 所有站点采集完后，在任意站点菜单点「导出全部暂存账户」。
   浏览器会下载一个 `accounts.capture.json`，包含此前暂存的全部站点/账号。
4. 把文件放到 `v2/secrets/`，再运行服务端导入器。
5. 需要核对时点「查看暂存账户」；需要重来时点「清空暂存（需确认）」。

## 暂存与覆盖

- 暂存键：`accounts-capture-shared-v1`，由 Tampermonkey 按脚本共享，跨站点可见。
- 同一 `site_url` + 同一账号（`account.id`，缺失时用 `name`、再缺失用 `email`）再次捕获时整条替换；
  新站点/新账号追加。
- 暂存只在本机当前 Tampermonkey 存储中；浏览器重启通常保留，换浏览器/换设备/清扩展数据会丢。
  导出前不要清理 Tampermonkey 数据。
- 文件里是明文 token / Cookie；导出后按凭据文件保护，不要提交到仓库或发到聊天。

## 输出文件与 schema

只在你点「导出全部暂存账户」时生成一个 `accounts.capture.json`，在浏览器默认下载目录；
文件包含 Tampermonkey 跨站暂存的所有账号。浏览器若已存在同名文件，下载时可能自动加 `(1)`，
导入最新文件即可；导入器按站点+账号合并，不会重复。
建议把导出文件移动到 `v2/secrets/`（该目录已在 `.gitignore` 中）。

```json
{
  "schema_version": 1,
  "captured_at": 1761000000000,
  "accounts": [
    {
      "site_name": "upstream-a",
      "site_url": "https://upstream-a.example.com",
      "site_type": "sub2api",
      "account": {
        "id": "123",
        "name": "capture-demo",
        "email": "demo@example.com"
      },
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

- `schema_version`：固定 `1`；`captured_at` 为毫秒时间戳。
- `site_url`：`location.origin`，导入器据此生成 `base_url` 与账户 id 前缀。
- `site_type`：`newapi` 或 `sub2api`。
- `account`：`id` / `name` / `email` 都可能为 `null`（拿不到时）。
- `auth.mode`：`bearer`（`token` 有值）或 `cookie`（没有 token、只有 Cookie，`user_id` 供服务端发
  `New-Api-User`）。
- `auth.cookie`：**两种模式都会尽量保存完整 Cookie**（`document.cookie` + `GM_cookie` 的全部非空
  Cookie，同名以 `GM_cookie` 为准）。上游的 access token 往往十几分钟就过期，服务端只有拿到 Cookie
  才能在 token 失效后重新登录续期；`bearer` 模式下 `cookie` 为空说明这次采集没读到 Cookie。
- `auth.expires_at`：access token 过期时间，毫秒时间戳；`null` 表示拿不到。
- `auth.refresh_token`：只有 sub2api 之类本身下发刷新令牌的站点才有值，NewAPI 为空。
- 同一 `site_url` + 同一账号（`account.id`，缺失时用 `name`、再缺失用 `email`）再次捕获时**整条替换**；
  不同账号追加。
- 可选字段（只在无法确认身份时出现）：
  - `identity_source: "site_fallback"`；
  - `warnings: ["account_identity_unavailable"]`；
  - `auth_fingerprint`：token 或 cookie 的 SHA-256 前 12 位十六进制，用于同站多账号去重。
- 文件里**没有** `channels`、`endpoints`、`base_url`、`id` 等 v2 字段；这些不归插件管。

文件不存在或为空时，脚本会新建 `{ "schema_version": 1, "captured_at": …, "accounts": [] }`。
文件存在但不是合法 JSON、或顶层不是对象 / 缺少 `accounts` 数组时，脚本会**停止并提示**，
不会覆盖可能手工维护的内容。

## 站点类型判断

按顺序：

1. 先 `GET /api/v1/auth/me`（`credentials:'include'`）：200 且返回 JSON 对象，或 401/403
   （接口存在但未带 token）→ `sub2api`。Sub2API 的接口应返回 JSON 而不是 HTML。
2. 否则 `GET /api/status`，返回 JSON 的 `data.version` 或 `data.system_name` 才判 `newapi`
   （不会仅因为该接口有内容就判 NewAPI）。
3. 否则看 localStorage 是否有 `sub2api*` 键，或扫描到 Sub2API 风格的 token/user → `sub2api`。
4. 仍无法判断才弹窗让用户输入 `newapi` 或 `sub2api`，不硬猜。

## 账号与凭据采集

### newapi

账号身份按顺序尝试，**任何一步失败都不弹窗**：

1. `GET /api/user/self`（`credentials: 'include'`）取 `data.id/username/display_name/email`；
2. 失败时 `POST /api/user/auth/refresh`（`credentials:'include'`，`Content-Type: application/json`，
   body `{}`），兼容 `data.access_token` 与顶层 `access_token`，同时取 `data.user` /
   `data.session` / `data.access_expires_at`；
3. 拿到 token 后带 `Authorization: Bearer <token>` 重试 `/api/user/self`（可选带 `X-Auth-Session`）；
4. 仍失败但 refresh 返回了 `user`，就用该 user 的 `id/username/email`；
5. 再用 `sessionCookieHeader()` 的完整 Cookie 作为显式 `Cookie` 头重试一次
   （浏览器可能把 `Cookie` 当 forbidden header 忽略）；
6. 从 localStorage 的 `user` / `userInfo` / `user_info` / `account` / `access_token` 解析
   `id/username/email`；
7. 若 token 是 JWT，解码 payload 取 `sub` / `id` / `user_id` / `username` / `name` / `email`；
8. 仍拿不到就用站点兜底：`account.id = "site:<hostname>"`、`account.name = site_name || hostname`，
   并写入 `identity_source: "site_fallback"`、`warnings: ["account_identity_unavailable"]`；
   同时尽量写入 `auth_fingerprint`（token/cookie 的 SHA-256 前 12 位），供同站多账号去重。

- token 优先级：refresh 得到的 `access_token`（写入 `auth.token`，`expires_at` 取
  `access_expires_at`，秒/毫秒都兼容）→ localStorage 里已可用的 access token →
  `GET /api/user/token` 的 access token。全程**不会弹窗要求粘贴 access token**。
- **每次都在 `auth.cookie` 写入完整 Cookie**（`document.cookie` + `GM_cookie` 全部非空 Cookie，
  合并去重）：NewAPI 的 access token 只有十几分钟，服务端必须靠 Cookie 才能续期。
  `mode` 仍然是 `bearer`；只有连 token 都拿不到时才退回 `mode: "cookie"`。
- 同时保留 `expires_at`（token 过期时间）与数字 `user_id`（服务端 cookie 模式发 `New-Api-User` 用）；
  `user_id` 取不到就留空，不弹窗。
- Cookie 读不到时**不阻塞采集、不弹手动输入**，改为在条目里写 `warnings`：
  - `cookie_empty`：Cookie 为空（导入后 token 过期将无法续期）；
  - `cookie_read_failed`：`GM_cookie` 调用报错；
  - `gm_cookie_unavailable`：脚本没有 `GM_cookie` 权限，可能只拿到非 HttpOnly Cookie。
- 已登录（`/api/user/self` 成功）但完全没有可用 token 且 Cookie 也为空时，错误信息为：
  「已登录但 Tampermonkey 未授权读取 Cookie；请在 Tampermonkey 设置中允许 Cookie 访问后重试」。
- refresh 失败只记录原因（状态码/错误名），不影响后续 Cookie/localStorage/JWT/站点兜底；
  access token 只在内存里的前端也能自动捕获。

### sub2api

账号身份与凭据全部自动，**不弹账号名或 token 输入**：

1. 递归扫描 localStorage / sessionStorage 的所有键与嵌套 JSON（Zustand persist、`auth-storage`
   等），找 `access_token` / `accessToken` / `token`（含 `auth_token`）、
   `refresh_token` / `refreshToken`、`user` / `account` / `profile`、`*expire*`；
2. 带 `Authorization: Bearer <access_token>` 调 `/api/v1/auth/me` 取
   `data.user_id/id/username/email`；
3. access token 缺失或请求失败、但有 refresh token 时，`POST /api/v1/auth/refresh`
   （`credentials:'include'`，body `{refresh_token}`），兼容 `{code,data:{access_token,refresh_token,expires_in}}`
   与顶层字段；成功后用新 token 重试 `/api/v1/auth/me`；
4. 仍失败则用完整 Cookie 再请求一次 `/api/v1/auth/me`；
5. 再取扫描到的 `user` 对象（如 `auth_user`）或 JWT payload 里的身份；
6. 都拿不到就用 `account.id = "site:<hostname>"` 兜底，并写
   `identity_source: "site_fallback"`、`warnings: ["account_identity_unavailable"]`，
   同时尽量写 `auth_fingerprint`（token/cookie 的 SHA-256 前 12 位），同站按指纹去重。

Sub2API 前端常见的存储键（来自公开 bundle）：

- `auth_token`：access token；
- `refresh_token`：刷新令牌；
- `token_expires_at`：过期时间（毫秒）；
- `auth_user`：用户 JSON（含 `id`）。

脚本不依赖固定键名，以上只是扫描时命中的常见键。没有 access token 时直接报错提示重新登录，
不会弹手动输入。

- Sub2API 有 `refresh_token` 就能续期；脚本仍会**尽量把完整 Cookie 一起写进 `auth.cookie`**，
  有就带，没有就留空并写 `cookie_empty` / `gm_cookie_unavailable` 等 warning。
- `auth.expires_at` 优先取 refresh 响应的 `expires_in` / `expires_at`，其次取存储里的过期时间，
  最后解码 JWT 的 `exp`。

所有 token / Cookie 只写进采集文件；脚本不 `console.log`、不在弹窗和错误信息里输出它们的值。
浮层只显示凭据状态：认证方式、Bearer token / Cookie / refresh_token 是「已保存（N 字符）」还是
「为空」、`expires_at` 时间、`user_id`，以及 `warnings` 的提示文字。

## 服务端导入器（不在本脚本内）

导入器读取采集文件（累计的 `accounts.capture.json`），映射成 `v2/secrets/accounts.json`：

- `base_url` ← `site_url`，`kind` ← `site_type`；
- `id` 由导入器生成（例如 `slug(host):账号标识`），同站多账号必须区分；
- `channels` 从已有 `accounts.json` 保留，不因导入丢失；
- `auth` 原样搬过去（`mode/token/cookie/refresh_token/expires_at/user_id`），
  **`bearer` 模式下的 `cookie` 也会保留**（服务端靠它续期），可按需补 `token_env`、
  `endpoints`、`quota_per_unit` 等配置；
- 导入时比较 `captured_at`：目标 `accounts.json` 里的条目更新时，旧采集不会覆盖新凭据；
- access token 已过期且没有 `refresh_token`、也没有 `cookie` 的条目会被拒绝，
  报告里显示 `expired_without_renewal`，不影响 `accounts.json` 里已有的可用凭据；
- 写回保持 `0600`，导入可重复执行（按 id 合并）。

**一个文件即可**：点「导出全部暂存账户」时导出的累计文件包含所有已采集账号。直接导入：

```bash
node v2/tools/import-capture.mjs --input ~/Downloads/accounts.capture.json
```

重复导入同一站点/同一账号只会更新 `auth`，不会丢失已配置的 `channels`，也不会删除其他账户。

插件不写 `accounts.json`，`v2` 服务也不会直接读 `accounts.capture.json`。

## 已知限制与注意事项

- **Chrome / Edge + Tampermonkey**：纯用户脚本依赖 Tampermonkey；不依赖 File System Access API，
  普通 HTTP 站点只要能注入脚本也能暂存。
- **导出位置**：导出文件落在浏览器默认下载目录（通常是 `下载/Downloads`），脚本无法指定绝对路径。
- **文件名冲突**：手动多次导出时浏览器可能自动加 `(1)` 后缀；每次导出都包含全部暂存账号，
  导入最新文件即可，导入器按站点+账号合并。
- **只暂存，不自动写文件**：每次「捕获当前站点（暂存）」只写 Tampermonkey 存储；
  必须再点「导出全部暂存账户」才会生成文件。
- **暂存生命周期**：GM 存储在本机当前 Tampermonkey；换浏览器/换设备/清扩展数据会丢，导出前不要清。
- **同站多账号**：切换账号后重新捕获，采集文件里会按账号各记一条；身份拿不到时用
  `site:<host>` 兜底，同一站点的兜底条目会合并为一条并覆盖更新，无法再区分多个账号。
- **身份兜底**：`site_fallback` 条目的 `account.id` 固定为 `site:<host>`；要保留同站多账号，
  需要能读到账号 id/用户名/邮箱，或导入后人工补账号身份。
- **HttpOnly Cookie**：newapi 的会话 Cookie 通常是 HttpOnly，必须依赖 `GM_cookie` 权限。
  没有 `GM_cookie` 权限时脚本仍会采集，但只写入 `warnings`（`gm_cookie_unavailable` /
  `cookie_empty`），**不会要求手动粘贴 NewAPI token**；这类条目导入后若 access token 已过期，
  导入器会以 `expired_without_renewal` 拒绝，因此请在 Tampermonkey 设置里允许 Cookie 访问后重采。
- **不同 fork 的 token 存储键不同**：sub2api 会递归扫描所有存储键与嵌套 JSON
  （包括 `auth_token` / `auth_user` / Zustand persist 等），不保证覆盖所有部署；
  找不到 access token 时直接报错提示重新登录，**不会弹窗让用户粘贴**。NewAPI 不再依赖固定 Cookie 名。
- **明文凭据**：采集文件内含 token/cookie，文件权限建议 `600`，不要提交仓库、
  不要贴到聊天或日志里。
- **导入前先导出**：导入器读取的是导出文件；暂存只在 Tampermonkey 存储里，不会自动出现在
  `v2/secrets/`。
- **浏览器与服务解耦**：采集不影响正在运行的服务；导入后新增账户通常需要重启 v2 服务才会生效。

## 常见失败

| 提示 | 处理 |
| --- | --- |
| 暂存为空 | 先在各个已登录站点执行「捕获当前站点（暂存）」，再导出 |
| 导出没有出现文件 | 检查浏览器下载栏是否拦截；允许下载后重试，或看默认下载目录 |
| 下载文件名带 `(1)` | 多次手动导出的正常现象；导入最新文件即可，内容都是累计账号 |
| 换站点后看不到之前账号 | 确认还是同一个 Tampermonkey 脚本、没有清扩展数据；点「查看暂存账户」核对 |
| `accounts.capture.json` 不是合法 JSON | 先手工修好或移走该文件，脚本不会覆盖损坏文件 |
| 未找到 token / 没有可用 Cookie | NewAPI：确认已登录，并在 Tampermonkey 设置里允许 Cookie 访问（不会再要求粘贴 token）；sub2api：确认已登录，脚本会扫描存储与 refresh 接口 |
| 浮层显示「Cookie 为空」 | 检查 Tampermonkey 设置是否允许 Cookie 访问（`GM_cookie`）；不然重采一次，否则导入后 token 过期无法续期 |
| 导入报告出现 `expired_without_renewal` | 采集时 token 已过期且没读到 Cookie/refresh_token；重新登录站点后再采集，不要在过期后导入旧文件 |
| 导入报告出现 `stale_capture` | `accounts.json` 里已有更新的凭据（`captured_at` 更晚），旧采集被跳过，属正常保护 |
| 无法读取账号身份 | Sub2API/NewAPI 都会自动用 `site:<host>` 兜底并写 `warnings`，不弹窗；导入后需要人工补账号名/ID |
| 站点类型只能是 newapi 或 sub2api | 弹窗里手动输入；确认访问的是上游站点而不是面板首页 |

## 检查脚本语法

```bash
node --check v2/tools/capture.user.js
```

脚本只在用户点浮层按钮后访问当前站点自身的接口（同源 `fetch` + `GM_cookie`），不向第三方站点发请求。
