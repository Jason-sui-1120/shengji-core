# 声纪双端统一代码架构

## 核心原则

**共享 core + 两端 Adapter，业务逻辑完全一致，端侧差异明确可审计。**

- **共享 core**（`shengji-core`）：51 个模块 + 29 组共享测试——纯业务逻辑（时间轴、稳定稿、去重、尾段收口、纪要、待办）
- **两端 Adapter**：
  - **公司端**（`company-adapter.mjs`）：MySQL、CAS 认证、多用户权限、Gateway/AIT 直连
  - **公网端**（`public-adapter.mjs`）：SQLite、无认证、单用户、Gateway
- **端侧差异**（保留，不共享）：数据库（MySQL vs SQLite）、认证（CAS vs 无认证）、权限（多用户 vs 单用户）、AI 通道（Gateway vs AIT 直连）、部署配置（环境变量、存储路径）

## 分层架构

```
core：会议业务、共享路由处理器、接口契约、回归测试
adapter：DB / 存储 / AI / 用户上下文的差异实现
shell：HTTP 服务启动、CAS 或公网鉴权挂载、环境变量读取
```

**Adapter 管能力差异，不管 HTTP 路由**——`index.mjs` 可以很薄，但仍负责"把共享路由挂到 HTTP 服务上"。

## 实时转写的三层状态机（唯一实现）

会议全程只维护一条**连续的源录音时间轴**；暂停、重连和恢复只追加新的音频区间，不重新从 0 计时。文字在同一时间轴上经历三层状态，后层只原位更新前层，绝不额外追加一份平行转写。

| 层级 | 何时产生 | 状态 | 对用户的含义 | 不允许做的事 |
|---|---|---|---|---|
| 实时预览 | 流式 ASR partial / SentenceEnd 到达 | 内存预览 | 当前正在识别的一句话，可随上游回改 | 不能作为纪要、待办或最终事实来源 |
| 草稿行 | 上游 `SentenceEnd` 后的短延迟；浏览器 VAD 仅作辅助 | `draft` | 已进入列表、可回放、不会因下一句话或 VAD 漏报而消失 | 不能等待 45 秒窗口才出现，也不能被稳定稿新增成重复行 |
| 稳定行 | 45 秒中心区间文件 ASR 校准成功；尾段失败则受控收口 | `stable` / `realtime_fallback` | 稳定稿替换对应草稿；自动分析只消费新的 stable revision | 校准失败不能无限阻塞结束会议，也不能伪装为已校准 |

### 关键收口规则

1. **SentenceEnd 是服务端落草稿的硬触发**：浏览器 `vad.endpoint` 丢失、连续发言或页面短暂断连，都不得让已确认句末长期只停留在实时预览。
2. **滚动校准只提交 45 秒中心区间**：前后上下文仅帮助断句和识别；落库前按词级时间、连续前后缀消重和单调时间约束处理，稳定稿原位替换草稿。
3. **自动分析以 stable revision 触发**：文件稿直接插入或替换均必须推进 revision 并通知分析；实时预览和纯草稿不触发会议结论。
4. **结束会议先封存，再补偿**：停止录音、写入完整源音频和强制收口已有草稿是主路径；尾段文件校准、会后说话人重算属于有超时的补偿任务。补偿失败标记 `realtime_fallback`，不阻塞归档或纪要生成。
5. **人工编辑优先**：用户编辑的文字和说话人不被文件 ASR、说话人分离或重跑覆盖。

### 分阶段实施与验收

| 阶段 | 范围 | 状态 | 验收门槛 |
|---|---|---|---|
| P0 | SentenceEnd 独立落草稿、稳定稿 revision 通知、尾段收口状态兼容、双端配置注入 | 已实施，待线上 1 倍速回归 | 无 VAD endpoint 仍在约 1.2 秒内出现草稿；草稿不消失；首个稳定稿到达后实时总结更新；尾段失败仍可归档 |
| P1 | 让实时说话人识别与会后重算完全后台化；增加草稿延迟、稳定覆盖率、尾段耗时告警 | 待实施 | 说话人服务慢或不可用不增加草稿落库延迟；结束会议不等待会后说话人任务 |
| P2 | 以同一份 1 倍速、多源银标重跑 10 分钟及 37 分钟回归 | 待实施 | 源录音 `complete`、稳定稿覆盖完整、可归档；以原始标注、完整文件 ASR、飞书妙记、ima 的多源共识评分，而非单一官方稿 |

## 端侧差异决策记录

### 为什么公司端用 MySQL、公网端用 SQLite？

- **公司端**：多用户、高并发、需要事务和行级锁——MySQL 8（InnoDB）
- **公网端**：单用户、轻量部署、零配置——SQLite（Node 内置 `node:sqlite`，不是 `better-sqlite3`）

### 为什么公司端用 CAS 认证、公网端无认证？

- **公司端**：企业内网，需要统一身份认证（CAS 单点登录）+ 多用户权限（只能访问自己的会议）
- **公网端**：公开访问，单用户（无认证，所有会议公开）

### 为什么公司端用 Gateway、公网端用 AIT 直连？

- **公司端**：企业内网，AI 请求走 Gateway（统一鉴权、限流、审计）
- **公网端**：公开访问，AI 请求直连 AIT（`api.msh.team`，需要 `AIT_API_KEY`）

