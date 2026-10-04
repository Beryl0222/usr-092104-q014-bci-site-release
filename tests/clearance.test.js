import assert from "node:assert/strict";
import test from "node:test";

import { admin, buildScenario, routineSession, therapist } from "./scenario.js";

test("完整登记后放行判定为获准，并给出所依据的版本组合", () => {
  const backend = buildScenario();
  const result = backend.checkClearance({ ...routineSession, operator_id: therapist.id });
  assert.equal(result.decision, "approved");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.combination.configuration_id, "cfg-1");
  assert.equal(result.combination.configuration_version, 1);
  assert.equal(result.combination.hardware_batch, "batch-7");
  assert.equal(result.combination.acquisition_firmware, "fw-3.2.0");
  assert.equal(result.combination.decoder_model, "dm-1.4");
  assert.equal(result.combination.exoskeleton_controller, "exo-ctl-2");
  assert.equal(result.combination.calibration_id, "cal-1");
  assert.equal(result.combination.release_grant_id, "grant-1");
  assert.equal(result.combination.credential_id, "cred-1");
  assert.equal(result.combination.population_id, "pop-1");
});

test("会话开始时记录完整版本组合快照", () => {
  const backend = buildScenario();
  const result = backend.startSession(therapist, { session_id: "s-1", ...routineSession });
  assert.equal(result.decision, "approved");
  const started = backend.events().find((e) => e.event_type === "SESSION_STARTED");
  assert.equal(started.payload.combination.configuration_version, 1);
  assert.equal(started.payload.prescription_ref, "rx-2026-1001");
});

test("科研验证、试用许可不能顶替常规康复启用", () => {
  const backend = buildScenario();
  for (const scope of ["research", "trial"]) {
    const result = backend.checkClearance({ ...routineSession, operator_id: therapist.id, scope });
    assert.equal(result.decision, "denied");
    assert.ok(result.reasons.some((r) => r.includes("不能顶替")), `scope=${scope} 应提示用途不能顶替`);
  }
});

test("仅有科研放行的组合不能用于常规康复会话", () => {
  const backend = buildScenario();
  backend.withdrawRelease(admin, { grant_id: "grant-1", reason: "改为仅科研" });
  backend.acceptEvidence(admin, { evidence_id: "ev-2", scope: "research", kind: "台架验证", configuration_id: "cfg-1", configuration_version: 1, result: "通过" });
  backend.grantRelease(admin, {
    grant_id: "grant-2",
    scope: "research",
    configuration_id: "cfg-1",
    configuration_version: 1,
    site_id: "site-a",
    protocol_id: "proto-1",
    protocol_version: 1,
    population_id: "pop-1",
    evidence_ids: ["ev-2"],
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });
  const result = backend.startSession(therapist, { session_id: "s-2", ...routineSession });
  assert.equal(result.decision, "denied");
  assert.ok(result.reasons.some((r) => r.includes("常规康复启用")));
  assert.ok(backend.events().some((e) => e.event_type === "SESSION_DENIED" && e.aggregate_id === "s-2"));
});

test("科研用途的证据不能支撑常规放行登记", () => {
  const backend = buildScenario();
  backend.acceptEvidence(admin, { evidence_id: "ev-3", scope: "research", kind: "台架验证", configuration_id: "cfg-1", configuration_version: 1, result: "通过" });
  assert.throws(
    () =>
      backend.grantRelease(admin, {
        grant_id: "grant-3",
        scope: "routine",
        configuration_id: "cfg-1",
        configuration_version: 1,
        site_id: "site-a",
        protocol_id: "proto-1",
        protocol_version: 1,
        population_id: "pop-1",
        evidence_ids: ["ev-3"],
        valid_from: "2026-10-01T00:00:00+08:00",
        valid_until: "2026-12-31T23:59:59+08:00",
      }),
    /不能支撑常规康复启用放行/,
  );
});

test("校准过期后放行拒绝", () => {
  const backend = buildScenario();
  const result = backend.checkClearance({ ...routineSession, operator_id: therapist.id, at: "2027-02-01T09:00:00+08:00" });
  assert.equal(result.decision, "denied");
  assert.ok(result.reasons.some((r) => r.includes("校准")));
});

test("构成版本停用后精确拒绝该版本", () => {
  const backend = buildScenario();
  backend.withdrawConfiguration(admin, { configuration_id: "cfg-1", target_version: 1, reason: "升级后信号漂移" });
  const result = backend.checkClearance({ ...routineSession, operator_id: therapist.id });
  assert.equal(result.decision, "denied");
  assert.ok(result.reasons.some((r) => r.includes("信号漂移")));
});

test("资质缺少对应用途时放行拒绝", () => {
  const backend = buildScenario();
  const result = backend.checkClearance({ ...routineSession, operator_id: "therapist-2" });
  assert.equal(result.decision, "denied");
  assert.ok(result.reasons.some((r) => r.includes("资质")));
});

test("未登记设备直接拒绝", () => {
  const backend = buildScenario();
  const result = backend.checkClearance({ ...routineSession, device_id: "dev-x", operator_id: therapist.id });
  assert.equal(result.decision, "denied");
  assert.ok(result.reasons.some((r) => r.includes("未登记产品构成")));
});
