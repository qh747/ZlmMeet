# zlm_meet

[![](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![](https://img.shields.io/badge/language-Go-blue.svg)](https://golang.org/)
[![](https://img.shields.io/badge/platform-linux-lightgrey.svg)](https://github.com/ZLMediaKit/ZLMediaKit)
[![](https://img.shields.io/badge/PRs-welcome-yellow.svg)]()
[![](https://img.shields.io/badge/requires-ZLMediaKit-orange.svg)](https://github.com/ZLMediaKit/ZLMediaKit)

> 一个基于 **ZLMediaKit + Go + WebRTC** 的最小可用多人视频会议示例。

```
浏览器 ──(WebSocket 信令)── Go 后端 ──(HTTP REST)── ZLMediaKit
   │                                                    ▲
   └──────────── WebRTC ICE/SRTP（音视频直连）─────────┘
```

## 项目特点

- 依托 ZLMediaKit 作为媒体网关，WebRTC 推拉流开箱即用，无需自行实现 SFU。
- 后端使用 Go + Gorilla WebSocket 实现信令，代码极简，易于二次开发。
- 前端零构建依赖，纯原生 HTML/JS，浏览器直开即用。
- 每个用户独立推流（`cam` + 可选 `screen`），其他人各自订阅，互不耦合。
- 流名称由后端统一生成（`room_<roomId>_user_<userId>_<kind>`），客户端无需关心命名。
- 支持麦克风/摄像头热切换、屏幕共享、文字聊天。
- 支持 TLS（HTTPS/WSS），满足局域网多设备摄像头权限要求。

## 项目定位

- 学习 WebRTC + ZLMediaKit 信令交互的最小参考实现。
- 企业内网快速搭建多人音视频会议的轻量底座。
- 可作为二次开发基础，扩展鉴权、录制、转推等生产特性。

## 功能清单

- 业务选择首页
  - 多人会议 / 1v1 通话 / 推流 / 拉流 四种业务卡片入口
  - 支持 `?biz=meeting|call|push|play` 深链直接打开对应表单

- 多人会议
  - 多人同时入会，房间隔离
  - 音视频实时发布与订阅
  - 麦克风 / 摄像头开关（对端实时感知）
  - 屏幕共享（基于 `getDisplayMedia`）
  - 房间内文字聊天
  - 自己摄像头流 / 屏幕共享流可一键录制（MP4）

- 1v1 通话
  - 两人专属房间，后端强制最多 2 人
  - 大画面 + 自视图小窗布局
  - 同样支持录制

- 独立推流
  - 输入流名后将本机摄像头推到 ZLM（mode=solo）
  - 录制按钮触发后端调用 ZLM 录制

- 独立拉流
  - 输入流名后从 ZLM 拉流播放

- 信令（WebSocket，JSON）
  - 统一 envelope：`{ "type", "reqId", "payload" }`
  - 支持 request/response 模式（`reqId` 回调）
  - 所有与 ZLM 的交互（SDP 交换、录制、close）都经信令服务端中转

- 媒体（WebRTC via ZLMediaKit）
  - WebRTC 推流（publish）与拉流（play）
  - 基于 ZLM REST API 的 SDP 交换代理
  - 录制由后端调用 `/index/api/startRecord` / `stopRecord`（MP4）
  - 离会自动停止录制并关闭关联流（`close_streams`）

## 快速开始

**快速开始前，请确保已有一个开启了 WebRTC 与 HTTP API 的 ZLMediaKit 实例。**

### 1. 准备 ZLMediaKit

最简单的方式（Linux / macOS）：

```bash
docker run -d --name zlm \
  --restart=always --network=host \
  -e MK_GENERAL_SECRET=035c73f7-bb6b-4889-a715-d9eb2d1925cc \
  zlmediakit/zlmediakit:master
```

> `--network=host` 让 WebRTC 的 UDP 端口（默认 8000）直接暴露，避免 NAT 困扰。
> Windows 不支持 host 网络，需显式映射 `80(TCP)`、`8000(UDP)`，并将 `webrtc.externIP` 配置为宿主机 LAN IP。

关键配置项（`config.ini`）：

```ini
[api]
secret=035c73f7-bb6b-4889-a715-d9eb2d1925cc

[http]
port=80

[rtc]
port=8000          ; WebRTC UDP 监听端口
externIP=          ; 多网卡 / 公网环境务必填写宿主机可达 IP
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

编译完成后，**编辑配置文件**，至少修改 `zlm.api_base` 和 `zlm.secret`：

```bash
vi backend/bin/conf/config.yaml
```

### 3. 启动后端

```bash
bash backend/scripts/start.sh
```

脚本会切换到 `backend/bin/` 目录后启动服务，确保 `static_dir` 和证书等相对路径正确解析。默认监听 `:8080`，打开 `http://localhost:8080/` 即可看到加入页。

### 4. 局域网多设备访问（HTTPS）

浏览器仅在 `https://` 或 `http://localhost` 下允许获取摄像头。局域网其他设备访问时需要 TLS，用 OpenSSL 生成自签证书，直接输出到 `backend/bin/cert/`（替换 IP 为宿主机实际 LAN IP）：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout backend/bin/cert/key.pem \
  -out backend/bin/cert/cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=IP:192.168.1.10,IP:127.0.0.1,DNS:localhost"
```

`build.sh` 生成的 `conf/config.yaml` 已将证书路径预设为：

```yaml
tls_cert: "cert/cert.pem"
tls_key:  "cert/key.pem"
```

证书放好后直接重启服务即可，访问 `https://192.168.1.10:8080/`，浏览器提示证书不受信任时点击"高级 → 继续访问"。

> 临时替代方案：Chrome 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，将 `http://192.168.1.10:8080` 加入白名单。

## 项目结构

```
zlm_meet/
├── backend/
│   ├── scripts/
│   │   ├── build.sh              # 初始化目录、编译
│   │   └── start.sh              # 启动服务
│   ├── bin/                      # 编译产出（由 build.sh 生成）
│   │   ├── zlm_meet              # 可执行程序
│   │   ├── conf/
│   │   │   └── config.yaml       # 运行时配置
│   │   └── cert/                 # TLS 证书目录
│   └── src/
│       ├── config-example.yaml   # 配置模板
│       ├── go.mod / go.sum
│       ├── cmd/
│       │   └── main.go           # 入口：加载配置、启动 HTTP/WS、优雅退出
│       └── pkg/
│           ├── config/config.go  # YAML 配置解析
│           ├── server/server.go  # 路由 + WS upgrader + 静态文件
│           ├── signaling/
│           │   ├── message.go    # 信令消息结构 + 类型常量
│           │   ├── hub.go        # 全局房间表
│           │   ├── room.go       # 房间 + 广播
│           │   └── client.go     # 单连接读写循环 + 消息处理
│           └── zlm/client.go     # ZLM REST API 封装（SDP 交换 / close_streams）
└── frontend/
    ├── index.html                # 加入页
    ├── meeting.html              # 会议页
    ├── css/style.css
    └── js/
        ├── signaling.js          # WS 客户端（含 request/response）
        ├── webrtc.js             # publishStream / playStream
        ├── ui.js                 # 视频网格 + 聊天面板 DOM 操作
        └── app.js                # 主流程
```

## 信令协议

所有消息统一使用以下 envelope 包装：

```jsonc
{ "type": "...", "reqId": "可选", "payload": { ... } }
```

`reqId` 用于客户端期望响应的请求（目前仅 `webrtc-offer`）。

### 客户端 → 服务端

| type             | payload                                                                          | 说明                                                         |
|------------------|----------------------------------------------------------------------------------|--------------------------------------------------------------|
| `join`           | `{room, nickname, mode?}`                                                        | 加入房间；`mode`=`meeting`(默认) / `call`(1v1, 容量 2) / `solo`(独立推/拉流) |
| `leave`          | `{}`                                                                             | 主动离开（也可直接断开 WS）                                  |
| `chat`           | `{text}`                                                                         | 向房间内广播文本（solo 模式不广播）                          |
| `media-state`    | `{micOn, camOn}`                                                                 | 同步麦克风/摄像头状态给其他人                                |
| `webrtc-offer`   | `{mode, kind?, targetUserId?, streamId?, sdp}`                                   | SDP 交换；`mode`=`publish`/`play`/`publish-solo`/`play-solo`；solo 模式必须带 `streamId` |
| `stream-started` | `{kind, streamId}`                                                               | 推流完成后通知房间                                           |
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
| `record-state`         | `{userId?, kind?, streamId, recording}`（ack 与 `reqId` 同；房间内同步给所有人）          |
| `error`                | `{message}`                                                                               |

## 已知限制

- 仅在局域网/直连可达的 WebRTC 环境下验证；公网部署需配置 STUN/TURN 并设置 `webrtc.externIP`。
- 无鉴权机制，房间号即门票；生产化建议在 `join` 前加 token 校验。
- 无 SFU 编排逻辑，依赖 ZLM 作媒体网关；如需 simulcast/SVC，需扩展 SDP 协商。
- 屏幕共享依赖 `getDisplayMedia`，部分浏览器（如 Safari）行为存在差异。

## 快速排错

| 现象                         | 排查方向                                                               |
|------------------------------|------------------------------------------------------------------------|
| 信令连不上                   | 后端是否已启动；URL 中 `http/https` 与 `ws/wss` 是否匹配              |
| 推流失败                     | ZLM 是否开启 WebRTC；`api_base` 与 `secret` 是否正确；UDP 8000 是否可达 |
| 看不到自己                   | 浏览器是否授予摄像头权限；当前页是否在 `https` 或 `localhost` 下       |
| 看不到对方                   | ZLM 控制台是否有对应 stream；浏览器控制台是否有 `play` 失败日志        |
| Chrome 提示 ICE failed       | `webrtc.externIP` 是否填写正确；防火墙是否拦截 UDP                     |

## 授权协议

本项目使用 [MIT](./LICENSE) 协议，保留版权信息可自由用于商业及非商业项目。
