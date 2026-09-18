# 生活垃圾称重账本

服务接收焚烧厂地磅设备上传的称重事件，并为日报提供每张票据的有效净重。事件由机构、事件号、票据号和设备序列共同描述；创建、更正、撤销及恢复记录都需要保留，业务发生时间与平台接收时间含义不同。

`src/event-store.js` 保存原始事件，`src/ledger-service.js` 解析票据当前状态，`fixtures/weighing-events.json` 提供脱敏样例。项目使用 Node.js 20 或更高版本，运行 `npm test` 可检查正常称重链路。

## 结算语义

事件按机构（`providerId`）隔离，同一票据（`ticketId`）内按 `sequence` 与 `supersedes` 构成唯一因果链；`receivedAt` 只是平台接收时间，不参与排序，因此乱序到达、整批重放、进程重启后重放都收敛到同一日报。

`ingest` 返回：

- `confirmed`：事件已链接入链；
- `deferred`（`awaiting-predecessor`）：前序事件未到达，等待补齐，期间不计入日报；
- `rejected`：附明确 `reason`（`invalid-weight`、`sequence-gap`、`circular-reference`、`duplicate-root`、`sequence-conflict`、`cross-ticket-supersedes`、`event-conflict` 等），不污染已确认数据；
- `duplicate`：同机构同事件号的相同重试，不产生新重量。

`current(ticketId[, providerId])` 返回票据状态（`active`/`revoked`/`pending`/`conflict`）、唯一有效净重与完整事件链（含等待中、被拒绝的事件及原因）。`dailyReport()`/`dailyTotal()` 只累计 `active` 票据的链头净重。
