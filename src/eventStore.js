import { randomUUID } from "node:crypto";

import { validateEvent } from "./validator.js";
import { DomainError } from "./domainError.js";

/**
 * 构造一条领域事件。version 由 EventStore 在追加时按聚合分配。
 */
export function makeEvent({
  eventType,
  aggregateType,
  aggregateId,
  payload = {},
  summary,
  siteId,
  occurredAt = new Date().toISOString(),
  eventId = randomUUID(),
}) {
  return {
    event_id: eventId,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version: 0,
    summary,
    ...(siteId ? { site_id: siteId } : {}),
    payload,
  };
}

/**
 * 追加型事件存储：事件只增不改；同一 aggregate_id 的 version 从 1 起严格递增。
 * 可选 sink：每追加一条事件就同步落盘（如 JSONL 追加器）。
 */
export class EventStore {
  #events = [];
  #versions = new Map();
  #sink;

  constructor({ sink } = {}) {
    this.#sink = sink;
  }

  append(event, { expectedVersion } = {}) {
    const errors = validateEvent({ ...event, version: 1 });
    if (errors.length) throw new DomainError("INVALID_EVENT", errors.join("；"), { errors });

    const key = event.aggregate_id;
    const current = this.#versions.get(key) ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `聚合 ${key} 版本冲突：期望基于 ${expectedVersion}，当前为 ${current}`,
        { aggregate_id: key, expected_version: expectedVersion, current_version: current },
      );
    }
    const stored = { ...event, version: current + 1 };
    this.#events.push(stored);
    this.#versions.set(key, stored.version);
    if (this.#sink) this.#sink(stored);
    return stored;
  }

  eventsFor(aggregateId) {
    return this.#events.filter((e) => e.aggregate_id === aggregateId);
  }

  allEvents() {
    return [...this.#events];
  }
}

/** JSONL 持久化 sink 工厂 */
export function jsonlSink(writer) {
  return (event) => writer.write(JSON.stringify(event) + "\n");
}
