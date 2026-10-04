import assert from "node:assert/strict";
import test from "node:test";

import { admin, buildScenario, routineSession, safetyOfficer, therapist } from "./scenario.js";

const receipt = { device_id: "dev-01", acknowledged_at: "2026-10-04T09:00:01+08:00", reported_state: "exoskeleton_powered_off" };

// site-a 与 site-b 各有会话与安全处置；site-c 存在但不在治理授权范围内。
function buildGovernanceScene() {
  const backend = buildScenario();
  backend.startSession(therapist, { session_id: "s-1", ...routineSession, signal_archive_ref: "sig://archive/s-1" });
  backend.completeSession(therapist, { session_id: "s-1", result_summary: "正常" });
  backend.emergencyStop(therapist, { stop_id: "stop-1", target: { kind: "device", device_id: "dev-01" }, reason: "信号漂移", device_receipt: receipt });
  backend.approveRecovery(safetyOfficer, { stop_id: "stop-1" });
  backend.quarantineBatch({ id: "lead-a", role: "center_lead", site_id: "site-a" }, { quarantine_id: "q-1", hardware_batch: "batch-7", reason: "复现排查" });

  backend.verifySiteCondition(admin, { site_id: "site-b", checks: ["屏蔽室"], valid_until: "2027-01-01T00:00:00+08:00" });
  backend.releaseSite(admin, { site_id: "site-b" });
  backend.assembleConfiguration(admin, {
    configuration_id: "cfg-2",
    composition: { hardware_batch: "batch-8", acquisition_firmware: "fw-3.2.0", decoder_model: "dm-1.4", exoskeleton_controller: "exo-ctl-2" },
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
  backend.startSession(therapist, { session_id: "s-2", ...routineSession, device_id: "dev-02", signal_archive_ref: "sig://archive/s-2" });
  return backend;
}

test("治理人员按授权范围比较跨站复现与处置", () => {
  const backend = buildGovernanceScene();
  const governance = {
    id: "gov-01",
    role: "governance",
    grants: [
      { site_id: "site-a", signal_access: true },
      { site_id: "site-b", signal_access: false },
    ],
  };
  const overview = backend.crossSiteSafetyOverview(governance);

  // 两个授权站点都在视图中，可比较处置情况
  assert.deepEqual(Object.keys(overview.sites).sort(), ["site-a", "site-b"]);
  assert.equal(overview.sites["site-a"].stops[0].stop_id, "stop-1");
  assert.equal(overview.sites["site-a"].stops[0].active, false);
  assert.equal(overview.sites["site-a"].stops[0].recovered_by, "so-01");
  assert.equal(overview.sites["site-a"].quarantines[0].hardware_batch, "batch-7");

  // site-a 授权接触信号：可见存档引用
  assert.equal(overview.sites["site-a"].sessions[0].signal_archive_ref, "sig://archive/s-1");
  assert.equal(overview.sites["site-a"].sessions[0].signal_access, "authorized");

  // site-b 未授权接触信号：引用被屏蔽
  assert.equal(overview.sites["site-b"].sessions[0].signal_archive_ref, null);
  assert.equal(overview.sites["site-b"].sessions[0].signal_access, "redacted");
});

test("未授权站点不出现在治理视图中，非治理角色无权访问", () => {
  const backend = buildGovernanceScene();
  const overview = backend.crossSiteSafetyOverview({ id: "gov-02", role: "governance", grants: [{ site_id: "site-a", signal_access: true }] });
  assert.deepEqual(Object.keys(overview.sites), ["site-a"]);

  assert.throws(() => backend.crossSiteSafetyOverview(therapist), /未授权/);
});
