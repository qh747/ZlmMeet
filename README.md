# zlm_meet

[![](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![](https://img.shields.io/badge/language-Go-blue.svg)](https://golang.org/)
[![](https://img.shields.io/badge/platform-linux-lightgrey.svg)](https://github.com/ZLMediaKit/ZLMediaKit)
[![](https://img.shields.io/badge/PRs-welcome-yellow.svg)]()
[![](https://img.shields.io/badge/requires-ZLMediaKit-orange.svg)](https://github.com/ZLMediaKit/ZLMediaKit)

> 一个基于 **ZLMediaKit + Go + WebRTC** 的最小可用多人视频会议示例，内置四种业务入口。

```
浏览器 ──(WebSocket 信令)── Go 后端 ──(HTTP REST)── ZLMediaKit
   │                                                  ▲
   └──────────── WebRTC ICE/SRTP（音视频直连）─────────┘
```

## 项目特点

- 依托 ZLMediaKit 作为媒体服务，WebRTC 推拉流开箱即用，无需自行实现 SFU。
- 后端使用 Go + WebSocket 实现信令，代码极简，易于二次开发。
- 前端零构建依赖，纯原生 HTML/JS（ES Module），浏览器直开即用。
- 首页统一入口，支持 **多人会议 / 1v1 通话 / 独立推流 / 独立拉流** 四种业务。
- 每个用户独立推流（`cam` + 可选 `screen`），其他人各自订阅，互不耦合。
- 「房间号」即 ZLM `app`，同房间共享一个流分组；会议/通话流名后端固定为 `user_<userId>_<kind>`，独立推/拉流由用户输入流名。
- 支持麦克风/摄像头热切换、屏幕共享、文字聊天、画质档位切换、MP4 录制与预览下载。

## 项目定位

- 学习 WebRTC + ZLMediaKit 信令交互的最小参考实现。
- 可作为二次开发基础，扩展鉴权、录制、转推等生产特性。

## 业务说明

首页（`/`）提供四张业务卡片，填写表单后进入对应页面。支持深链直达：`/?biz=meeting|call|push|play`。

| 业务 | 页面 | 房间模式 | 人数限制 | 说明 |
|------|------|----------|----------|------|
| 多人会议 | `meeting.html` | `meeting` | 无 | 多人音视频、屏幕共享、聊天、录制 |
| 1v1 通话 | `call.html` | `call` | 最多 2 人 | 大画面 + 自视图小窗，功能与会议类似 |
| 推流 | `push.html` | `solo` | 无 | 输入房间号 + 流名，将本机摄像头推到 ZLM |
| 拉流 | `play.html` | `solo` | 无 | 输入房间号 + 流名，从 ZLM 拉流播放 |

**房间号与流名约定**

- 前端「房间号」→ ZLM 的 `app` 字段；同一房间号的用户处于同一 ZLM 流分组。
- 会议/通话：后端自动生成流名 `user_<userId>_cam` / `user_<userId>_screen`。
- 独立推/拉流：用户自定义流名（仅字母数字、`_`、`-`、`.`，最长 128 字符）。

## 功能清单

### 首页与通用

- 业务选择首页 + 弹窗表单（昵称/房间号/流名按业务显隐）
- 昵称、房间号写入 `sessionStorage`，下次自动填充
- 深链 `?biz=xxx` 直接打开对应业务表单

### 多人会议 / 1v1 通话

- 多人（或两人）同时入会，房间隔离
- 音视频实时发布与订阅（推流完成后自动通知对端拉流）
- 麦克风 / 摄像头开关（对端实时感知）
- 画质切换：流畅（426×240）、标清（640×480）、高清（1280×720），热切换 `replaceTrack`
- 屏幕共享（基于 `getDisplayMedia`）
- 房间内文字聊天（`solo` 模式不广播）
- 摄像头流 / 屏幕共享流分别可录制（MP4）
- 停止录制后弹出预览浮层，支持在线播放与下载

### 独立推流 / 拉流

- 推流：输入「房间号 + 流名」后将本机摄像头推到 ZLM
- 拉流：输入相同房间号与流名即可播放
- 推流页同样支持画质切换与 MP4 录制、预览、下载

### 信令（WebSocket，JSON）

- 统一 envelope：`{ "type", "reqId", "payload" }`
- 支持 request/response 模式（`reqId` 回调，用于 SDP 交换与录制控制）
- 所有与 ZLM 的交互（SDP 交换、录制、close）都经信令服务端中转

### 媒体（WebRTC via ZLMediaKit）

- WebRTC 推流（publish）与拉流（play）
- 基于 ZLM REST API 的 SDP 交换代理
- 录制由后端调用 `/index/api/startRecord` / `stopRecord`（MP4）
- 停止录制后通过 Hook 缓存或 API 轮询解析文件 URL，经 `/api/record-file` 同源代理预览/下载
- 离会自动停止录制并关闭关联流（`close_streams`）

### HTTP 辅助接口

| 路径 | 说明 |
|------|------|
| `/ws` | WebSocket 信令 |
| `/healthz` | 健康检查，返回 `ok` |
| `/api/zlm-hook/record-mp4` | 接收 ZLM 录制完成 Hook |
| `/api/record-file?url=...&mode=preview\|download` | 同源代理 ZLM 录制文件（支持 Range） |
| `/` | 静态前端（`static_dir` 配置时） |

## 快速开始

**快速开始前，请确保已有一个开启了 WebRTC 与 HTTP API 的 ZLMediaKit 实例。**

### 1. 准备 ZLMediaKit

关联配置项（`config.ini`）：

```ini
[api]
secret=your_secret

[http]
port=8081
```

额外配置录制完成 Hook，使停止录制后预览即时可用（无需等待 API 轮询）：

```ini
[hook]
on_record_mp4 = https://<信令服务地址>:8080/api/zlm-hook/record-mp4
```

> 若信令服务启用了 TLS（`tls_cert` / `tls_key`），Hook 地址**必须**使用 `https://`，否则 ZLM 会收到 400。自签证书仅会在 ZLM 日志中打印警告，不影响 Hook 功能。

额外配置启用ZLMediakit的RTSP媒体流解复用功能，降低画面首开延时：

```ini
[protocol]
enable_rtsp=1

[rtsp]
directProxy=0
```

### 2. 编译后端

需要 Go 1.21+。使用项目提供的脚本一键完成依赖拉取、编译和目录初始化：

```bash
bash backend/scripts/build.sh
```

脚本会自动完成以下工作：

- 检查 Go 版本（要求 1.21+）
- 创建 `backend/bin/`、`backend/bin/conf/`、`backend/bin/cert/` 目录
- 将 `config-example.yaml` 复制为 `backend/bin/conf/config.yaml`，并自动修正路径
- 执行 `go mod tidy` 拉取依赖
- 编译，输出到 `backend/bin/zlm_meet`

编译完成后，**编辑配置文件**：

```bash
vi backend/bin/conf/config.yaml
```

主要配置项：

| 配置项 | 说明 |
|--------|------|
| `listen` | 信令服务监听地址，默认 `:8080` |
| `tls_cert` / `tls_key` | TLS 证书；留空则以 HTTP 监听 |
| `static_dir` | 前端静态资源目录（相对 `bin/` 运行目录） |
| `allowed_origins` | WebSocket Origin 白名单；留空则不校验（开发用） |
| `zlm.api_base` | ZLM HTTP API 地址，如 `http://192.168.1.10:8081` |
| `zlm.secret` | ZLM `config.ini` 中的 `[api] secret` |

> 注：ZLM 流路径里的 `app` 字段由前端「房间号」决定，不在配置文件中。同房间内所有人共用同一个 ZLM `app`，互相可见。

### 3. 启动后端

```bash
bash backend/scripts/start.sh
```

脚本会切换到 `backend/bin/` 目录后启动服务，确保 `static_dir` 和证书等相对路径正确解析。默认监听 `:8080`，打开 `https://信令服务ip:端口/` 即可看到业务选择页。

### 4. 局域网多设备访问（HTTPS）

浏览器仅在 `https://` 或 `http://localhost` 下允许获取摄像头。局域网其他设备访问时需要 TLS，用 OpenSSL 生成自签证书，直接输出到 `backend/bin/cert/`：

```bash
cd backend/bin/cert
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
```

`build.sh` 生成的 `conf/config.yaml` 已将证书路径预设为：

```yaml
tls_cert: "cert/cert.pem"
tls_key:  "cert/key.pem"
```

证书放好后直接重启服务即可。访问 `https://信令服务ip:端口/`，浏览器提示证书不受信任时点击「高级 → 继续访问」。

## 项目结构

```
zlm_meet/
├── backend/
│   ├── conf/
│   │   └── config-example.yaml # 配置模板
│   ├── scripts/
│   │   ├── build.sh            # 初始化目录、编译
│   │   └── start.sh            # 启动服务
│   ├── bin/                    # 编译产出（由 build.sh 生成）
│   │   ├── zlm_meet            # 可执行程序
│   │   ├── conf/
│   │   │   └── config.yaml     # 运行时配置
│   │   └── cert/               # TLS 证书目录
│   └── src/
│       ├── go.mod / go.sum
│       ├── cmd/
│       │   └── main.go         # 入口：加载配置、启动 HTTP/WS、优雅退出
│       └── pkg/
│           ├── config/config.go  # YAML 配置解析
│           ├── server/server.go  # 路由 + WS + Hook + 录制代理 + 静态文件
│           ├── signaling/
│           │   ├── message.go    # 信令消息结构 + 类型常量
│           │   ├── hub.go        # 全局房间表
│           │   ├── room.go       # 房间 + 广播 + 人数限制
│           │   └── client.go     # 单连接读写循环 + 消息处理
│           └── zlm/client.go     # ZLM REST API + Hook 缓存 + 录制 URL 解析
└── frontend/
    ├── index.html              # 业务选择 + 加入表单
    ├── meeting.html            # 多人会议页
    ├── call.html               # 1v1 通话页（与 meeting 共用 app.js）
    ├── push.html               # 独立推流页
    ├── play.html               # 独立拉流页
    ├── css/style.css
    └── js/
        ├── signaling.js        # WS 客户端（含 request/response）
        ├── webrtc.js           # publishStream / playStream（含 ICE 等待优化）
        ├── ui.js               # 视频网格 + 聊天面板 DOM 操作
        ├── quality.js          # 画质档位与热切换 UI
        ├── app.js              # 会议/通话主流程
        ├── push.js             # 独立推流主流程
        └── play.js             # 独立拉流主流程
```

## 信令协议

所有消息统一使用以下 envelope 包装：

```jsonc
{ "type": "...", "reqId": "可选", "payload": { ... } }
```

`reqId` 用于客户端期望响应的请求（`webrtc-offer`、`record-start`、`record-stop`）。

### 客户端 → 服务端

| type             | payload                                                                          | 说明                                                         |
|------------------|----------------------------------------------------------------------------------|--------------------------------------------------------------|
| `join`           | `{room, nickname, mode?}`                                                        | 加入房间，`room` 映射为 ZLM `app`；`mode`=`meeting`(默认) / `call`(1v1, 容量 2) / `solo`(独立推/拉流) |
| `leave`          | `{}`                                                                             | 主动离开（也可直接断开 WS）                                  |
| `chat`           | `{text}`                                                                         | 向房间内广播文本（solo 模式不广播）                          |
| `media-state`    | `{micOn, camOn}`                                                                 | 同步麦克风/摄像头状态给其他人                                |
| `webrtc-offer`   | `{mode, kind?, targetUserId?, streamId?, sdp}`                                   | SDP 交换；`mode`=`publish`/`play`/`publish-solo`/`play-solo`；solo 模式必须带 `streamId` |
| `stream-started` | `{kind, streamId}`                                                               | 推流完成后通知房间（服务端在 publish 成功时也会主动广播）    |
| `stream-stopped` | `{kind, streamId}`                                                               | 停止某条推流（如关闭屏幕共享）                               |
| `record-start`   | `{kind?, streamId?}`                                                             | 申请录制自己拥有的流；房间场景给 `kind`、solo 给 `streamId`；带 `reqId` 等待 ack |
| `record-stop`    | `{kind?, streamId?}`                                                             | 同上，停止录制                                               |

### 服务端 → 客户端

| type                   | payload                                                                                   |
|------------------------|-------------------------------------------------------------------------------------------|
| `joined`               | `{userId, room, peers: [{userId, nickname, micOn, camOn, streams:[{kind, streamId}]}]}`  |
| `peer-joined`          | `{userId, nickname}`                                                                      |
| `peer-left`            | `{userId}`                                                                                |
| `peer-state`           | `{userId, micOn, camOn}`                                                                  |
| `webrtc-answer`        | `{mode, kind, targetUserId, streamId, sdp}`（与请求同 `reqId`）                           |
| `peer-stream-started`  | `{userId, kind, streamId}`                                                                |
| `peer-stream-stopped`  | `{userId, kind, streamId}`                                                                |
| `chat`                 | `{from, nickname, text, ts}`                                                              |
| `record-state`         | `{userId?, kind?, streamId, recording, recordFileUrl?}`（停止录制且解析到文件时带 `recordFileUrl`；ack 与 `reqId` 同；房间内同步给所有人） |
| `error`                | `{message}`                                                                               |

## 已知限制

- 仅在局域网/直连可达的 WebRTC 环境下验证；公网部署需在 ZLM 端配置 STUN/TURN 并设置 `webrtc.externIP`，前端 `RTCPeerConnection` 默认不内置 `iceServers`，如需 STUN/TURN 请自行在 `frontend/js/webrtc.js` 中扩展。
- 无鉴权机制，房间号即门票；生产化建议在 `join` 前加 token 校验。
- 无 SFU 编排逻辑，依赖 ZLM 作媒体网关；如需 simulcast/SVC，需扩展 SDP 协商。
- 屏幕共享依赖 `getDisplayMedia`，部分浏览器（如 Safari）行为存在差异。
- 房间即 ZLM `app`：不同房间号的用户彼此不可见，同一房间号会复用同一个 ZLM 流分组，注意避免房间号冲突。
- 未配置 `on_record_mp4` Hook 时，停止录制后需依赖后端轮询 ZLM API 获取文件 URL，预览可能有数秒延迟。

## 快速排错

| 现象                         | 排查方向                                                               |
|------------------------------|------------------------------------------------------------------------|
| 信令连不上                   | 后端是否已启动；URL 中 `http/https` 与 `ws/wss` 是否匹配              |
| 推流失败                     | ZLM 是否开启 WebRTC；`api_base` 与 `secret` 是否正确；UDP 8000 是否可达 |
| 看不到自己                   | 浏览器是否授予摄像头权限；当前页是否在 `https` 或 `localhost` 下       |
| 看不到对方                   | ZLM 控制台是否有对应 stream；浏览器控制台是否有 `play` 失败日志        |
| Chrome 提示 ICE failed       | `webrtc.externIP` 是否填写正确；防火墙是否拦截 UDP                     |
| 录制完成无预览               | 是否配置 `hook.on_record_mp4`；Hook 地址协议是否与信令服务 TLS 一致   |
| 预览无法播放                 | `/api/record-file` 代理是否可达；ZLM 录制目录 HTTP 是否可访问         |

## 授权协议

本项目使用 [MIT](./LICENSE) 协议，保留版权信息可自由用于商业及非商业项目。
