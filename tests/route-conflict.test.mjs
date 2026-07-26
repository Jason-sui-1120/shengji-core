// 路由冲突测试：共享路由表中的 * 方法与动态路径不遮蔽更具体的端侧路由。
// 验证：对共享路由表中的每个 pattern，确认它不会错误匹配端侧独有的更具体路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGlossaryRoutes } from "../modules/register-glossary-routes.mjs";
import { registerSpeakerRoutes } from "../modules/register-speaker-routes.mjs";
import { registerMeetingExtrasRoutes } from "../modules/register-meeting-extras-routes.mjs";
import { registerFinalizationRoutes } from "../modules/register-finalization-routes.mjs";
import { registerStateRoutes } from "../modules/register-state-routes.mjs";
import { registerProjectMeetingRoutes } from "../modules/register-project-meeting-routes.mjs";
import { registerProjectContextRoutes } from "../modules/register-project-context-routes.mjs";

function stubDeps() {
  return {
    readJson: async () => ({}), sendJson: () => {},
    upsertGlossaryEntry: async () => {}, deleteGlossaryEntry: async () => {},
    correctBatchGlossary: async () => ({}), getState: async () => ({}),
    renameSpeaker: async () => ({}), deleteSpeaker: async () => {},
    reconcileSpeakers: async () => ({}), backfillSpeakers: async () => {},
    reconcileByVoiceCluster: async () => ({}),
    listMeetingSegments: async () => [], replaceSummaryBlock: async () => ({}),
    insertAction: async () => ({}), updateAction: async () => ({}),
    softDeleteAction: async () => ({}), restoreAction: async () => ({}),
    canAccess: async () => true, getFinalizationGate: async () => ({}),
    saveFinalizedDraft: async () => ({}), finalizeMeeting: async () => ({}),
    startFinalizeDraftJob: () => ({}), getFinalizeDraftJobStatus: () => ({}),
    searchTranscripts: async () => ({}), insertTranscript: async () => ({}), updateTranscript: async () => ({}),
    createMeeting: async () => ({}), createProject: async () => ({}), getTrash: async () => ({}),
    softDeleteProject: async () => ({}), restoreProject: async () => ({}), purgeProject: async () => ({}),
    softDeleteMeeting: async () => ({}), restoreMeeting: async () => ({}), purgeMeeting: async () => ({}), purgeAction: async () => ({}),
    updateProjectMemory: async () => ({}), chatWithProject: async () => ({}),
    getProjectChatHistory: async () => ({}), createActionFromChat: async () => ({}), markProjectChatMemorySaved: async () => ({}),
    getAuthContext: () => ({}),
  };
}

const allSharedRoutes = [
  ...registerGlossaryRoutes(stubDeps()),
  ...registerSpeakerRoutes(stubDeps()),
  ...registerMeetingExtrasRoutes(stubDeps()),
  ...registerFinalizationRoutes(stubDeps()),
  ...registerStateRoutes(stubDeps()),
  ...registerProjectMeetingRoutes(stubDeps()),
  ...registerProjectContextRoutes(stubDeps()),
];

// 端侧独有的更具体路由（不应被共享路由的 * 方法或宽 pattern 遮蔽）
const endpointSpecificPaths = [
  { method: "GET", path: "/api/projects/1/chat" },           // 项目聊天详情
  { method: "GET", path: "/api/projects/1/members" },         // 成员管理
  { method: "PATCH", path: "/api/projects/1/visibility" },   // 可见性管理
  { method: "GET", path: "/api/meetings/1/playback" },       // 回放
  { method: "GET", path: "/api/meetings/1/export.md" },      // 导出
  { method: "GET", path: "/api/meetings/1/transcripts" },    // 会议转写
  { method: "GET", path: "/api/meetings/1/transcripts.md" }, // 转写导出
  { method: "GET", path: "/api/asr/models" },                 // ASR 模型
  { method: "GET", path: "/api/asr/probe" },                  // ASR 探测
  { method: "GET", path: "/api/auth/mock-users" },            // 认证
];

test("共享路由不遮蔽端侧独有的更具体路由", () => {
  for (const { method, path } of endpointSpecificPaths) {
    for (const route of allSharedRoutes) {
      if (route.method !== "*" && route.method !== method) continue;
      const m = path.match(route.pattern);
      if (m) {
        // 匹配了——检查是否是合法的共享路由（而不是遮蔽）
        // /api/projects/:id 匹配 /api/projects/1/chat 吗？不，pattern 是 /^\/api\/projects\/(\d+)$/ 精确结尾
        assert.fail(`共享路由 ${route.method} ${route.pattern} 错误匹配了端侧路由 ${method} ${path}`);
      }
    }
  }
  console.log(`✓ ${endpointSpecificPaths.length} 个端侧独有路由不被共享路由遮蔽`);
});

test("共享路由 * 方法只匹配精确路径（不误匹配子路径）", () => {
  // /api/projects/:id 的 pattern 是 /^\/api\/projects\/(\d+)$/——精确结尾，不匹配 /api/projects/1/chat
  const projectMeeting = allSharedRoutes.find((r) => r.pattern.source.includes("projects") && r.method === "*");
  assert.ok(projectMeeting, "应有项目路由");
  assert.ok(!"/api/projects/1/chat".match(projectMeeting.pattern), "项目路由不应匹配 /chat 子路径");
  assert.ok(!"/api/projects/1/members".match(projectMeeting.pattern), "项目路由不应匹配 /members 子路径");
  assert.ok("/api/projects/1".match(projectMeeting.pattern), "项目路由应匹配精确 /:id");
});
