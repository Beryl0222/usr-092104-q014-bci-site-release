import assert from "node:assert/strict";
import test from "node:test";

import { buildScenario, routineSession, safetyOfficer, therapist } from "./scenario.js";

const receipt = {
  device_id: "dev-01",
  acknowledged_at: "2026-10-04T09:00:01+08:00",
  reported_state: "exoskeleton_powered_off",
};

test("紧急停止立即生效并保存设备回执", () => {
  const backend = buildScenario();
  const before = backend.checkClearance({ ...routineSession, operator_id: therapist.id });
  assert.equal(before.decision, "approved");

  backend.emergencyStop(therapist, { stop_id: "stop-1", target: { kind: "device", device_id: "dev-01" }, reason: "外骨骼异常抖动", device_receipt: receipt });

  // 同一时刻再判定：立即拒绝
  const after = backend.checkClearance({ ...routineSession, operator_id: therapist.id });
  assert.equal(after.decision, "denied");
  assert.ok(after.reasons.some((r) => r.includes("外骨骼异常抖动")));

  // 新会话同样被拒绝
  const session = backend.startSession(therapist, { session_id: "s-1", ...routineSession });
  assert.equal(session.decision, "denied");

  // 回执随事件保存
  const stop = backend.events().find((e) => e.event_type === "SAFETY_STOPPED");
  assert.deepEqual(stop.payload.device_receipt, receipt);
});

test("缺少设备回执的紧急停止被拒绝", () => {
  const backend = buildScenario();
  assert.throws(
    () => backend.emergencyStop(therapist, { stop_id: "stop-1", target: { kind: "device", device_id: "dev-01" }, reason: "异常" }),
    /设备回执/,
  );
});

test("恢复必须由有权人员重新批准", () => {
  const backend = buildScenario();
  backend.emergencyStop(therapist, { stop_id: "stop-1", target: { kind: "device", device_id: "dev-01" }, reason: "异常", device_receipt: receipt });

  // 治疗师无权恢复
  assert.throws(() => backend.approveRecovery(therapist, { stop_id: "stop-1" }), /未授权/);
  assert.equal(backend.checkClearance({ ...routineSession, operator_id: therapist.id }).decision, "denied");

  // 安全官批准后恢复
  backend.approveRecovery(safetyOfficer, { stop_id: "stop-1" });
  assert.equal(backend.checkClearance({ ...routineSession, operator_id: therapist.id }).decision, "approved");
});

test("按构成版本停止可精确暂停升级后出现漂移的范围", () => {
  const backend = buildScenario();
  backend.emergencyStop(safetyOfficer, {
    stop_id: "stop-2",
    target: { kind: "configuration", configuration_id: "cfg-1", configuration_version: 1 },
    reason: "fw-3.2.0 升级后信号漂移",
    device_receipt: receipt,
  });
  const result = backend.checkClearance({ ...routineSession, operator_id: therapist.id });
  assert.equal(result.decision, "denied");
  assert.ok(result.reasons.some((r) => r.includes("信号漂移")));
});
