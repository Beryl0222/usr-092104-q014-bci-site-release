# 脑机示范设备放行

示范项目办公室的设备放行后端领域内核：治疗师每次脑机康复训练开始前，系统对
**硬件批次 + 采集固件 + 解码算法 + 外骨骼控制器 + 人员资质 + 启用模式**给出一个明确结论
（`ALLOWED` / `DENIED` 及逐条原因）。所有对象以追加事件版本化，沿用本仓库既有的领域事件信封向下游流转。

## 目录

- `contracts/domain.schema.json`：领域事件信封、稳定枚举（事件类型、聚合类型、启用模式）。
- `src/eventStore.js`：追加型事件存储，聚合内 `version` 从 1 严格递增，支持乐观并发；可挂 JSONL sink 落盘。
- `src/projection.js`：把事件流按追加顺序折叠为读模型，并提供校准、急停、影响面、信号授权等查询。
- `src/clearance.js`：会话前放行判定（纯函数），所有规则集中于此。
- `src/appService.js`：应用服务（命令 → 事件），含急停、恢复批准、批次隔离、影响面、离线指令、治理报表。
- `src/validator.js`：事件基础字段与枚举校验。
- `tests/`：18 条领域一致性测试；`tests/fixture.js` 为五中心联调基线。
- `scripts/walkthrough.mjs`：五家示范中心一天时间线的可执行走查（`node scripts/walkthrough.mjs`）。
- `data/sample.json`：中文联调样例。

## 本地检查

```bash
npm test
node scripts/walkthrough.mjs
```

## 版本化对象（各自独立聚合与版本流）

| 对象 | aggregate_type | 关键事件 |
| --- | --- | --- |
| 产品构成（批次/采集固件/解码模型/外骨骼控制器钉版） | `device_configuration` | CONFIGURATION_ASSEMBLED / DISCONTINUED |
| 硬件批次（固件发布、隔离） | `hardware_batch` | FIRMWARE_RELEASED / BATCH_QUARANTINED / BATCH_RELEASED_FROM_QUARANTINE |
| 校准（信号漂移） | `calibration` | CALIBRATION_RECORDED |
| 解码模型 | `decoder_model` | MODEL_RELEASED / MODEL_RETIRED |
| 适用人群 | `population_scope` | POPULATION_SCOPE_DEFINED |
| 验证证据 | `release_evidence` | EVIDENCE_ACCEPTED / EVIDENCE_REVOKED |
| 示范中心 | `demonstration_site` | SITE_REGISTERED（含联网状态） |
| 场地条件 | `site_condition` | SITE_CONDITION_ASSESSED |
| 人员能力 | `operator_credential` | PERSONNEL_CERTIFIED / CREDENTIAL_REVOKED |
| 训练方案 | `therapy_protocol` | PROTOCOL_APPROVED / PROTOCOL_WITHDRAWN |
| 站点放行 | `site_release` | SITE_RELEASED / RELEASE_SUSPENDED |
| 训练会话 | `therapy_session` | SESSION_CLEARED / SESSION_STARTED / SESSION_ENDED |
| 安全事件 | `safety_event` | SAFETY_STOPPED / DEVICE_ACK_RECORDED / OPERATION_RESUMED |
| 设备指令（离线排队） | `device_command` | COMMAND_QUEUED / COMMAND_EXPIRED |
| 患者信号授权 | `signal_access_policy` | PATIENT_SIGNAL_POLICY_GRANTED |

事件信封保持兼容：`event_id / event_type / aggregate_type / aggregate_id / occurred_at / version / summary`，
明细放 `payload`，跨站事件带 `site_id`。

## 启用模式（不可互相顶替）

- `RESEARCH_VALIDATION` 科研验证
- `INVESTIGATIONAL_AUTHORIZATION` 试用许可
- `ROUTINE_REHABILITATION` 常规康复启用

证据、站点放行、人员资质、训练方案均按模式逐一对应；仅有其他模式的证据时结论为
`EVIDENCE_MODE_MISMATCH`。“总部已验证产品”不等于本站点已放行：每站还需本站校准、场地评估、
持证人员、已批准方案与 `SITE_RELEASED`。

## 放行判定项（src/clearance.js）

构成存在且未停用、用途仅限 `CONTROL_ONLY`；批次已登记且未隔离；采集固件与外骨骼控制器固件
为批次当前发布版本（升级后旧钉版 → `FIRMWARE_DRIFT`）；模型已发布、未退役、钉版一致
（`MODEL_DRIFT` / `MODEL_RETIRED`）；本站本构成最新校准有效、未过期、漂移在限内；患者满足
适用人群纳入/排除；存在覆盖本站、本模式、当前日期的验收证据；场地条件达标；本人资质覆盖
站点/模式/构成且有效；已批准方案与构成/模式/人群/站点一致；本站放行在役；无未关闭急停。

判定后、开训前还会即时复核一次：放行之后若发生隔离、急停等变化，旧结论立即失效
（`CLEARANCE_STALE`），驳回的会话不得开始。

## 安全红线

- **系统不得根据脑信号诊断患者或修改医生处方。** 构成与模型的 `intended_use` 只允许
  `CONTROL_ONLY`；`DIAGNOSE_FROM_SIGNAL`、`MODIFY_PRESCRIPTION` 指令在入口被拒。
- **紧急停止立即生效。** `SAFETY_STOPPED` 一追加，所有放行判定立刻看到未关闭安全事件；
  设备回执以 `DEVICE_ACK_RECORDED` 保存，缺回执不得恢复。
- **恢复须重新批准。** 仅构造服务时登记的有权人员可 `OPERATION_RESUMED`，治疗师本人无权恢复。

## 处置与治理

- **批次级隔离**：`BATCH_QUARANTINED` 只驳回使用该批次的构成，其他批次设备照常可用；
  `impactOf()` 返回受影响构成、站点和历史放行结果。
- **固件/模型变更影响面**：发布新版本后可立即列出钉在该固件轨/模型上的全部构成、涉及站点
  与历史结论，支持精确暂停问题范围，而非停掉“已验证产品”的全部设备。
- **离线不补执行**：离线站点排队的指令带 `expires_at`；重新联网时过期指令记
  `COMMAND_EXPIRED`（原因 `RECONNECT_AFTER_EXPIRY`），绝不补执行；未过期且到生效时间的才交付。
- **跨站治理**：`governanceReport(viewer)` 按 构成×模式 汇总各站准/驳数量与原因码、未关闭
  急停与隔离批次；查看者只见 `PATIENT_SIGNAL_POLICY_GRANTED` 授权范围内的患者信号，
  其余患者引用显示 `REDACTED`，越权读取抛 `SIGNAL_ACCESS_DENIED`。

## 持久化与流转

`EventStore` 可挂 sink（如 `jsonlSink`）把每条事件追加落盘；重启后重放事件流即恢复同一读模型。
构造 `ReleaseService({ publish })` 后，每个状态变更事件都同步经 `publish` 发出，沿用现有领域
事件约定供下游订阅。
