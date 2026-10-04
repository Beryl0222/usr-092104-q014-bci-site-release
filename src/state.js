// 将事件流折叠为读模型。每类对象各自独立版本化，版本语义即聚合内事件序号。

export function emptyState() {
  return {
    configurations: new Map(), // configuration_id → { versions: Map(版本 → { composition, devices, withdrawn, reason }) }
    deviceIndex: new Map(), // device_id → { configuration_id, version, site_id }（设备当前落在哪个构成版本上）
    calibrations: new Map(), // calibration_id → { device_id, configuration_id, configuration_version, valid_from, valid_until, ... }
    models: new Map(), // model_id → { versions: Map(版本 → 模型资料) }
    populations: new Map(), // population_id → { versions: Map(版本 → { criteria }) }
    sites: new Map(), // site_id → { activated, condition_valid_until, condition_checks }
    credentials: new Map(), // credential_id → { operator_id, grants, valid_from, valid_until, suspended }
    protocols: new Map(), // protocol_id → { versions: Map(版本 → { population_id, population_version, steps }) }
    evidence: new Map(), // evidence_id → { scope, kind, result, ... }
    grants: new Map(), // grant_id → { scope, configuration_id, configuration_version, site_id, ..., withdrawn }
    sessions: new Map(), // session_id → { status, combination, result_summary, ... }
    stops: new Map(), // stop_id → { target, reason, device_receipt, active, ... }
    quarantines: new Map(), // quarantine_id → { site_id, hardware_batch, reason, active }
    instructions: new Map(), // instruction_id → { site_id, kind, payload, not_before, not_after, status }
  };
}

function ensure(map, id, init) {
  if (!map.has(id)) map.set(id, init());
  return map.get(id);
}

export function applyEvent(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "CONFIGURATION_ASSEMBLED": {
      const cfg = ensure(state.configurations, event.aggregate_id, () => ({ versions: new Map() }));
      cfg.versions.set(event.version, {
        composition: p.composition,
        devices: p.devices ?? [],
        withdrawn: false,
        reason: null,
      });
      for (const d of p.devices ?? []) {
        state.deviceIndex.set(d.device_id, {
          configuration_id: event.aggregate_id,
          version: event.version,
          site_id: d.site_id,
        });
      }
      break;
    }
    case "CONFIGURATION_WITHDRAWN": {
      const ver = state.configurations.get(event.aggregate_id)?.versions.get(p.target_version);
      if (ver) {
        ver.withdrawn = true;
        ver.reason = p.reason;
      }
      break;
    }
    case "CALIBRATION_RECORDED":
      state.calibrations.set(event.aggregate_id, { id: event.aggregate_id, ...p });
      break;
    case "MODEL_PUBLISHED": {
      const model = ensure(state.models, event.aggregate_id, () => ({ versions: new Map() }));
      model.versions.set(event.version, { ...p });
      break;
    }
    case "POPULATION_DEFINED": {
      const pop = ensure(state.populations, event.aggregate_id, () => ({ versions: new Map() }));
      pop.versions.set(event.version, { criteria: p.criteria });
      break;
    }
    case "SITE_CONDITION_VERIFIED": {
      const site = ensure(state.sites, event.aggregate_id, () => ({ activated: false, condition_valid_until: null, condition_checks: [] }));
      site.condition_valid_until = p.valid_until;
      site.condition_checks = p.checks ?? [];
      break;
    }
    case "SITE_RELEASED": {
      const site = ensure(state.sites, event.aggregate_id, () => ({ activated: false, condition_valid_until: null, condition_checks: [] }));
      site.activated = true;
      break;
    }
    case "CREDENTIAL_ISSUED":
      state.credentials.set(event.aggregate_id, {
        id: event.aggregate_id,
        operator_id: p.operator_id,
        grants: p.grants ?? [],
        valid_from: p.valid_from,
        valid_until: p.valid_until,
        suspended: false,
      });
      break;
    case "CREDENTIAL_SUSPENDED": {
      const cred = state.credentials.get(event.aggregate_id);
      if (cred) cred.suspended = true;
      break;
    }
    case "PROTOCOL_APPROVED": {
      const proto = ensure(state.protocols, event.aggregate_id, () => ({ versions: new Map() }));
      proto.versions.set(event.version, {
        population_id: p.population_id,
        population_version: p.population_version,
        steps: p.steps ?? [],
      });
      break;
    }
    case "EVIDENCE_ACCEPTED":
      state.evidence.set(event.aggregate_id, { id: event.aggregate_id, ...p });
      break;
    case "RELEASE_GRANTED":
      state.grants.set(event.aggregate_id, { id: event.aggregate_id, ...p, withdrawn: false });
      break;
    case "RELEASE_WITHDRAWN": {
      const grant = state.grants.get(event.aggregate_id);
      if (grant) {
        grant.withdrawn = true;
        grant.withdraw_reason = p.reason;
      }
      break;
    }
    case "SESSION_STARTED":
      state.sessions.set(event.aggregate_id, { id: event.aggregate_id, status: "started", ...p });
      break;
    case "SESSION_DENIED":
      state.sessions.set(event.aggregate_id, { id: event.aggregate_id, status: "denied", ...p });
      break;
    case "SESSION_COMPLETED": {
      const session = state.sessions.get(event.aggregate_id);
      if (session) {
        session.status = "completed";
        session.result_summary = p.result_summary;
      }
      break;
    }
    case "SAFETY_STOPPED":
      state.stops.set(event.aggregate_id, { id: event.aggregate_id, active: true, ...p });
      break;
    case "STOP_RECOVERY_APPROVED": {
      const stop = state.stops.get(event.aggregate_id);
      if (stop) {
        stop.active = false;
        stop.recovered_by = p.approved_by;
      }
      break;
    }
    case "BATCH_QUARANTINED":
      state.quarantines.set(event.aggregate_id, { id: event.aggregate_id, active: true, ...p });
      break;
    case "QUARANTINE_LIFTED": {
      const quarantine = state.quarantines.get(event.aggregate_id);
      if (quarantine) quarantine.active = false;
      break;
    }
    case "INSTRUCTION_ISSUED":
      state.instructions.set(event.aggregate_id, { id: event.aggregate_id, status: "issued", ...p });
      break;
    case "INSTRUCTION_APPLIED": {
      const instruction = state.instructions.get(event.aggregate_id);
      if (instruction) instruction.status = "applied";
      break;
    }
    case "INSTRUCTION_REJECTED_EXPIRED": {
      const instruction = state.instructions.get(event.aggregate_id);
      if (instruction) instruction.status = "rejected_expired";
      break;
    }
    default:
      break;
  }
}
