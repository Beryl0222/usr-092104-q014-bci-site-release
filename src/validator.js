import { readFile } from "node:fs/promises";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const EVENT_TYPES = new Set([
  "CONFIGURATION_ASSEMBLED",
  "CONFIGURATION_DISCONTINUED",
  "FIRMWARE_RELEASED",
  "CALIBRATION_RECORDED",
  "MODEL_RELEASED",
  "MODEL_RETIRED",
  "POPULATION_SCOPE_DEFINED",
  "EVIDENCE_ACCEPTED",
  "EVIDENCE_REVOKED",
  "SITE_REGISTERED",
  "SITE_CONDITION_ASSESSED",
  "PERSONNEL_CERTIFIED",
  "CREDENTIAL_REVOKED",
  "PROTOCOL_APPROVED",
  "PROTOCOL_WITHDRAWN",
  "SITE_RELEASED",
  "RELEASE_SUSPENDED",
  "BATCH_QUARANTINED",
  "BATCH_RELEASED_FROM_QUARANTINE",
  "SESSION_CLEARED",
  "SESSION_STARTED",
  "SESSION_ENDED",
  "SAFETY_STOPPED",
  "OPERATION_RESUMED",
  "DEVICE_ACK_RECORDED",
  "COMMAND_QUEUED",
  "COMMAND_EXPIRED",
  "PATIENT_SIGNAL_POLICY_GRANTED",
]);

const AGGREGATE_TYPES = new Set([
  "device_configuration",
  "hardware_batch",
  "calibration",
  "decoder_model",
  "population_scope",
  "release_evidence",
  "demonstration_site",
  "site_condition",
  "operator_credential",
  "therapy_protocol",
  "site_release",
  "therapy_session",
  "safety_event",
  "device_command",
  "signal_access_policy",
]);

export const ACTIVATION_MODES = ["RESEARCH_VALIDATION", "INVESTIGATIONAL_AUTHORIZATION", "ROUTINE_REHABILITATION"];

let schemaEnums;

async function loadSchemaEnums() {
  if (!schemaEnums) {
    const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
    schemaEnums = {
      events: new Set(schema.properties.event_type.enum),
      aggregates: new Set(schema.properties.aggregate_type.enum),
    };
  }
  return schemaEnums;
}

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !EVENT_TYPES.has(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.has(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法时间戳");
  }
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  return errors;
}

export async function validateEventAgainstSchema(record) {
  const enums = await loadSchemaEnums();
  const errors = validateEvent(record);
  if (record.event_type && !enums.events.has(record.event_type)) errors.push("schema 中未登记该 event_type");
  if (record.aggregate_type && !enums.aggregates.has(record.aggregate_type)) errors.push("schema 中未登记该 aggregate_type");
  return errors;
}
