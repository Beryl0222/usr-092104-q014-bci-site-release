import assert from "node:assert/strict";
import test from "node:test";

import { admin, buildScenario, routineSession, therapist } from "./scenario.js";

// 基础场景（dev-01 / dm-1.4 / site-a）之外，再登记 dev-02 / dm-1.5 / site-b，各跑一次会话。
function buildTwoModels() {
  const backend = buildScenario();
  backend.startSession(therapist, { session_id: "s-1", ...routineSession });
  backend.completeSession(therapist, { session_id: "s-1", result_summary: "完成 20 分钟训练，无异常" });

  backend.verifySiteCondition(admin, { site_id: "site-b", checks: ["屏蔽室"], valid_until: "2027-01-01T00:00:00+08:00" });
  backend.releaseSite(admin, { site_id: "site-b" });
  backend.publishModel(admin, { model_id: "dm-1.5", algorithm_family: "CSP+LR", artifact_hash: "sha256:dm15" });
  backend.assembleConfiguration(admin, {
    configuration_id: "cfg-2",
    composition: { hardware_batch: "batch-8", acquisition_firmware: "fw-3.3.0", decoder_model: "dm-1.5", exoskeleton_controller: "exo-ctl-2" },
    devices: [{ device_id: "dev-02", site_id: "site-b" }],
  });
  backend.recordCalibration(admin, {
    calibration_id: "cal-2",
    device_id: "dev-02",
    configuration_id: "cfg-2",
    configuration_version: 1,
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });
  backend.grantRelease(admin, {
    grant_id: "grant-2",
    scope: "routine",
    configuration_id: "cfg-2",
    configuration_version: 1,
    site_id: "site-b",
    protocol_id: "proto-1",
    protocol_version: 1,
    population_id: "pop-1",
    evidence_ids: ["ev-1"],
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });
  backend.startSession(therapist, { session_id: "s-2", ...routineSession, device_id: "dev-02" });
  backend.completeSession(therapist, { session_id: "s-2", result_summary: "完成训练，出现轻微漂移" });
  return backend;
}

test("模型变更后列出受影响站点与历史结果", () => {
  const backend = buildTwoModels();
  const impact = backend.impactOfComponent({ decoder_model: "dm-1.4" });

  assert.deepEqual(impact.affected_sites, ["site-a"]);
  assert.deepEqual(impact.affected_devices.map((d) => d.device_id), ["dev-01"]);
  assert.deepEqual(impact.configuration_versions.map((c) => c.configuration_id), ["cfg-1"]);
  assert.deepEqual(impact.sessions.map((s) => s.session_id), ["s-1"]);
  assert.equal(impact.sessions[0].result_summary, "完成 20 分钟训练，无异常");
});

test("固件变更的影响面只覆盖使用该固件的组合", () => {
  const backend = buildTwoModels();
  const impact = backend.impactOfComponent({ acquisition_firmware: "fw-3.3.0" });

  assert.deepEqual(impact.affected_sites, ["site-b"]);
  assert.deepEqual(impact.affected_devices.map((d) => d.device_id), ["dev-02"]);
  assert.deepEqual(impact.sessions.map((s) => s.session_id), ["s-2"]);
});

test("影响面分析至少需要一个构成要素", () => {
  const backend = buildTwoModels();
  assert.throws(() => backend.impactOfComponent({}), /至少指定一个构成要素/);
});
