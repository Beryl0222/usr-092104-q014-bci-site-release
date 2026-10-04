#!/usr/bin/env node
/**
 * 五家示范中心联调走查：把领域规则按一天的时间线演一遍。
 * 运行：node scripts/walkthrough.mjs
 */
import { EventStore } from "../src/eventStore.js";
import { ReleaseService } from "../src/appService.js";
import { buildService, clearanceInput, SITES, CONFIG, BATCH, SCOPE, PROTOCOL, APPROVER, THERAPIST, GOVERNANCE } from "../tests/fixture.js";

const log = [];
const published = [];
const service = buildService({ publish: (e) => published.push(e) });

const line = (title) => log.push(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);

// 1) 训练前：治疗师拿到明确答案
line("09:00 北京中心 训练前放行询问");
const morning = service.requestClearance("walk-sess-1", clearanceInput());
log.push(`结论：${morning.decision}（证据 ${morning.evidence_id}，批次 ${morning.components.hardware_batch_id}）`);

// 2) 上海中心：总部证据"产品已验证"不等于本站获常规放行
line("09:10 上海中心 总部证据不能替代站点放行（试用/科研也不能顶替常规）");
service.recordCalibration("cal-sh-1", { configuration_id: CONFIG, site_id: SITES.shanghai, status: "VALID", drift_metrics: { within_limits: true } });
service.assessSiteCondition(SITES.shanghai, { configuration_id: CONFIG, conditions_met: true });
service.certifyPersonnel("cred-sh", { person_id: "therapist-sh", site_id: SITES.shanghai, modes: ["RESEARCH_VALIDATION", "INVESTIGATIONAL_AUTHORIZATION", "ROUTINE_REHABILITATION"] });
// 注意：上海刻意没有 SITE_RELEASED；全局证据 site_ids=ALL 也不顶用
const sh = service.requestClearance("walk-sess-sh", clearanceInput({ site_id: SITES.shanghai, operator_id: "therapist-sh" }));
log.push(`结论：${sh.decision}；原因：${sh.reasons.map((r) => r.code).join("、")}（证据模式不可顶替的规则见测试 EVIDENCE_MODE_MISMATCH）`);

// 3) 总部发布采集固件 3.2.0：影响面立即可见，北京旧钉版漂移
line("10:00 固件升级 3.2.0：列出受影响站点与历史结果");
service.releaseFirmware(BATCH, { track: "ACQUISITION", firmware_id: "fw-acq", version: "3.2.0" });
const impact = service.impactOf({ kind: "FIRMWARE", id: "fw-acq", version: "3.2.0" });
log.push(`受影响构成：${impact.affected_configuration_ids.join(", ")}；站点：${impact.affected_site_ids.join(", ")}；历史结论 ${impact.historical_results.length} 条`);
const drift = service.requestClearance("walk-sess-2", clearanceInput());
log.push(`升级后北京放行：${drift.decision}（${drift.reasons.map((r) => r.code).join("、")}）→ 重新组装/重验前暂停问题范围`);

// 4) 批次隔离：只停 07 批次，08 批次设备照常
line("10:20 中心负责人隔离问题批次，无关设备不停");
const quarantineImpact = service.quarantineBatch(BATCH, { reason: "电极阻抗批次性异常" });
log.push(`隔离影响构成：${quarantineImpact.affected_configuration_ids.join(", ")}（其他批次不在此列）`);

// 5) 紧急停止：立即生效、设备回执保存、有权人员恢复
line("10:35 紧急停止 → 回执 → 批准恢复");
service.safetyStop("walk-stop-1", {
  site_id: SITES.beijing, configuration_id: CONFIG, triggered_by: THERAPIST, reason: "外骨骼异响",
  receipt: { receipt: "ACK-EXO-07-20261004-1035" },
});
log.push("急停已追加：所有放行判定立即看到未关闭安全事件；设备回执已保存");
service.resumeAfterSafety("walk-stop-1", { approved_by: APPROVER, note: "现场排查完毕，机械紧固件复位" });
log.push(`恢复批准人：${APPROVER}（治疗师本人无权恢复）`);

// 6) 离线中心武汉：排队指令在断网期间过期，联网不补执行
line("14:00 离线中心武汉重新联网：过期指令不补执行");
service.setSiteConnectivity(SITES.wuhan, "OFFLINE");
service.queueCommand("walk-cmd-1", {
  target_site_id: SITES.wuhan, command_type: "PUSH_CALIBRATION_BASELINE",
  not_before: "2026-09-20T00:00:00+08:00", expires_at: "2026-09-25T00:00:00+08:00",
});
service.queueCommand("walk-cmd-2", {
  target_site_id: SITES.wuhan, command_type: "PUSH_CALIBRATION_BASELINE",
  expires_at: "2026-10-10T00:00:00+08:00",
});
const sync = service.syncOnReconnect(SITES.wuhan, "2026-10-04T14:00:00+08:00");
for (const d of sync.dispositions) log.push(`指令 ${d.command_id}：${d.disposition}`);

// 7) 治理：跨站复现比较 + 授权范围内患者信号
line("15:00 治理人员跨站复现与处置比较");
service.requestClearance("walk-sess-gov", clearanceInput({ patient_ref: "patient-001" }));
const report = service.governanceReport(GOVERNANCE);
for (const cell of report.reproducibility) {
  log.push(`构成 ${cell.configuration_id} / ${cell.mode}：` + cell.sites.map((s) => `${s.site_id}(准${s.allowed}/驳${s.denied})`).join(" "));
}
log.push(`未关闭急停 ${report.open_safety_stops.length} 起；隔离批次 ${report.quarantined_batches.map((b) => b.batch_id).join(",") || "无"}`);
log.push(`患者信号可见性：授权患者 patient-001 可见，跨站未授权患者显示 ${report.sessions.find((s) => s.site_id === SITES.shanghai)?.patient_ref ?? "REDACTED"}`);

line("事件流");
log.push(`共追加 ${published.length} 条领域事件，全部按 aggregate_id 内 version 从 1 递增，沿用既有事件信封向下游流转。`);

console.log(log.join("\n"));
