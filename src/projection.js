/**
 * 读模型投影：把追加事件流折叠为当前世界状态。
 * 所有判定都只基于投影结果，不直接读事件外的状态。
 */

export function fold(events) {
  const state = {
    configurations: new Map(),
    batches: new Map(),
    calibrations: new Map(),
    models: new Map(),
    scopes: new Map(),
    evidences: new Map(),
    sites: new Map(),
    credentials: new Map(),
    protocols: new Map(),
    releases: new Map(),
    sessions: new Map(),
    safetyEvents: new Map(),
    commands: new Map(),
    signalGrants: [],
  };

  // 按追加顺序折叠（因果顺序）；occurred_at 仅用于展示与效期计算。
  let seq = 0;
  for (const e of events) apply(state, e, seq++);
  return state;
}
function site(state, id) {
  if (!state.sites.has(id)) state.sites.set(id, { id, conditions: new Map(), connectivity: "ONLINE" });
  return state.sites.get(id);
}

function apply(state, e, seq) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "CONFIGURATION_ASSEMBLED": {
      state.configurations.set(e.aggregate_id, {
        id: e.aggregate_id,
        components: p.components,
        supersedes: p.supersedes ?? [],
        intended_use: p.intended_use ?? "CONTROL_ONLY",
        status: "ASSEMBLED",
        assembled_at: e.occurred_at,
      });
      break;
    }
    case "CONFIGURATION_DISCONTINUED": {
      const c = state.configurations.get(e.aggregate_id);
      if (c) c.status = "DISCONTINUED";
      break;
    }
    case "FIRMWARE_RELEASED": {
      // 同轨保留全部发布记录，最新一条为当前发布；升级后旧版本仍可追溯。
      const b = state.batches.get(e.aggregate_id) ?? { id: e.aggregate_id, firmwares: [], quarantined: false };
      b.firmwares.push({
        track: p.track,
        firmware_id: p.firmware_id,
        version: p.version,
        released_at: e.occurred_at,
        seq,
      });
      state.batches.set(e.aggregate_id, b);
      break;
    }
    case "BATCH_QUARANTINED": {
      const b = state.batches.get(p.batch_id) ?? { id: p.batch_id, firmwares: [], quarantined: false };
      b.quarantined = true;
      b.quarantine_reason = p.reason;
      b.quarantined_at = e.occurred_at;
      state.batches.set(p.batch_id, b);
      break;
    }
    case "BATCH_RELEASED_FROM_QUARANTINE": {
      const b = state.batches.get(p.batch_id);
      if (b) {
        b.quarantined = false;
        b.quarantine_reason = undefined;
      }
      break;
    }
    case "CALIBRATION_RECORDED": {
      state.calibrations.set(e.aggregate_id, {
        id: e.aggregate_id,
        configuration_id: p.configuration_id,
        site_id: p.site_id,
        status: p.status,
        recorded_at: p.recorded_at ?? e.occurred_at,
        valid_until: p.valid_until,
        drift_metrics: p.drift_metrics,
        seq,
      });
      break;
    }
    case "MODEL_RELEASED": {
      const m = state.models.get(p.model_id) ?? { id: p.model_id, versions: new Set(), status: "ACTIVE" };
      m.versions.add(p.version);
      m.current_version = p.version;
      m.intended_use = p.intended_use ?? "CONTROL_ONLY";
      m.status = "ACTIVE";
      state.models.set(p.model_id, m);
      break;
    }
    case "MODEL_RETIRED": {
      const m = state.models.get(p.model_id);
      if (m) m.status = "RETIRED";
      break;
    }
    case "POPULATION_SCOPE_DEFINED": {
      state.scopes.set(e.aggregate_id, {
        id: e.aggregate_id,
        indication: p.indication,
        inclusion_attributes: p.inclusion_attributes ?? [],
        exclusion_attributes: p.exclusion_attributes ?? [],
      });
      break;
    }
    case "EVIDENCE_ACCEPTED": {
      state.evidences.set(e.aggregate_id, {
        id: e.aggregate_id,
        configuration_id: p.configuration_id,
        mode: p.mode,
        population_scope_id: p.population_scope_id,
        site_ids: p.site_ids ?? "ALL",
        claims: p.claims ?? [],
        valid_from: p.valid_from ?? e.occurred_at,
        valid_until: p.valid_until,
        study_ref: p.study_ref,
        status: "ACCEPTED",
      });
      break;
    }
    case "EVIDENCE_REVOKED": {
      const v = state.evidences.get(e.aggregate_id);
      if (v) v.status = "REVOKED";
      break;
    }
    case "SITE_REGISTERED": {
      const existing = state.sites.get(e.aggregate_id);
      state.sites.set(e.aggregate_id, {
        id: e.aggregate_id,
        name: p.name ?? existing?.name,
        connectivity: p.connectivity ?? existing?.connectivity ?? "ONLINE",
        conditions: existing?.conditions ?? new Map(),
      });
      break;
    }
    case "SITE_CONDITION_ASSESSED": {
      const s = site(state, p.site_id);
      if (p.connectivity) s.connectivity = p.connectivity;
      s.conditions.set(p.configuration_id, {
        configuration_id: p.configuration_id,
        conditions_met: p.conditions_met,
        assessed_at: p.assessed_at ?? e.occurred_at,
        findings: p.findings ?? {},
      });
      break;
    }
    case "PERSONNEL_CERTIFIED": {
      state.credentials.set(e.aggregate_id, {
        id: e.aggregate_id,
        person_id: p.person_id,
        site_id: p.site_id,
        modes: p.modes ?? [],
        configuration_ids: p.configuration_ids ?? "ALL",
        valid_from: p.valid_from ?? e.occurred_at,
        valid_until: p.valid_until,
        status: "ACTIVE",
      });
      break;
    }
    case "CREDENTIAL_REVOKED": {
      const c = state.credentials.get(e.aggregate_id);
      if (c) c.status = "REVOKED";
      break;
    }
    case "PROTOCOL_APPROVED": {
      state.protocols.set(e.aggregate_id, {
        id: e.aggregate_id,
        configuration_id: p.configuration_id,
        mode: p.mode,
        population_scope_id: p.population_scope_id,
        site_id: p.site_id ?? "ALL",
        status: "APPROVED",
      });
      break;
    }
    case "PROTOCOL_WITHDRAWN": {
      const pr = state.protocols.get(e.aggregate_id);
      if (pr) pr.status = "WITHDRAWN";
      break;
    }
    case "SITE_RELEASED": {
      state.releases.set(e.aggregate_id, {
        id: e.aggregate_id,
        site_id: p.site_id,
        configuration_id: p.configuration_id,
        mode: p.mode,
        population_scope_id: p.population_scope_id,
        protocol_id: p.protocol_id,
        status: "ACTIVE",
        released_at: e.occurred_at,
      });
      break;
    }
    case "RELEASE_SUSPENDED": {
      const r = state.releases.get(e.aggregate_id);
      if (r) {
        r.status = "SUSPENDED";
        r.suspension_reason = p.reason;
      }
      break;
    }
    case "SESSION_CLEARED": {
      state.sessions.set(e.aggregate_id, {
        id: e.aggregate_id,
        site_id: p.site_id,
        configuration_id: p.configuration_id,
        components: p.components,
        mode: p.mode,
        operator_id: p.operator_id,
        patient_ref: p.patient_ref,
        population_scope_id: p.population_scope_id,
        protocol_id: p.protocol_id,
        prescription_ref: p.prescription_ref,
        patient_attributes: p.patient_attributes,
        decision: p.decision,
        reasons: p.reasons ?? [],
        evidence_id: p.evidence_id,
        evaluated_at: p.evaluated_at ?? e.occurred_at,
        status: "CLEARED",
      });
      break;
    }
    case "SESSION_STARTED": {
      const s = state.sessions.get(e.aggregate_id);
      if (s) {
        s.status = "STARTED";
        s.started_at = e.occurred_at;
      }
      break;
    }
    case "SESSION_ENDED": {
      const s = state.sessions.get(e.aggregate_id);
      if (s) {
        s.status = "ENDED";
        s.ended_at = e.occurred_at;
        s.outcome = p.outcome;
      }
      break;
    }
    case "SAFETY_STOPPED": {
      state.safetyEvents.set(e.aggregate_id, {
        id: e.aggregate_id,
        session_id: p.session_id,
        site_id: p.site_id,
        configuration_id: p.configuration_id,
        device_ref: p.device_ref,
        triggered_by: p.triggered_by,
        reason: p.reason,
        stopped_at: e.occurred_at,
        open: true,
        device_ack: undefined,
      });
      break;
    }
    case "OPERATION_RESUMED": {
      const sev = state.safetyEvents.get(p.safety_event_id);
      if (sev) {
        sev.open = false;
        sev.resumed_at = e.occurred_at;
        sev.resumed_by = p.approved_by;
      }
      break;
    }
    case "DEVICE_ACK_RECORDED": {
      if (p.safety_event_id) {
        const sev = state.safetyEvents.get(p.safety_event_id);
        if (sev) sev.device_ack = { receipt: p.receipt, ack_at: p.ack_at ?? e.occurred_at };
      }
      if (p.command_id) {
        const cmd = state.commands.get(p.command_id);
        if (cmd) {
          cmd.status = "ACKED";
          cmd.receipt = p.receipt;
        }
      }
      break;
    }
    case "COMMAND_QUEUED": {
      state.commands.set(e.aggregate_id, {
        id: e.aggregate_id,
        target_site_id: p.target_site_id,
        command_type: p.command_type,
        not_before: p.not_before,
        expires_at: p.expires_at,
        parameters: p.parameters ?? {},
        issued_at: e.occurred_at,
        status: "QUEUED",
      });
      break;
    }
    case "COMMAND_EXPIRED": {
      const cmd = state.commands.get(e.aggregate_id);
      if (cmd) {
        cmd.status = "EXPIRED";
        cmd.expire_reason = p.reason;
      }
      break;
    }
    case "PATIENT_SIGNAL_POLICY_GRANTED": {
      state.signalGrants.push({
        person_id: p.person_id,
        site_id: p.site_id,
        patient_refs: p.patient_refs,
        scopes: p.scopes ?? [],
        valid_until: p.valid_until,
        granted_at: e.occurred_at,
      });
      break;
    }
    default:
      break;
  }
}

