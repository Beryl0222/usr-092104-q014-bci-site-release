import assert from "node:assert/strict";
import test from "node:test";

import { admin, buildScenario, routineSession, therapist } from "./scenario.js";

const lead = { id: "lead-a", role: "center_lead", site_id: "site-a" };

function issueWithdrawInstruction(backend) {
  backend.issueInstruction(admin, {
    instruction_id: "ins-1",
    site_id: "site-a",
    kind: "withdraw_release",
    payload: { grant_id: "grant-1" },
    not_before: "2026-10-04T10:00:00+08:00",
    not_after: "2026-10-04T11:00:00+08:00",
  });
}

test("离线中心重新联网时不补执行过期指令", () => {
  const backend = buildScenario(); // 当前时间 09:00，站点随后离线
  issueWithdrawInstruction(backend);

  // 12:00 才重新联网：指令已过期
  const outcomes = backend.reconnectSite(lead, { site_id: "site-a", at: "2026-10-04T12:00:00+08:00" });
  assert.deepEqual(outcomes, [{ instruction_id: "ins-1", outcome: "rejected_expired" }]);

  // 放行未被撤销，会话仍可开始
  assert.equal(backend.checkClearance({ ...routineSession, operator_id: therapist.id }).decision, "approved");
  assert.equal(backend.events().filter((e) => e.event_type === "RELEASE_WITHDRAWN").length, 0);
  assert.ok(backend.events().some((e) => e.event_type === "INSTRUCTION_REJECTED_EXPIRED" && e.aggregate_id === "ins-1"));
});

test("有效期内的指令在重连时执行", () => {
  const backend = buildScenario();
  issueWithdrawInstruction(backend);

  const outcomes = backend.reconnectSite(lead, { site_id: "site-a", at: "2026-10-04T10:30:00+08:00" });
  assert.deepEqual(outcomes, [{ instruction_id: "ins-1", outcome: "applied" }]);

  assert.equal(backend.events().filter((e) => e.event_type === "RELEASE_WITHDRAWN").length, 1);
  const result = backend.checkClearance({ ...routineSession, operator_id: therapist.id, at: "2026-10-04T10:30:00+08:00" });
  assert.equal(result.decision, "denied");
});

test("过期指令不会二次处理", () => {
  const backend = buildScenario();
  issueWithdrawInstruction(backend);
  backend.reconnectSite(lead, { site_id: "site-a", at: "2026-10-04T12:00:00+08:00" });
  const again = backend.reconnectSite(lead, { site_id: "site-a", at: "2026-10-04T13:00:00+08:00" });
  assert.deepEqual(again, []);
});
