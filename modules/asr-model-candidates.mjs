/**
 * asr-model-candidates.mjs —— ASR 模型候选列表（唯一来源）。
 * schema.mjs（种子数据）与 index.mjs（/api/asr/models）都从本模块导入，
 * 不允许各自维护。修改模型候选只改这里。
 */
export const asrModels = [
  {
    id: "ke-stream-asr",
    vendor: "KE",
    pricePerHour: 1,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "default",
    reason: "平台内置实时流式 ASR，价格低，适合作为会议记录 MVP 默认模型。",
  },
  {
    id: "ke-funasr-paraformer-large-stream-asr",
    vendor: "KE FunASR",
    pricePerHour: 1,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "candidate",
    reason: "FunASR Paraformer 流式模型，成本低，适合作为中文会议识别对照模型。",
  },
  {
    id: "ke-funasr-paraformer-0105",
    vendor: "KE FunASR",
    pricePerHour: 1,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "candidate",
    reason: "同价位候选模型，可用于中文会议准确率 A/B 测试。",
  },
  {
    id: "huoshan-realtime-asr",
    vendor: "Volcengine",
    pricePerHour: 1.2,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "benchmark",
    reason: "成本略高但可作为外部厂商实时识别基线。",
  },
  {
    id: "huoshanLM-realtime-asr",
    vendor: "Volcengine",
    pricePerHour: 1.5,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "benchmark",
    reason: "适合对照测试识别质量和稳定性，不建议 MVP 默认。",
  },
  {
    id: "huoshanLM-realtime-asr-nostream",
    vendor: "Volcengine",
    pricePerHour: 1.5,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "fallback",
    reason: "非流式倾向，不适合作为实时会议主链路默认。",
  },
  {
    id: "tencent-realtime-asr-zh",
    vendor: "Tencent",
    pricePerHour: 3,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "fallback",
    reason: "中文实时识别能力成熟，但价格明显高，先不做默认。",
  },
  {
    id: "ke-realtime-fireredasr-test",
    vendor: "KE",
    pricePerHour: 1,
    endpoint: "/v1/audio/asr/stream",
    recommendation: "lab",
    reason: "名称带 test，先作为实验模型，不进入默认生产候选。",
  },
];
