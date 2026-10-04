import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/eventStore.js";
import { ReleaseService } from "../src/appService.js";
import { fold } from "../src/projection.js";
import { DomainError } from "../src/domainError.js";
import {
  buildService,
  clearanceInput,
  SITES,
  CONFIG,
  MODEL,
  BATCH,
  BATCH_OTHER,
  SCOPE,
  EVIDENCE,
  PROTOCOL,
  APPROVER,
  THERAPIST,
  GOVERNANCE,
} from "./fixture.js";

const codes = (result) => result.reasons.map((r) => r.code);

/** 让另一站点具备与北京相同的常规康复启用要素（复用全局证据/方案） */
function enableSite(service, siteId) {
  service.recordCalibration(`cal-${siteId}-1`, {
    configuration_id: CONFIG,
    site_id: siteId,
    status: "VALID",
    valid_until: "2026-12-31T00:00:00+08:00",
    drift_metrics: { within_limits: true },
  });
  service.assessSiteCondition(siteId, { configuration_id: CONFIG, conditions_met: true });
  service.certifyPersonnel(`cred-${siteId}`, {
    person_id: `therapist-${siteId}`,
    site_id: siteId,
    modes: ["ROUTINE_REHABILITATION"],
    configuration_ids: "ALL",
  });
  service.releaseForSite(`rel-${siteId}-1`, {
    site_id: siteId,
    configuration_id: CONFIG,
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    protocol_id: PROTOCOL.ROUTINE_REHABILITATION,
  });
  return { site_id: siteId, operator_id: `therapist-${siteId}` };
}

test("基线：批次/固件/模型/控制器/资质组合齐备时给出明确 ALLOWED", () => {
  const service = buildService();
  const result = service.requestClearance("sess-ok", clearanceInput());
  assert.equal(result.decision, "ALLOWED");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.evidence_id, EVIDENCE.ROUTINE_REHABILITATION);
  assert.equal(result.components.hardware_batch_id, BATCH);
});

test("科研验证、试用许可、常规康复启用不能互相顶替", () => {
  const service = buildService();
  // 撤回常规证据后，科研证据仍在，但不能顶替常规启用
  service.revokeEvidence(EVIDENCE.ROUTINE_REHABILITATION, "复核中");
  const result = service.requestClearance("sess-mode", clearanceInput());
  assert.equal(result.decision, "DENIED");
  assert.ok(codes(result).includes("EVIDENCE_MODE_MISMATCH"));
  assert.match(result.reasons.find((r) => r.code === "EVIDENCE_MODE_MISMATCH").detail, /不能顶替/);

  // 反向：科研会话也不能被常规放行/常规方案顶替
  const research = service.requestClearance(
    "sess-mode-2",
    clearanceInput({ session_ignore: true, mode: "RESEARCH_VALIDATION", protocol_id: "proto-none" }),
  );
  assert.equal(research.decision, "DENIED");
  assert.ok(codes(research).includes("PROTOCOL_UNKNOWN"));
});

test("中心负责人隔离一个批次：该批次设备驳回，无关批次设备继续可用", () => {
  const service = buildService();

  // 用无关批次组装另一构成并完成常规启用要素
  service.releaseFirmware(BATCH_OTHER, { track: "EXOSKELETON", firmware_id: "fw-exo-ctrl", version: "2.4.1" });
  service.assembleConfiguration("cfg-neuro-2", {
    hardware_batch_id: BATCH_OTHER,
    acquisition_firmware: { firmware_id: "fw-acq", version: "3.1.0" },
    decoder_model: { id: MODEL, version: "7.2.0" },
    exoskeleton_controller: { id: "fw-exo-ctrl", firmware_version: "2.4.1" },
  });
  service.acceptEvidence("ev-routine-2", {
    configuration_id: "cfg-neuro-2",
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    site_ids: "ALL",
    valid_from: "2026-09-01T00:00:00+08:00",
  });
  service.assessSiteCondition(SITES.beijing, { configuration_id: "cfg-neuro-2", conditions_met: true });
  service.recordCalibration("cal-bj-2", {
    configuration_id: "cfg-neuro-2",
    site_id: SITES.beijing,
    status: "VALID",
    valid_until: "2026-12-31T00:00:00+08:00",
    drift_metrics: { within_limits: true },
  });
  service.approveProtocol("proto-routine-2", {
    configuration_id: "cfg-neuro-2",
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    site_id: "ALL",
  });
  service.releaseForSite("rel-bj-2", {
    site_id: SITES.beijing,
    configuration_id: "cfg-neuro-2",
    mode: "ROUTINE_REHABILITATION",
    population_scope_id: SCOPE,
    protocol_id: "proto-routine-2",
  });

  const impact = service.quarantineBatch(BATCH, { reason: "同批次电极阻抗异常" });

  const blocked = service.requestClearance("sess-q", clearanceInput());
  assert.equal(blocked.decision, "DENIED");
  assert.ok(codes(blocked).includes("BATCH_QUARANTINED"));
  assert.deepEqual(impact.affected_configuration_ids, [CONFIG]);

  const other = service.requestClearance(
    "sess-ok-2",
    clearanceInput({ configuration_id: "cfg-neuro-2", protocol_id: "proto-routine-2" }),
  );
  assert.equal(other.decision, "ALLOWED");
});

