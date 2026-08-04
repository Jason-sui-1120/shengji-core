// core 共享 fake AI 契约——契约测试统一的可控 AI 响应，不依赖真实 gateway
// 目标：契约测试覆盖"AI 返回各种响应"的场景，不需真实 API key / 网络

/**
 * 构造可控的 callChatCompletion fake
 * @param {object} options
 * @param {object} [options.responses] - 按 prompt 关键词映射响应 { keyword: responseText }
 * @param {string} [options.defaultResponse] - 默认响应（JSON 字符串）
 * @param {boolean} [options.fail] - 是否全部失败
 * @returns {Function} callChatCompletion({model, messages, ...}) => {ok, text}
 */
export function createFakeChatCompletion({ responses = {}, defaultResponse = "{}", fail = false } = {}) {
  const calls = [];
  const fn = async ({ model, messages, ...rest }) => {
    const prompt = messages?.map((m) => m.content || "").join("\n") || "";
    calls.push({ model, prompt: prompt.slice(0, 200), ...rest });
    if (fail) {
      return { ok: false, text: "fake AI gateway error", status: 502 };
    }
    // 按关键词匹配响应
    for (const [keyword, response] of Object.entries(responses)) {
      if (prompt.includes(keyword)) {
        return { ok: true, text: wrapGatewayResponse(response), model };
      }
    }
    return { ok: true, text: wrapGatewayResponse(defaultResponse), model };
  };
  fn.calls = calls; // 暴露调用记录供断言
  return fn;
}

/**
 * 把 content 包装成 AI gateway 完整响应格式
 */
function wrapGatewayResponse(content) {
  return JSON.stringify({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
}

/**
 * 构造可控的 callFinalMinutes fake（返回结构化纪要）
 * @param {object} minutes - 要返回的纪要对象
 * @returns {Function} callFinalMinutes({meeting, transcripts, ...}) => {ok, data}
 */
export function createFakeFinalMinutes(minutes = {}) {
  const defaultMinutes = {
    overview: "测试会议概述[T1]",
    topics: [{ title: "测试议题", bullets: ["测试要点[T1]"] }],
    timelineChapters: [{ startTime: "00:00", title: "开场", summary: "测试" }],
    decisions: ["测试决策[T1]"],
    risks: ["测试风险[T1]"],
    openQuestions: [],
    quoteMoments: [{ quote: "测试金句", speaker: "说话人 1", reason: "测试" }],
    speakerViewpoints: [{ speaker: "说话人 1", viewpoints: ["测试观点[T1]"] }],
    actionUpdates: [],
  };
  const merged = { ...defaultMinutes, ...minutes };
  return async () => ({ ok: true, data: merged });
}

/**
 * 构造可控的 parseJsonContent fake
 * @param {object} [mapping] - text → parsed object
 * @returns {Function} parseJsonContent(text) => object
 */
export function createFakeParseJsonContent(mapping = {}) {
  return (text) => {
    for (const [key, value] of Object.entries(mapping)) {
      if (String(text).includes(key)) return value;
    }
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
}

/**
 * 标准 AI 错误场景集合（契约测试复用）
 */
export const aiErrorScenarios = {
  /** gateway 502 错误 */
  gatewayError: { ok: false, text: "AI gateway unavailable", status: 502 },
  /** 返回非 JSON */
  invalidJson: { ok: true, text: "这不是 JSON" },
  /** 返回空 choices */
  emptyChoices: { ok: true, text: JSON.stringify({ choices: [] }) },
  /** 返回空 content */
  emptyContent: { ok: true, text: JSON.stringify({ choices: [{ message: { content: "" } }] }) },
  /** 返回非对象 JSON */
  nonObjectJson: { ok: true, text: JSON.stringify({ choices: [{ message: { content: "[1,2,3]" } }] }) },
};
