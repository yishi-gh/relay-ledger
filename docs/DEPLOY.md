# 部署指南

本文从一台空服务器开始，把一个**只读的 NewAPI 中转站经营看板**装到“面板在公网有登录、采集在后台常驻”的状态。示例中的域名统一为 `relay.example.com`，运行用户为 `relay-ledger`，代码目录 `/opt/relay-ledger`，配置目录 `/etc/relay-ledger`，数据目录 `/var/lib/relay-ledger`，按实际环境替换即可。

本项目只读：不写中转站业务库、不改渠道状态、不调上游配置。部署时也不需要给看板任何写入业务库的权限。

## 1. 部署形态

```text
浏览器 ──https──> nginx ──auth_request /verify──> relay-auth (127.0.0.1:8790)
                    │
                    └── proxy_pass ──> relay-panel (127.0.0.1:8788)
relay-collector ──> 上游余额接口 / 站点日志源 ──> /var/lib/relay-ledger
```

三个常驻进程：

| 进程 | 作用 | 监听 |
| --- | --- | --- |
| `relay-panel` | 看板 HTTP 服务与 JSON API | `127.0.0.1:8788` |
| `relay-auth` | 登录页、会话 Cookie、`auth_request` 校验 | `127.0.0.1:8790` |
| `relay-collector` | 余额与站点日志采集、每日清理与归档 | 无（只出站） |

面板本身没有鉴权，`relay-panel` 只能监听回环地址；公网入口一律走 nginx + `relay-auth`。

## 2. 前置条件

- Linux 服务器，systemd 管理服务。
- Node.js **≥ 22.13**（`node:sqlite` 从该版本起免 `--experimental-sqlite`），`node --version` 确认。
- nginx，且编译了 `http_auth_request` 模块：`nginx -V 2>&1 | grep auth_request` 有输出即可。
- 一个域名与可用的 TLS 证书（下文按 certbot 的默认证书路径写）。
- 系统时间已同步（`timedatectl` 显示 `System clock synchronized: yes`）。余额快照按边界 ±5 分钟判定，机器时钟漂移会直接把成本判成缺失。
- 数据源二选一：与 NewAPI 同机的 `one-api.db` 读权限，或一个中转站管理员 PAT。见第 5 节。

## 3. 目录、用户与权限

```bash
# 运行用户：不给登录 shell，只用于跑这三个服务
sudo useradd --system --home /opt/relay-ledger --shell /usr/sbin/nologin relay-ledger

sudo install -d -o relay-ledger -g relay-ledger -m 0755 /opt/relay-ledger
sudo install -d -o relay-ledger -g relay-ledger -m 0750 /var/lib/relay-ledger
sudo install -d -o root          -g relay-ledger -m 0750 /etc/relay-ledger
```

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `/opt/relay-ledger` | 代码，升级时整目录替换 | `0755` |
| `/etc/relay-ledger` | `instance.json`、`accounts.json`、登录凭据 | 目录 `0750`，配置文件 `0640` 或 `0600` |
| `/var/lib/relay-ledger` | 中转站日志库、看板库、令牌文件 | 运行用户可写 |

直读模式（`source: "db"`）下，`relay-ledger` 用户还要能读 NewAPI 的业务库及其 WAL 文件：

```bash
# 二选一：把运行用户加入 NewAPI 的组，或用 ACL 只授读权限
sudo setfacl -m u:relay-ledger:r /home/newapi/one-api.db
sudo setfacl -m u:relay-ledger:r /home/newapi/one-api.db-wal 2>/dev/null || true
sudo setfacl -m u:relay-ledger:r /home/newapi/one-api.db-shm 2>/dev/null || true
```

## 4. 安装代码与实例配置

把仓库放到 `/opt/relay-ledger`（`git clone` 或 `rsync` 均可），确认 `web/vendor/echarts.min.js` 存在（图表依赖，随仓库分发）。

