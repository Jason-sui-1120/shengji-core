/**
 * speaker-gateway.mjs —— 说话人 embedding/diarization 的网关封装。
 * 统一处理"直连 AIT"和"通过 AI 网关"两种调用方式，无状态无 DB。
 */
import { toGatewayHttpUrl, getGatewayHeaders } from "./http-utils.mjs";
import {
  AI_GATEWAY_BASE_URL, BELLA_API_BASE_URL,
  AIT_API_KEY,
  AIT_SPEAKER_EMBEDDING_ENDPOINT, AIT_SPEAKER_DIARIZATION_ENDPOINT,
} from "./config.mjs";

function getRequestId(response) {
  return response?.headers?.get?.("x-request-id")
    || response?.headers?.get?.("x-bella-request-id")
    || response?.headers?.get?.("x-bella-trace-id")
    || response?.headers?.get?.("trace-id")
    || "";
}

async function toSpeakerResponse(response) {
  return {
    ok: response.ok,
    status: response.status,
    requestId: getRequestId(response),
    text: await response.text(),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function getUploadedFileId(payload) {
  return payload?.id || payload?.data?.id || payload?.file_id || payload?.data?.file_id || "";
}

function getUploadedFileUrl(payload) {
  const value = payload?.url || payload?.data?.url || payload?.data;
  return typeof value === "string" ? value : "";
}

function shouldRetryDiarizationWithUpload(response) {
  const status = Number(response?.status || 0);
  const detail = String(response?.text || "");
  return status === 0
    || status >= 500
    || /(?:url|download|connection adapters|failed to fetch|cannot access|unreachable)/i.test(detail);
}

/**
 * CampPlus 只接受可下载的 HTTP(S) URL。应用回源 URL 受网关、签名或网络策略
 * 影响而不可达时，把同一段 WAV 临时上传到 AIT 文件服务，获得模型可访问的 URL。
 * `purpose=temp` 由文件服务负责过期清理，不在应用侧形成第二份长期录音。
 */
export async function uploadTemporarySpeakerAudio(audioBase64, {
  signal,
  apiKey = AIT_API_KEY,
  apiBase = BELLA_API_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  const audio = Buffer.from(String(audioBase64 || ""), "base64");
  if (!audio.length) throw new Error("speaker audio is empty");
  if (!apiKey) throw new Error("AIT_API_KEY is not configured");
  if (!apiBase) throw new Error("BELLA_API_BASE_URL is not configured");

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speaker-window.wav");
  form.append("purpose", "temp");
  const headers = buildAitAuthorizationHeaders(apiKey);
  const uploadResponse = await fetchImpl(`${String(apiBase).replace(/\/$/, "")}/files`, {
    method: "POST",
    headers,
    body: form,
    signal,
  });
  const uploadText = await uploadResponse.text();
  const fileId = getUploadedFileId(parseJson(uploadText));
  if (!uploadResponse.ok || !fileId) {
    throw new Error(`speaker file upload failed: ${uploadResponse.status}`);
  }

  const urlResponse = await fetchImpl(`${String(apiBase).replace(/\/$/, "")}/files/${encodeURIComponent(fileId)}/url`, {
    headers,
    signal,
  });
  const urlText = await urlResponse.text();
  const url = getUploadedFileUrl(parseJson(urlText));
  if (!urlResponse.ok || !/^https?:\/\//i.test(url)) {
    throw new Error(`speaker file URL failed: ${urlResponse.status}`);
  }
  return url;
}

export function buildAitAuthorizationHeaders(apiKey = AIT_API_KEY) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export async function directSpeakerEmbedding(body) {
  if (!AIT_API_KEY) {
    return { ok: false, status: 500, text: JSON.stringify({ error: "AIT_API_KEY is not configured" }) };
  }
  const response = await fetch(`${BELLA_API_BASE_URL}${AIT_SPEAKER_EMBEDDING_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildAitAuthorizationHeaders(),
    },
    body: JSON.stringify(body),
  });
  return toSpeakerResponse(response);
}

export async function callSpeakerEmbedding(body) {
  if (AI_GATEWAY_BASE_URL) {
    const response = await fetch(toGatewayHttpUrl("/gateway/speaker/embedding"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...getGatewayHeaders(),
      },
      body: JSON.stringify(body),
    });
    return toSpeakerResponse(response);
  }
  return directSpeakerEmbedding(body);
}

export async function executeDirectSpeakerDiarization(body, {
  timeoutMs = 120_000,
  apiKey = AIT_API_KEY,
  apiBase = BELLA_API_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    return { ok: false, status: 500, text: JSON.stringify({ error: "AIT_API_KEY is not configured" }) };
  }
  const { audioBase64 = "", base64: legacyBase64 = "", ...requestBody } = body || {};
  const fallbackAudioBase64 = String(audioBase64 || legacyBase64 || "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = `${String(apiBase).replace(/\/$/, "")}${AIT_SPEAKER_DIARIZATION_ENDPOINT}`;
    const request = async (payload) => toSpeakerResponse(await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAitAuthorizationHeaders(apiKey),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }));

    const initialUrl = String(requestBody.url || "");
    if (/^https?:\/\//i.test(initialUrl)) {
      const directResult = await request(requestBody);
      if (directResult.ok || !fallbackAudioBase64 || !shouldRetryDiarizationWithUpload(directResult)) {
        return directResult;
      }
    } else if (!fallbackAudioBase64) {
      return { ok: false, status: 400, requestId: "", text: JSON.stringify({ error: "speaker audio URL is unavailable" }) };
    }

    const uploadedUrl = await uploadTemporarySpeakerAudio(fallbackAudioBase64, {
      signal: controller.signal,
      apiKey,
      apiBase,
      fetchImpl,
    });
    return request({ ...requestBody, url: uploadedUrl });
  } catch (error) {
    return { ok: false, status: 0, requestId: "", text: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function directSpeakerDiarization(body, timeoutMs = 120_000) {
  return executeDirectSpeakerDiarization(body, { timeoutMs });
}

export async function callSpeakerDiarization(body, timeoutMs = 120_000) {
  if (AI_GATEWAY_BASE_URL) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(toGatewayHttpUrl("/gateway/speaker/diarization"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getGatewayHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return toSpeakerResponse(response);
    } catch (error) {
      return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
  return directSpeakerDiarization(body, timeoutMs);
}
