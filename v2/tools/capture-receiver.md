# 本地采集接收器（capture-receiver.mjs）

采集脚本把累积的 capture JSON `POST` 到本机接收器，接收器读取现有的
`v2/secrets/accounts.capture.json`，按账号合并后原子写回**同一个**文件，
因此不会再出现 `accounts (1).capture.json` 这类副本。

- 只监听 `127.0.0.1`，不接受外部网络请求；
- 零 npm 依赖，Node 原生 ESM；
- 只记录启动、停止和计数，不记录请求体、token 或账号凭据。

## 启动

```bash
# 默认：127.0.0.1:8799 → v2/secrets/accounts.capture.json
node v2/tools/capture-receiver.mjs

# 换端口 / 换文件
node v2/tools/capture-receiver.mjs --port 8800
node v2/tools/capture-receiver.mjs --file /path/to/accounts.capture.json

# 可选访问令牌（也可用环境变量 RELAY_LEDGER_CAPTURE_TOKEN）
node v2/tools/capture-receiver.mjs --token <TOKEN>
RELAY_LEDGER_CAPTURE_TOKEN=<TOKEN> node v2/tools/capture-receiver.mjs

# 查看参数
node v2/tools/capture-receiver.mjs --help
```

| 参数 | 说明 |
| --- | --- |
| `--port, -p` | 监听端口，默认 `8799`，范围 1..65535 |
| `--file, -f` | 采集文件路径，默认 `v2/secrets/accounts.capture.json`（相对脚本位置推导） |
| `--token, -t` | 可选的共享令牌；未传时读 `RELAY_LEDGER_CAPTURE_TOKEN` |

PowerShell 设置环境变量只在当前窗口生效：

```powershell
$env:RELAY_LEDGER_CAPTURE_TOKEN = "<TOKEN>"
node v2/tools/capture-receiver.mjs
```

前台按 `Ctrl+C` 停止；Windows 下也可用 `capture-receiver.vbs` 隐藏启动（见下文）。

## 健康检查

```bash
curl http://127.0.0.1:8799/health
```

```json
{ "ok": true, "service": "relay-ledger-capture-receiver", "version": 1 }
```

健康检查不返回文件路径、token 或任何账号信息。

## 接口

### `POST /capture`

```http
POST /capture HTTP/1.1
Host: 127.0.0.1:8799
X-Relay-Ledger-Capture: 1
X-Relay-Ledger-Token: <TOKEN>        # 仅配置了 token 时需要
Content-Type: application/json
```

请求体接受两种形式：

```json
{ "schema_version": 1, "accounts": [ { "site_url": "https://demo.test", "account": { "id": "u1" } } ] }
```

```json
{ "site_url": "https://demo.test", "account": { "id": "u1" } }
```

- 每个账户必须有非空 `site_url`；`account` 可选；
- 未知字段（`auth`、`warnings`、自定义字段等）原样保留；
- `schema_version` 省略或为 `1`，其他值返回 400。

成功响应：

```json
{ "ok": true, "added": 1, "updated": 0, "total": 1, "file": "accounts.capture.json" }
```

响应只给出计数和文件名，不含 token、完整路径或账号内容。

### 合并规则

按与采集脚本一致的键定位账号，优先级从高到低：

1. `site_url + account.id`
2. `site_url + account.name`
3. `site_url + account.email`
4. 都没有时：`site_url + "|site_fallback|" + accountKey`（`identity_source` 为
   `site_fallback` 时同样走这条；`accountKey` 取 id/name/email，再退回
   `auth_fingerprint`，最后是 `no-fingerprint`）

比较大小写不敏感，与脚本一致。命中同一键时比较 `captured_at`（支持数字毫秒或
可解析时间字符串，缺失视为最旧）：较新的覆盖较旧的，相等时以本次提交为准。
未命中的条目追加，其他账号与文件顶层未知字段保持不变。

### 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 合并并写入成功 |
| 400 | JSON 非法、结构不对、缺少 `site_url`、`schema_version` 不支持 |
| 401 | 配置了 token，但 `X-Relay-Ledger-Token` 缺失或错误 |
| 403 | 缺少 `X-Relay-Ledger-Capture: 1` |
| 405 | 方法不允许（含 `OPTIONS`，不回应 CORS 预检） |
| 409 | 现有文件不是合法 JSON 或缺少 `accounts` 数组；拒绝覆盖，需先手工修复 |
| 413 | 请求体超过 2 MiB |
| 415 | `Content-Type` 不是 `application/json` |
| 500 | 写入失败（磁盘权限等），详情只写日志 |

