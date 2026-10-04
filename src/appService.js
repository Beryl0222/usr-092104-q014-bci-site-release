import { EventStore, makeEvent } from "./eventStore.js";
import { fold, configurationsUsing, signalAccessAt } from "./projection.js";
import { evaluateClearance } from "./clearance.js";
import { DomainError } from "./domainError.js";

/**
 * 设备放行应用服务。所有状态变更都以追加事件完成；
 * 事件经构造时传入的 publish 回调沿用现有领域事件约定向下游流转。
 */
export class ReleaseService {
  #store;
  #publish;
  #safetyApprovers;

  constructor({ store = new EventStore(), publish = () => {}, safetyApprovers = new Set() } = {}) {
    this.#store = store;
    this.#publish = publish;
    this.#safetyApprovers = safetyApprovers instanceof Set ? safetyApprovers : new Set(safetyApprovers);
  }

  get state() {
    return fold(this.#store.allEvents());
  }

  #append(event, opts) {
    const stored = this.#store.append(event, opts);
    this.#publish(stored);
    return stored;
  }

  // ---------- 注册类命令（总部/办公室维护主数据） ----------

  registerSite(siteId, { name, connectivity = "ONLINE" } = {}) {
    return this.#append(
      makeEvent({
        eventType: "SITE_REGISTERED",
        aggregateType: "demonstration_site",
        aggregateId: siteId,
        payload: { name, connectivity },
        summary: `登记示范中心 ${name ?? siteId}（${connectivity === "OFFLINE" ? "离线" : "在线"}）`,
      }),
    );
  }

  definePopulationScope(scopeId, payload) {
    return this.#append(
      makeEvent({
        eventType: "POPULATION_SCOPE_DEFINED",
        aggregateType: "population_scope",
        aggregateId: scopeId,
        payload,
        summary: `定义适用人群 ${scopeId}：${payload.indication ?? ""}`,
      }),
    );
  }

  assembleConfiguration(configurationId, components, { supersedes = [], intended_use = "CONTROL_ONLY" } = {}) {
    // 红线：产品构成不得声明诊断或处方用途
    if (intended_use !== "CONTROL_ONLY") {
      throw new DomainError("FORBIDDEN_INTENDED_USE", "产品构成仅允许 CONTROL_ONLY：不得诊断患者或修改医生处方");
    }
    return this.#append(
      makeEvent({
        eventType: "CONFIGURATION_ASSEMBLED",
        aggregateType: "device_configuration",
        aggregateId: configurationId,
        payload: { components, supersedes, intended_use },
        summary: `组装产品构成 ${configurationId}（批次/采集固件/解码模型/外骨骼控制器钉版）`,
      }),
    );
  }

  releaseFirmware(batchId, { track, firmware_id, version }, occurredAt) {
    return this.#append(
      makeEvent({
        eventType: "FIRMWARE_RELEASED",
        aggregateType: "hardware_batch",
        aggregateId: batchId,
        payload: { track, firmware_id, version },
        summary: `批次 ${batchId} 发布固件 ${firmware_id}@${version}（${track}）`,
        occurredAt,
      }),
    );
  }

  releaseModel(modelId, { version, intended_use = "CONTROL_ONLY" } = {}) {
    if (intended_use !== "CONTROL_ONLY") {
      throw new DomainError("FORBIDDEN_INTENDED_USE", "解码模型仅允许 CONTROL_ONLY：输出不得用于诊断或处方修改");
    }
    return this.#append(
      makeEvent({
        eventType: "MODEL_RELEASED",
        aggregateType: "decoder_model",
        aggregateId: modelId,
        payload: { model_id: modelId, version, intended_use },
        summary: `发布解码模型 ${modelId}@${version}`,
      }),
    );
  }

  recordCalibration(calibrationId, payload, siteId) {
    return this.#append(
      makeEvent({
        eventType: "CALIBRATION_RECORDED",
        aggregateType: "calibration",
        aggregateId: calibrationId,
        siteId,
        payload,
        summary: `站点 ${siteId} 记录构成 ${payload.configuration_id} 校准（漂移指标：${JSON.stringify(payload.drift_metrics ?? {})}）`,
      }),
    );
  }

  acceptEvidence(evidenceId, payload) {
    return this.#append(
      makeEvent({
        eventType: "EVIDENCE_ACCEPTED",
        aggregateType: "release_evidence",
        aggregateId: evidenceId,
        payload,
        summary: `按 ${payload.mode} 模式接受构成 ${payload.configuration_id} 的验证证据`,
      }),
    );
  }

  revokeEvidence(evidenceId, reason) {
    return this.#append(
      makeEvent({
        eventType: "EVIDENCE_REVOKED",
        aggregateType: "release_evidence",
        aggregateId: evidenceId,
        payload: { reason },
        summary: `撤回证据 ${evidenceId}：${reason}`,
      }),
    );
  }

  setSiteConnectivity(siteId, connectivity) {
    return this.registerSite(siteId, { name: this.state.sites.get(siteId)?.name, connectivity });
  }

  assessSiteCondition(siteId, payload) {
    return this.#append(
      makeEvent({
        eventType: "SITE_CONDITION_ASSESSED",
        aggregateType: "site_condition",
        aggregateId: `cond:${siteId}:${payload.configuration_id}`,
        siteId,
        payload: { site_id: siteId, ...payload },
        summary: `站点 ${siteId} 评估构成 ${payload.configuration_id} 场地条件：${payload.conditions_met ? "达标" : "不达标"}`,
      }),
    );
  }

  certifyPersonnel(credentialId, payload) {
    return this.#append(
      makeEvent({
        eventType: "PERSONNEL_CERTIFIED",
        aggregateType: "operator_credential",
        aggregateId: credentialId,
        payload,
        summary: `认证 ${payload.person_id} 于 ${payload.site_id} 的 ${payload.modes.join("/")} 资质`,
      }),
    );
  }

  revokeCredential(credentialId, reason) {
    return this.#append(
      makeEvent({
        eventType: "CREDENTIAL_REVOKED",
        aggregateType: "operator_credential",
        aggregateId: credentialId,
        payload: { reason },
        summary: `撤销资质 ${credentialId}：${reason}`,
      }),
    );
  }

  approveProtocol(protocolId, payload) {
    return this.#append(
      makeEvent({
        eventType: "PROTOCOL_APPROVED",
        aggregateType: "therapy_protocol",
        aggregateId: protocolId,
        payload,
        summary: `批准训练方案 ${protocolId}（${payload.mode}）`,
      }),
    );
  }

  withdrawProtocol(protocolId, reason) {
    return this.#append(
      makeEvent({
        eventType: "PROTOCOL_WITHDRAWN",
        aggregateType: "therapy_protocol",
        aggregateId: protocolId,
        payload: { reason },
        summary: `撤回训练方案 ${protocolId}：${reason}`,
      }),
    );
  }

  retireModel(modelId, reason) {
    return this.#append(
      makeEvent({
        eventType: "MODEL_RETIRED",
        aggregateType: "decoder_model",
        aggregateId: modelId,
        payload: { model_id: modelId, reason },
        summary: `退役解码模型 ${modelId}：${reason}`,
      }),
    );
  }

  suspendRelease(releaseId, reason) {
    return this.#append(
      makeEvent({
        eventType: "RELEASE_SUSPENDED",
        aggregateType: "site_release",
        aggregateId: releaseId,
        payload: { reason },
        summary: `暂停站点放行 ${releaseId}：${reason}`,
      }),
    );
  }

  releaseForSite(releaseId, payload) {
    return this.#append(
      makeEvent({
        eventType: "SITE_RELEASED",
        aggregateType: "site_release",
        aggregateId: releaseId,
        siteId: payload.site_id,
        payload,
        summary: `站点 ${payload.site_id} 就构成 ${payload.configuration_id} 获 ${payload.mode} 放行`,
      }),
    );
  }

  grantSignalAccess(policyId, payload) {
    return this.#append(
      makeEvent({
        eventType: "PATIENT_SIGNAL_POLICY_GRANTED",
        aggregateType: "signal_access_policy",
        aggregateId: policyId,
        siteId: payload.site_id,
        payload,
        summary: `授予 ${payload.person_id} 在 ${payload.site_id} 的患者信号访问范围`,
      }),
    );
  }

  // ---------- 会话放行（治疗师每天训练前的明确答案） ----------

  requestClearance(sessionId, input) {
    const result = evaluateClearance(this.state, input);
    this.#append(
      makeEvent({
        eventType: "SESSION_CLEARED",
        aggregateType: "therapy_session",
        aggregateId: sessionId,
        siteId: input.site_id,
        payload: {
          ...input,
          decision: result.decision,
          reasons: result.reasons,
          evidence_id: result.evidence_id,
          evaluated_at: result.evaluated_at,
          components: result.components,
        },
        summary:
          result.decision === "ALLOWED"
            ? `会话 ${sessionId} 获准：${input.mode} 训练可以开始`
            : `会话 ${sessionId} 驳回：${result.reasons.map((r) => r.code).join("、")}`,
      }),
    );
    return result;
  }

  startSession(sessionId) {
    const session = this.state.sessions.get(sessionId);
    if (!session) throw new DomainError("SESSION_NOT_CLEARED", `会话 ${sessionId} 尚未申请放行`);
    if (session.decision !== "ALLOWED") {
      throw new DomainError("CLEARANCE_DENIED", `会话 ${sessionId} 放行结论为驳回，不得开始训练`, { reasons: session.reasons });
    }
    if (session.status !== "CLEARED") throw new DomainError("SESSION_STATE", `会话状态为 ${session.status}，不能开始`);
    // 开始前即时复核：放行之后若发生急停/隔离，结论立即失效
    const recheck = evaluateClearance(this.state, {
      configuration_id: session.configuration_id,
      site_id: session.site_id,
      mode: session.mode,
      operator_id: session.operator_id,
      patient_ref: session.patient_ref,
      population_scope_id: session.population_scope_id,
      protocol_id: session.protocol_id,
      patient_attributes: session.patient_attributes,
      now: session.evaluated_at,
    });
    if (recheck.decision === "DENIED") {
      throw new DomainError("CLEARANCE_STALE", "放行后条件已变化，禁止开始", { reasons: recheck.reasons });
    }
    return this.#append(
      makeEvent({
        eventType: "SESSION_STARTED",
        aggregateType: "therapy_session",
        aggregateId: sessionId,
        siteId: session.site_id,
        summary: `会话 ${sessionId} 训练开始`,
      }),
    );
  }

  endSession(sessionId, outcome) {
    return this.#append(
      makeEvent({
        eventType: "SESSION_ENDED",
        aggregateType: "therapy_session",
        aggregateId: sessionId,
        payload: { outcome },
        summary: `会话 ${sessionId} 训练结束`,
      }),
    );
  }

  // ---------- 紧急停止：立即生效，设备回执必须保存 ----------

  safetyStop(safetyEventId, { session_id, site_id, configuration_id, device_ref, triggered_by, reason, receipt }) {
    // 第一条事件即生效：投影后所有放行判定立刻看到未关闭急停
    this.#append(
      makeEvent({
        eventType: "SAFETY_STOPPED",
        aggregateType: "safety_event",
        aggregateId: safetyEventId,
        siteId: site_id,
        payload: { session_id, site_id, configuration_id, device_ref, triggered_by, reason },
        summary: `紧急停止立即生效：${reason}`,
      }),
    );
    if (receipt) this.recordStopAck(safetyEventId, receipt);
  }

  recordStopAck(safetyEventId, { receipt, ack_at } = {}) {
    if (!receipt) throw new DomainError("DEVICE_RECEIPT_REQUIRED", "必须保存设备回执");
    const sev = this.state.safetyEvents.get(safetyEventId);
    if (!sev) throw new DomainError("SAFETY_EVENT_UNKNOWN", `安全事件 ${safetyEventId} 不存在`);
    return this.#append(
      makeEvent({
        eventType: "DEVICE_ACK_RECORDED",
        aggregateType: "safety_event",
        aggregateId: safetyEventId,
        siteId: sev.site_id,
        payload: { safety_event_id: safetyEventId, receipt, ack_at },
        summary: `保存设备急停回执 ${receipt}`,
      }),
    );
  }

  /** 恢复训练只能由有权人员重新批准；患者信号输出在恢复前一律阻断 */
  resumeAfterSafety(safetyEventId, { approved_by, note }) {
    const sev = this.state.safetyEvents.get(safetyEventId);
    if (!sev) throw new DomainError("SAFETY_EVENT_UNKNOWN", `安全事件 ${safetyEventId} 不存在`);
    if (!sev.open) throw new DomainError("SAFETY_EVENT_CLOSED", `安全事件 ${safetyEventId} 已关闭`);
    if (!sev.device_ack) throw new DomainError("DEVICE_RECEIPT_MISSING", "设备回执缺失，不能批准恢复");
    if (!this.#safetyApprovers.has(approved_by)) {
      throw new DomainError("APPROVER_UNAUTHORIZED", `${approved_by} 无权批准恢复`);
    }
    return this.#append(
      makeEvent({
        eventType: "OPERATION_RESUMED",
        aggregateType: "safety_event",
        aggregateId: safetyEventId,
        siteId: sev.site_id,
        payload: { safety_event_id: safetyEventId, approved_by, note },
        summary: `有权人员 ${approved_by} 批准恢复`,
      }),
    );
  }

  // ---------- 批次隔离：只停问题批次，不波及无关设备 ----------

  quarantineBatch(batchId, { reason, reason_ref }) {
    this.#append(
      makeEvent({
        eventType: "BATCH_QUARANTINED",
        aggregateType: "hardware_batch",
        aggregateId: batchId,
        payload: { batch_id: batchId, reason, reason_ref },
        summary: `隔离批次 ${batchId}：${reason}（其他批次不受影响）`,
      }),
    );
    return this.impactOf({ kind: "BATCH", id: batchId });
  }

  releaseBatchFromQuarantine(batchId, { approved_by }) {
    if (!this.#safetyApprovers.has(approved_by)) {
      throw new DomainError("APPROVER_UNAUTHORIZED", `${approved_by} 无权解除批次隔离`);
    }
    return this.#append(
      makeEvent({
        eventType: "BATCH_RELEASED_FROM_QUARANTINE",
        aggregateType: "hardware_batch",
        aggregateId: batchId,
        payload: { batch_id: batchId, approved_by },
        summary: `解除批次 ${batchId} 隔离`,
      }),
    );
  }

  // ---------- 固件/模型变更影响面 ----------

  /**
   * 固件或模型改变后，列出受影响的产品构成、站点和历史结果。
   * target: { kind: "FIRMWARE"|"MODEL", id, version? }
   */
  impactOf(target) {
    const s = this.state;
    const configs = configurationsUsing(s, target);
    const siteSet = new Set();
    const historicalResults = [];
    for (const e of this.#store.allEvents()) {
      if (!configs.some((c) => c.id === e.payload?.configuration_id)) continue;
      if (e.site_id) siteSet.add(e.site_id);
      if (e.event_type === "SESSION_CLEARED") {
        historicalResults.push({
          session_id: e.aggregate_id,
          site_id: e.site_id,
          configuration_id: e.payload.configuration_id,
          mode: e.payload.mode,
          decision: e.payload.decision,
          reason_codes: (e.payload.reasons ?? []).map((r) => r.code),
          evaluated_at: e.payload.evaluated_at,
        });
      }
    }
    for (const r of s.releases.values()) if (configs.some((c) => c.id === r.configuration_id)) siteSet.add(r.site_id);
    return {
      target,
      affected_configuration_ids: configs.map((c) => c.id),
      affected_site_ids: [...siteSet],
      historical_results: historicalResults.sort((a, b) => Date.parse(a.evaluated_at) - Date.parse(b.evaluated_at)),
    };
  }

  // ---------- 离线指令：过期不补执行 ----------

  queueCommand(commandId, { target_site_id, command_type, parameters, not_before, expires_at }) {
    if (["DIAGNOSE_FROM_SIGNAL", "MODIFY_PRESCRIPTION"].includes(command_type)) {
      throw new DomainError("FORBIDDEN_COMMAND", "禁止下发基于脑信号诊断或修改处方的指令");
    }
    const site = this.state.sites.get(target_site_id);
    const offline = site?.connectivity === "OFFLINE";
    return this.#append(
      makeEvent({
        eventType: "COMMAND_QUEUED",
        aggregateType: "device_command",
        aggregateId: commandId,
        siteId: target_site_id,
        payload: {
          target_site_id,
          command_type,
          parameters,
          not_before,
          expires_at,
          queued_while_offline: offline,
        },
        summary: offline
          ? `离线站点 ${target_site_id} 排队指令 ${command_type}，联网时按效期决定执行或作废`
          : `向站点 ${target_site_id} 下发指令 ${command_type}`,
      }),
    );
  }

  /**
   * 离线中心重新联网时同步：过期指令一律作废，绝不补执行；
   * 未过期且到达生效时间的才交付。返回处置清单。
   */
  syncOnReconnect(siteId, now = new Date().toISOString()) {
    const s = this.state;
    const dispositions = [];
    for (const cmd of s.commands.values()) {
      if (cmd.target_site_id !== siteId || cmd.status !== "QUEUED") continue;
      if (cmd.expires_at && Date.parse(now) > Date.parse(cmd.expires_at)) {
        this.#append(
          makeEvent({
            eventType: "COMMAND_EXPIRED",
            aggregateType: "device_command",
            aggregateId: cmd.id,
            siteId,
            payload: { reason: "RECONNECT_AFTER_EXPIRY" },
            summary: `站点 ${siteId} 重新联网时指令 ${cmd.id} 已过期，作废且不补执行`,
            occurredAt: now,
          }),
        );
        dispositions.push({ command_id: cmd.id, disposition: "EXPIRED_NOT_EXECUTED" });
      } else if (cmd.not_before && Date.parse(now) < Date.parse(cmd.not_before)) {
        dispositions.push({ command_id: cmd.id, disposition: "WAITING_NOT_BEFORE" });
      } else {
        dispositions.push({ command_id: cmd.id, disposition: "DELIVERED" });
      }
    }
    return { site_id: siteId, synced_at: now, dispositions };
  }

  // ---------- 治理：跨站复现与处置比较 ----------

  /**
   * 治理人员视角：按 构成×模式 比较各站放行结论、驳回原因、急停与隔离处置。
   * viewer 只能看到其信号授权范围内的患者明细，其余患者引用脱敏。
   */
  governanceReport(viewerId) {
    const s = this.state;
    const rows = [];
    for (const session of s.sessions.values()) {
      const visible = signalAccessAt(s, viewerId, session.patient_ref, session.site_id);
      rows.push({
        site_id: session.site_id,
        configuration_id: session.configuration_id,
        mode: session.mode,
        session_id: session.id,
        decision: session.decision,
        reason_codes: session.reasons.map((r) => r.code),
        status: session.status,
        patient_ref: visible ? session.patient_ref : "REDACTED",
      });
    }
    const matrix = new Map();
    for (const r of rows) {
      const key = `${r.configuration_id}|${r.mode}`;
      const cell = matrix.get(key) ?? { configuration_id: r.configuration_id, mode: r.mode, sites: new Map() };
      const perSite = cell.sites.get(r.site_id) ?? { site_id: r.site_id, allowed: 0, denied: 0, reason_codes: new Set() };
      if (r.decision === "ALLOWED") perSite.allowed += 1;
      else perSite.denied += 1;
      r.reason_codes.forEach((code) => perSite.reason_codes.add(code));
      cell.sites.set(r.site_id, perSite);
      matrix.set(key, cell);
    }
    return {
      reproducibility: [...matrix.values()].map((cell) => ({
        configuration_id: cell.configuration_id,
        mode: cell.mode,
        sites: [...cell.sites.values()].map((x) => ({ ...x, reason_codes: [...x.reason_codes] })),
      })),
      open_safety_stops: [...s.safetyEvents.values()].filter((e) => e.open).map((e) => ({
        safety_event_id: e.id,
        site_id: e.site_id,
        configuration_id: e.configuration_id,
        reason: e.reason,
      })),
      quarantined_batches: [...s.batches.values()].filter((b) => b.quarantined).map((b) => ({
        batch_id: b.id,
        reason: b.quarantine_reason,
      })),
      sessions: rows,
    };
  }

  assertSignalAccess(personId, patientRef, siteId) {
    if (!signalAccessAt(this.state, personId, patientRef, siteId)) {
      throw new DomainError("SIGNAL_ACCESS_DENIED", `${personId} 不在该患者信号授权范围内`);
    }
  }
}
