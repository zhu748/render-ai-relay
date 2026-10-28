# Render AI Relay

部署在 Render 的固定目标 HTTP 反向代理，专门处理 AI 接口长时间等待的问题。只需配置目标域名；不登记渠道，不登记模型，不转换 AI 协议，不改写请求正文。

**对可保活的 JSON / SSE 请求，只要还没有实际正文可以交给客户端，就发送空白换行。流式和非流式都覆盖，也不需要等上游先返回响应头。** 默认转交请求后 1 秒发送首个空白，之后空闲时每 1 秒一次。将 `HEARTBEAT_START_DELAY_SECONDS=0` 可立即发送第一个空白。

版本 **1.7.0**。本项目已经完成本地验证，尚未连接你的真实目标站、部署到你的 Render 账户或经过你的 Cloudflare 域名。

仓库：[zhu748/render-ai-relay](https://github.com/zhu748/render-ai-relay)。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zhu748/render-ai-relay)

## Render 部署

### 使用 Blueprint

1. 点击上面的 **Deploy to Render** 按钮；或在 Render 选择 **New → Blueprint**，连接 `zhu748/render-ai-relay`。
2. 如果使用自己的仓库，先 Fork 本仓库，或将 `render-ai-relay` 文件夹**里面的文件**上传到仓库根目录；`package.json` 和 `render.yaml` 应直接位于根目录。
3. 创建时填写唯一必填项 `TARGET_URL`，例如 `https://your-ai-site.example`。
4. 等待部署完成，访问 `https://你的服务.onrender.com/__proxy_health`，应返回包含 `ok: true` 和版本号的 JSON。
5. 将客户端的 API Base URL 换成中转域名，**API Key 仍填写目标站原来的 Key**。模型名和请求参数也保持原来的值。

提供的 `render.yaml` 使用 Free 实例用于开始测试，没有数据库和持久磁盘。需要长期运行时，可在 Render 中选择适合自己的实例类型。

Blueprint 默认关闭跟随源码推送的自动部署，便于自行决定何时更新；可在 Render 控制台开启自动部署。

### 查看后台与升级现有服务

**根路径 `/` 继续转发目标网站。中转自己的管理页面是 `https://你的中转域名/__proxy/`。** 目标网站内显示的日志属于目标网站，不是本项目的运行日志。

1. 已部署旧版的服务：在 Render → 当前服务 → **Environment** 添加 `ADMIN_TOKEN`，值设为你自己的随机管理密钥。这不是目标站 API Key，也不是 GitHub Token。
2. 在 **Manual Deploy → Deploy latest commit** 部署最新代码。源码推送不会自动更新关闭了自动部署的实例。
3. 打开 `/__proxy/`，输入 `ADMIN_TOKEN` 连接。使用 Blueprint 新建服务会自动生成该环境变量，可在 Render 的 Environment 中查看。
4. 再发一次实际非流式请求，查看它是否出现、处于哪一阶段、发出了几次心跳，以及上游 / 中转各自的 HTTP 状态码。

后台显示当前实例的活动请求和最近 200 条事件，前台每 2 秒增量刷新，页面隐藏时降为 30 秒。事件游标包含实例标识，重启、游标过期或切换实例时自动重新读取。日志保存在内存，进程重启后清空，多实例之间不共享。未设置 `ADMIN_TOKEN` 时可打开帮助页面，但不能读取日志或运行测试。管理密钥只通过 `X-Admin-Token` 请求头发送，不接受 URL 参数，不写入浏览器持久存储，也不转发到目标站。

后台同时显示请求正文内存、JSON 响应暂存量、SSE 缓冲量及各自上限，并显示进程 RSS、JS 堆、事件循环 P99 延迟、待清理文件预算和磁盘剩余空间。RSS 在受限环境中可能不可读，其他指标仍可使用。请求详情还显示是否复用上游连接、是否正在等待下游读取。连接尚未完成时也可以断开；重连、断开会取消旧的状态请求和心跳测试。心跳测试超过预定时长 15 秒仍未结束时，会报告链路超时；实例退出期间显示退出状态并禁用新测试。

“请求透传核对”可以选择一条请求，查看收到 / 发出的请求头名称、调整 / 移除 / 新增的头名称、原始正文长度、正文是否已提交给上游连接，以及 Origin / Referer 是否与目标站同源。不记录这些头的值；“已提交”不代表上游已成功处理，“不同源”也不代表请求一定失败。

管理页提供 10 秒 / 135 秒模拟等待测试，等待期间按同样的心跳配置输出空白，最后返回 JSON。通过 CF 域名打开页面再测试，可以观察首字节时间、实际收到的数据块和最大接收间隔。**测试不会调用目标站，不消耗模型额度；它只检查访问域名到 Render 这一段，不能证明目标站内部的 AI 请求正常。** 测试同时最多两条，每条最多 180 秒，停止测试会清理计时器。

无需打开管理页也能查看日志：Render → 当前 Web Service → **Logs**。项目现在主动记录 `request_received`、`upstream_request`、`heartbeat_started`、`upstream_headers`、`relay_error` 和 `request_finished`，包含相同的 `request_id`。响应头中的 `X-Render-Relay-Request-Id` 可用于对应查找；`X-Render-Relay-Version` 可核对部署版本。

### 页面能打开，不代表接口一定经过中转

本项目转发根路径时会原样返回目标 HTML，不修改 HTML、JavaScript 内的 URL、Cookie 域、CSP 或重定向地址。如果目标网页写着 `fetch('https://原目标域名/api')`、使用原域名的 `<base>`，或跳转回原域名，那一段请求可能绕开中转。应将实际 API Base URL 配为中转地址；只有进入中转的请求才会出现在这里。

浏览器从中转域名打开网页时，请求的来源与 Cookie 行为也可能变化。项目保留**收到的** `Origin` / `Referer` 值，不自动改成目标域名；浏览器没有发送的原域名 Cookie 无法由中转补回。目标站 `Set-Cookie` 中原有的 Domain 和 Path 也不会改写。因此，请求正文和业务头透传不等于完整复制原域名浏览器会话。目标站若校验来源、登录状态、IP 或 proof 与会话的关联，需要对照真实请求单独处理。

如果日志显示本中转持续发心跳，但目标站自己的浏览器桥接器访问 Google 等上游时仍在约 126 秒失败，需要检查目标站内部连接。外层中转发出的空白不能重置另一段连接的读取超时，也不会把原始非流式请求偷偷改成流式。

### 手动创建 Web Service

如果不用 Blueprint，创建 **Web Service**，选择源码仓库并填写：

| Render 设置 | 值 |
| --- | --- |
| Runtime / Language | Node |
| Root Directory | 仓库根目录，通常留空 |
| Build Command | `npm ci --omit=dev && npm run check` |
| Start Command | `npm start` |
| Health Check Path | `/__proxy_health` |
| 环境变量 `TARGET_URL` | `https://你的目标站域名` |
| 环境变量 `NODE_VERSION` | `24` |

服务监听 `0.0.0.0` 和 Render 提供的 `PORT`，本地默认端口为 `10000`。不需要自行在 Render 配置反向代理或申请源站 TLS 证书。

### 目标地址与路径

`TARGET_URL` 是固定目标，调用方不能用参数把它换成其他网站。客户端请求路径和查询串直接追加到这个地址的路径后，不解码、不重新排列，也不自动跟随目标站返回的重定向。

| TARGET_URL | 客户端请求 | 目标站实际收到 |
| --- | --- | --- |
| `https://ai.example` | `/v1/chat/completions?x=1&x=2` | `https://ai.example/v1/chat/completions?x=1&x=2` |
| `https://ai.example/backend` | `/v1/messages` | `https://ai.example/backend/v1/messages` |

如果客户端自己会追加 `/v1`，`TARGET_URL` 一般不要再带 `/v1`，否则路径会重复。也不要把目标填成这个中转服务自己的域名。

## 绑定域名并开启 CF 小黄云

1. 在 Render 的 **Settings → Custom Domains** 中添加中转域名，例如 `relay.example.com`。
2. 在 Cloudflare 为 `relay` 添加 CNAME，目标填 Render 分配的 `你的服务.onrender.com`。先选 **DNS only / 灰云**，按 Render 页面要求完成域名验证。
3. 等 Render 显示证书已签发且有效，再把该 CNAME 改为 **Proxied / 小黄云**。SSL/TLS 使用 Full；Render 证书验证正常后也可以使用 Full (strict)。
4. 用自定义域名验证健康检查和一次 AI 请求。不要为 AI 接口设置缓存或会缓冲响应的其他中间层。

Cloudflare 回源到的是 Render 上的这个项目，项目再连接目标 AI 站。项目发出的空白会穿过 Render 和 CF 回到客户端。

Render Free 在连续 15 分钟无入站流量时会休眠，下次请求有冷启动等待；**进程还没启动时，本项目无法发送心跳**。Free 实例也可能重启，心跳不是长期可用性的保证。

## 部署保活：定时访问 URL

支持参考 gcli2api 保活机制实现的定时 GET 探测。部署保活定时访问指定 URL，请求心跳在等待 AI 响应时发送空白；两项功能独立配置。

### 使用环境变量

在 Render → 当前服务 → Environment 中添加以下配置，再重新部署：

```dotenv
KEEPALIVE_URL=https://你的服务.onrender.com/keepalive
KEEPALIVE_INTERVAL=60
KEEPALIVE_TIMEOUT_SECONDS=30
```

也可将 URL 配为自己通过 Cloudflare 访问的域名，例如 `https://relay.example.com/keepalive`。填写完整 HTTP(S) 地址。不要填写模型生成接口或代理根路径；配置的地址会实际收到 GET 请求。

`/keepalive` 是本实例的轻量公开端点，GET / HEAD 返回空正文和 HTTP 200，不要求中转密钥、不占转发名额、不访问目标站。其他方法返回 405；实例退出期间返回 503。外层 CDN 应放行该路径并避免缓存，服务响应已设置 `Cache-Control: no-store`。

URL 留空时默认不创建后台探测任务。启用后服务开始监听才发出首次探测，随后从上一条探测结束起等待指定间隔，始终串行。每次有独立的总超时，收到 HTTP 响应头即结束，不下载整个正文，不自动跟随重定向。2xx 记为成功；其他状态或网络错误记为失败，并在下一正常间隔继续探测。退出或更改配置会取消旧请求和计时器。

### 使用管理页

打开 `/__proxy/`，输入 `ADMIN_TOKEN`，在“部署保活”中填写 URL 和间隔，或点击“使用当前服务地址”，再“保存并应用”。清空 URL 后保存即可关闭。页面显示运行状态、请求次数、最近状态码和错误码；断开管理页面不会关闭服务端保活任务。

保存相同配置不会重启任务、清零统计或提前发起探测。面板保存会检查读取配置时的版本；如果另一管理会话已修改配置，返回 HTTP 412 并保留当前输入，点击“重新读取配置”后再编辑。版本只随配置变更而更新，后台探测结果变化不会造成冲突。

设置接口 `GET /__proxy/keepalive` 返回 `revision`；自建管理客户端可在 PUT 的 JSON 中增加 `expected_revision`，防止过期写入。不携带该可选字段的旧客户端保持原有行为。接口仍需 `X-Admin-Token`，正文上限 8 KiB，同时最多两个上传，默认 15 秒上传期限；超额返回 429，超时返回 408。取消、断连和退出都会清理未完成上传。

**面板修改只对当前实例生效，进程重启后恢复环境变量配置。** 非空 `KEEPALIVE_URL` / `KEEPALIVE_INTERVAL` 优先，并锁定对应的面板字段；需要修改时编辑环境变量后重新部署。空值不锁定字段。Blueprint 默认提供空 URL 和 60 秒间隔，因此新服务不会自动向外部发请求；如需从面板调整默认间隔，可先清空相应环境变量并重新部署。

保活 URL 只向持有管理密钥的设置接口返回，不出现在运行日志或通用状态数据中；探测不会携带目标站 API Key、中转密钥或管理密钥。

此任务随进程运行。进程已休眠、停止或被平台杀掉时，自身任务也会停止；它不能保证免费实例始终在线，也不能延长单次 AI 请求的总超时。

## 怎样保持请求原样

- HTTP 方法、路径、查询参数、请求正文原始字节保持不变。即使请求正文内有特殊 JSON 格式、空格、自定义字段、未知模型名，也不会重建 JSON。
- `Authorization`、`x-api-key`、`Cookie` 和自定义业务请求头透传。不在服务端保存或替换你的目标站 Key。
- 读取请求内的 `stream: true` 仅用于在尚无上游响应头时判断应声明 JSON 还是 SSE，**不会修改这个字段**。也可以用 `Accept: text/event-stream` 指示 SSE。
- `Host` / TLS SNI 使用目标域名。逐跳请求头按 HTTP 规则移除；传输长度按原始正文计算。支持保活的请求会把 `Accept-Encoding` 设为 `identity`，避免将空白混进压缩数据。
- 目标响应的 JSON 正文保持原始字节，只在前面追加空白；SSE 保留原事件字节，仅在安全边界插入空白。如果已提前发过心跳，会移除上游开头可选的 UTF-8 BOM，防止它被当成首条事件字段的一部分；未提前发心跳时保留 BOM。HTTP 版本、请求头大小写和顺序不保证与直连逐字节一致。

默认不改写 CORS；目标站 CORS 头按下面的响应头限制透传。配置 `CORS_ORIGINS` 后，中转为精确匹配的浏览器 Origin 提前设置 CORS，支持 Authorization、X-Proxy-Token 等请求头的预检，并覆盖上游 CORS 允许源。管理接口不启用跨域访问。此配置不启用跨域 Cookie 凭据，不替代中转或上游鉴权。未配置时，提前心跳之后仍无法补发上游稍后返回的 CORS 头。WebSocket、CONNECT 隧道以及任意二进制格式的心跳不在本项目范围内。

## 管理入口隔离

需要访问上游网页时，建议给中转绑定两个独立域名，例如 `relay.example.com` 和 `admin.example.com`，然后设置：

```dotenv
ADMIN_HOSTS=admin.example.com
```

通过 `https://admin.example.com/__proxy/` 管理。该主机的普通路径不会返回任何上游内容；API 域名上的管理路径返回 403。白名单使用 HTTP Host，不接受协议或路径；本地非默认端口需包含端口，例如 `127.0.0.2:10000`。仍然必须使用 `ADMIN_TOKEN`，Host 限制不代替认证。

不配置时保留旧版同域入口。上游网页与同域管理页共享浏览器信任域，管理页 CSP 不能完整隔离上游脚本。默认拒绝带 `Service-Worker` 或 `Sec-Fetch-Dest: serviceworker` 的上游注册请求；需要 PWA 时，先隔离管理域名，再显式设置 `ALLOW_UPSTREAM_SERVICE_WORKERS=true`。已经注册的 Worker 不会自动卸载，迁移时应使用独立的新管理域名，或先清除旧域名的站点数据。

## 按接口选择心跳模式

| 模式 | 等待上游响应头时 | 收到响应头后 | 状态与业务头 |
| --- | --- | --- | --- |
| `early` | 提前输出猜测格式的空白 | JSON / SSE 安全保活 | 提前输出后不能补改 |
| `after-headers` | 等待 | JSON / SSE 安全保活 | 保留实际状态及业务头，表示头可能调整 |
| `off` | 等待 | 原样透传 | 保留，不做 JSON / SSE 完整性检查 |

例如将默认模式设为等待响应头，仅对生成接口提前心跳，下载接口完全透传：

```dotenv
HEARTBEAT_MODE=after-headers
HEARTBEAT_ROUTES=[{"prefix":"/v1/chat/completions","mode":"early"},{"prefix":"/v1/files/","mode":"off"}]
CORS_ORIGINS=https://client.example
```

规则按最长路径前缀匹配，优先于默认模式和旧的前缀名单。全局心跳间隔为 0、HEAD / OPTIONS、Range、网页导航以及 `X-Proxy-Heartbeat: off` 等安全绕过始终优先。`after-headers` 无法保护上游尚未返回响应头的长等待。

## 心跳行为

### 尚未收到目标响应头

从请求发送给目标站开始计时。默认 1 秒后还没有实际正文时，就提交响应并发送两个真实的 LF 字节，即 `\n\n`（不是反斜杠文字）。之后每隔 1 秒继续发送。

请求内 `stream: true` 或 `Accept: text/event-stream` 对应 SSE 响应头；其余可保活请求先按 JSON 处理。两个空白换行既是合法的 JSON 前置空白，也是 SSE 中会被忽略的空事件。浏览器页面导航、`Accept: text/html` 和 `Sec-Fetch-Dest` 指明的网页 / 静态资源会直接透传，避免把慢网页错误地声明成 JSON。

如果目标站实际上返回 NDJSON、HTML、下载文件或其他格式，而上游响应头又非常晚，本项目无法凭空预知格式。请将这些路径排除保活，见下文的前缀设置或单次绕过。

### 非流式 JSON

目标 JSON 会先写入该请求独立的临时文件，同时逐块检查语法、完整性和 UTF-8。**文件尚未接收完整时，继续定时发送空白**；验证完成后停止心跳，原样发送整个文件并删除临时文件。检查只保留当前语法和嵌套状态，不将完整响应加载到内存，也不重新序列化。

未闭合字符串、缺少括号、非法数字、尾随垃圾或非法 UTF-8 会返回 `invalid_upstream_json`，不会作为正常成功结果交付；默认最多嵌套 1024 层容器，超限返回 `json_nesting_limit`。错误响应不包含上游正文。尚未发送心跳时 HTTP 状态为 502；已经发送心跳时 HTTP 状态保持已提交的值，正文返回 `error.status: 502`。显式关闭心跳时仍原样透传，不做这些检查。

请求分类只识别有界长度的顶层键，不再完整 `JSON.parse` 请求；大正文每扫描 256 KiB 让出事件循环。支持转义的 `stream` 键、重复键的最后值及 Accept 权重；`q=0` 不会被当成 SSE 偏好。无效或过深的 JSON 仍原样交给上游，此时等待真实响应头再启用心跳。

这样即便上游在一个 JSON 字符串中间长时间停顿，也不会把保活换行插进字符串。独立临时文件根目录缺失时会自动创建，临时文件权限为 `0600`，正常完成、报错和客户端取消时均清理；每个目录记录当前主机、PID 和随机实例标识；初始化时只回收有合法标记且原 PID 已不存在的目录，保留未知目录、符号链接、其他主机与活动 PID 的文件。旧版本无标记文件不会自动删除。删除失败保留预算并后台重试，实际删除后才释放。创建文件前检查可用空间，写入失败也返回独立的存储错误。Render 重建实例时会清除临时文件系统。默认单个 JSON 响应上限为 256 MiB。

### SSE 流式

**未完成的 SSE 事件暂存在中转内，完整事件到达后立即按背压转发。** 因而上游即使停在半条 `data:` 字段内部，中转也可以在客户端当前的安全边界继续发送空白，不必等待上游补齐事件。仅包含注释的完整行可以立即透传；事件内部的注释与对应事件一起转发。

支持跨网络数据块拆分的 UTF-8 BOM、CR、LF 和 CRLF。识别 BOM 时最多暂存两个前缀字节，不会把心跳插入 UTF-8 BOM 内部；只收到完整 BOM 时，仍会继续保活。

单个事件默认上限 16 MiB，所有请求的 SSE 缓冲共享 64 MiB 预算；缓冲采用固定大小块，避免大量微小分块造成对象堆积。大事件尚在等待下游排空时仍占用预算。超限会返回明确的 SSE 错误，取消、超时和完成都会释放预算。图片等大事件可按需调整上限。

如果上游在未完成的事件、字段行或 BOM 前缀中结束，会报告 `incomplete_sse_event`，不会把半条字段接到错误事件前面，也不会将它记为成功。中转不解释模型的 `[DONE]`、finish_reason 或业务完成条件；完整事件之后的正常 EOF 仍由业务客户端判断是否完成。关闭心跳时仍采用原始字节透传，不做事件缓冲与完整性检查。

### 状态码和响应头的取舍

如果目标站在首个心跳前完成响应，可以保留真实状态码和响应头。

**如果已经在目标响应头到来前开始发心跳，HTTP 200 和猜测的 Content-Type 就已经提交，之后无法修改。** 后续才知道的响应头（例如 `Set-Cookie`、速率限制头）也不能补发。目标站后续返回 JSON 错误时，原始错误 JSON 会接在空白后，客户端需要检查正文，不能只检查 HTTP 200。

如果目标站随后返回与已提交格式不兼容的内容，项目会返回可解析的 `relay_error`，而不会把 HTML 或 gzip 字节接进 JSON。连接错误、总超时、超出响应大小上限等错误也会尽量以 JSON 或 SSE 错误事件结束；已经开始传输的 JSON / 透明正文发生错误时，只能关闭连接，避免在半条正文中追加错误。

这是提前发送响应正文的 HTTP 限制。若需要保留目标状态码和业务响应头，可选择 `after-headers` 模式；需要逐字节正文和所有表示头均透明透传时，请选择 `off`。等待上游响应头期间，这两种模式都不会提前发送空白。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TARGET_URL` | 必填 | 固定目标 HTTP(S) 地址，可带路径前缀，不带密钥、查询串、片段 |
| `PORT` | `10000` | 监听端口，Render 会提供 |
| `HEARTBEAT_START_DELAY_SECONDS` | `1` | 首个空白前等待秒数；`0` 表示立即发送；最大 `60` |
| `HEARTBEAT_INTERVAL_SECONDS` | `1` | 后续空白间隔；`0` 关闭保活；最大 `60` |
| `HEARTBEAT_MODE` | `early` | 默认模式：`early`、`after-headers`、`off` |
| `HEARTBEAT_ROUTES` | `[]` | 路由规则 JSON 数组，最长路径前缀优先，最多 64 条 |
| `KEEPALIVE_URL` | 空 | 部署保活 URL；空值默认禁用，填写本实例公开的 `/keepalive` 地址即可启用；非空环境变量锁定面板 URL 字段 |
| `KEEPALIVE_INTERVAL` | `60` | 每次探测结束后的等待秒数，整数 5–86400；非空环境变量锁定面板间隔字段 |
| `KEEPALIVE_TIMEOUT_SECONDS` | `30` | 单次部署保活总超时，1–300 秒；不影响 AI 转发期限 |
| `ADMIN_REQUEST_TIMEOUT_SECONDS` | `15` | 管理设置正文的上传期限，1–120 秒；与 AI 请求总期限独立 |
| `UPSTREAM_TIMEOUT_SECONDS` | `1800` | 整次上游请求总期限，心跳不延长它；`0` 不设置总期限 |
| `CONNECT_TIMEOUT_SECONDS` | `30` | 建立上游 TCP / TLS 连接的期限 |
| `TCP_KEEPALIVE_SECONDS` | `15` | 两侧 TCP keepalive 的首次探测延迟，1–300 秒；不代替应用层心跳 |
| `UPSTREAM_IDLE_SOCKET_TIMEOUT_SECONDS` | `15` | 回收空闲上游连接，最大 300 秒；复用时清除该期限，不影响活动 AI 请求；也遵循更短的上游 Keep-Alive 提示 |
| `DOWNSTREAM_STALL_TIMEOUT_SECONDS` | `120` | 连续等待下游排空写入队列的期限，最大 3600 秒；`0` 关闭；不会因上游尚无数据而触发 |
| `SHUTDOWN_GRACE_SECONDS` | `25` | 退出时等待已有请求完成的秒数，0–300；不得超过平台实际终止宽限期；之后额外保留最多 1 秒发送错误与清理 |
| `MAX_REQUEST_BYTES` | `33554432` | 原始请求正文大小上限，32 MiB |
| `MAX_JSON_RESPONSE_BYTES` | `268435456` | 单个临时 JSON 响应大小上限，256 MiB |
| `MAX_JSON_DEPTH` | `1024` | 保活 JSON 响应允许的容器嵌套深度，整数 1–16384；不限制请求正文或透明响应 |
| `MAX_CONCURRENT_REQUESTS` | `32` | 同时处理的转发请求上限，含正在上传的请求 |
| `MAX_BUFFERED_REQUEST_BYTES` | `67108864` | 原始正文字节共享的 64 MiB 逻辑预算，不等于进程 RSS |
| `MAX_BUFFERED_RESPONSE_BYTES` | `536870912` | 当前进程所有临时 JSON 响应共享的 512 MiB 暂存预算，发送期间继续占用，删除文件后释放 |
| `MAX_SSE_EVENT_BYTES` | `16777216` | 单个 SSE 事件上限，16 MiB |
| `MAX_BUFFERED_SSE_BYTES` | `67108864` | 当前进程共享的 SSE 正文缓冲预算，64 MiB；这是逻辑正文大小，不是进程 RSS |
| `TEMP_DIRECTORY` | 系统临时目录下的 `render-ai-relay` | 自动创建的独立临时文件根目录，可指定其他可写目录 |
| `TEMP_MIN_FREE_BYTES` | `16777216` | 创建 JSON 暂存文件前预留的磁盘空间，默认 16 MiB；`0` 仅关闭最低空间阈值 |
| `TEMP_CLEANUP_RETRY_SECONDS` | `5` | 删除失败后的后台重试间隔，0.05–300 秒；成功删除才释放预算 |
| `MAX_PENDING_TEMP_CLEANUPS` | `64` | 待清理目录数量上限，1–1024；达到后拒绝新 JSON 暂存，避免大量小文件撑大清理队列 |
| `HEARTBEAT_PATH_PREFIXES` | 空 | 逗号分隔的客户端路径前缀；空表示所有普通路径；例如 `/v1/,/api/` |
| `PROXY_TOKEN` | 空 | 可选的中转访问密钥，客户端放在 `X-Proxy-Token`，不替代上游 Authorization |
| `ADMIN_TOKEN` | 空；Blueprint 新建时自动生成 | 独立管理密钥，用于 `/__proxy/` 的日志与心跳测试，空值禁用诊断数据访问 |
| `ADMIN_HOSTS` | 空 | 专用管理 Host 白名单，逗号分隔；这些主机禁止上游内容，其他主机禁止管理路径 |
| `ALLOW_UPSTREAM_SERVICE_WORKERS` | `false` | 是否允许上游 Service Worker 注册；启用管理密钥时，允许注册必须先配置独立管理域名 |
| `CORS_ORIGINS` | 空 | 精确的浏览器 API Origin 白名单，逗号分隔；不支持通配符和跨域 Cookie 凭据 |

默认所有普通方法都可保活，不要求请求体一定是 JSON 或带 `stream: false`。`HEAD`、`OPTIONS`、带 `Range` 的请求、网页导航 / 已标明的静态资源以及健康检查不插入空白。`/__proxy` 与 `/__proxy/` 路径前缀保留给管理功能；`/keepalive` 保留给部署探测，均不向目标站转发。

数字环境变量为空或仅含空白时使用默认值；关闭期限或心跳时请明确填写支持该选项的 `0`，避免空白意外被解释为零。

单次请求需要保持完全透明时，可以添加 `X-Proxy-Heartbeat: off`。这个控制头和 `X-Proxy-Token` 都会在转发到目标站前移除。已明确识别为二进制、压缩、无正文、部分内容或显式声明非 UTF-8 / US-ASCII 字符集的 JSON 响应也不注入空白；如果此前已经开始了猜测格式的心跳，则按不兼容响应处理。

压缩的请求正文仍会按原始字节发送，但无法直接从压缩数据中读出 `stream`。此类 SSE 请求请同时提供 `Accept: text/event-stream`，或者绕过保活。

## 验证

健康检查只检查中转进程，不请求目标站：

```bash
curl https://你的中转域名/__proxy_health
```

实际非流式请求示例，密钥填写目标站的原有密钥：

```bash
curl -N -i --max-time 1800 https://你的中转域名/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TARGET_KEY' \
  -d '{"model":"你的原始模型名","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

等待期间看到空白行，最后看到完整 JSON 即符合预期。流式测试把 `stream` 改成 `true`。如果设置了 `PROXY_TOKEN`，额外增加 `-H 'X-Proxy-Token: 你的中转密钥'`。

客户端自己的**总超时**需要大于实际生成时间，例如 1800 秒。空白只能防止无数据等待，不能突破客户端固定总时长，也不能修复目标站自己返回的超时错误。若目标站内部也经过 CF，目标站内部的回源超时仍需由目标站处理。

## 本地运行和测试

需要 Node.js 24.5 或更高的 24.x 版本，无第三方运行时依赖。定时器使用单调时钟，按最后一次实际输出时间重新计算下一次心跳，避免定时器提前触发时漏发一整个周期。

```bash
cp .env.example .env
# 编辑 .env 中的 TARGET_URL
npm ci
npm start
```

```bash
npm run check
npm run bench:request
npm run test:load
node scripts/slow-check.js
# 模拟上游在半条 SSE 事件内停顿 135 秒
SMOKE_RESPONSE_KIND=sse node scripts/slow-check.js
```

`npm run check` 运行语法检查与集成测试；Render Blueprint 在构建时也执行这组检查。GitHub Actions 会在推送和拉取请求时执行相同检查，再分别进行 5 秒 JSON 等待与半条 SSE 事件等待测试，所用 GitHub Actions 已固定到提交 SHA。

`slow-check.js` 在本机创建模拟上游，故意等 135 秒才返回响应头，使用默认 1 秒首包和 1 秒心跳，在客户端启用 3 秒读空闲超时，验证最终 JSON 保持不变。这是本地链路测试，不等于已经验证你的 Render / CF / 目标站完整链路。

项目包含 Dockerfile，也可以用 `docker build -t render-ai-relay .` 后，以 `-e TARGET_URL=https://你的目标站 -p 10000:10000` 运行。

服务默认最多接收 32 个并发转发请求，请求正文共享 64 MiB 逻辑预算；正文使用至多 64 KiB 的块收集并按背压发送，不创建整份拼接副本，块内未用空间和网络缓冲仍不计入该预算；超出时在访问目标站前返回 HTTP 503 和 `Retry-After: 1`。客户端上传中断时会释放资源；正文发送给目标站后即释放内存预算，不会在模型推理期间一直占用。健康检查不占用转发名额。

请求头已声明正文超过 `MAX_REQUEST_BYTES` 时，无需等待上传即可返回 413。提前拒绝尚未上传完的请求时，中转在错误响应发出后关闭连接，避免继续接收无限上传。

JSON 响应除单条上限外，还受当前进程共享暂存预算限制。超出共享预算时返回 `response_storage_limit`，错误中的状态为 503；此前未发心跳时，HTTP 状态也为 503，并包含 `Retry-After: 1`。取消、超时和正常完成都会清理临时文件，删除完成后才释放暂存预算和并发名额；删除失败会保留对应预算并记录清理失败事件。该预算不统计进程启动前遗留的临时文件；1.7.0 开始会保守回收已标记的孤立目录，并检查文件系统可用空间。

JSON 临时文件不需要持久磁盘。空 JSON 或仅含空白的 JSON 响应会转换为明确的 `empty_upstream_response` 错误；SSE 在安全事件边界断开时会尽量发送错误事件。

两侧连接开启 TCP keepalive；上游空闲连接默认 15 秒回收，优先复用最近使用的连接，并参考上游更短的 Keep-Alive 提示，降低复用陈旧连接的风险。活动请求不受空闲连接池期限影响。TCP 探测不能延长 Cloudflare 的 HTTP 超时或复活已断开的连接。

如果客户端持续不排空写入队列，默认 120 秒后记录 `downstream_stalled`，关闭该连接并取消对应上游、释放资源。即使最后一段写入尚未达到背压阈值，也会检查；SSE 调用 `end()` 后仍等待实际发送完成，才释放并发名额和记录成功。超时或退出取消时会销毁尚未排空的连接。极慢的客户端可按需提高或关闭此保护。

收到 `SIGTERM` / `SIGINT` 后进入退出状态，健康检查返回 503，新转发与测试请求停止接受，已有响应继续处理，并及时关闭随之空闲的 keep-alive 连接。默认宽限 25 秒；到期后在可解析的 JSON / SSE 边界发送 `server_shutting_down`，取消上游并清理，额外最多 1 秒后强制终止。已发送部分透明正文的连接及不读取错误的客户端只能关闭。平台若更早强制杀进程，应用无法再发送错误。不支持的 Upgrade / CONNECT 请求在拒绝响应发出后直接释放连接，不等待客户端关闭。

日志包含方法、路径（不含查询串，最多 256 字符）、阶段、耗时、心跳计数和状态码，不记录请求正文、响应正文、Authorization、Cookie 或其他认证头。请不要把密钥放进路径本身。不自动重放转发请求，避免 AI 生成被重复提交。部署保活独立记录 `keepalive_started`、`keepalive_result` 和 `keepalive_stopped`，不记录 URL、查询串或响应正文。

## 额外验证

`npm run check` 同时核对数字配置默认值、环境变量示例、Blueprint 与 README，防止配置说明漂移。测试需要 OpenSSL 命令生成临时 HTTPS 测试证书。`npm run bench:request` 使用约 5.7 MiB 的合成正文，报告分类耗时、采样堆增量和事件循环延迟，结果取决于机器负载。

`npm run test:load` 通过本地模拟上游接收 32 条并发请求，每条约 1 MiB；验证第 33 条返回 503、健康检查仍可用、响应对应关系及完成后的资源计数归零。它不是 Render 实例容量承诺。

真实浏览器检查是可选的开发验证，不增加生产依赖：

```bash
npm install --no-save --package-lock=false --ignore-scripts playwright@1.62.1
npx playwright install chromium --only-shell
npm run test:browser
```

它检查默认注册拦截、上游 Worker 与独立管理源的隔离、管理密钥不泄漏、设置保存及 10 秒心跳探测。GitHub Actions 已加入独立浏览器和 Docker 构建任务；手动运行 workflow 时勾选 `long_tests`，可额外运行两类 135 秒长等待。

管理密钥保护的 `/__proxy/metrics` 提供 JSON 累计指标；`/__proxy/status` 同时返回资源、阶段耗时、指标及事件游标。增量读取使用 `?since=游标&stream=实例标识`，遇到重启、游标过期或实例变化时以 `events_reset` 告知调用方重置事件缓存。原有不带游标的调用仍返回最近 200 条事件。

## 文件

- `src/proxy.js`：原始请求转发、心跳、JSON 暂存、SSE 安全转发与连接清理。
- `src/config.js`：集中定义数字设置、默认值及新策略的校验。
- `src/policy.js`：有界请求分类、Accept 权重、路由策略、管理主机与 API CORS。
- `src/storage.js`：私有临时目录、空间检查、清理重试与保守孤立文件恢复。
- `src/metrics.js`：内存、事件循环、累计结果及阶段耗时指标。
- `src/sse.js`：有容量上限的 SSE 事件缓冲、BOM、换行和完整性检查。
- `src/json.js`：逐字节 JSON 语法、UTF-8 和嵌套深度校验。
- `src/request.js`：共享的原始请求正文收集、容量限制和取消处理。
- `src/errors.js`：统一的中转错误类型。
- `src/keepalive.js`：URL 定时 GET 探测、环境变量优先、超时与任务清理。
- `src/server.js`：Render 启动入口、端口配置与退出处理。
- `src/diagnostics.js`：受管理密钥保护的运行状态、最近事件和流式心跳测试。
- `src/admin.html` / `src/admin.js`：`/__proxy/` 诊断管理页。
- `render.yaml`：Render Blueprint。
- `.env.example`：可选配置示例。
- `Dockerfile`：Docker 部署。
- `test/proxy.test.js`：本地集成测试。
- `test/admin.test.js`：管理页连接、重连、取消和测试超时的交互逻辑测试。
- `test/server.test.js`：真实进程启动、配置错误保密和退出排空测试。
- `test/sse.test.js`：事件分块、换行、UTF-8、注释、容量与 EOF 检查。
- `test/keepalive.test.js`：定时探测、禁用、超时、取消、非重叠、配置变更和敏感信息保护。
- `test/json.test.js` / `test/request.test.js`：JSON 分块及语法变异校验、上传取消与监听器清理。
- `scripts/slow-check.js`：135 秒真实等待验证。
- `.github/workflows/ci.yml`：GitHub 自动检查与短时间心跳验证。

## 参考文档

- [Render Web Services](https://render.com/docs/web-services)
- [Render Blueprint YAML](https://render.com/docs/blueprint-spec)
- [Render Cloudflare DNS 配置](https://render.com/docs/configure-cloudflare-dns)
- [Render Free 实例限制](https://render.com/docs/free)
- [Render 日志](https://render.com/docs/logging)
- [Cloudflare 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
- [RFC 8259：JSON 语法与空白](https://www.rfc-editor.org/rfc/rfc8259.html#section-2)
- [WHATWG SSE 解析规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)
- [Node.js 24 HTTP 连接池与超时](https://nodejs.org/docs/latest-v24.x/api/http.html)
- [gcli2api 旧版部署保活机制参考](https://github.com/su-kaka/agy2api/blob/faead1475c40f9bfca44a94ecfa38e83065a9eb7/src/keeplive.py)：参考定时访问 URL 的机制，使用独立 Node.js 实现；未引入 Python 项目或依赖。
