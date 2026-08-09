// config.mjs —— core 仓库内的测试 shim（不在 core-sync 同步清单中，不会复制到消费端）。
// 真实配置由两端各自的 server/config.mjs 提供（常量式接口，两端一致）。
// 此文件只让 core 模块在 core 仓库内可独立 import/冒烟，默认值与两端 config.mjs 保持一致。
export const AIT_API_KEY = "";
export const AIT_PUBLIC_BASE_URL = "";
export const AIT_AUDIO_URL_SIGNING_SECRET = "";
export const AI_GATEWAY_BASE_URL = "";
export const AI_GATEWAY_SHARED_TOKEN = "";
export const BELLA_API_BASE_URL = "";
export const AIT_FINAL_MODEL = "Qwen3.7-Max";
export const AIT_FINAL_FAST_MODEL = "Qwen3.5-Flash";
export const ROLLING_ASR_TIMEOUT_MS = 90_000;
export const ROLLING_ASR_URL_TIMEOUT_MS = 60_000;
export const ROLLING_ASR_MODEL = "huoshan-asr";
export const ROLLING_ASR_MIN_WINDOW_OVERLAP_RATIO = 0.4;
export const AIT_SPEAKER_EMBEDDING_ENDPOINT = "/audio/speaker/embedding";
export const AIT_SPEAKER_EMBEDDING_MODEL = "ke-speaker-embedding-campplus";
export const AIT_SPEAKER_DIARIZATION_ENDPOINT = "/audio/speaker/diarization";
export const AIT_SPEAKER_DIARIZATION_MODEL = "ke-campplus-16k-common-advanced";
export const SPEAKER_EMBEDDING_THRESHOLD = 0.55;
export const SPEAKER_CANDIDATE_THRESHOLD = 0.62;
export const SPEAKER_CANDIDATE_PROMOTE_COUNT = 3;
export const SPEAKER_DIARIZATION_MIN_SEGMENT_SECONDS = 0.25;
export const SESSION_SIGNATURE = "";
