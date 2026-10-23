# Render AI Relay

部署在 Render 的固定目标 HTTP 反向代理，专门处理 AI 接口长时间等待的问题。只需配置目标域名；不登记渠道，不登记模型，不转换 AI 协议，不改写请求正文。

**只要还没有实际正文可以交给客户端，就发送空白换行保活。流式和非流式都覆盖，也不需要等上游先返回响应头。** 默认转交请求后 1 秒发送首个空白，之后空闲时每 1 秒一次。将 `HEARTBEAT_START_DELAY_SECONDS=0` 可立即发送第一个空白。

版本 **1.1.0**。本项目已经完成本地验证，尚未连接你的真实目标站、部署到你的 Render 账户或经过你的 Cloudflare 域名。

仓库：[zhu748/render-ai-relay](https://github.com/zhu748/render-ai-relay)。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zhu748/render-ai-relay)

## Render 部署

### 使用 Blueprint

1. 点击上面的 **Deploy to Render** 按钮；或在 Render 选择 **New → Blueprint**，连接 `zhu748/render-ai-relay`。
2. 如果使用自己的仓库，先 Fork 本仓库，或将 `render-ai-relay` 文件夹**里面的文件**上传到仓库根目录；`package.json` 和 `render.yaml` 应直接位于根目录。
3. 创建时填写唯一必填项 `TARGET_URL`，例如 `https://your-ai-site.example`。
4. 等待部署完成，访问 `https://你的服务.onrender.com/__proxy_health`，应返回 `{"ok":true}`。
5. 将客户端的 API Base URL 换成中转域名，**API Key 仍填写目标站原来的 Key**。模型名和请求参数也保持原来的值。

提供的 `render.yaml` 使用 Free 实例用于开始测试，没有数据库和持久磁盘。需要长期运行时，可在 Render 中选择适合自己的实例类型。

Blueprint 默认关闭跟随源码推送的自动部署，便于自行决定何时更新；可在 Render 控制台开启自动部署。

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

## 怎样保持请求原样

- HTTP 方法、路径、查询参数、请求正文原始字节保持不变。即使请求正文内有特殊 JSON 格式、空格、自定义字段、未知模型名，也不会重建 JSON。
- `Authorization`、`x-api-key`、`Cookie` 和自定义业务请求头透传。不在服务端保存或替换你的目标站 Key。
- 读取请求内的 `stream: true` 仅用于在尚无上游响应头时判断应声明 JSON 还是 SSE，**不会修改这个字段**。也可以用 `Accept: text/event-stream` 指示 SSE。
- `Host` / TLS SNI 使用目标域名。逐跳请求头按 HTTP 规则移除；传输长度按原始正文计算。支持保活的请求会把 `Accept-Encoding` 设为 `identity`，避免将空白混进压缩数据。
- 目标响应的 JSON 正文保持原始字节，只在前面追加空白；SSE 保留原事件字节，仅在安全边界插入空白。HTTP 版本、请求头大小写和顺序不保证与直连逐字节一致。

没有额外的 CORS 改写；目标站 CORS 头按下面的响应头限制透传。WebSocket、CONNECT 隧道以及任意二进制格式的心跳不在本项目范围内。

## 心跳行为

### 尚未收到目标响应头

从请求发送给目标站开始计时。默认 1 秒后还没有实际正文时，就提交响应并发送两个真实的 LF 字节，即 `\n\n`（不是反斜杠文字）。之后每隔 1 秒继续发送。

请求内 `stream: true` 或 `Accept: text/event-stream` 对应 SSE 响应头；其余请求先按 JSON 处理。两个空白换行既是合法的 JSON 前置空白，也是 SSE 中会被忽略的空事件。

如果目标站实际上返回 NDJSON、HTML、下载文件或其他格式，而上游响应头又非常晚，本项目无法凭空预知格式。请将这些路径排除保活，见下文的前缀设置或单次绕过。

### 非流式 JSON

目标 JSON 会先写入该请求独立的临时文件。**文件尚未接收完整时，继续定时发送空白**；完整后停止心跳，原样发送整个文件并删除临时文件。

这样即便上游在一个 JSON 字符串中间长时间停顿，也不会把保活换行插进字符串。独立临时文件根目录缺失时会自动创建，临时文件权限为 `0600`，正常完成、报错和客户端取消时均清理；异常终止可能留下临时文件，Render 重建实例时会清除临时文件系统。默认单个 JSON 响应上限为 256 MiB。

### SSE 流式

目标事件到达后，立即按照背压逐块转发。没有实际输出时，定时发送空白；但**若上游停在一个未结束的 SSE 事件中间，暂不插入空白**，以免截断该事件。

因此，上游若把一个事件发送一半后长期沉默，仍可能触发中间层的超时。普通完整 SSE 事件之间的长等待会由空白保活覆盖。

### 状态码和响应头的取舍

如果目标站在首个心跳前完成响应，可以保留真实状态码和响应头。

**如果已经在目标响应头到来前开始发心跳，HTTP 200 和猜测的 Content-Type 就已经提交，之后无法修改。** 后续才知道的响应头（例如 `Set-Cookie`、速率限制头）也不能补发。目标站后续返回 JSON 错误时，原始错误 JSON 会接在空白后，客户端需要检查正文，不能只检查 HTTP 200。

如果目标站随后返回与已提交格式不兼容的内容，项目会返回可解析的 `relay_error`，而不会把 HTML 或 gzip 字节接进 JSON。连接错误、总超时、超出响应大小上限等错误也会尽量以 JSON 或 SSE 错误事件结束；已传输一半的 SSE 事件发生错误时会直接关闭连接。

这是提前发送响应正文的 HTTP 限制。若需要严格保留目标状态码和所有响应头，请关闭保活；关闭后将重新面临长等待超时。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TARGET_URL` | 必填 | 固定目标 HTTP(S) 地址，可带路径前缀，不带密钥、查询串、片段 |
| `PORT` | `10000` | 监听端口，Render 会提供 |
| `HEARTBEAT_START_DELAY_SECONDS` | `1` | 首个空白前等待秒数；`0` 表示立即发送；最大 `60` |
| `HEARTBEAT_INTERVAL_SECONDS` | `1` | 后续空白间隔；`0` 关闭保活；最大 `60` |
| `UPSTREAM_TIMEOUT_SECONDS` | `1800` | 整次上游请求总期限，心跳不延长它；`0` 不设置总期限 |
| `CONNECT_TIMEOUT_SECONDS` | `30` | 建立上游 TCP / TLS 连接的期限 |
| `MAX_REQUEST_BYTES` | `33554432` | 原始请求正文大小上限，32 MiB |
| `MAX_JSON_RESPONSE_BYTES` | `268435456` | 单个临时 JSON 响应大小上限，256 MiB |
| `MAX_CONCURRENT_REQUESTS` | `32` | 同时处理的转发请求上限，含正在上传的请求 |
| `MAX_BUFFERED_REQUEST_BYTES` | `67108864` | 所有请求正文共享的 64 MiB 内存预算 |
| `TEMP_DIRECTORY` | 系统临时目录下的 `render-ai-relay` | 自动创建的独立临时文件根目录，可指定其他可写目录 |
| `HEARTBEAT_PATH_PREFIXES` | 空 | 逗号分隔的客户端路径前缀；空表示所有普通路径；例如 `/v1/,/api/` |
| `PROXY_TOKEN` | 空 | 可选的中转访问密钥，客户端放在 `X-Proxy-Token`，不替代上游 Authorization |

默认所有普通方法都可保活，不要求请求体一定是 JSON 或带 `stream: false`。`HEAD`、`OPTIONS`、带 `Range` 的请求以及健康检查不插入空白。

单次请求需要保持完全透明时，可以添加 `X-Proxy-Heartbeat: off`。这个控制头和 `X-Proxy-Token` 都会在转发到目标站前移除。已明确识别为二进制、压缩、无正文或部分内容的响应也不注入空白；如果此前已经开始了猜测格式的心跳，则按不兼容响应处理。

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

需要 Node.js 24，无第三方运行时依赖。定时器使用单调时钟，按最后一次实际输出时间重新计算下一次心跳，避免定时器提前触发时漏发一整个周期。

```bash
cp .env.example .env
# 编辑 .env 中的 TARGET_URL
npm ci
npm start
```

```bash
npm run check
node scripts/slow-check.js
```

`npm run check` 运行语法检查与集成测试；Render Blueprint 在构建时也执行这组检查。GitHub Actions 会在推送和拉取请求时执行相同检查，再进行 5 秒模拟慢请求测试，所用 GitHub Actions 已固定到提交 SHA。

`slow-check.js` 在本机创建模拟上游，故意等 135 秒才返回响应头，使用默认 1 秒首包和 1 秒心跳，在客户端启用 3 秒读空闲超时，验证最终 JSON 保持不变。这是本地链路测试，不等于已经验证你的 Render / CF / 目标站完整链路。

项目包含 Dockerfile，也可以用 `docker build -t render-ai-relay .` 后，以 `-e TARGET_URL=https://你的目标站 -p 10000:10000` 运行。

服务默认最多接收 32 个并发转发请求，请求正文共享 64 MiB 内存预算；超出时在访问目标站前返回 HTTP 503 和 `Retry-After: 1`。客户端上传中断时会释放资源；正文发送给目标站后即释放内存预算，不会在模型推理期间一直占用。健康检查不占用转发名额。

JSON 临时文件不需要持久磁盘。空 JSON 或仅含空白的 JSON 响应会转换为明确的 `empty_upstream_response` 错误；SSE 在安全事件边界断开时会尽量发送错误事件。

日志不记录请求正文、响应正文、Authorization、Cookie 或 URL 查询串。不自动重试请求，避免 AI 生成被重复提交。

## 文件

- `src/proxy.js`：原始请求转发、心跳、JSON 暂存、SSE 安全转发与连接清理。
- `src/server.js`：Render 启动入口、端口配置与退出处理。
- `render.yaml`：Render Blueprint。
- `.env.example`：可选配置示例。
- `Dockerfile`：Docker 部署。
- `test/proxy.test.js`：本地集成测试。
- `scripts/slow-check.js`：135 秒真实等待验证。
- `.github/workflows/ci.yml`：GitHub 自动检查与短时间心跳验证。

## 参考文档

- [Render Web Services](https://render.com/docs/web-services)
- [Render Blueprint YAML](https://render.com/docs/blueprint-spec)
- [Render Cloudflare DNS 配置](https://render.com/docs/configure-cloudflare-dns)
- [Render Free 实例限制](https://render.com/docs/free)
- [Cloudflare 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
- [RFC 8259：JSON 语法与空白](https://www.rfc-editor.org/rfc/rfc8259.html#section-2)
