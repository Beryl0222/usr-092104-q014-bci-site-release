import { createBackend } from "../src/backend.js";

export const NOW = "2026-10-04T09:00:00+08:00";
export const admin = { id: "hq-01", role: "registry_admin" };
export const safetyOfficer = { id: "so-01", role: "safety_officer" };
export const therapist = { id: "therapist-1", role: "therapist" };

// 一套完整可用的登记：站点、人群、方案、模型、构成、校准、资质、证据、常规放行。
// 返回 backend 与常用 id，各测试可在此基础上继续登记或变更。
export function buildScenario(now = NOW) {
  const backend = createBackend({ now: () => now });

  backend.verifySiteCondition(admin, { site_id: "site-a", checks: ["屏蔽室", "应急电源"], valid_until: "2027-01-01T00:00:00+08:00" });
  backend.releaseSite(admin, { site_id: "site-a" });

  backend.definePopulation(admin, { population_id: "pop-1", criteria: "卒中后上肢功能障碍成人" });
  backend.approveProtocol(admin, { protocol_id: "proto-1", population_id: "pop-1", population_version: 1, steps: ["校准", "运动想象", "外骨骼联动"] });

  backend.publishModel(admin, { model_id: "dm-1.4", algorithm_family: "CSP+LR", artifact_hash: "sha256:dm14" });

  backend.assembleConfiguration(admin, {
    configuration_id: "cfg-1",
    composition: { hardware_batch: "batch-7", acquisition_firmware: "fw-3.2.0", decoder_model: "dm-1.4", exoskeleton_controller: "exo-ctl-2" },
    devices: [{ device_id: "dev-01", site_id: "site-a" }],
  });

  backend.recordCalibration(admin, {
    calibration_id: "cal-1",
    device_id: "dev-01",
    configuration_id: "cfg-1",
    configuration_version: 1,
    method: "阻抗与漂移校准",
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });

  backend.issueCredential(admin, {
    credential_id: "cred-1",
    operator_id: "therapist-1",
    grants: [{ protocol_id: "proto-1", scope: "routine" }],
    valid_from: "2026-01-01T00:00:00+08:00",
    valid_until: "2027-01-01T00:00:00+08:00",
  });

  backend.acceptEvidence(admin, { evidence_id: "ev-1", scope: "routine", kind: "临床验证", configuration_id: "cfg-1", configuration_version: 1, result: "达到放行标准" });
  backend.grantRelease(admin, {
    grant_id: "grant-1",
    scope: "routine",
    configuration_id: "cfg-1",
    configuration_version: 1,
    site_id: "site-a",
    protocol_id: "proto-1",
    protocol_version: 1,
    population_id: "pop-1",
    evidence_ids: ["ev-1"],
    valid_from: "2026-10-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
  });

  return backend;
}

export const routineSession = {
  device_id: "dev-01",
  protocol_id: "proto-1",
  scope: "routine",
  prescription_ref: "rx-2026-1001",
};
