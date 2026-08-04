// core 共享 Markdown 导出格式化工具——两端完全一致（md5 校验），统一来源
// 用于 exportFinalizedMeetingMarkdown / exportMeetingTranscriptsMarkdown 的纪要/转写导出

export function formatTopicMarkdown(topics = []) {
  if (!topics.length) return ["暂无议题纪要。"];
  return topics.flatMap((topic) => [
    `### ${topic.title || "会议议题"}`,
    "",
    ...formatListMarkdown(topic.bullets, "暂无议题内容。"),
    "",
  ]);
}

export function formatTimelineMarkdown(chapters = []) {
  if (!chapters.length) return ["- 暂无时间轴章节。"];
  return chapters.map((chapter) => `- ${chapter.startTime || "时间未知"} ${chapter.title || "会议章节"}：${chapter.summary || "暂无摘要。"}`);
}

export function formatQuoteMarkdown(moments = []) {
  if (!moments.length) return ["- 暂无金句。"];
  return moments.map((moment) => `- 「${moment.quote}」${moment.speaker ? `—— ${moment.speaker}` : ""}${moment.reason ? `。${moment.reason}` : ""}`);
}

export function formatSpeakerViewpointMarkdown(viewpoints = []) {
  if (!viewpoints.length) return ["- 暂无发言人观点。"];
  return viewpoints.flatMap((item) => [
    `### ${item.speaker || "未知发言人"}`,
    "",
    ...formatListMarkdown(item.viewpoints, "暂无观点。"),
    "",
  ]);
}

export function formatListMarkdown(items = [], emptyText) {
  const usableItems = items.map((item) => String(item || "").trim()).filter(Boolean);
  return usableItems.length ? usableItems.map((item) => `- ${item}`) : [`- ${emptyText}`];
}

export function formatActionMarkdown(actions = []) {
  if (!actions.length) return ["- 暂无待办。"];
  return actions.map((action) => {
    const status = { candidate: "候选", clarify: "待澄清", confirmed: "已确认", in_progress: "进行中", done: "已完成", cancelled: "已取消" }[action.status] || action.status || "待确认";
    const source = action.source ? `；来源：${action.source}` : "";
    return `- ${action.title || "待办事项"}（负责人：${action.owner || "待确认"}；截止：${action.due || "待确认"}；状态：${status}${source}）`;
  });
}

export function formatExportTime(value) {
  if (!value) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

export function safeFileName(value) {
  return String(value || "会议纪要").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "会议纪要";
}
