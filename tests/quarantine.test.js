import assert from "node:assert/strict";
import test from "node:test";

import { admin, buildScenario, routineSession, safetyOfficer, therapist } from "./scenario.js";

// 在基础场景上扩展：site-a 增加 batch-8 设备，site-b 增加同批次 batch-7 设备。
function buildMultiSite() {
  const backend = buildScenario();
  backend.verifySiteCondition(admin, { site_id: "site-b", checks: ["屏蔽室"], valid_until: "2027-01-01T00:00:00+08:00" });
  backend.releaseSite(admin, { site_id: "site-b" });

  backend.assembleConfiguration(admin, {
    configuration_id: "cfg-2",
    composition: { hardware_batch: "batch-8", acquisition_firmware: "fw-3.2.0", decoder_model: "dm-1.4", exoskeleton_controller: "exo-ctl-2" },
    devices: [{ device_id: "dev-02", site_id: "site-a" }],
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
    site_id: "site-a",
    protocol_id: "proto-1",
    protocol_version: 1,
    population_id: "pop-1",
    evidence_ids: ["ev-1"],
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });

  backend.assembleConfiguration(admin, {
    configuration_id: "cfg-3",
    composition: { hardware_batch: "batch-7", acquisition_firmware: "fw-3.2.0", decoder_model: "dm-1.4", exoskeleton_controller: "exo-ctl-2" },
    devices: [{ device_id: "dev-03", site_id: "site-b" }],
  });
  backend.recordCalibration(admin, {
    calibration_id: "cal-3",
    device_id: "dev-03",
    configuration_id: "cfg-3",
    configuration_version: 1,
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });
  backend.grantRelease(admin, {
    grant_id: "grant-3",
    scope: "routine",
    configuration_id: "cfg-3",
    configuration_version: 1,
    site_id: "site-b",
    protocol_id: "proto-1",
    protocol_version: 1,
    population_id: "pop-1",
    evidence_ids: ["ev-1"],
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });
  return backend;
}

const lead = { id: "lead-a", role: "center_lead", site_id: "site-a" };

test("中心负责人隔离一个批次：本中心同批次停用，其余不受影响", () => {
  const backend = buildMultiSite();
  backend.quarantineBatch(lead, { quarantine_id: "q-1", hardware_batch: "batch-7", reason: "批次信号漂移待查" });

  // 本中心同批次：拒绝
  const local = backend.checkClearance({ ...routineSession, operator_id: therapist.id });
  assert.equal(local.decision, "denied");
  assert.ok(local.reasons.some((r) => r.includes("隔离")));

  // 本中心其他批次：不受影响
  const otherBatch = backend.checkClearance({ ...routineSession, device_id: "dev-02", operator_id: therapist.id });
  assert.equal(otherBatch.decision, "approved");

  // 其他中心同批次：不受影响
  const otherSite = backend.checkClearance({ ...routineSession, device_id: "dev-03", operator_id: therapist.id });
  assert.equal(otherSite.decision, "approved");
});

test("解除隔离后恢复放行", () => {
  const backend = buildMultiSite();
  backend.quarantineBatch(lead, { quarantine_id: "q-1", hardware_batch: "batch-7", reason: "待查" });
  backend.liftQuarantine(safetyOfficer, { quarantine_id: "q-1" });
  assert.equal(backend.checkClearance({ ...routineSession, operator_id: therapist.id }).decision, "approved");
});

test("中心负责人不能跨中心隔离，也不能无站点绑定", () => {
  const backend = buildMultiSite();
  const leadB = { id: "lead-b", role: "center_lead", site_id: "site-b" };
  backend.quarantineBatch(leadB, { quarantine_id: "q-2", hardware_batch: "batch-7", reason: "B 中心自查" });
  // q-2 只作用于 site-b，site-a 的 batch-7 不受影响
  assert.equal(backend.checkClearance({ ...routineSession, operator_id: therapist.id }).decision, "approved");
  assert.equal(backend.checkClearance({ ...routineSession, device_id: "dev-03", operator_id: therapist.id }).decision, "denied");

  assert.throws(() => backend.quarantineBatch({ id: "lead-x", role: "center_lead" }, { quarantine_id: "q-3", hardware_batch: "batch-7", reason: "x" }), /绑定站点/);
  assert.throws(() => backend.quarantineBatch(therapist, { quarantine_id: "q-4", hardware_batch: "batch-7", reason: "x" }), /未授权/);
});