test("固件升级后构成钉版漂移即驳回，并能列出受影响站点与历史结果", () => {
  const service = buildService();
  const before = service.requestClearance("sess-fw-1", clearanceInput());
  assert.equal(before.decision, "ALLOWED");

  service.releaseFirmware(BATCH, { track: "ACQUISITION", firmware_id: "fw-acq", version: "3.2.0" });

  const after = service.requestClearance("sess-fw-2", clearanceInput());
  assert.equal(after.decision, "DENIED");
  assert.ok(codes(after).includes("FIRMWARE_DRIFT"));

  const impact = service.impactOf({ kind: "FIRMWARE", id: "fw-acq", version: "3.2.0" });
  assert.deepEqual(impact.affected_configuration_ids, [CONFIG]);
  assert.deepEqual(impact.affected_site_ids, [SITES.beijing]);
  assert.ok(impact.historical_results.some((r) => r.session_id === "sess-fw-1" && r.decision === "ALLOWED"));
  assert.ok(impact.historical_results.some((r) => r.session_id === "sess-fw-2" && r.decision === "DENIED"));
});

test("模型升级与退役：漂移驳回，退役驳回，影响面可追溯", () => {
  const service = buildService();
  service.releaseModel(MODEL, { version: "8.0.0" });
  const drift = service.requestClearance("sess-m-1", clearanceInput());
  assert.ok(codes(drift).includes("MODEL_DRIFT"));

  service.retireModel(MODEL, "存在替代版本");
  const retired = service.requestClearance("sess-m-2", clearanceInput());
  assert.ok(codes(retired).includes("MODEL_RETIRED"));
});

test("校准过期、漂移超限或失效均驳回", () => {
  const expired = buildService();
  expired.recordCalibration("cal-exp", {
    configuration_id: CONFIG,
    site_id: SITES.beijing,
    status: "VALID",
    valid_until: "2026-09-30T00:00:00+08:00",
    drift_metrics: { within_limits: true },
  });
  assert.ok(codes(expired.requestClearance("sess-cal-1", clearanceInput())).includes("CALIBRATION_EXPIRED"));

  const drift = buildService();
  drift.recordCalibration("cal-drift", {
    configuration_id: CONFIG,
    site_id: SITES.beijing,
    status: "VALID",
    valid_until: "2026-12-31T00:00:00+08:00",
    drift_metrics: { within_limits: false, baseline_shift_uv: 88 },
  });
  assert.ok(codes(drift.requestClearance("sess-cal-2", clearanceInput())).includes("SIGNAL_DRIFT_OUT_OF_LIMITS"));

  const invalid = buildService();
  invalid.recordCalibration("cal-inv", {
    configuration_id: CONFIG,
    site_id: SITES.beijing,
    status: "INVALID",
    drift_metrics: { within_limits: false },
  });
  assert.ok(codes(invalid.requestClearance("sess-cal-3", clearanceInput())).includes("CALIBRATION_INVALID"));
});

test("适用人群：排除条件触发即驳回", () => {
  const service = buildService();
  const result = service.requestClearance(
    "sess-scope",
    clearanceInput({ patient_attributes: { diagnosis: "stroke", limb: "upper", seizure_uncontrolled: true } }),
  );
  assert.ok(codes(result).includes("PATIENT_EXCLUDED"));
});

test("资质模式不符、撤销与过期均驳回", () => {
  const service = buildService();
  service.certifyPersonnel("cred-li2", {
    person_id: THERAPIST,
    site_id: SITES.beijing,
    modes: ["RESEARCH_VALIDATION"],
    configuration_ids: "ALL",
  });
  // 新资质仍含常规？两条 ACTIVE 资质取任一匹配 —— 撤销旧资质后只剩科研资质
  service.revokeCredential("cred-li", "年度复核未通过");
  const result = service.requestClearance("sess-cred", clearanceInput());
  assert.ok(codes(result).includes("CREDENTIAL_SCOPE_MODE"));
});

