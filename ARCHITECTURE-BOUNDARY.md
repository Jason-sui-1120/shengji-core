# 声纪双端架构边界清单

> 唯一来源原则：`shengji-frontend`（前端）、`shengji-core`（会议业务核心）。
> 允许差异仅限：认证、数据库、多用户权限、模型/Gateway 调用、部署方式。
> 禁止在两端 `server/index.mjs` 各自复制修改共同业务逻辑。

## 1. 共享模块（shengji-core/modules，35 个，core-sync.json 哈希锁定）

| 模块 | 职责 |
|---|---|
| live-asr-session | 实时 ASR 会话状态机（WS 桥、VAD、flush、滚动校准调度、尾段收口） |
| live-asr-helpers | 源音频管理、转写行处理、滚动恢复、声纹行草稿 |
| rolling-transcript-service / rolling-window-plan / rolling-store | 45 秒稳定稿滚动校准 |
| tail-stabilization | 尾段校准与超时降级 |
| transcript-composer / transcript-coverage / text-utils / transcript-align | 转写合成、覆盖率、时间轴、对齐 |
| speakers / speaker-core / speaker-gateway / voice-cluster-service | 说话人识别、声纹聚类 |
| glossary / glossary-text / glossary-query / hotwords | 热词规范化 |
| file-asr / audio-utils / file-segments / file-wav | 文件 ASR 与音频处理 |
| meeting-notes / project-memory / action-utils / evidence-utils | 纪要与待办编排 |
| env / config / model-routing / db / http-utils / time-utils / scheduler | 基础设施工 |

**规则**：共同业务逻辑变更只允许在这里改一处，两端经 `sync-core.mjs --sync` 同步，CI 校验哈希。

## 2. Adapter（两端各自实现，注入共享核心）

| 领域 | 公网端 | 公司端 |
|---|---|---|
| 数据库 | SQLite（node:sqlite，同步） | MySQL 5.7（mysql2，异步） |
| 认证 | 无登录 | CAS SSO + 会话 + mock 模式 |
| 权限 | 无 | canAccessMeeting / 项目成员 |
| 模型通道 | 内网 Gateway 代理 | AIT 直连（openapi-ait.ke.com） |
| 音频存储 | 本地 data/audio/*.wav | MySQL meeting_audio_chunks 分片 + tmpdir 缓存 |
| 部署 | GitHub Actions → 灯塔机 PM2 | 公司云平台 Pod |

## 3. Profile 配置（两端各自 config.mjs / models.json 提供）

- 模型键：models.json 权威（git 管理，两端一致），env/config.json 仅可覆盖非模型键
- ASR 载荷：ASR_ENABLE_ADVANCED_PAYLOAD / ASR_USE_WS_OPTIONS（公司 AIT 直连实测值 vs 公网网关值）
- 超时：TAIL_STABILIZATION_TIMEOUT_MS / POST_MEETING_SPEAKER_TIMEOUT_MS（两端默认一致 60s/15s）
- 部署：AIT_PUBLIC_BASE_URL（diarization 回源）、DB 连接、CAS 配置
- 启动日志输出生效值（不含密钥），改配置无需动共享核心

## 4. 路由例外

见 `api-profile-exceptions.json`（机器可读，唯一差异来源）：
- 公司端独有：/api/auth/*（6 个）、项目成员/可见性（3 个）、会议音频鉴权路由（2 个）
- 公网端独有：/api/meetings/:id/playback.wav
- 形态差异：/api/audio/*（公司端强制 meeting-<id>- 前缀+鉴权，公网端裸文件名）

**规则**：不在清单中的业务 API 必须双端同时存在、结构一致；新增例外必须更新清单并注明 owner/reviewedAt。

## 5. 门禁

| 门禁 | 位置 | 阻断条件 |
|---|---|---|
| core-sync 哈希 | 两端 prebuild + CI | 共享模块与 core-sync.json 不一致 |
| frontend-sync 哈希 | 两端 prebuild + CI | 前端与 frontend-sync.json 不一致 |
| import-smoke | core 发布前 | 35 模块 import 失败或纯函数抽测异常 |
| audit-deps-injection | 两端 CI（待接入） | 注入缺失/字面量硬编码/stub（白名单见 adapter-exceptions.json） |
| api-contract | 两端 CI（待接入） | 共同 API 缺失或响应结构漂移（例外仅 api-profile-exceptions.json） |
