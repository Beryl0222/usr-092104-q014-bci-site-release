import { RELEASE_SCOPES, SCOPE_LABELS } from "./events.js";
import { inWindow, ts } from "./util.js";

// 放行判定：回答治疗师“这台设备的这个构成版本 + 我的资质，今天在这个站点、这个用途下是否获准使用”。
// 纯函数，只读状态；判定结果与所依据的完整版本组合一起返回，便于审计与复核。
export function evaluateClearance(state, { device_id, operator_id, protocol_id, scope, at }) {
  const reasons = [];
  const combination = { device_id, operator_id, protocol_id, scope };

  if (!RELEASE_SCOPES.includes(scope)) {
    return { decision: "denied", reasons: [`未知用途范围：${scope}`], combination };
  }

  const device = state.deviceIndex.get(device_id);
  if (!device) {
    return { decision: "denied", reasons: [`设备 ${device_id} 未登记产品构成`], combination };
  }
  combination.site_id = device.site_id;
  combination.configuration_id = device.configuration_id;
  combination.configuration_version = device.version;

  const cfgVersion = state.configurations.get(device.configuration_id)?.versions.get(device.version);
  if (!cfgVersion) {
    return { decision: "denied", reasons: [`产品构成 ${device.configuration_id} 第 ${device.version} 版缺失`], combination };
  }
  Object.assign(combination, cfgVersion.composition);

  if (cfgVersion.withdrawn) {
    reasons.push(`产品构成第 ${device.version} 版已停用：${cfgVersion.reason ?? "未说明原因"}`);
  }

  if (!state.models.has(cfgVersion.composition.decoder_model)) {
    reasons.push(`解码算法 ${cfgVersion.composition.decoder_model} 未登记`);
  }

  for (const stop of state.stops.values()) {
    if (stop.active && stopCovers(stop.target, state, device, device_id)) {
      reasons.push(`安全停止 ${stop.id} 生效中：${stop.reason}`);
    }
  }

  for (const q of state.quarantines.values()) {
    if (q.active && q.site_id === device.site_id && q.hardware_batch === cfgVersion.composition.hardware_batch) {
      reasons.push(`硬件批次 ${q.hardware_batch} 在站点 ${q.site_id} 隔离中：${q.reason}`);
    }
  }

  const calibration = [...state.calibrations.values()].find(
    (c) =>
      c.device_id === device_id &&
      c.configuration_id === device.configuration_id &&
      c.configuration_version === device.version &&
      inWindow(at, c.valid_from, c.valid_until),
  );
  if (calibration) combination.calibration_id = calibration.id;
  else reasons.push("缺少覆盖当前产品构成版本的有效校准记录");

  const site = state.sites.get(device.site_id);
  if (!site?.activated) reasons.push(`站点 ${device.site_id} 未获启用`);
  if (!site?.condition_valid_until || ts(site.condition_valid_until) < ts(at)) {
    reasons.push(`站点 ${device.site_id} 场地条件核验缺失或已过期`);
  }

  // 用途严格匹配：科研验证、试用许可、常规康复启用各自独立放行，互不顶替。
  const grant = [...state.grants.values()].find(
    (g) =>
      !g.withdrawn &&
      g.scope === scope &&
      g.configuration_id === device.configuration_id &&
      g.configuration_version === device.version &&
      g.site_id === device.site_id &&
      g.protocol_id === protocol_id &&
      inWindow(at, g.valid_from, g.valid_until),
  );
  if (!grant) {
    reasons.push(`缺少${SCOPE_LABELS[scope]}放行：当前构成版本在本站点未获该用途批准，其他用途的放行不能顶替`);
  } else {
    combination.release_grant_id = grant.id;
    combination.protocol_version = grant.protocol_version;
    for (const evId of grant.evidence_ids ?? []) {
      if (!state.evidence.has(evId)) reasons.push(`验证证据 ${evId} 未登记或未获接受`);
    }
    const protoVersion = state.protocols.get(protocol_id)?.versions.get(grant.protocol_version);
    if (!protoVersion) {
      reasons.push(`训练方案 ${protocol_id} 第 ${grant.protocol_version} 版未获批准`);
    } else {
      combination.population_id = protoVersion.population_id;
      combination.population_version = protoVersion.population_version;
      if (protoVersion.population_id !== grant.population_id) {
        reasons.push("训练方案适用人群与放行批准不一致");
      } else if (!state.populations.get(protoVersion.population_id)?.versions.has(protoVersion.population_version)) {
        reasons.push(`适用人群 ${protoVersion.population_id} 第 ${protoVersion.population_version} 版未登记`);
      }
    }
  }

  const credential = [...state.credentials.values()].find(
    (c) =>
      !c.suspended &&
      c.operator_id === operator_id &&
      inWindow(at, c.valid_from, c.valid_until) &&
      (c.grants ?? []).some((g) => g.protocol_id === protocol_id && g.scope === scope),
  );
  if (credential) combination.credential_id = credential.id;
  else reasons.push(`操作人员不具备${SCOPE_LABELS[scope]}用途下该训练方案的有效资质`);

  return { decision: reasons.length === 0 ? "approved" : "denied", reasons, combination };
}

function stopCovers(target, state, device, device_id) {
  if (target.kind === "device") return target.device_id === device_id;
  if (target.kind === "site") return target.site_id === device.site_id;
  if (target.kind === "configuration") {
    return (
      target.configuration_id === device.configuration_id &&
      (target.configuration_version == null || target.configuration_version === device.version)
    );
  }
  return false;
}
