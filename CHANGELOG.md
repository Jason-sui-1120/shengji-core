# Changelog

## 1.14.0 - 2026-08-06

- 滚动文件 ASR 只部分对齐实时草稿时，改为以中心窗口的文件稿整体替换未人工编辑自动行，杜绝未映射残片在封存时以 fallback 与稳定稿重复并存。
- 仅将具有 `fileSegmentCount > 0` 的对齐项视为真实文件稿映射，修复占位对齐行被错误算作已校准的问题。
- 整体替换会按绝对时间轴继承现有说话人提示，避免稳定稿因文本校准退化为“待识别”。
- 新增服务级回归测试，覆盖部分对齐整体替换、人工行保护路径与说话人提示继承。

## Unreleased

### Added

- 新增完整项目文档入口、当前状态、双端前端同步、公司测试环境部署和质量回归口径。
- 共享前端同步范围扩展到统一 `App.tsx`，公司版登录后页面与公网版使用同一套流程。

### Changed

- 文档以完整录音、绝对时间轴、45 秒稳定文件 ASR、稳定转写合成、异步说话人回填和证据化纪要为当前基线。
- 公网与公司版不再依赖 git submodule 或开发机符号链接；云构建读取仓库内真实文件。

## v1.7.4 - 2026-07-29

### Added

- **P0 实时会议链路正确性**：
  - flush 时间冻结（v1.7.0）：`enqueueFlush` 快照加 `capturedAtAudioMs`，缺少 ASR 句尾时间戳时只能用快照的 `capturedAtAudioMs`（不是排队执行时的当前会议时间），防止前一段耗时较长时扩大前一段时间区间。
  - AudioWorklet 资源路径用 `import.meta.env.BASE_URL`（不硬编码根路径）+ VAD 下沉到 AudioWorklet（主线程不重复 PCM→Float32 转换）+ 资源释放关闭 Worklet port。
  - 稳定稿失败可观测性（v1.7.1）：rolling 文件 ASR 失败/LLM 对齐失败/队列满分别有结构化状态码和原因；尾段降级发送 `tailFailureCode`/`tailFailureReason`/`tailFailedWindows`（服务端可查询失败原因和重试次数）。

- **P1 双端 Adapter 收敛**：
  - 公司端 23 个内联函数迁入 `company-adapter.mjs`，公网端 20 个内联函数迁入 `public-adapter.mjs`。
  - core 只依赖接口（`deps.xxx`），不知道 MySQL/SQLite/CAS/Gateway 实现细节。
  - 契约测试不依赖真实服务/MySQL（`shared-routes-registered` 改为 fake Adapter 验证路由注册）。
  - 全量测试：公司端 86/86 全绿（1 秒）、公网端 91/91 全绿（1 秒）。

- **P2 同步门禁强化**：
  - 双端 CI 门禁：`frontend-sync`、`core-sync`、`injection`、`api-contract`。
  - 干净 checkout 校验（GitLab `GIT_DEPTH=0` 完整克隆，GitHub tarball 不用 `git clone` CDN 缓存）。
  - 只改清单不改文件必然失败、只改一端共享文件必然失败（哈希校验）。

- **P3 双端行为回归**：
  - `dual-end-regression.test.mjs`：单人长讲述/多人交替与抢话/弱网重连与停止，验证时间轴单调性、稳定稿覆盖率、说话人轨道（两端跑同一输入，输出必须一致）。
  - 测试动态检测 modules 位置（core 里 `../modules/`，消费端 `./`）。

- **P4 部署链路与版本溯源闭环**：
  - build-info 五版本字段：`appCommit`、`buildTime`、`coreVersion`、`frontendRevision`、`deploymentProfile`。
  - health 返回与构建日志一致（`gen-build-info.mjs` 打印 `build-info.json written: xxx core=xxx frontend=xxx`）。
  - 域名访问的 health 与容器内 health 一致（`getBuildInfo()` 不缓存，每次读 `build-info.json`）。

- **Adapter 契约测试**（覆盖 Codex 建议的 5 个维度）：
  - 公司端 18 个测试（`company-adapter.test.mjs`）、公网端 16 个测试（`public-adapter.test.mjs`）。
  - 输入/输出与错误语义、事务与幂等性、多租户/权限边界、SQLite/MySQL 行为差异、降级策略。

- **发布前环境冒烟**（`smoke-company-db.mjs`）：
  - 连真实公司测试库验证连接/迁移/关键会议接口，失败时明确标记环境/连接失败或代码失败。
  - 读写探针用事务（finally 中回滚，不残留测试数据）。
  - 应用级冒烟（`/api/health` 验证 HTTP 路由、鉴权、配置装配）。

### Changed

- **核心原则**：Adapter 管能力差异，不管 HTTP 路由——`index.mjs` 可以很薄，但仍负责"把共享路由挂到 HTTP 服务上"。
- **分层架构**：core（会议业务、共享路由处理器、接口契约、回归测试）→ adapter（DB/存储/AI/用户上下文的差异实现）→ shell（HTTP 服务启动、CAS 或公网鉴权挂载、环境变量读取）。

### Fixed

- **CI 文案统一**：数据库不可用时失败并标记基础设施问题，不静默通过。
- **smoke-company-db 从自动 CI 移除**：加单独的手动触发的 `company_db_smoke` job（生产环境部署前跑，CI 里没有真实公司测试库）。
- **CI 工作目录风险**：`cd server && node smoke-company-db.mjs` 改为 `(cd server && node smoke-company-db.mjs)`（子 shell，不影响后续 `npm run build`）。
- **`./shared/` → `./` 转换**：直接用 GitHub API 更新文件不会跑 `sync-frontends.mjs` 的 `./shared/` → `./` 转换——必须手动转换或触发 CI 的 sync 步骤。
- **CI 的 `git clone` 命中 GitHub CDN 缓存**：改用 `gh api` 下载 tarball（强制刷新）。
- **`formatAudioOffset` 移到 `live-asr-helpers.mjs`**：Adapter 从 `live-asr-helpers` import（不是 `index.mjs`，避免循环依赖）。

## v0.1.0 - 2026-06-24

### Added

- 完成 MVP 主链路：项目、会议、录音、实时转写、AI 实施总结、待办池、历史会议、项目记忆和项目 AI 对话。
- 支持真实麦克风 ASR、说话人识别、人工说话人修正和转写导出。
- 支持会后最终纪要、历史会议详情、Markdown 导出和时间轴/金句定位转写。
- 支持项目记忆结构化沉淀和人工编辑。
- 支持公网服务通过内网 AI Gateway 调用企业内网模型能力。
- 补全文档体系：产品、功能、技术架构、路线图、开发环境、Git 协作、发布流程和版本管理。

### Changed

- 录音状态改为跨页面保持，切换导航不主动停止录音。
- 实时会议导航在录音中显示红色录音标识。
- ASR WebSocket 意外断开后自动重连。

### Known Issues

- 长会议稳定性仍需要 60/120 分钟真实压测。
- 会后编辑器仍需继续优化结构化解析和右侧待办/风险同步。
- 项目 AI 对话目前只回答问题，尚未支持一键沉淀为项目记忆或待办。