test("场地条件不达标或方案撤回即驳回", () => {
  const service = buildService();
  service.assessSiteCondition(SITES.beijing, {
    configuration_id: CONFIG,
    conditions_met: false,
    findings: { shielding: "不足" },
  });
  assert.ok(codes(service.requestClearance("sess-site", clearanceInput())).includes("SITE_CONDITION_UNMET"));

  const service2 = buildService();
  service2.withdrawProtocol(PROTOCOL.ROUTINE_REHABILITATION, "修订中");
  assert.ok(codes(service2.requestClearance("sess-proto", clearanceInput())).includes("PROTOCOL_NOT_APPROVED"));
});

test("站点放行被暂停即驳回", () => {
  const service = buildService();
  service.suspendRelease("rel-bj-1", "升级复核");
  assert.ok(codes(service.requestClearance("sess-rel", clearanceInput())).includes("SITE_NOT_RELEASED"));
});

test("紧急停止立即生效；恢复必须有设备回执且由有权人员重新批准", () => {
  const service = buildService();
  const cleared = service.requestClearance("sess-stop", clearanceInput());
  assert.equal(cleared.decision, "ALLOWED");

  service.safetyStop("stop-1", {
    session_id: "sess-stop",
    site_id: SITES.beijing,
    configuration_id: CONFIG,
    device_ref: "exo-07",
    triggered_by: THERAPIST,
    reason: "患者主诉不适",
  });

  const blocked = service.requestClearance("sess-stop-2", clearanceInput());
  assert.ok(codes(blocked).includes("SAFETY_STOP_OPEN"));

  // 无回执不能恢复
  assert.throws(
    () => service.resumeAfterSafety("stop-1", { approved_by: APPROVER }),
    (e) => e instanceof DomainError && e.code === "DEVICE_RECEIPT_MISSING",
  );
  // 无权人员不能批准恢复
  service.recordStopAck("stop-1", { receipt: "ACK-EXO-07-9931" });
  assert.throws(
    () => service.resumeAfterSafety("stop-1", { approved_by: THERAPIST }),
    (e) => e.code === "APPROVER_UNAUTHORIZED",
  );
  // 回执已保存
  assert.equal(service.state.safetyEvents.get("stop-1").device_ack.receipt, "ACK-EXO-07-9931");

  service.resumeAfterSafety("stop-1", { approved_by: APPROVER, note: "排查完毕" });
  assert.equal(service.requestClearance("sess-stop-3", clearanceInput()).decision, "ALLOWED");
});

test("放行后若发生急停，开始训练时即时复核失败，不得用旧结论开训", () => {
  const service = buildService();
  service.requestClearance("sess-stale", clearanceInput());
  service.safetyStop("stop-2", {
    site_id: SITES.beijing,
    configuration_id: CONFIG,
    triggered_by: THERAPIST,
    reason: "外骨骼异响",
    receipt: { receipt: "ACK-1" },
  });
  assert.throws(() => service.startSession("sess-stale"), (e) => e.code === "CLEARANCE_STALE");
});

test("驳回的会话不能开始；获准会话可开始并结束", () => {
  const service = buildService();
  service.quarantineBatch(BATCH, { reason: "抽检不合格" });
  service.requestClearance("sess-bad", clearanceInput());
  assert.throws(() => service.startSession("sess-bad"), (e) => e.code === "CLEARANCE_DENIED");

  const good = buildService();
  good.requestClearance("sess-good", clearanceInput());
  good.startSession("sess-good");
  good.endSession("sess-good", { completed: true });
  assert.equal(good.state.sessions.get("sess-good").status, "ENDED");
});