写入方式：同目录临时文件 → `fsync` → `rename` 原子替换；POSIX 上文件权限为
`0600`，Windows 上尽力设置（实际保护依赖用户目录 ACL）。所有请求的“读-合并-写”
串行执行，并发提交不会互相覆盖。

## 后台运行与登录自启

### Windows：隐藏窗口启动

`capture-receiver.vbs` 用 `WScript.Shell` 隐藏启动同目录的
`node capture-receiver.mjs`，路径由 `WScript.ScriptFullName` 推导，不写死盘符：

```text
双击  v2\tools\capture-receiver.vbs
```

需要 token 时，请在启动脚本前设置系统/用户环境变量 `RELAY_LEDGER_CAPTURE_TOKEN`
（vbs 不保存任何令牌）。

### Windows：放进启动文件夹

1. 右键 `capture-receiver.vbs` →「创建快捷方式」；
2. `Win+R` 输入 `shell:startup` 打开当前用户的启动文件夹；
3. 把快捷方式拖进去。

登录后自动运行，无控制台窗口。注意：

- 快捷方式指向 vbs，不要直接指向 `.mjs`，否则会弹黑窗；
- 不要重复启动（会报端口占用），改端口后同步更新采集脚本里的地址；
- vbs 与 `capture-receiver.mjs` 必须放在同一目录，移动时一起移动。

### macOS / Linux

用 `nohup` 或系统服务管理器（launchd / systemd）启动，例如：

```bash
nohup node v2/tools/capture-receiver.mjs >> /tmp/relay-ledger-capture-receiver.log 2>&1 &
```

## 安全边界

- **仅本机**：默认绑定 `127.0.0.1`，不要改成 `0.0.0.0`，也不要做端口转发/反向代理；
- **不开放 CORS**：不返回任何 `Access-Control-*` 头，`OPTIONS` 直接 405，
  普通网页无法跨域提交；
- **自定义头门槛**：必须带 `X-Relay-Ledger-Capture: 1`，可挡住表单/图片等简单请求；
- **可选 token**：配置 `--token` 或 `RELAY_LEDGER_CAPTURE_TOKEN` 后，请求还必须带
  `X-Relay-Ledger-Token`，比较使用常量时间算法。本机多用户环境建议开启；
- **文件含凭据**：`accounts.capture.json` 里有上游 access token / refresh token /
  cookie，视同密码管理。POSIX 保持 `0600`，Windows 确认只有自己的账户可读；
  不要提交到 Git、不要同步到网盘、不要贴进聊天或日志；
- **日志**：只打印启动地址、文件路径、停止信息和新增/更新计数，绝不打印请求体、
  接收器 token 或账号 token。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `EADDRINUSE` | 端口已被占用：`netstat -ano \| findstr 8799` 找到进程并结束，或换 `--port` 并同步改采集脚本地址 |
| 启动报 `ENOENT` / 找不到 node | Node 未安装或不在 PATH；vbs 启动失败会弹错误码提示 |
| `curl` 连不上 | 服务未启动、端口不一致，或代理把 `127.0.0.1` 也走了代理（加 `--noproxy 127.0.0.1`） |
| 403 | 请求缺 `X-Relay-Ledger-Capture: 1` |
| 401 | 配置了 token 但 `X-Relay-Ledger-Token` 缺失/错误；检查环境变量是否在当前进程可见 |
| 400 `site_url 缺失` | 提交的条目没有 `site_url`，或顶层既没有 `accounts` 也不是单个账户对象 |
| 409 `file_invalid` | 现有 `accounts.capture.json` 已被改坏；先手工修复或移走，接收器不会覆盖损坏文件 |
| 413 | 单次提交超过 2 MiB；减少条目或清理过大的字段后重试 |
| 写入成功但导入器看不到新账号 | 确认改的是同一个文件：默认 `v2/secrets/accounts.capture.json`；用 `--file` 时两边路径要一致 |
| 浏览器报跨域/被拦截 | 属预期：接收器不开放 CORS；请由采集脚本在扩展后台/本机上下文提交，而不是从普通网页 fetch |

## 测试

```bash
node --check v2/tools/capture-receiver.mjs
node --test v2/test/capture-receiver.test.mjs
```

测试使用临时目录和端口 0，不读写真实的 `v2/secrets/accounts.json`。
