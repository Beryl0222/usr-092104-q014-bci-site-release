import { EventStore } from "../src/eventStore.js";
import { ReleaseService } from "../src/appService.js";

export const SITES = {
  beijing: "site-bj",
  shanghai: "site-sh",
  guangzhou: "site-gz",
  chengdu: "site-cd",
  wuhan: "site-wh",
};

export const CONFIG = "cfg-neuro-1";
export const MODEL = "decoder-m1";
export const BATCH = "hw-batch-2026-07";
export const BATCH_OTHER = "hw-batch-2026-08";
export const SCOPE = "scope-stroke-upper-limb";
export const EVIDENCE = {
  RESEARCH_VALIDATION: "ev-research-1",
  INVESTIGATIONAL_AUTHORIZATION: "ev-trial-1",
  ROUTINE_REHABILITATION: "ev-routine-1",
};
export const PROTOCOL = {
  RESEARCH_VALIDATION: "proto-research-1",
  ROUTINE_REHABILITATION: "proto-routine-1",
};

export const APPROVER = "lead-chen";
export const THERAPIST = "therapist-li";
export const GOVERNANCE = "governance-zhao";

/**
 * 搭出五中心联调基线：北京中心常规康复启用全要素齐备，
 * 其余四站已登记、可按需补证据/条件/资质/放行。返回 service。
 */
export function buildService({ publish = () => {}, approvers = [APPROVER] } = {}) {
  const service = new ReleaseService({ store: new EventStore(), publish, safetyApprovers: new Set(approvers) });

  for (const [, id] of Object.entries(SITES)) service.registerSite(id, { name: id });

  service.definePopulationScope(SCOPE, {
    indication: "卒中后上肢运动障碍",
    inclusion_attributes: { diagnosis: "stroke", limb: "upper" },
    exclusion_attributes: { seizure_uncontrolled: true },
  });

  service.releaseFirmware(BATCH, { track: "ACQUISITION", firmware_id: "fw-acq", version: "3.1.0" });
  service.releaseFirmware(BATCH, { track: "EXOSKELETON", firmware_id: "fw-exo-ctrl", version: "2.4.1" });
  service.releaseFirmware(BATCH_OTHER, { track: "ACQUISITION", firmware_id: "fw-acq", version: "3.1.0" });
  service.releaseModel(MODEL, { version: "7.2.0" });

  service.assembleConfiguration(CONFIG, {
    hardware_batch_id: BATCH,
    acquisition_firmware: { firmware_id: "fw-acq", version: "3.1.0" },
    decoder_model: { id: MODEL, version: "7.2.0" },
    exoskeleton_controller: { id: "fw-exo-ctrl", firmware_version: "2.4.1" },
  });

  service.recordCalibration("cal-bj-1", {
    configuration_id: CONFIG,
    site_id: SITES.beijing,
    status: "VALID",
    valid_until: "2026-12-31T00:00:00+08:00",
    drift_metrics: { within_limits: true, max_uv: 12 },
  });

  service.acceptEvidence(EVIDENCE.ROUTINE_REHABILITATION, {
    configuration_id: CONFIG,
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    site_ids: "ALL",
    valid_from: "2026-09-01T00:00:00+08:00",
    claims: ["运动意图解码控制外骨骼"],
  });
  service.acceptEvidence(EVIDENCE.RESEARCH_VALIDATION, {
    configuration_id: CONFIG,
    mode: "RESEARCH_VALIDATION",
    population_scope_id: SCOPE,
    site_ids: "ALL",
    valid_from: "2026-08-01T00:00:00+08:00",
  });

  service.assessSiteCondition(SITES.beijing, {
    configuration_id: CONFIG,
    conditions_met: true,
    findings: { shielding: "ok", emergency_power: true },
  });

  service.certifyPersonnel("cred-li", {
    person_id: THERAPIST,
    site_id: SITES.beijing,
    modes: ["RESEARCH_VALIDATION", "INVESTIGATIONAL_AUTHORIZATION", "ROUTINE_REHABILITATION"],
    configuration_ids: "ALL",
    valid_until: "2027-01-01T00:00:00+08:00",
  });

  service.approveProtocol(PROTOCOL.ROUTINE_REHABILITATION, {
    configuration_id: CONFIG,
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    site_id: "ALL",
  });

  service.releaseForSite("rel-bj-1", {
    site_id: SITES.beijing,
    configuration_id: CONFIG,
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    protocol_id: PROTOCOL.ROUTINE_REHABILITATION,
  });

  service.grantSignalAccess("pol-gov", {
    person_id: GOVERNANCE,
    site_id: SITES.beijing,
    patient_refs: ["patient-001"],
    scopes: ["GOVERNANCE_READ"],
  });

  return service;
}

export function clearanceInput(overrides = {}) {
  return {
    configuration_id: CONFIG,
    site_id: SITES.beijing,
    mode: "ROUTINE_REHABILITATION",
    operator_id: THERAPIST,
    patient_ref: "patient-001",
    population_scope_id: SCOPE,
    protocol_id: PROTOCOL.ROUTINE_REHABILITATION,
    patient_attributes: { diagnosis: "stroke", limb: "upper" },
    now: "2026-10-04T09:00:00+08:00",
    ...overrides,
  };
}