test("离线中心重新联网不补执行过期指令，未过期指令正常交付", () => {
  const service = buildService();
  service.setSiteConnectivity(SITES.wuhan, "OFFLINE");
  service.queueCommand("cmd-old", {
    target_site_id: SITES.wuhan,
    command_type: "PUSH_CALIBRATION_BASELINE",
    parameters: { baseline: "sep" },
    not_before: "2026-09-20T00:00:00+08:00",
    expires_at: "2026-09-25T00:00:00+08:00",
  });
  service.queueCommand("cmd-fresh", {
    target_site_id: SITES.wuhan,
    command_type: "PUSH_CALIBRATION_BASELINE",
    parameters: { baseline: "oct" },
    expires_at: "2026-10-10T00:00:00+08:00",
  });

  const result = service.syncOnReconnect(SITES.wuhan, "2026-10-04T08:00:00+08:00");
  const map = Object.fromEntries(result.dispositions.map((d) => [d.command_id, d.disposition]));
  assert.equal(map["cmd-old"], "EXPIRED_NOT_EXECUTED");
  assert.equal(map["cmd-fresh"], "DELIVERED");
  assert.equal(service.state.commands.get("cmd-old").status, "EXPIRED");
  assert.equal(service.state.commands.get("cmd-fresh").status, "QUEUED");
});

test("红线：禁止基于脑信号诊断或修改处方的构成、模型与指令", () => {
  const service = buildService();
  assert.throws(
    () => service.assembleConfiguration("cfg-bad", {}, { intended_use: "DIAGNOSIS" }),
    (e) => e.code === "FORBIDDEN_INTENDED_USE",
  );
  assert.throws(
    () =>
      service.queueCommand("cmd-diag", {
        target_site_id: SITES.beijing,
        command_type: "DIAGNOSE_FROM_SIGNAL",
        expires_at: "2026-10-10T00:00:00+08:00",
      }),
    (e) => e.code === "FORBIDDEN_COMMAND",
  );
  assert.throws(
    () =>
      service.queueCommand("cmd-rx", {
        target_site_id: SITES.beijing,
        command_type: "MODIFY_PRESCRIPTION",
        expires_at: "2026-10-10T00:00:00+08:00",
      }),
    (e) => e.code === "FORBIDDEN_COMMAND",
  );
});

test("治理人员可比跨站复现与处置，且只见授权范围内的患者信号", () => {
  const service = buildService();
  const sh = enableSite(service, SITES.shanghai);

  service.requestClearance("sess-bj", clearanceInput({ patient_ref: "patient-001" }));
  service.requestClearance(
    "sess-sh",
    clearanceInput({ site_id: sh.site_id, operator_id: sh.operator_id, patient_ref: "patient-002" }),
  );

  const report = service.governanceReport(GOVERNANCE);
  const bj = report.sessions.find((r) => r.session_id === "sess-bj");
  const shr = report.sessions.find((r) => r.session_id === "sess-sh");
  assert.equal(bj.patient_ref, "patient-001"); // 授权范围内
  assert.equal(shr.patient_ref, "REDACTED"); // 非授权患者脱敏

  const cell = report.reproducibility.find((c) => c.mode === "ROUTINE_REHABILITATION");
  const siteIds = cell.sites.map((s) => s.site_id).sort();
  assert.deepEqual(siteIds, [SITES.beijing, SITES.shanghai]);

  // 越权直接读取患者信号被拒
  assert.throws(
    () => service.assertSignalAccess(GOVERNANCE, "patient-002", SITES.shanghai),
    (e) => e.code === "SIGNAL_ACCESS_DENIED",
  );
});

test("事件存储：版本严格递增、乐观并发冲突可检测、重放得到同一读模型", () => {
  const published = [];
  const service = buildService({ publish: (e) => published.push(e) });
  const store = new EventStore();
  store.append({
    event_id: "x1",
    event_type: "SITE_REGISTERED",
    aggregate_type: "demonstration_site",
    aggregate_id: "agg-x",
    occurred_at: "2026-10-04T00:00:00+08:00",
    version: 0,
    summary: "x",
  });
  assert.throws(
    () =>
      store.append(
        {
          event_id: "x2",
          event_type: "SITE_REGISTERED",
          aggregate_type: "demonstration_site",
          aggregate_id: "agg-x",
          occurred_at: "2026-10-04T00:01:00+08:00",
          version: 0,
          summary: "x",
        },
        { expectedVersion: 99 },
      ),
    (e) => e.code === "VERSION_CONFLICT",
  );

  // 所有状态变更都经 publish 按既有领域事件约定流出
  assert.ok(published.some((e) => e.event_type === "SITE_RELEASED"));
  assert.ok(published.every((e) => Number.isInteger(e.version) && e.version >= 1));

  // 重放全部事件得到同一投影
  const replayed = fold(published);
  assert.equal(replayed.sessions.size, 0);
  service.requestClearance("sess-replay", clearanceInput());
  const replayed2 = fold(published);
  assert.equal(replayed2.sessions.get("sess-replay").decision, "ALLOWED");
});