```bash
sudo cp /opt/relay-ledger/instance.example.json /etc/relay-ledger/instance.json
sudo chown root:relay-ledger /etc/relay-ledger/instance.json
sudo chmod 640 /etc/relay-ledger/instance.json
```

`instance.json` 的字段：

```json
{
  "site": {
    "id": "relay",
    "name": "My Relay",
    "base_url": "https://relay.example.com",
    "log_path": "/api/log"
  },
  "paths": {
    "data_dir": "/var/lib/relay-ledger",
    "relay_db": "/home/newapi/one-api.db",
    "site_token": "/etc/relay-ledger/site-pat",
    "accounts": ""
  },
  "collect": {
    "source": "db",
    "spend_interval_ms": 900000,
    "logs_interval_ms": 900000
  }
}
```

- 配置定位顺序：`--config=<path>` → 环境变量 `RELAY_LEDGER_INSTANCE` → 仓库根 `instance.json`；三者都缺失时用内置默认值正常启动。生产部署统一用 `RELAY_LEDGER_INSTANCE=/etc/relay-ledger/instance.json`。
- `paths.*` 的相对路径相对于 `instance.json` 所在目录，不是进程的当前目录。
- `site.id` 同时决定日志库文件名 `<dataDir>/db/sites/<site.id>.db`，部署后不要再改，改了等于换一个新库。
- `paths.accounts` 留空时取 `<dataDir>/accounts.json`。
- `collect.source` 决定数据接入方式，见下一节。

## 5. 两种数据接入方式

| 方式 | 前提 | 优点 | 代价 |
| --- | --- | --- | --- |
| 直读 `one-api.db`（`source: "db"`） | 面板与 NewAPI 同机，或能挂载其数据目录 | 实时、增量、不需要管理员令牌 | 需读权限；跨机要挂载 |
| HTTP 导出（`source: "http"`） | 有中转站管理员 PAT | 可跨机 | 依赖源站导出接口性能 |

选择建议：

- **同机部署直接用 `db`。** 采集按 id 游标增量读取，只读打开，不写业务库；库文件不存在或打不开时回退 `http`（同一轮不混用两种源），两条路都不可用则该轮失败并报错。
- **面板不在中转站机器上时用 `http`。** 首次回补按 `--chunk-days` 分片，一天约 10 MB；导出接口慢时可把 `--timeout-ms` 调大。PAT 只进请求头，不进日志与错误信息。
- 两种方式写同一张 `logs` 表、同一套去重口径，后续可切换，已采数据不会重复。

PAT 文件支持两种写法：

```text
# 单行纯 token
<REDACTED>
```

```text
# 多行，全角冒号分隔，按 site.id 取对应行
relay：<REDACTED>
another-site：<REDACTED>
```

```bash
sudo install -o root -g relay-ledger -m 0640 /dev/null /etc/relay-ledger/site-pat
sudoedit /etc/relay-ledger/site-pat     # 写入上面的内容
```

## 6. 上游账户与渠道映射

```bash
sudo cp /opt/relay-ledger/v2/secrets/accounts.example.json /var/lib/relay-ledger/accounts.json
sudo chown relay-ledger:relay-ledger /var/lib/relay-ledger/accounts.json
sudo chmod 600 /var/lib/relay-ledger/accounts.json
```

字段、三种账户类型、渠道映射与最小示例见 [UPSTREAM.md](UPSTREAM.md)。要点：

- 凭据只放服务器、权限 `0600`、永不入仓库。
- 渠道映射按渠道 `base_url` 主机人工填写；停用账户也要保留映射，否则它名下的渠道会掉进「未映射」。
- 本地配置绝不覆盖生产配置，变更按账户逐条补字段并验证。

## 7. systemd 服务

模板在 `v2/deploy/`，装好后只需改 `User` / `Group`、node 路径（`command -v node` 的结果），以及数据目录（若不用 `/var/lib/relay-ledger`）：

```bash
sudo cp /opt/relay-ledger/v2/deploy/relay-collector.service \
        /opt/relay-ledger/v2/deploy/relay-panel.service \
        /opt/relay-ledger/v2/deploy/relay-auth.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now relay-collector relay-panel relay-auth
systemctl status relay-collector relay-panel relay-auth
journalctl -u relay-collector -n 50
```