// ---------- 读模型查询 ----------

export function latestCalibration(state, configurationId, siteId) {
  const rows = [...state.calibrations.values()]
    .filter((c) => c.configuration_id === configurationId && c.site_id === siteId)
    .sort((a, b) => b.seq - a.seq);
  return rows[0];
}

export function openSafetyStop(state, siteId, configurationId) {
  return [...state.safetyEvents.values()].find(
    (s) => s.open && s.site_id === siteId && s.configuration_id === configurationId,
  );
}

/** 配置是否钉住了指定固件/模型版本（受影响面分析用） */
export function configurationsUsing(state, target) {
  return [...state.configurations.values()].filter((c) => {
    if (c.status === "DISCONTINUED" && target.includeDiscontinued === false) return false;
    const comp = c.components ?? {};
    if (target.kind === "FIRMWARE") {
      // 固件按固件标识（轨）匹配：新版本发布后，所有钉在该轨上的构成都在影响面内，
      // 无论钉的是新是旧；target.version 仅用于报告标注，不缩小影响面。
      const refs = [
        comp.acquisition_firmware,
        { firmware_id: comp.exoskeleton_controller?.id, version: comp.exoskeleton_controller?.firmware_version },
      ];
      return refs.some((r) => r && r.firmware_id === target.id);
    }
    if (target.kind === "MODEL") {
      return (
        comp.decoder_model?.id === target.id &&
        (target.version === undefined || String(comp.decoder_model.version) === String(target.version))
      );
    }
    if (target.kind === "BATCH") {
      return comp.hardware_batch_id === target.id;
    }
    return false;
  });
}

/** 某人当前对某患者信号是否在授权范围内 */
export function signalAccessAt(state, personId, patientRef, siteId, at = new Date().toISOString()) {
  return state.signalGrants.some(
    (g) =>
      g.person_id === personId &&
      g.site_id === siteId &&
      (!g.valid_until || Date.parse(at) <= Date.parse(g.valid_until)) &&
      (g.patient_refs === "ALL_IN_SITE" || g.patient_refs.includes(patientRef)),
  );
}
