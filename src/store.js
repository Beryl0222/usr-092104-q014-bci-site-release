import { validateEvent } from "./validator.js";

// 追加式事件存储：所有领域事实只能追加，按聚合严格递增 version。
export class EventStore {
  #events = [];
  #versions = new Map();

  #key(type, id) {
    return `${type}/${id}`;
  }

  nextVersion(aggregate_type, aggregate_id) {
    return (this.#versions.get(this.#key(aggregate_type, aggregate_id)) ?? 0) + 1;
  }

  get size() {
    return this.#events.length;
  }

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件不符合领域约定：${errors.join("；")}`);
    const key = this.#key(event.aggregate_type, event.aggregate_id);
    const expected = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new Error(`聚合 ${key} 的下一版本应为 ${expected}，收到 ${event.version}`);
    }
    this.#events.push(Object.freeze({ ...event }));
    this.#versions.set(key, expected);
    return event;
  }

  all() {
    return [...this.#events];
  }

  ofAggregate(aggregate_type, aggregate_id) {
    return this.#events.filter((e) => e.aggregate_type === aggregate_type && e.aggregate_id === aggregate_id);
  }

  ofType(event_type) {
    return this.#events.filter((e) => e.event_type === event_type);
  }
}
