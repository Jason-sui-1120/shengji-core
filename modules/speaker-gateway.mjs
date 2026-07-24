/**
 * speaker-gateway.mjs —— 说话人 embedding/diarization 的网关封装。
 * 统一处理"直连 AIT"和"通过 AI 网关"两种调用方式，无状态无 DB。
 */
import { toGatewayHttpUrl, getGatewayHeaders } from "./http-utils.mjs";
import {
  AI_GATEWAY_BASE_URL, BELLA_API_BASE_URL,
  AIT_SPEAKER_EMBEDDING_ENDPOINT, AIT_SPEAKER_DIARIZATION_ENDPOINT,
} from "./config.mjs";

export async function directSpeakerEmbedding(body) {
  if (!process.env.AIT_API_KEY) {
    return { ok: false, status: 500, text: JSON.stringify({ error: "AIT_API_KEY is not configured" }) };
  }
  const response = await fetch(`${BELLA_API_BASE_URL}${AIT_SPEAKER_EMBEDDING_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.AIT_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
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
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }
  return directSpeakerEmbedding(body);
}

export async function directSpeakerDiarization(body) {
  if (!process.env.AIT_API_KEY) {
    return { ok: false, status: 500, text: JSON.stringify({ error: "AIT_API_KEY is not configured" }) };
  }
  const response = await fetch(`${BELLA_API_BASE_URL}${AIT_SPEAKER_DIARIZATION_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.AIT_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
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
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    } catch (error) {
      return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
  return directSpeakerDiarization(body);
}
