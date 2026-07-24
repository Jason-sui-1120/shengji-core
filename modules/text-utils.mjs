/**
 * text-utils.mjs —— 文本规范化纯函数。
 * 无状态、无 DB、无网络依赖，可被 speakers/asr-live/finalize 等模块共用。
 */

export function normalizeSpeakerKey(value) {
  const raw = String(value).trim();
  const numberMatch = raw.match(/(\d+)/);
  if (numberMatch) {
    const number = Number(numberMatch[1]);
    return `说话人 ${number === 0 ? 1 : number}`;
  }
  return raw.startsWith("说话人") ? raw : `说话人 ${raw}`;
}

export function normalizeTranscriptSegment(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([。！？!?])\1+/g, "$1")
    .trim();
}

const FILLER_WORDS = /^(嗯+|啊+|呃+|唉+|哎+|哦+|噢+|哈+|呵+|嘿+|嘛+|呢+|吧+|呀+|噢+|唔+|呣+|哼+|嗷+|呜+|额+|鸭+|尼+|把+|得+|的+|了+|是+|在+|有+|个+|这+|那+|什么+|就是+|然后+|就是说+|然后说+|那个+|这个+|一个+|对+|好+|行+|是吧+|对吧+|好吧+|好的+|可以+|OK+|ok+|嗯哼+|嗯啊+|啊哈+|好的呀+|行吧+|好嘞+|嗯呢+|是呀+|对呀+|好的吧+|嗯好的+|好谢谢+|谢谢+|好嗯+|嗯好+|好嗯好+|嗯嗯好+|好嗯嗯+|嗯嗯嗯+|好对+|对嗯+|嗯对+|行嗯+|嗯行+|嗯嗯行+|行嗯嗯+|嗯嗯好嗯+|好嗯嗯好+|嗯好嗯+|好嗯好嗯+|嗯嗯+|嗯嗯嗯+|嗯嗯嗯嗯+|嗯嗯嗯嗯嗯+|好+|好的+|好吧+|好嘞+|行+|行吧+|对+|对吧+|是+|是吧+|可以+|OK+|嗯+|啊+|呃+|哦+|哎+|唉+|哈+|嘛+|呢+|吧+|呀+|额+|噢+|唔+|哼+|嗷+|呜+|嘿+|呵+|嗯哼+|嗯啊+|啊哈+|嗯呢+|对呀+|是呀+|好嘞+|嗯好的+|嗯好+|好嗯+|嗯对+|对嗯+|嗯行+|行嗯+|嗯嗯好+|好嗯嗯+|嗯嗯行+|行嗯嗯+|嗯好嗯+|好嗯好+|嗯嗯嗯好+|好嗯嗯嗯+|嗯嗯嗯行+|行嗯嗯嗯+|好对+|对好+|好谢谢+|谢谢+|好嗯好嗯+|嗯好嗯好+|好嗯好+|嗯好嗯+|嗯嗯嗯嗯好+|好嗯嗯嗯嗯+|嗯嗯嗯嗯嗯好+|好嗯嗯嗯嗯嗯+|嗯嗯嗯嗯嗯嗯+|嗯嗯嗯嗯嗯嗯嗯+|嗯嗯嗯嗯嗯嗯嗯嗯+|嗯嗯嗯嗯嗯嗯嗯嗯嗯+)([。！？!?，,.]?\s*)$/i;

export function isFillerOnly(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if (/^[。！？!?，,.；;：:\s]+$/.test(trimmed)) return true;
  if (FILLER_WORDS.test(trimmed)) return true;
  const noPunct = trimmed.replace(/[。！？!?，,.；;：:、\s]/g, "");
  if (noPunct.length <= 4 && /^(嗯+|啊+|呃+|哦+|哎+|唉+|哈+|嘛+|呢+|吧+|呀+|额+|噢+|唔+|哼+|嗷+|呜+|嘿+|呵+|好+|对+|行+|是+|可以+|谢谢+|好的+|好吧+|对吧+|是吧+|行吧+|好嘞+|嗯哼+|嗯呢+|对呀+|是呀+|嗯好+|好嗯+|嗯对+|对嗯+|嗯行+|行嗯+)+$/i.test(noPunct)) return true;
  return false;
}
