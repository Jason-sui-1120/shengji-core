/**
 * finalize-evidence.mjs —— 会后归档证据构建（两端共用）。
 * 稳定转写格式化、分块、事实证据提取（长会议不丢前半场）。
 */
import { AIT_FINAL_FAST_MODEL } from "./config.mjs";

export function formatStableTranscriptLines(transcripts) {
  return (Array.isArray(transcripts) ? transcripts : [])
    .map((line) => `[T${line.id}][${line.qualityStatus || "unknown"}] ${line.time} ${line.speaker}: ${line.text}`)
    .filter((line) => line.trim());
}

export function splitTranscriptIntoChunks(transcripts, maxChars = 14_000, overlapLines = 5) {
  const chunks = [];
  let lines = [];
  let size = 0;
  const allLines = formatStableTranscriptLines(transcripts);
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i];
    if (lines.length && size + line.length + 1 > maxChars) {
      chunks.push(lines.join("\n"));
      // 保留最后 overlapLines 行作为下一块的开头，保持跨块上下文
      const overlap = lines.slice(-overlapLines);
      lines = [...overlap];
      size = overlap.reduce((sum, l) => sum + l.length + 1, 0);
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length) chunks.push(lines.join("\n"));
  return chunks;
}

export async function buildFinalTranscriptEvidence(transcripts, model, { callChatCompletion, parseJsonContent } = {}) {
  const fullText = formatStableTranscriptLines(transcripts).join("\n");
  console.log(`[finalize-evidence] transcriptCount=${transcripts.length} fullTextLen=${fullText.length}`);
  if (fullText.length <= 24_000) {
    return { mode: "full_transcript", text: fullText, chunkCount: 1 };
  }

  const chunks = splitTranscriptIntoChunks(transcripts);
  console.log(`[finalize-evidence] chunked mode, chunkCount=${chunks.length}`);
  // 限制并行度为 2，避免内存峰值导致 OOM
  const evidenceChunks = [];
  for (let batchStart = 0; batchStart < chunks.length; batchStart += 2) {
    const batch = [];
    for (let i = batchStart; i < Math.min(batchStart + 2, chunks.length); i++) {
      batch.push((async () => {
        const response = await callChatCompletion({
          model: model || AIT_FINAL_FAST_MODEL,
          messages: [
            { role: "system", content: "你是会议转写分块事实提取器。只输出合法 JSON，不得补充原文没有的事实。" },
            { role: "user", content: `请从以下第 ${i + 1}/${chunks.length} 个稳定转写分块中提取可供最终纪要使用的事实索引。每一条必须保留对应的 [T数字] 证据；不确定则不要写。\n\n输出 JSON：{"facts":["[T1] 事实"],"timeline":["[T1] 时间推进"],"decisions":["[T1] 决策"],"actions":["[T1] 行动"],"risks":["[T1] 风险或依赖"],"questions":["[T1] 待确认问题"],"quotes":["[T1] 代表性原话"]}\n\n稳定转写分块：\n${chunks[i]}` },
          ],
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
        });
        if (!response.ok) throw new Error(`第 ${i + 1} 个转写分块提取失败：${response.text.slice(0, 200)}`);
        const payload = JSON.parse(response.text);
        const content = payload?.choices?.[0]?.message?.content || "";
        console.log(`[finalize-evidence] chunk ${i + 1}/${chunks.length} contentLen=${content.length}`);
        const evidence = parseJsonContent(content);
        if (!evidence || typeof evidence !== "object") throw new Error(`第 ${i + 1} 个转写分块未返回可用事实索引`);
        return { index: i, text: `【稳定转写分块 ${i + 1}/${chunks.length}】\n${JSON.stringify(evidence)}` };
      })());
    }
    const results = await Promise.allSettled(batch);
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        evidenceChunks.push(r.value.text);
      } else {
        const failIdx = batchStart + j;
        console.error(`[finalize-evidence] chunk ${failIdx + 1} failed: ${r.reason?.message || r.reason}`);
        evidenceChunks.push(`【稳定转写分块 ${failIdx + 1}/${chunks.length}（提取失败，使用原文）】\n${chunks[failIdx]}`);
      }
    }
  }
  return { mode: "chunked_evidence", text: evidenceChunks.join("\n\n"), chunkCount: chunks.length };
}

