// 领域对象身份与事件登记处。
// 本文件与 contracts/domain.schema.json 保持一致：新增对象或事件时两边同步登记，只做增量扩展。

export const EVENT_TYPES = [
  "CONFIGURATION_ASSEMBLED",
  "CONFIGURATION_WITHDRAWN",
  "CALIBRATION_RECORDED",
  "MODEL_PUBLISHED",
  "POPULATION_DEFINED",
  "SITE_CONDITION_VERIFIED",
  "SITE_RELEASED",
  "CREDENTIAL_ISSUED",
  "CREDENTIAL_SUSPENDED",
  "PROTOCOL_APPROVED",
  "EVIDENCE_ACCEPTED",
  "RELEASE_GRANTED",
  "RELEASE_WITHDRAWN",
  "SESSION_STARTED",
  "SESSION_DENIED",
  "SESSION_COMPLETED",
  "SAFETY_STOPPED",
  "STOP_RECOVERY_APPROVED",
  "BATCH_QUARANTINED",
  "QUARANTINE_LIFTED",
  "INSTRUCTION_ISSUED",
  "INSTRUCTION_APPLIED",
  "INSTRUCTION_REJECTED_EXPIRED",
];

export const AGGREGATE_TYPES = [
  "device_configuration",
  "calibration_record",
  "decoder_model",
  "population_criteria",
  "site_condition",
  "operator_credential",
  "therapy_protocol",
  "release_evidence",
  "release_grant",
  "therapy_session",
  "safety_event",
  "quarantine",
  "instruction",
];

// 事件类型与聚合类型的固定配对，用于统一对象身份。
export const EVENT_AGGREGATE = {
  CONFIGURATION_ASSEMBLED: "device_configuration",
  CONFIGURATION_WITHDRAWN: "device_configuration",
  CALIBRATION_RECORDED: "calibration_record",
  MODEL_PUBLISHED: "decoder_model",
  POPULATION_DEFINED: "population_criteria",
  SITE_CONDITION_VERIFIED: "site_condition",
  SITE_RELEASED: "site_condition",
  CREDENTIAL_ISSUED: "operator_credential",
  CREDENTIAL_SUSPENDED: "operator_credential",
  PROTOCOL_APPROVED: "therapy_protocol",
  EVIDENCE_ACCEPTED: "release_evidence",
  RELEASE_GRANTED: "release_grant",
  RELEASE_WITHDRAWN: "release_grant",
  SESSION_STARTED: "therapy_session",
  SESSION_DENIED: "therapy_session",
  SESSION_COMPLETED: "therapy_session",
  SAFETY_STOPPED: "safety_event",
  STOP_RECOVERY_APPROVED: "safety_event",
  BATCH_QUARANTINED: "quarantine",
  QUARANTINE_LIFTED: "quarantine",
  INSTRUCTION_ISSUED: "instruction",
  INSTRUCTION_APPLIED: "instruction",
  INSTRUCTION_REJECTED_EXPIRED: "instruction",
};

// 三种用途各自独立放行，互相不能顶替。
export const RELEASE_SCOPES = ["research", "trial", "routine"];

export const SCOPE_LABELS = {
  research: "科研验证",
  trial: "试用许可",
  routine: "常规康复启用",
};

export const ROLES = ["registry_admin", "safety_officer", "center_lead", "therapist", "governance"];
