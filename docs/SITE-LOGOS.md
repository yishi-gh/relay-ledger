# 站点图标发现

实现位于 `v2/lib/site-logos.mjs`。2026-11-11 对照 Magpie 官方提交
[`418bb6c9e11b5e1e4d93495b38b63c3d12265cb7`](https://github.com/yetone/magpie/tree/418bb6c9e11b5e1e4d93495b38b63c3d12265cb7)
的 favicon/icon 源码，采用其状态接口发现、页面候选排序和面板默认图标回避策略。

## 发现顺序

1. 可信 `resolveSource({ kind, id })` 返回来源 origin；支持 `channel`、`account` 和 `site/current`。
2. 未登录 GET `/api/status`，仅识别 `success: true` 且有字符串 `data.system_name` 的响应。优先读取 `data.logo` 的绝对 URL、相对来源根目录的路径或 data URI。探测最多占用 1200ms。
3. 查首页 `rel=icon`、`apple-touch-icon` 和 `apple-touch-icon-precomposed`，优先 SVG，再 touch 图标，再按声明尺寸选择较大的栅格图标；最多保留 8 个候选。
4. 普通站点最后尝试 `/favicon.ico`。识别为 NewAPI/OneAPI 风格面板后，跳过同源 `/logo.png`、`/logo.svg` 和 favicon 通用路径；没有自定义图标就返回 `null`，由现有 UI 显示首字母。
5. 来源没有可用页面且未识别为面板时，可去掉一层 `api.` 或 `www.`。保守地仅支持剩下两段的 `.com/.net/.org` 域名，并排除常见托管后缀；不回退 `co.uk`、`.io` 等域名，不继续剥离其它层。这只决定图标来源，不影响账户关联。

## 网络与格式限制

图标候选可以指向网页或 status 声明的公网 CDN，图标重定向最多 3 次。状态接口和页面重定向保持同源。每次网络请求重新检查全部 DNS 答案，并使用固定 IP 的 lookup 连接，保留原域名 SNI；拒绝私网、保留地址、元数据地址、userinfo、非 HTTP(S) scheme 和非 80/443/9443 端口。原生直连不使用环境代理，不携带 Cookie 或认证信息，也不调用第三方图标代理。

支持 PNG/JPEG/WebP/GIF/ICO，以及受限 UTF-8 SVG。SVG 只允许静态形状、分组、渐变、裁剪、内部引用和少量样式属性；拒绝脚本、事件、动画、foreignObject、image、外部 URL、CSS 转义、DOCTYPE/entity、XML 样式表及未知元素/属性。保守拒绝的 SVG 继续尝试下一候选。

HTML/status 响应压缩前后分别最多 512KiB，图片分别最多 1MiB。支持 gzip、br、deflate；data URI 也受图片大小与格式校验约束，并受所在文档的大小限制。排队、探测、下载和解压共用最多 8 秒预算。

## 缓存与生命周期

保持 4 个执行任务、64 个等待 origin，同源请求合并。排队过期或队列满时不写负缓存；正缓存 7 天，失败缓存 6 小时，过期图片可先返回并后台刷新。

缓存仍位于 `dataDir/site-logos`，文件名由原来源 origin 的 SHA-256 决定。metadata 使用 `version: 2`，旧策略缓存会在下次读取时重新发现；无需删除缓存目录，也不修改实例配置或其它数据。

`drain()` 等待已接收的读取、后台刷新和写入全部结束。测试在删除临时目录之前必须等待它；`getLogo()` 的超时返回不代表后台收尾已经完成。