### 为什么公司端 `config.json` 平台 Secret 注入、公网端 `.env` 本地配置？

- **公司端**：企业部署平台（K8s ConfigMap/Secret 注入 `config.json`），敏感配置（数据库密码、AI API Key）不落盘
- **公网端**：单机部署（`.env` 本地配置），敏感配置（AI API Key）在 `.env`（`.gitignore` 忽略）

## Adapter 契约测试（覆盖 Codex 建议的 5 个维度）

**公司端**（`company-adapter.test.mjs`，18 个测试）：
1. **输入/输出与错误语义**：`formatMeetingElapsedTime`（HH:MM:SS 格式、非法输入返回 00:00）、`getAsrHotwordsForMeeting`（返回热词数组）、`getMeetingGlossaryEntries`（返回词库条目数组）、`bumpMeetingStableRevision`（返回递增版本号）、`uniqueStrings`（数组去重）
2. **事务与幂等性**：`persistMeetingElapsedSeconds`（重复调用幂等）、`setMeetingStatus`（重复设置同一状态幂等）、`insertTranscript`（返回转写 ID）
3. **多租户/权限边界**：`getMeetingLiveRecord`（返回会议记录含项目信息）、`getFinalizedMeetingByMeetingId`（返回已完成会议记录）
4. **SQLite/MySQL 行为差异**：`getLatestTranscriptId`（无转写时返回 0，MySQL MAX 返回 NULL）、`countDraftTranscripts`（返回草稿转写数量）
5. **降级策略**：`forceStabilizeDraftTranscripts`（降级时强制稳定草稿）、`performRollingTranscriptCorrection`（滚动校正失败时返回错误）、`loadRollingResumeAudio`（无源音频时返回空 PCM）、`savePcmAsWav`（PCM 转 WAV）、`buildTranscriptLineDrafts`（构建转写行草稿）

**公网端**（`public-adapter.test.mjs`，16 个测试）：
1. **输入/输出与错误语义**：`openDb`（返回 SQLite 连接）、`formatTime`（HH:MM:SS 格式）、`getHotwords`（返回热词数组）、`applyGlossary`（应用词库别名校正）
2. **事务与幂等性**：`persistMeetingElapsedSeconds`（重复调用幂等）、`setMeetingStatus`（重复设置同一状态幂等）、`insertTranscript`（返回转写 ID）
3. **多租户/权限边界**：`getMeetingLiveRecord`（返回会议记录）、`getFinalizedMeetingByMeetingId`（返回已完成会议记录）
4. **SQLite/MySQL 行为差异**：`getLatestTranscriptId`（返回最新转写 ID）、`normalizeTranscriptDraftTimeline`（规范化时间轴）
5. **降级策略**：`callFileTranscription`（文件转写）、`callFileTranscriptionByUrl`（URL 文件转写）、`diarizeSpeakerSegments`（说话人分离）、`ensureMeetingSourceAudio`（确保源音频文件存在）、`loadRollingResumeAudio`（无源音频时返回空 PCM）

## CI 门禁（双端）

**公司端**（GitLab CI）：
- `verify:frontend-sync`（前端同步门禁）
- `verify:core-sync`（core 同步门禁）
- `verify:injection`（注入审计）
- `verify-api-contract`（API 契约测试，CI 标准 MySQL 8）
- `npm run build`（构建）
- `node --test`（纯逻辑测试）

**公网端**（GitHub Actions）：
- `Verify canonical shared frontend`（前端同步门禁）
- `Verify shengji-core sync`（core 同步门禁）
- `Verify deps injection`（注入审计）
- `Verify API contract`（API 契约测试）

**发布前手动门禁**（`company_db_smoke` job）：
- 公司测试库冒烟（专用数据库、受保护变量、事务回滚、禁止生产库）
- 应用级冒烟（`/api/health` 验证 HTTP 路由、鉴权、配置装配）

## 部署链路与版本溯源闭环

**health 返回五版本字段**：
- `appCommit`（当前部署提交）
- `buildTime`（构建时间）
- `coreVersion`（core 版本）
- `frontendRevision`（frontend 版本）
- `deploymentProfile`（部署环境：company / public）

**build-info 生成规范**：
- 构建前获取当前 git commit（`git rev-parse --short=10 HEAD`）
- 构建时生成项目根 `build-info.json`
- 打包时复制到运行产物 `dist/server/build-info.json`
- 文件生成或复制失败必须使构建失败
- health 只返回同一 build-info 中的版本字段

## 演进方向

**短期（1-2 周）**：固化当前成果
- Adapter 契约测试补齐（18 + 16 个测试）✅
- 端侧薄壳化（路由注册迁入 Adapter）——**Codex 建议不迁移**（Adapter 管能力差异，不管 HTTP 路由）

**中期（1-2 月）**：npm 包化
- `shengji-core` 发布为内部 npm 包（`@shengji/core@1.7.4`）
- 两端 `package.json` 锁定版本（不再文件复制/sync）
- **公司端优先用 GitLab Package Registry**（不是 GitHub Packages）

**长期（3-6 月）**：端侧只剩薄壳
- 所有业务逻辑都在 `@shengji/core`（包括 Adapter 接口定义）
- 端侧只剩启动逻辑（创建 Adapter、注册路由、启动服务）
- 逐步 TypeScript 化核心接口（JSON Schema / JSDoc / runtime contract 固化接口，core 稳定后再转 TypeScript）
