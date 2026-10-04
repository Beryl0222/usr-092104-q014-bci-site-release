# 脑机示范设备放行

本仓库保存脑机示范设备放行的领域词汇、事件约定与放行后端实现，供相关单位统一对象身份、事件顺序和版本语义。

后端回答的核心问题：每次训练开始前，这台设备的**硬件批次、采集固件、解码算法、外骨骼控制器**构成的当前版本，加上**操作人员的资质**，今天在这个站点、这个用途下是否获准使用——并给出判定所依据的完整版本组合。

## 系统边界

- 系统只回答“放行 / 不放行”，**不根据脑信号诊断患者**：脑信号仅以 `signal_archive_ref` 不透明引用登记，从不参与任何判定。
- **不修改医生处方**：处方仅以 `prescription_ref` 不透明引用登记，系统不解析、不变更。

## 分别版本化的对象

| 聚合 | 含义 | 关键事件 |
| --- | --- | --- |
| device_configuration | 产品构成（硬件批次/采集固件/解码算法/外骨骼控制器 + 设备清单） | CONFIGURATION_ASSEMBLED、CONFIGURATION_WITHDRAWN |
| calibration_record | 校准（按设备 × 构成版本，有有效期） | CALIBRATION_RECORDED |
| decoder_model | 解码模型 | MODEL_PUBLISHED |
| population_criteria | 适用人群 | POPULATION_DEFINED |
| release_evidence | 验证证据（按用途归口） | EVIDENCE_ACCEPTED |
| site_condition | 场地条件与站点启用 | SITE_CONDITION_VERIFIED、SITE_RELEASED |
| operator_credential | 人员能力（方案 × 用途授权，有有效期） | CREDENTIAL_ISSUED、CREDENTIAL_SUSPENDED |
| therapy_protocol | 训练方案（绑定适用人群版本） | PROTOCOL_APPROVED |
| release_grant | 放行（构成版本 × 站点 × 用途 × 方案，有有效期） | RELEASE_GRANTED、RELEASE_WITHDRAWN |
| therapy_session | 会话（开始/拒绝/结束，携带版本组合快照） | SESSION_STARTED、SESSION_DENIED、SESSION_COMPLETED |
| safety_event | 安全事件（停止与恢复） | SAFETY_STOPPED、STOP_RECOVERY_APPROVED |
| quarantine | 批次隔离（按站点） | BATCH_QUARANTINED、QUARANTINE_LIFTED |
| instruction | 下发离线中心的指令（有有效期） | INSTRUCTION_ISSUED、INSTRUCTION_APPLIED、INSTRUCTION_REJECTED_EXPIRED |

每类对象的版本即其聚合内事件序号，各自独立演进。事件信封沿用 `contracts/domain.schema.json`：`event_id / event_type / aggregate_type / aggregate_id / occurred_at / version / summary`，领域数据放在 `payload` 内；登记只作增量扩展，保持事件兼容。

## 关键规则

- **用途互不顶替**：科研验证（research）、试用许可（trial）、常规康复启用（routine）各自独立放行。判定与登记两层把关——放行登记时证据用途必须与放行用途一致，会话判定时放行用途必须与请求用途一致。
- **紧急停止**：`emergencyStop` 返回即生效，后续判定立即拒绝；设备回执（`device_receipt`）随 SAFETY_STOPPED 事件强制保存。恢复只能由安全官（safety_officer）通过 `approveRecovery` 重新批准。
- **精确暂停**：可停用某个构成版本（CONFIGURATION_WITHDRAWN）、撤销某条放行（RELEASE_WITHDRAWN），或按构成版本发起安全停止，只影响落在该版本组合上的设备。
- **批次隔离**：中心负责人只能隔离本中心的一个硬件批次；本中心其他批次、其他中心同批次设备均不受影响。
- **离线指令**：指令携带 `not_before / not_after` 有效期；中心重新联网时只执行仍在有效期内的指令，过期指令记录 INSTRUCTION_REJECTED_EXPIRED，绝不补执行。
- **影响面**：固件或模型等构成要素变化后，`impactOfComponent` 列出受影响的构成版本、设备、站点与历史会话结果。
- **治理视图**：`crossSiteSafetyOverview` 供治理人员比较跨站安全事件的复现与处置；患者信号存档引用仅在授权的站点可见，其余屏蔽。

## 角色

| 角色 | 权限 |
| --- | --- |
| registry_admin | 总部登记：构成、校准、模型、人群、场地、资质、方案、证据、放行、指令 |
| safety_officer | 停用构成、撤销放行、暂停资质、解除隔离、恢复批准 |
| center_lead | 本中心批次隔离与解除、本中心重连处理、紧急停止 |
| therapist | 放行查询、发起/结束会话、紧急停止 |
| governance | 跨站治理视图（按站点授权范围接触患者信号引用） |

## 代码结构

- `contracts/domain.schema.json`：领域事件信封与稳定枚举。
- `src/events.js`：事件类型、聚合类型、用途范围与角色的登记处（与 schema 同步）。
- `src/validator.js`：事件基础字段与身份配对校验。
- `src/store.js`：追加式事件存储（按聚合严格递增版本）。
- `src/state.js`：事件流折叠为读模型。
- `src/clearance.js`：放行判定纯函数。
- `src/backend.js`：命令与查询门面（授权、停止/恢复、隔离、指令、影响面、治理视图）。
- `data/sample.json`：一条中文联调样例。
- `tests/`：领域资料一致性检查与后端行为测试。

## 用法示例

```js
import { createBackend } from "./src/backend.js";

const backend = createBackend();
// …总部完成登记（站点、人群、方案、模型、构成、校准、资质、证据、放行）…

const answer = backend.checkClearance({
  device_id: "dev-01",
  operator_id: "therapist-1",
  protocol_id: "proto-1",
  scope: "routine",
});
// answer.decision: "approved" | "denied"
// answer.reasons: 拒绝原因（空数组即获准）
// answer.combination: 判定所依据的完整版本组合
```

## 本地检查

```bash
npm test
```
