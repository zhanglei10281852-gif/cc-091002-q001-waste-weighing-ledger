# 生活垃圾称重账本

服务接收焚烧厂地磅设备上传的称重事件，并为日报提供每张票据的唯一有效净重。事件由机构、事件号、票据号和设备序列共同描述；创建、更正、撤销及恢复记录全部永久保留，业务发生时间（`occurredAt`）与平台接收时间（`receivedAt`）含义不同，**乱序到达不影响结算结论**。

## 因果模型

- `(providerId, eventId)` 是事件的唯一身份：同机构同号重试幂等（`receivedAt` 不参与判定），不同机构的同名事件、同名票据互不干扰。
- 票据内以 `sequence` 定先后、`supersedes` 指前序；链路必须从 `sequence=1` 的 `created` 开始逐号递增。
- 合法动作转移：`created|corrected|restored → corrected|revoked`，`revoked → restored`。
- `revoked` 使票据失效（日报计 0）；`restored` 恢复撤销前的有效重量，自带重量时以载荷为准。

## 接收处置（`ingest`）

| status | 含义 |
| --- | --- |
| `confirmed` | 事件已在确认链上 |
| `deferred`（`missing-predecessor`） | 前序未知，等待补传，期间不提前入账；前序到达后自动转确认 |
| `duplicate` | 同机构重试，不产生新重量 |
| `rejected` | 明确原因：`invalid-weight`、`conflict-event-id`、`sequence-gap`、`circular-chain`、`ambiguous-sequence`、`illegal-transition`、`predecessor-ticket-mismatch`、`invalid-origin`、`duplicate-origin` 等 |

非法事件不会污染已确认数据：被撤销、成环、跳号、分叉的重量都不会进入日报。

## 查询接口

- `ticket(providerId, ticketId)`：票据完整视图——`status`（`active`/`revoked`/`pending`/`rejected`）、唯一有效净重 `netKg`、末端事件 `tipEventId`，以及含每次更正/撤销/恢复处置原因的完整 `chain`。
- `current(ticketId, providerId?)`：当前唯一有效净重（兼容旧签名）。
- `dailyReport(providerId?)` / `dailyTotal(providerId?)`：每张票据恰好计一次净重。
- `replay(events)`：幂等批量重放，任意批次、任意顺序、重复执行或重启进程后结果一致。

`src/event-store.js` 只追加保存原始事件，`src/ledger-service.js` 每次入库后纯函数式重算票据状态，`fixtures/weighing-events.json` 提供脱敏样例。项目使用 Node.js 20 或更高版本，运行 `npm test` 检查正常链路、乱序更正/撤销/恢复、离线补传、重试幂等、跨机构隔离、循环引用与跳号等场景。
