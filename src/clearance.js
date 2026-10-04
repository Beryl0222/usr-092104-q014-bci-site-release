import { latestCalibration, openSafetyStop } from "./projection.js";

/**
 * 会话前放行判定：纯函数，输入折叠后的读模型，输出明确答案。
 * 治疗师每天训练前问的就是：批次+采集固件+解码模型+外骨骼控制器+本人资质，
 * 在指定启用模式下今天是否获准使用。
 *
 * 三种启用模式 RESEARCH_VALIDATION / INVESTIGATIONAL_AUTHORIZATION /
 * ROUTINE_REHABILITATION 必须逐一对应证据、资质、方案、站点放行，不得互相顶替。
 */
export function evaluateClearance(state, input) {
  const reasons = [];
  const now = input.now ?? new Date().toISOString();
  const add = (code, detail) => reasons.push({ code, detail });

  const config = state.configurations.get(input.configuration_id);
  if (!config) {
    add("CONFIGURATION_UNKNOWN", `产品构成 ${input.configuration_id} 不存在`);
    return denied(reasons);
  }
  if (config.status === "DISCONTINUED") add("CONFIGURATION_DISCONTINUED", "该产品构成已停用");

  // 红线：系统只做运动控制输出，不得诊断、不得改处方
  if (config.intended_use && config.intended_use !== "CONTROL_ONLY") {
    add("FORBIDDEN_INTENDED_USE", `产品构成用途 ${config.intended_use} 越界（仅允许 CONTROL_ONLY）`);
  }

  const comp = config.components ?? {};
  const batchId = comp.hardware_batch_id;
  const batch = state.batches.get(batchId);
  if (!batch) add("HARDWARE_BATCH_UNKNOWN", `硬件批次 ${batchId} 未登记`);
  if (batch?.quarantined) add("BATCH_QUARANTINED", `硬件批次 ${batchId} 已被隔离：${batch.quarantine_reason ?? ""}`);

  // 固件核对：构成钉住的采集固件与外骨骼控制器固件，必须是批次当前发布版本
  const firmwareRefs = [
    { slot: "acquisition_firmware", ref: comp.acquisition_firmware },
    { slot: "exoskeleton_controller", ref: { firmware_id: comp.exoskeleton_controller?.id, version: comp.exoskeleton_controller?.firmware_version } },
  ];
  for (const { slot, ref } of firmwareRefs) {
    if (!ref?.firmware_id || ref.version === undefined) {
      add("COMPONENT_MISSING", `产品构成缺少 ${slot} 版本钉版`);
      continue;
    }
    if (!batch) continue;
    const releases = batch.firmwares.filter((f) => f.firmware_id === ref.firmware_id);
    const exact = releases.find((f) => String(f.version) === String(ref.version));
    const newest = releases.sort((a, b) => b.seq - a.seq)[0];
    if (!exact) add("FIRMWARE_VERSION_NOT_RELEASED", `${slot} 固件 ${ref.firmware_id}@${ref.version} 未在该批次发布`);
    else if (newest && String(newest.version) !== String(ref.version)) {
      add("FIRMWARE_DRIFT", `${slot} 已升级至 ${newest.version}，构成仍钉在 ${ref.version}，须重新组装并重验`);
    }
  }

  // 解码模型：必须存在、在役、钉版一致、用途仅限控制
  const modelRef = comp.decoder_model;
  const model = modelRef ? state.models.get(modelRef.id) : undefined;
  if (!modelRef?.id || modelRef.version === undefined) add("COMPONENT_MISSING", "产品构成缺少 decoder_model 钉版");
  if (modelRef && !model) add("MODEL_UNKNOWN", `解码模型 ${modelRef.id} 未发布`);
  if (model?.status === "RETIRED") add("MODEL_RETIRED", `解码模型 ${modelRef?.id} 已退役`);
  if (model && !model.versions.has(modelRef.version)) add("MODEL_VERSION_UNRELEASED", `模型版本 ${modelRef.id}@${modelRef.version} 未发布`);
  if (model && model.current_version && String(model.current_version) !== String(modelRef.version)) {
    add("MODEL_DRIFT", `模型当前版本 ${model.current_version}，构成仍钉在 ${modelRef.version}，须重新组装并重验`);
  }
  if (model?.intended_use && model.intended_use !== "CONTROL_ONLY") {
    add("FORBIDDEN_INTENDED_USE", `模型用途 ${model.intended_use} 越界：禁止用于诊断或处方修改`);
  }

  // 校准：本站本构成最新一条必须有效、未过期、漂移在限内
  const calibration = latestCalibration(state, config.id, input.site_id);
  if (!calibration) add("CALIBRATION_MISSING", `站点 ${input.site_id} 无该构成的校准记录`);
  if (calibration && calibration.status !== "VALID") add("CALIBRATION_INVALID", `校准状态 ${calibration.status}`);
  if (calibration?.valid_until && Date.parse(calibration.valid_until) < Date.parse(now)) {
    add("CALIBRATION_EXPIRED", `校准已于 ${calibration.valid_until} 到期`);
  }
  if (calibration?.drift_metrics && calibration.drift_metrics.within_limits === false) {
    add("SIGNAL_DRIFT_OUT_OF_LIMITS", `信号漂移超出限界：${JSON.stringify(calibration.drift_metrics)}`);
  }

  // 适用人群：患者属性必须满足纳入、不触发排除
  const scope = input.population_scope_id ? state.scopes.get(input.population_scope_id) : undefined;
  if (input.population_scope_id && !scope) add("POPULATION_SCOPE_UNKNOWN", "适用人群定义不存在");
  if (scope) {
    const attrs = input.patient_attributes ?? {};
    for (const [k, expected] of Object.entries(scope.inclusion_attributes)) {
      if (attrs[k] !== expected) add("PATIENT_OUT_OF_SCOPE", `纳入条件不满足：${k} 应为 ${expected}`);
    }
    for (const [k, forbidden] of Object.entries(scope.exclusion_attributes)) {
      if (attrs[k] === forbidden) add("PATIENT_EXCLUDED", `触发排除条件：${k}=${forbidden}`);
    }
  }

  // 验证证据：模式必须严格一致，科研/试用/常规不得顶替；覆盖本站、本构成、当前日期
  const matching = [...state.evidences.values()].filter(
    (v) =>
      v.status === "ACCEPTED" &&
      v.configuration_id === config.id &&
      v.mode === input.mode &&
      (v.site_ids === "ALL" || v.site_ids.includes(input.site_id)) &&
      (!v.population_scope_id || v.population_scope_id === input.population_scope_id),
  );
  const evidence = matching.find(
    (v) => Date.parse(v.valid_from) <= Date.parse(now) && (!v.valid_until || Date.parse(v.valid_until) >= Date.parse(now)),
  );
  if (!evidence) {
    const wrongMode = [...state.evidences.values()].find((v) => v.status === "ACCEPTED" && v.configuration_id === config.id && v.mode !== input.mode);
    add(
      "EVIDENCE_MODE_MISMATCH",
      wrongMode
        ? `仅有 ${wrongMode.mode} 证据，不能顶替本次 ${input.mode} 使用`
        : `缺少 ${input.mode} 模式下覆盖本站与当前日期的验收证据`,
    );
  }

  // 场地条件：最新评估必须达标
  const site = state.sites.get(input.site_id);
  if (!site) add("SITE_UNKNOWN", `站点 ${input.site_id} 未登记`);
  const condition = site?.conditions.get(config.id);
  if (!condition) add("SITE_CONDITION_NOT_ASSESSED", "该站点未评估此构成的场地条件");
  if (condition && condition.conditions_met !== true) add("SITE_CONDITION_UNMET", `场地条件不达标：${JSON.stringify(condition.findings)}`);

  // 人员能力：本人资质覆盖站点、模式、构成且在有效期内
  const credential = [...state.credentials.values()].find(
    (c) => c.person_id === input.operator_id && c.status === "ACTIVE",
  );
  if (!credential) add("CREDENTIAL_MISSING", `治疗师 ${input.operator_id} 无有效资质`);
  if (credential) {
    if (credential.site_id !== input.site_id && credential.site_id !== "ALL") add("CREDENTIAL_SCOPE_SITE", "资质不含本站");
    if (!credential.modes.includes(input.mode)) add("CREDENTIAL_SCOPE_MODE", `资质不含启用模式 ${input.mode}`);
    if (credential.configuration_ids !== "ALL" && !credential.configuration_ids.includes(config.id)) {
      add("CREDENTIAL_SCOPE_CONFIGURATION", "资质不含该产品构成");
    }
    if (credential.valid_until && Date.parse(credential.valid_until) < Date.parse(now)) add("CREDENTIAL_EXPIRED", "资质已过期");
  }

  // 训练方案：须已批准且模式/构成/人群/站点一致
  const protocol = input.protocol_id ? state.protocols.get(input.protocol_id) : undefined;
  if (!input.protocol_id) add("PROTOCOL_MISSING", "未指定训练方案");
  if (input.protocol_id && !protocol) add("PROTOCOL_UNKNOWN", "训练方案不存在");
  if (protocol && protocol.status !== "APPROVED") add("PROTOCOL_NOT_APPROVED", `方案状态 ${protocol.status}`);
  if (protocol && protocol.configuration_id !== config.id) add("PROTOCOL_CONFIGURATION_MISMATCH", "方案与产品构成不一致");
  if (protocol && protocol.mode !== input.mode) add("PROTOCOL_MODE_MISMATCH", "方案与启用模式不一致");
  if (protocol && scope && protocol.population_scope_id !== scope.id) add("PROTOCOL_SCOPE_MISMATCH", "方案与适用人群不一致");
  if (protocol && protocol.site_id !== "ALL" && protocol.site_id !== input.site_id) add("PROTOCOL_SITE_MISMATCH", "方案不覆盖本站");

  // 站点放行：总部/办公室针对本站本构成本模式的放行须在役
  const release = [...state.releases.values()].find(
    (r) =>
      r.site_id === input.site_id &&
      r.configuration_id === config.id &&
      r.mode === input.mode &&
      r.status === "ACTIVE",
  );
  if (!release) add("SITE_NOT_RELEASED", `本站未就该构成获得 ${input.mode} 放行`);

  // 存在未关闭的急停：一律拒绝
  const stop = openSafetyStop(state, input.site_id, config.id);
  if (stop) add("SAFETY_STOP_OPEN", `安全事件 ${stop.id} 尚未由有权人员批准恢复（${stop.reason}）`);

  return {
    decision: reasons.length ? "DENIED" : "ALLOWED",
    reasons,
    evidence_id: evidence?.id,
    evaluated_at: now,
    components: {
      hardware_batch_id: batchId,
      acquisition_firmware: comp.acquisition_firmware,
      decoder_model: comp.decoder_model,
      exoskeleton_controller: comp.exoskeleton_controller,
    },
  };
}

function denied(reasons) {
  return { decision: "DENIED", reasons, evidence_id: undefined, evaluated_at: new Date().toISOString(), components: {} };
}