三个单元共同约定：

- `WorkingDirectory=/opt/relay-ledger`，`Environment=RELAY_LEDGER_INSTANCE=/etc/relay-ledger/instance.json`。
- `Restart=always`，异常退出后自动拉起；`NoNewPrivileges=true`、`PrivateTmp=true`。
- 用 `User=relay-ledger` 占位；若换成别的用户，必须同时改数据目录与配置文件的属主，否则读不到 `instance.json`、写不了看板库。
- 采集单元给 `TimeoutStopSec=30`，收到 `SIGTERM` 后等在跑的一轮收尾再退出。

## 8. nginx 与登录

```bash
sudo cp /opt/relay-ledger/v2/deploy/nginx.conf.example /etc/nginx/sites-available/relay-ledger.conf
sudo ln -s /etc/nginx/sites-available/relay-ledger.conf /etc/nginx/sites-enabled/
sudoedit /etc/nginx/sites-available/relay-ledger.conf   # 改 server_name 与证书路径
sudo nginx -t && sudo systemctl reload nginx
```

模板包含四个 location：`/login`（公开，登录页与表单）、`/verify`（`internal`，只给 `auth_request` 用）、`/logout`（公开，清 Cookie）、`/`（面板本体）。

### gzip 必须开

```nginx
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
```

首访要下约 1.9 MB 静态资源（含 1.1 MB 图表库）。少了 `gzip_proxied any`，nginx 不会压缩来自上游（`relay-panel`）的响应，等于白传；`gzip_types` 少了 `text/javascript` / `application/javascript`，`app.js` 也不压缩。这是实测过的必需要点。

### 登录凭据

```bash
sudo install -d -m 0750 -o root -g relay-ledger /etc/relay-ledger
printf '%s\n' '换成你的密码' | sudo tee /etc/relay-ledger/panel-password >/dev/null
head -c 32 /dev/urandom | base64 | sudo tee /etc/relay-ledger/session-secret >/dev/null
sudo chown root:relay-ledger /etc/relay-ledger/panel-password /etc/relay-ledger/session-secret
sudo chmod 640 /etc/relay-ledger/panel-password /etc/relay-ledger/session-secret
```

- 密码文件一行明文；会话密钥一行随机串，重启之间必须保持不变，换了等于所有已登录会话失效。
- 文件不存在或为空时 `relay-auth` 直接退出，不会自动生成。
- 默认路径在 `/root` 下，普通运行用户读不到，所以单元里用 `PANEL_PASSWORD_FILE` 与 `PANEL_SESSION_SECRET_FILE` 指到 `/etc/relay-ledger`。

### Cookie 转发

`auth_request` 子请求不继承原请求头。`/verify` 上必须写：

```nginx
proxy_pass_request_body off;
proxy_set_header Content-Length "";
proxy_set_header Cookie $http_cookie;
```

少了最后一行，登录成功也会立刻被打回登录页。`/login`（POST 表单）不能关请求体。

## 9. 调度：常驻或 cron 二选一

推荐 `relay-collector` 常驻：余额与日志各 15 分钟一轮，按墙钟重新对齐槽位，重启不会长期盲窗，清理与归档也在同一个进程里。

cron 备选见 `v2/deploy/crontab.example`：余额在 `:10/:25/:40/:55`，日志在 `:14/:29/:44/:59`，两行都带 `RELAY_LEDGER_INSTANCE`。两者只能选一个，同时启用会重复采集（数据幂等，但白费请求，也让上游更快触发限流）。

## 10. 首次验证

```bash
# 用生产配置各跑一次，退出码 0 才算通过
sudo -u relay-ledger env RELAY_LEDGER_INSTANCE=/etc/relay-ledger/instance.json \
  node /opt/relay-ledger/v2/jobs/run-scheduler.mjs --once

curl -s http://127.0.0.1:8788/api/healthz
curl -s http://127.0.0.1:8788/api/quality     # jobs、collect_errors、源库行数
curl -s http://127.0.0.1:8788/api/upstreams   # 余额、last_sync、last_job
```

