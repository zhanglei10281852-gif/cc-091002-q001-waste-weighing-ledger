export const actions = ['created', 'corrected', 'revoked', 'restored'];
export const dispositions = ['confirmed', 'deferred', 'rejected'];

// 合法重量：毛重、皮重均为有限数且毛重不小于皮重
export const validWeight = event =>
  Number.isFinite(event.grossKg) &&
  Number.isFinite(event.tareKg) &&
  event.grossKg >= event.tareKg;

const requiredStrings = ['providerId', 'eventId', 'ticketId'];

// 结构校验：与链路无关的硬性要求，不通过的事件不会进入事件库
export function validateShape(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'malformed-event';
  for (const field of requiredStrings) {
    if (typeof event[field] !== 'string' || event[field].trim() === '') return `missing-${field}`;
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) return 'invalid-sequence';
  if (!actions.includes(event.action)) return 'unknown-action';
  for (const field of ['occurredAt', 'receivedAt']) {
    if (typeof event[field] !== 'string' || Number.isNaN(Date.parse(event[field]))) return `invalid-${field}`;
  }
  if (
    event.supersedes !== undefined &&
    event.supersedes !== null &&
    typeof event.supersedes !== 'string'
  ) {
    return 'invalid-supersedes';
  }
  const carriesWeight = event.grossKg !== undefined || event.tareKg !== undefined;
  // created/corrected 必须携带合法重量；revoked/restored 可省略重量，
  // 一旦携带则同样必须合法（restored 携带时以其载荷为准）
  if ((event.action === 'created' || event.action === 'corrected' || carriesWeight) && !validWeight(event)) {
    return 'invalid-weight';
  }
  return null;
}

// 重试判定只比较设备侧业务字段；receivedAt 是平台接收时间，重传时必然不同，不参与幂等
export const businessFields = [
  'providerId', 'eventId', 'ticketId', 'sequence', 'action', 'supersedes',
  'grossKg', 'tareKg', 'occurredAt',
];

export function sameBusinessPayload(a, b) {
  return businessFields.every(f => (a[f] ?? null) === (b[f] ?? null));
}

// 链路上允许的动作转移：活动态（创建/更正/恢复）之后可更正或撤销，撤销之后只能恢复
export const allowedTransitions = {
  created: ['corrected', 'revoked'],
  corrected: ['corrected', 'revoked'],
  restored: ['corrected', 'revoked'],
  revoked: ['restored'],
};
