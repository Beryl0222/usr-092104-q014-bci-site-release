import { EVENT_AGGREGATE, RELEASE_SCOPES, SCOPE_LABELS } from "./events.js";
import { EventStore } from "./store.js";
import { applyEvent, emptyState } from "./state.js";
import { evaluateClearance } from "./clearance.js";
import { ts } from "./util.js";

// 系统边界：本后端只回答“放行 / 不放行”。
// 不根据脑信号诊断患者——脑信号仅以 signal_archive_ref 不透明引用登记，从不参与任何判定；
// 不修改医生处方——处方仅以 prescription_ref 不透明引用登记，系统不解析、不变更。

export function createBackend({ now } = {}) {
  const store = new EventStore();
  const state = emptyState();
  const clock = now ?? (() => new Date().toISOString());
  let seq = 0;

  function emit(event_type, aggregate_id, summary, payload, at) {
    const event = {
      event_id: `evt-${String(++seq).padStart(4, "0")}`,
      event_type,
      aggregate_type: EVENT_AGGREGATE[event_type],
      aggregate_id,
      occurred_at: at ?? clock(),
      version: store.nextVersion(EVENT_AGGREGATE[event_type], aggregate_id),
      summary,
      payload,
    };
    store.append(event);
    applyEvent(state, event);
    return event;
  }

  function requireRole(actor, roles, action) {
    if (!actor || !roles.includes(actor.role)) {
      throw new Error(`未授权：${action}需要 ${roles.join(" / ")} 角色`);
    }
  }

  // ---------- 注册类命令（总部登记） ----------

  function assembleConfiguration(actor, input) {
    requireRole(actor, ["registry_admin"], "登记产品构成");
    const { configuration_id, composition, devices } = input;
    for (const key of ["hardware_batch", "acquisition_firmware", "decoder_model", "exoskeleton_controller"]) {
      if (!composition?.[key]) throw new Error(`产品构成缺少要素：${key}`);
    }
    if (!Array.isArray(devices) || devices.length === 0) throw new Error("产品构成必须登记至少一台设备");
    return emit(
      "CONFIGURATION_ASSEMBLED",
      configuration_id,
      `产品构成登记：${composition.hardware_batch} / ${composition.acquisition_firmware} / ${composition.decoder_model} / ${composition.exoskeleton_controller}`,
      { composition, devices },
      input.at,
    );
  }

  function withdrawConfiguration(actor, input) {
    requireRole(actor, ["registry_admin", "safety_officer"], "停用产品构成版本");
    const ver = state.configurations.get(input.configuration_id)?.versions.get(input.target_version);
    if (!ver) throw new Error(`产品构成 ${input.configuration_id} 第 ${input.target_version} 版不存在`);
    if (ver.withdrawn) throw new Error("该构成版本已停用");
    return emit(
      "CONFIGURATION_WITHDRAWN",
      input.configuration_id,
      `停用产品构成第 ${input.target_version} 版：${input.reason}`,
      { target_version: input.target_version, reason: input.reason },
      input.at,
    );
  }

  function recordCalibration(actor, input) {
    requireRole(actor, ["registry_admin"], "登记校准");
    const device = state.deviceIndex.get(input.device_id);
    if (!device || device.configuration_id !== input.configuration_id || device.version !== input.configuration_version) {
      throw new Error(`设备 ${input.device_id} 当前不在构成 ${input.configuration_id} 第 ${input.configuration_version} 版上，校准无法对应`);
    }
    return emit(
      "CALIBRATION_RECORDED",
      input.calibration_id,
      `设备 ${input.device_id} 校准登记`,
      {
        device_id: input.device_id,
        configuration_id: input.configuration_id,
        configuration_version: input.configuration_version,
        method: input.method,
        valid_from: input.valid_from,
        valid_until: input.valid_until,
      },
      input.at,
    );
  }

  function publishModel(actor, input) {
    requireRole(actor, ["registry_admin"], "登记解码模型");
    return emit(
      "MODEL_PUBLISHED",
      input.model_id,
      `解码模型 ${input.model_id} 发布`,
      { algorithm_family: input.algorithm_family, artifact_hash: input.artifact_hash, notes: input.notes },
      input.at,
    );
  }

  function definePopulation(actor, input) {
    requireRole(actor, ["registry_admin"], "定义适用人群");
    return emit("POPULATION_DEFINED", input.population_id, `适用人群定义：${input.criteria}`, { criteria: input.criteria }, input.at);
  }

  function verifySiteCondition(actor, input) {
    requireRole(actor, ["registry_admin"], "核验场地条件");
    return emit(
      "SITE_CONDITION_VERIFIED",
      input.site_id,
      `站点 ${input.site_id} 场地条件核验`,
      { checks: input.checks ?? [], valid_until: input.valid_until },
      input.at,
    );
  }

  function releaseSite(actor, input) {
    requireRole(actor, ["registry_admin"], "启用站点");
    return emit("SITE_RELEASED", input.site_id, `站点 ${input.site_id} 获启用`, {}, input.at);
  }

  function issueCredential(actor, input) {
    requireRole(actor, ["registry_admin"], "签发人员资质");
    if (!Array.isArray(input.grants) || input.grants.length === 0) throw new Error("资质必须包含至少一项授权");
    for (const g of input.grants) {
      if (!g.protocol_id || !RELEASE_SCOPES.includes(g.scope)) throw new Error("资质授权必须指明训练方案与合法用途范围");
    }
    return emit(
      "CREDENTIAL_ISSUED",
      input.credential_id,
      `签发资质：${input.operator_id}`,
      { operator_id: input.operator_id, grants: input.grants, valid_from: input.valid_from, valid_until: input.valid_until },
      input.at,
    );
  }

  function suspendCredential(actor, input) {
    requireRole(actor, ["registry_admin", "safety_officer"], "暂停人员资质");
    if (!state.credentials.has(input.credential_id)) throw new Error(`资质 ${input.credential_id} 不存在`);
    return emit("CREDENTIAL_SUSPENDED", input.credential_id, `暂停资质：${input.reason}`, { reason: input.reason }, input.at);
  }

  function approveProtocol(actor, input) {
    requireRole(actor, ["registry_admin"], "批准训练方案");
    if (!state.populations.get(input.population_id)?.versions.has(input.population_version)) {
      throw new Error(`适用人群 ${input.population_id} 第 ${input.population_version} 版未登记`);
    }
    return emit(
      "PROTOCOL_APPROVED",
      input.protocol_id,
      `训练方案批准`,
      { population_id: input.population_id, population_version: input.population_version, steps: input.steps ?? [] },
      input.at,
    );
  }

  function acceptEvidence(actor, input) {
    requireRole(actor, ["registry_admin"], "接受验证证据");
    if (!RELEASE_SCOPES.includes(input.scope)) throw new Error(`未知用途范围：${input.scope}`);
    return emit(
      "EVIDENCE_ACCEPTED",
      input.evidence_id,
      `验证证据接受（${SCOPE_LABELS[input.scope]}）`,
      {
        scope: input.scope,
        kind: input.kind,
        configuration_id: input.configuration_id,
        configuration_version: input.configuration_version,
        result: input.result,
      },
      input.at,
    );
  }

  function grantRelease(actor, input) {
    requireRole(actor, ["registry_admin"], "登记放行");
    const { grant_id, scope, configuration_id, configuration_version, site_id, protocol_id, protocol_version, population_id } = input;
    if (!RELEASE_SCOPES.includes(scope)) throw new Error(`未知用途范围：${scope}`);
    const cfg = state.configurations.get(configuration_id)?.versions.get(configuration_version);
    if (!cfg) throw new Error(`产品构成 ${configuration_id} 第 ${configuration_version} 版未登记`);
    if (cfg.withdrawn) throw new Error("已停用的构成版本不能登记放行");
    if (!state.sites.get(site_id)?.activated) throw new Error(`站点 ${site_id} 未获启用`);
    const proto = state.protocols.get(protocol_id)?.versions.get(protocol_version);
    if (!proto) throw new Error(`训练方案 ${protocol_id} 第 ${protocol_version} 版未获批准`);
    if (proto.population_id !== population_id) throw new Error("放行适用人群必须与训练方案一致");
    for (const evId of input.evidence_ids ?? []) {
      const ev = state.evidence.get(evId);
      if (!ev) throw new Error(`验证证据 ${evId} 未获接受`);
      if (ev.scope !== scope) {
        throw new Error(`证据 ${evId} 属于${SCOPE_LABELS[ev.scope]}，不能支撑${SCOPE_LABELS[scope]}放行`);
      }
    }
    return emit(
      "RELEASE_GRANTED",
      grant_id,
      `${SCOPE_LABELS[scope]}放行：${configuration_id} 第 ${configuration_version} 版 @ ${site_id}`,
      {
        scope,
        configuration_id,
        configuration_version,
        site_id,
        protocol_id,
        protocol_version,
        population_id,
        evidence_ids: input.evidence_ids ?? [],
        valid_from: input.valid_from,
        valid_until: input.valid_until,
      },
      input.at,
    );
  }

  function withdrawRelease(actor, input) {
    requireRole(actor, ["registry_admin", "safety_officer"], "撤销放行");
    const grant = state.grants.get(input.grant_id);
    if (!grant || grant.withdrawn) throw new Error(`放行 ${input.grant_id} 不存在或已撤销`);
    return emit("RELEASE_WITHDRAWN", input.grant_id, `撤销放行：${input.reason}`, { reason: input.reason }, input.at);
  }

  // ---------- 放行查询与会话 ----------

  // 治疗师开工前的明确答案：获准 / 不准予 + 所依据的完整版本组合。
  function checkClearance(input) {
    const at = input.at ?? clock();
    return evaluateClearance(state, { ...input, at });
  }

  function startSession(actor, input) {
    requireRole(actor, ["therapist"], "发起训练会话");
    const { session_id, device_id, protocol_id, scope, prescription_ref, signal_archive_ref } = input;
    if (state.sessions.has(session_id)) throw new Error(`会话 ${session_id} 已存在`);
    if (!prescription_ref) throw new Error("必须登记医生处方引用 prescription_ref；系统仅登记引用，不解析、不修改处方");
    const at = input.at ?? clock();
    const evaluation = evaluateClearance(state, { device_id, operator_id: actor.id, protocol_id, scope, at });
    if (evaluation.decision === "denied") {
      emit(
        "SESSION_DENIED",
        session_id,
        `放行拒绝：${evaluation.reasons.join("；")}`,
        { device_id, operator_id: actor.id, protocol_id, scope, reasons: evaluation.reasons, combination: evaluation.combination },
        at,
      );
      return { decision: "denied", reasons: evaluation.reasons, combination: evaluation.combination };
    }
    emit(
      "SESSION_STARTED",
      session_id,
      `会话开始（${SCOPE_LABELS[scope]}）`,
      {
        device_id,
        operator_id: actor.id,
        protocol_id,
        scope,
        prescription_ref, // 处方不透明引用：仅登记，不解析、不修改
        signal_archive_ref: signal_archive_ref ?? null, // 脑信号存档引用：不参与任何放行或诊断判断
        combination: evaluation.combination,
      },
      at,
    );
    return { decision: "approved", session_id, combination: evaluation.combination };
  }

  function completeSession(actor, input) {
    requireRole(actor, ["therapist"], "结束训练会话");
    const session = state.sessions.get(input.session_id);
    if (!session || session.status !== "started") throw new Error(`会话 ${input.session_id} 不在进行中`);
    return emit("SESSION_COMPLETED", input.session_id, "会话结束", { result_summary: input.result_summary }, input.at);
  }

  // ---------- 安全停止与恢复 ----------

  // 紧急停止：命令返回时状态已同步生效，后续放行判定立即拒绝；设备回执随事件保存。
  function emergencyStop(actor, input) {
    requireRole(actor, ["therapist", "center_lead", "safety_officer"], "紧急停止");
    const { stop_id, target, reason, device_receipt } = input;
    if (!target || !["device", "site", "configuration"].includes(target.kind)) {
      throw new Error("停止目标必须是 device / site / configuration");
    }
    if (!device_receipt?.device_id || !device_receipt?.acknowledged_at || !device_receipt?.reported_state) {
      throw new Error("紧急停止必须保存设备回执（device_id、acknowledged_at、reported_state）");
    }
    return emit(
      "SAFETY_STOPPED",
      stop_id,
      `紧急停止：${reason}`,
      { target, reason, device_receipt, initiated_by: actor.id },
      input.at,
    );
  }

  // 恢复只能由有权人员（安全官）重新批准。
  function approveRecovery(actor, input) {
    requireRole(actor, ["safety_officer"], "恢复批准");
    const stop = state.stops.get(input.stop_id);
    if (!stop || !stop.active) throw new Error(`安全停止 ${input.stop_id} 不存在或已恢复`);
    return emit("STOP_RECOVERY_APPROVED", input.stop_id, "恢复批准", { approved_by: actor.id }, input.at);
  }

  // ---------- 批次隔离 ----------

  // 中心负责人只能隔离本中心的一个批次，不影响其他批次与其他中心。
  function quarantineBatch(actor, input) {
    requireRole(actor, ["center_lead"], "批次隔离");
    if (!actor.site_id) throw new Error("中心负责人必须绑定站点才能隔离批次");
    return emit(
      "BATCH_QUARANTINED",
      input.quarantine_id,
      `站点 ${actor.site_id} 隔离批次 ${input.hardware_batch}`,
      { site_id: actor.site_id, hardware_batch: input.hardware_batch, reason: input.reason },
      input.at,
    );
  }

  function liftQuarantine(actor, input) {
    const quarantine = state.quarantines.get(input.quarantine_id);
    if (!quarantine || !quarantine.active) throw new Error(`隔离 ${input.quarantine_id} 不存在或已解除`);
    const isLocalLead = actor?.role === "center_lead" && actor.site_id === quarantine.site_id;
    if (!isLocalLead && actor?.role !== "safety_officer") {
      throw new Error("未授权：只能由本中心负责人或安全官解除隔离");
    }
    return emit("QUARANTINE_LIFTED", input.quarantine_id, "解除批次隔离", {}, input.at);
  }

  // ---------- 离线中心指令 ----------

  function issueInstruction(actor, input) {
    requireRole(actor, ["registry_admin"], "签发指令");
    if (!(ts(input.not_before) < ts(input.not_after))) throw new Error("指令有效期 not_before 必须早于 not_after");
    return emit(
      "INSTRUCTION_ISSUED",
      input.instruction_id,
      `向站点 ${input.site_id} 签发指令：${input.kind}`,
      { site_id: input.site_id, kind: input.kind, payload: input.payload ?? {}, not_before: input.not_before, not_after: input.not_after },
      input.at,
    );
  }

  // 站点重新联网：只执行仍在有效期内的指令；过期指令记录拒绝，绝不补执行。
  function reconnectSite(actor, input) {
    requireRole(actor, ["registry_admin", "center_lead"], "站点重连处理");
    const { site_id } = input;
    if (actor.role === "center_lead" && actor.site_id !== site_id) {
      throw new Error(`未授权：中心负责人只能处理本站点 ${actor.site_id}`);
    }
    const at = input.at ?? clock();
    const outcomes = [];
    for (const ins of state.instructions.values()) {
      if (ins.site_id !== site_id || ins.status !== "issued") continue;
      if (ts(at) > ts(ins.not_after)) {
        emit("INSTRUCTION_REJECTED_EXPIRED", ins.id, "指令已过期，离线重连不予补执行", { site_id, rejected_at: at }, at);
        outcomes.push({ instruction_id: ins.id, outcome: "rejected_expired" });
      } else if (ts(at) >= ts(ins.not_before)) {
        applyInstruction(ins, at);
        emit("INSTRUCTION_APPLIED", ins.id, "指令已在有效期内执行", { site_id, applied_at: at }, at);
        outcomes.push({ instruction_id: ins.id, outcome: "applied" });
      }
    }
    return outcomes;
  }

  function applyInstruction(instruction, at) {
    if (instruction.kind === "withdraw_release") {
      const grant = state.grants.get(instruction.payload?.grant_id);
      if (grant && !grant.withdrawn) {
        emit("RELEASE_WITHDRAWN", grant.id, `按指令 ${instruction.id} 撤销放行`, { reason: `指令 ${instruction.id} 触发` }, at);
      }
    }
    // kind 为 notice 等仅告知类指令：记录已执行，无副作用
  }

  // ---------- 影响面分析 ----------

  // 固件或模型等构成要素变化后：列出受影响的构成版本、设备、站点与历史会话结果。
  function impactOfComponent(criteria) {
    const keys = ["hardware_batch", "acquisition_firmware", "decoder_model", "exoskeleton_controller"].filter((k) => criteria[k] != null);
    if (keys.length === 0) {
      throw new Error("至少指定一个构成要素（hardware_batch / acquisition_firmware / decoder_model / exoskeleton_controller）");
    }
    const matches = (composition) => composition != null && keys.every((k) => composition[k] === criteria[k]);

    const configuration_versions = [];
    for (const [cid, cfg] of state.configurations) {
      for (const [ver, v] of cfg.versions) {
        if (matches(v.composition)) {
          configuration_versions.push({ configuration_id: cid, version: ver, withdrawn: v.withdrawn, composition: v.composition });
        }
      }
    }

    const affected_devices = [];
    const affected_sites = new Set();
    for (const [device_id, d] of state.deviceIndex) {
      const composition = state.configurations.get(d.configuration_id)?.versions.get(d.version)?.composition;
      if (matches(composition)) {
        affected_devices.push({ device_id, ...d });
        affected_sites.add(d.site_id);
      }
    }

    const sessions = [];
    for (const s of state.sessions.values()) {
      if (s.status === "denied") continue;
      if (matches(s.combination)) {
        sessions.push({
          session_id: s.id,
          site_id: s.combination.site_id,
          device_id: s.combination.device_id,
          status: s.status,
          result_summary: s.result_summary ?? null,
        });
        affected_sites.add(s.combination.site_id);
      }
    }

    return { criteria, configuration_versions, affected_devices, affected_sites: [...affected_sites], sessions };
  }

  // ---------- 跨站治理视图 ----------

  // 治理人员按授权范围比较各站的安全事件复现与处置；患者信号引用仅在授权站点可见。
  function crossSiteSafetyOverview(actor) {
    requireRole(actor, ["governance"], "跨站治理视图");
    const sites = {};
    for (const grant of actor.grants ?? []) {
      const { site_id, signal_access } = grant;
      sites[site_id] = {
        stops: [...state.stops.values()]
          .filter((s) => stopTouchesSite(s, site_id))
          .map((s) => ({ stop_id: s.id, target: s.target, reason: s.reason, active: s.active, recovered_by: s.recovered_by ?? null })),
        quarantines: [...state.quarantines.values()]
          .filter((q) => q.site_id === site_id)
          .map((q) => ({ quarantine_id: q.id, hardware_batch: q.hardware_batch, active: q.active, reason: q.reason })),
        sessions: [...state.sessions.values()]
          .filter((s) => s.status !== "denied" && s.combination?.site_id === site_id)
          .map((s) => ({
            session_id: s.id,
            status: s.status,
            result_summary: s.result_summary ?? null,
            signal_archive_ref: signal_access ? (s.signal_archive_ref ?? null) : null,
            signal_access: signal_access ? "authorized" : "redacted",
          })),
      };
    }
    return { viewer: actor.id, sites };
  }

  function stopTouchesSite(stop, site_id) {
    const t = stop.target;
    if (t.kind === "site") return t.site_id === site_id;
    if (t.kind === "device") return state.deviceIndex.get(t.device_id)?.site_id === site_id;
    if (t.kind === "configuration") {
      return [...state.deviceIndex.values()].some(
        (d) => d.site_id === site_id && d.configuration_id === t.configuration_id && (t.configuration_version == null || d.version === t.configuration_version),
      );
    }
    return false;
  }

  return {
    // 注册类命令
    assembleConfiguration,
    withdrawConfiguration,
    recordCalibration,
    publishModel,
    definePopulation,
    verifySiteCondition,
    releaseSite,
    issueCredential,
    suspendCredential,
    approveProtocol,
    acceptEvidence,
    grantRelease,
    withdrawRelease,
    // 放行与会话
    checkClearance,
    startSession,
    completeSession,
    // 安全
    emergencyStop,
    approveRecovery,
    // 隔离
    quarantineBatch,
    liftQuarantine,
    // 离线指令
    issueInstruction,
    reconnectSite,
    // 查询
    impactOfComponent,
    crossSiteSafetyOverview,
    events: () => store.all(),
  };
}
