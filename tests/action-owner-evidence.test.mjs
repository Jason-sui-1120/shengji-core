import test from "node:test";
import assert from "node:assert/strict";
import { validateActionOwnerFromEvidence } from "./action-owner-evidence.mjs";

test("仅由说话人汇报计划时不得猜测其为负责人", () => {
  const owner = validateActionOwnerFromEvidence({
    owner: "说话人3",
    source: "[T12] 今晚再上线一次，之后找两条数据验证",
  }, [{ id: 12, speaker: "说话人3", text: "今晚再上线一次，上线之后会找两条相同的数据验证" }]);
  assert.equal(owner, "待确认");
});

test("明确第一人称承诺时保留说话人负责人", () => {
  const owner = validateActionOwnerFromEvidence({
    owner: "说话人3",
    source: "[T12] 我来验证",
  }, [{ id: 12, speaker: "说话人3", text: "这个我来验证，今晚给结果" }]);
  assert.equal(owner, "说话人3");
});

test("原文明示让具体角色处理时保留负责人", () => {
  const owner = validateActionOwnerFromEvidence({
    owner: "VP",
    source: "[T13] 让VP先处理",
  }, [{ id: 13, speaker: "说话人2", text: "下周四上线，然后会让 VP 先处理" }]);
  assert.equal(owner, "VP");
});

test("没有对应证据时负责人回落待确认", () => {
  assert.equal(validateActionOwnerFromEvidence({ owner: "开发团队", source: "[T99] 上线" }, []), "待确认");
});
