import { AGGREGATE_TYPES, EVENT_AGGREGATE, EVENT_TYPES } from "./events.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未登记的事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未登记的聚合类型：${record.aggregate_type}`);
  if (
    "event_type" in record &&
    "aggregate_type" in record &&
    EVENT_TYPES.includes(record.event_type) &&
    EVENT_AGGREGATE[record.event_type] !== record.aggregate_type
  ) {
    errors.push(`事件 ${record.event_type} 必须落在聚合 ${EVENT_AGGREGATE[record.event_type]} 上`);
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是合法时间");
  return errors;
}
