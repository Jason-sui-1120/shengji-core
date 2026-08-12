# 声纪（Shengji）

声纪将企业会议从录音、转写到纪要、待办和项目记忆连成可回放、可编辑、可追溯的闭环。

## 当前状态（2026-07-22）

- 公网版：GitHub `main`，SQLite，生产地址 `https://gdzx1.top/voice/`。
- 公司版：GitLab `master`，MySQL + CAS，测试地址 `https://test-shengjivoicerecorder.ke.com/`。
- 共享前端唯一源：`Jason-sui-1120/shengji-frontend` 的 `main`；两端以真实文件构建，不使用 git submodule 或本机符号链接。
- 当前共享前端版本以各仓库根目录 `frontend-sync.json` 为准；该文件记录来源提交和逐文件 SHA-256。
- 生产环境与仓库最新代码可能不同；当前线上状态和待发布范围见 [项目当前状态](docs/CURRENT_STATE.md)。

## 能力概览

1. 会议开始后持续保存完整源录音，并维持统一的绝对时间轴。
2. 流式 partial 只显示在顶部当前句气泡；每个已确认句段直接作为服务端草稿进入时间轴，随后由稳定稿在原位置替换。
3. 45 秒中心窗口的文件 ASR 生成稳定文字；动态前后文、去重和单调时间约束避免跨窗重复与回放漂移。
4. 实时声纹、45 秒分离和会后聚类共用一套会议说话人轨道：草稿先显示暂定身份，后台按原行纠正，弱证据不新增可见人数。
5. 会中生成讨论状态、候选待办和动态纪要；会后基于稳定/规范转写生成最终纪要、风险、结论与行动项。
6. 历史会议支持音频回放、文本跟随、时间轴跳转、编辑转写/说话人和导出。

## 文档入口

- [项目当前状态](docs/CURRENT_STATE.md)
- [产品与功能规格](docs/product/PRODUCT_OVERVIEW.md)
- [技术架构](docs/tech/ARCHITECTURE.md)
- [会议 AI 链路](docs/tech/MEETING_AI_PIPELINE.md)
- [质量与基准测试](docs/quality/ASR_BENCHMARK.md)
- [前端同步机制](docs/engineering/FRONTEND_SYNC.md)
- [双端统一方案与发布规范](docs/双端统一方案与发布规范.md)
- [本地开发](docs/engineering/DEV_SETUP.md)
- [公网发布与公司测试部署](docs/engineering/RELEASE_PROCESS.md)

## 最短开发路径

```bash
npm install
npm run api
npm run dev
```

提交前至少运行：

```bash
npm run build
node --check server/index.mjs
```

不要提交密钥、真实录音、数据库、`.env*` 或构建产物。
