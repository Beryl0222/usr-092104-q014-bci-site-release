import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { validateEvent, validateEventAgainstSchema } from "../src/validator.js";

test("校验器枚举与 schema 登记保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const sample = {
    event_id: "enum-check",
    event_type: schema.properties.event_type.enum[0],
    aggregate_type: schema.properties.aggregate_type.enum[0],
    aggregate_id: "x",
    occurred_at: "2026-10-04T00:00:00+08:00",
    version: 1,
    summary: "x",
  };
  assert.deepEqual(await validateEventAgainstSchema(sample), []);

  const bad = { ...sample, event_type: "NOT_A_REAL_EVENT" };
  assert.ok((await validateEventAgainstSchema(bad)).some((m) => m.includes("event_type")));
});

test("非法信封字段被拒收", () => {
  assert.deepEqual(validateEvent({ event_id: "x" }), [
    "缺少字段：event_type",
    "缺少字段：aggregate_type",
    "缺少字段：aggregate_id",
    "缺少字段：occurred_at",
    "缺少字段：version",
    "缺少字段：summary",
  ]);
  assert.ok(validateEvent({
    event_id: "x",
    event_type: "SAFETY_STOPPED",
    aggregate_type: "safety_event",
    aggregate_id: "x",
    occurred_at: "not-a-date",
    version: 0,
    summary: "x",
  }).includes("version 必须是正整数"));
});