`--once` 会连真实上游与中转站库。第一次跑通常要回补几天日志，属正常现象。

## 11. 数据保留与备份

常驻采集每天自动跑一次：`prune-logs` 清 7 天前的原始请求体与 30 天前的任务记录，`rollup-logs` 把 90 天前的明细按天归档。手动执行：

```bash
node v2/jobs/prune-logs.mjs --dry-run
node v2/jobs/rollup-logs.mjs --keep-days=90 --dry-run
```

需要备份的只有 `/var/lib/relay-ledger/dashboard.db`（余额快照与充值事件是唯一无法重建的数据），中转站日志库可重新采集：

```bash
sqlite3 /var/lib/relay-ledger/dashboard.db ".backup '/var/backups/relay-ledger-$(date +%F).db'"
```

## 12. 升级

```bash
sudo systemctl stop relay-collector
# 替换 /opt/relay-ledger 下的代码，不要覆盖 /etc/relay-ledger 与 /var/lib/relay-ledger
sudo systemctl start relay-collector
sudo systemctl restart relay-panel relay-auth
curl -s http://127.0.0.1:8788/api/quality
```

表结构由程序启动时 `CREATE TABLE IF NOT EXISTS` 补齐，不删旧表。升级前备份 `dashboard.db`。

## 13. 安全清单

- [ ] `relay-panel` 只监听 `127.0.0.1`，公网只能经 nginx 访问。
- [ ] `accounts.json`、PAT 文件、登录凭据均 `0600` 或 `0640`，属主是运行用户或 root。
- [ ] `instance.json`、数据目录、凭据文件都不在版本库里（仓库 `.gitignore` 已覆盖）。
- [ ] 本地配置不整文件覆盖生产，只按账户补字段（见 [DECISIONS.md](DECISIONS.md) D13）。
- [ ] 上游返回 403 / 429 时先停一轮，不加重试，避免账号被限流。
- [ ] 采集进程只有一个实例：换签写回 `accounts.json` 是“读-改-写”，多实例会互相覆盖。

## 14. 故障排查

| 症状 | 常见原因 | 处理 |
| --- | --- | --- |
| 登录后立刻回到登录页 | `/verify` 没有转发 Cookie | nginx 加 `proxy_set_header Cookie $http_cookie;` |
| 所有成本显示 `—` | 余额快照不足一个桶，或采集没跑 | 看 `/api/quality` 的 `jobs` 与 `collect_errors`；确认时钟已同步 |
| 渠道名为空 | 源库 `channel_name` 为 NULL | 采集器会用 `channels.name` 回填；仍为空说明渠道已删除 |
| 首访 2 秒以上 | nginx 未压缩 | 检查 `gzip_proxied any` 与 `gzip_types` |
| 首访几十秒、多个接口同时超时 | 同步 SQLite + 冷缓存，首个查询把事件循环占满，后面的请求排队 | 等启动预热跑完（日志里有 `[warmup] ok`）；磁盘慢时单次聚合可到 3 秒级，属预期，不是宕机 |
| 启动日志说「源库不存在，已创建空库」 | `paths.relay_db` 或 `site.id` 指错了位置 | 改 `instance.json` 后重启；空库是给首次部署用的，不会自动找回旧数据 |
| `/api/quality` 出现 `auth_failed` | 上游令牌过期 | 更新 `accounts.json` 对应账户，重启 collector |
| 采集报 `SQLITE_BUSY` | 与中转站业务库写入撞车 | 保持只读连接，避开业务高峰；不要与中转站同秒执行大查询 |
| 面板起不来 | 中转站日志库不存在或路径错 | 检查 `site.id` 与 `<dataDir>/db/sites/<site.id>.db` |
| `node:sqlite` 报错 | Node 版本过低 | 升级到 ≥ 22.13 |
