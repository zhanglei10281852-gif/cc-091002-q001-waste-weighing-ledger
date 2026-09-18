import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/event-store.js';
import { LedgerService } from '../src/ledger-service.js';

let seq = 0;
const ts = () => new Date(Date.UTC(2026, 8, 10, 0, seq++)).toISOString();

function event(over = {}) {
  return {
    providerId: 'P1',
    eventId: `E${seq}`,
    ticketId: 'T1',
    sequence: 1,
    action: 'created',
    grossKg: 10000,
    tareKg: 4000,
    occurredAt: ts(),
    receivedAt: ts(),
    ...over,
  };
}

function newService() {
  return new LedgerService(new EventStore());
}

test('正常创建：唯一净重并入日报', () => {
  const s = newService();
  assert.equal(s.ingest(event({ grossKg: 12800, tareKg: 5400 })).status, 'confirmed');
  assert.equal(s.current('T1').netKg, 7400);
  assert.equal(s.dailyTotal(), 7400);
});

test('更正与撤销按 receivedAt 乱序到达，仍按设备序列收敛', () => {
  const s = newService();
  const created = event({ eventId: 'E1', sequence: 1, action: 'created', grossKg: 12800, tareKg: 5400, receivedAt: '2026-09-10T08:00:05Z' });
  const revoked = event({ eventId: 'E3', ticketId: 'T1', sequence: 3, action: 'revoked', supersedes: 'E2', receivedAt: '2026-09-10T08:00:01Z' });
  const corrected = event({ eventId: 'E2', sequence: 2, action: 'corrected', grossKg: 12000, tareKg: 5400, supersedes: 'E1', receivedAt: '2026-09-10T08:00:03Z' });
  // 撤销最先到、创建最后到
  assert.equal(s.ingest(revoked).status, 'deferred');
  assert.equal(s.ingest(corrected).status, 'deferred');
  assert.equal(s.dailyTotal(), 0, '前序未知不得提前入账');
  assert.equal(s.ingest(created).status, 'confirmed');
  // 全部到齐后票据处于已撤销，日报不采用被撤销的毛重
  assert.equal(s.current('T1'), null);
  assert.equal(s.dailyTotal(), 0);
});

test('撤销后恢复：净重只计一次，恢复可带新重量', () => {
  const s = newService();
  s.ingest(event({ eventId: 'E1', sequence: 1, grossKg: 12800, tareKg: 5400 }));
  s.ingest(event({ eventId: 'E2', sequence: 2, action: 'corrected', grossKg: 12000, tareKg: 5400, supersedes: 'E1' }));
  s.ingest(event({ eventId: 'E3', sequence: 3, action: 'revoked', supersedes: 'E2' }));
  assert.equal(s.dailyTotal(), 0);
  s.ingest(event({ eventId: 'E4', sequence: 4, action: 'restored', grossKg: undefined, tareKg: undefined, supersedes: 'E3' }));
  assert.equal(s.current('T1').netKg, 6600, '未带重量时恢复撤销前的有效净重');
  assert.equal(s.dailyTotal(), 6600, '重复回调不会累计两次');
  // 恢复时携带新重量以载荷为准
  const s2 = newService();
  s2.ingest(event({ eventId: 'E1', sequence: 1, grossKg: 12800, tareKg: 5400 }));
  s2.ingest(event({ eventId: 'E2', sequence: 2, action: 'revoked', supersedes: 'E1' }));
  s2.ingest(event({ eventId: 'E3', sequence: 3, action: 'restored', grossKg: 13000, tareKg: 5000, supersedes: 'E2' }));
  assert.equal(s2.current('T1').netKg, 8000);
});

test('离线补传：未知前序先 deferred，前序到达后自动 confirmed', () => {
  const s = newService();
  const late = event({ eventId: 'E2', sequence: 2, action: 'corrected', grossKg: 9000, tareKg: 3000, supersedes: 'E1' });
  const r1 = s.ingest(late);
  assert.equal(r1.status, 'deferred');
  assert.equal(r1.reason, 'missing-predecessor');
  assert.equal(s.dailyTotal(), 0);
  s.ingest(event({ eventId: 'E1', sequence: 1, grossKg: 10000, tareKg: 4000 }));
  assert.equal(s.current('T1').netKg, 6000);
  assert.equal(s.dailyTotal(), 6000);
});

test('同机构重试（receivedAt 不同）返回 duplicate 且不产生新重量', () => {
  const s = newService();
  const e = event({ eventId: 'E1', grossKg: 12800, tareKg: 5400 });
  assert.equal(s.ingest(e).status, 'confirmed');
  const retry = { ...e, receivedAt: '2026-09-11T00:00:00Z' };
  assert.equal(s.ingest(retry).status, 'duplicate');
  assert.equal(s.dailyTotal(), 7400);
  assert.equal(s.ticket('P1', 'T1').chain.length, 1);
});

test('同机构同号但业务载荷冲突被拒绝', () => {
  const s = newService();
  s.ingest(event({ eventId: 'E1', grossKg: 12800, tareKg: 5400 }));
  const r = s.ingest(event({ eventId: 'E1', grossKg: 9999, tareKg: 5400, receivedAt: '2026-09-11T00:00:00Z' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'conflict-event-id');
  assert.equal(s.current('T1').netKg, 7400, '已确认数据不被污染');
});

test('不同机构的同名事件与同名票据互不干扰', () => {
  const s = newService();
  assert.equal(s.ingest(event({ providerId: 'P1', eventId: 'E1', ticketId: 'T', grossKg: 10000, tareKg: 4000 })).status, 'confirmed');
  assert.equal(s.ingest(event({ providerId: 'P2', eventId: 'E1', ticketId: 'T', grossKg: 20000, tareKg: 5000 })).status, 'confirmed');
  assert.equal(s.dailyTotal('P1'), 6000);
  assert.equal(s.dailyTotal('P2'), 15000);
  assert.equal(s.dailyTotal(), 21000);
  assert.equal(s.current('T'), null, '票据重名且跨机构时必须显式指定 providerId');
  assert.equal(s.current('T', 'P2').netKg, 15000);
});

test('循环引用返回 circular-chain 且不污染其他已确认数据', () => {
  const s = newService();
  // 另一张完全正常的票
  s.ingest(event({ ticketId: 'GOOD', eventId: 'G1', grossKg: 10000, tareKg: 4000 }));
  // 成环的三连环
  s.ingest(event({ ticketId: 'BAD', eventId: 'B1', sequence: 1, grossKg: 100, tareKg: 10, supersedes: 'B3' }));
  s.ingest(event({ ticketId: 'BAD', eventId: 'B2', sequence: 2, grossKg: 200, tareKg: 10, supersedes: 'B1' }));
  s.ingest(event({ ticketId: 'BAD', eventId: 'B3', sequence: 3, grossKg: 300, tareKg: 10, supersedes: 'B2' }));
  const view = s.ticket('P1', 'BAD');
  assert.equal(view.status, 'rejected');
  assert.ok(view.chain.every(c => c.disposition === 'rejected' && c.reason === 'circular-chain'));
  assert.equal(s.dailyTotal(), 6000, '正常票照常入账，环票重量不入账');
});

test('跳号返回 sequence-gap，后继全部不入账', () => {
  const s = newService();
  s.ingest(event({ eventId: 'E1', sequence: 1, grossKg: 10000, tareKg: 4000 }));
  const r = s.ingest(event({ eventId: 'E3', sequence: 3, action: 'corrected', grossKg: 9000, tareKg: 3000, supersedes: 'E1' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'sequence-gap');
  assert.equal(s.current('T1').netKg, 6000, '仍采用跳号前的有效重量');
  s.ingest(event({ eventId: 'E4', sequence: 4, action: 'revoked', supersedes: 'E3' }));
  assert.equal(s.current('T1').netKg, 6000, '挂在非法事件后的撤销无效');
});

test('非法动作转移被拒绝', () => {
  const s = newService();
  s.ingest(event({ eventId: 'E1', sequence: 1 }));
  const r = s.ingest(event({ eventId: 'E2', sequence: 2, action: 'restored', supersedes: 'E1' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'illegal-transition');
});

test('跨票据引用被拒绝', () => {
  const s = newService();
  s.ingest(event({ ticketId: 'T1', eventId: 'E1', sequence: 1 }));
  const r = s.ingest(event({ ticketId: 'T2', eventId: 'X1', sequence: 2, action: 'corrected', supersedes: 'E1' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'predecessor-ticket-mismatch');
});

test('同一前序分叉出两个同序号事件：两者均 ambiguous-sequence，结算停在分叉前', () => {
  const s = newService();
  s.ingest(event({ eventId: 'E1', sequence: 1, grossKg: 10000, tareKg: 4000 }));
  const a = s.ingest(event({ eventId: 'E2a', sequence: 2, action: 'corrected', grossKg: 9000, tareKg: 3000, supersedes: 'E1' }));
  const b = s.ingest(event({ eventId: 'E2b', sequence: 2, action: 'corrected', grossKg: 8000, tareKg: 2000, supersedes: 'E1' }));
  assert.equal(a.status, 'confirmed', '分叉未形成前先到的一条暂时确认');
  assert.equal(b.reason, 'ambiguous-sequence');
  const view = s.ticket('P1', 'T1');
  assert.deepEqual(view.chain.filter(c => c.reason === 'ambiguous-sequence').map(c => c.eventId).sort(), ['E2a', 'E2b']);
  assert.equal(view.netKg, 6000, '不猜测取哪一支，结算停在分叉前');
});

test('非法重量与结构错误被拒绝', () => {
  const s = newService();
  assert.equal(s.ingest(event({ grossKg: 100, tareKg: 200 })).reason, 'invalid-weight');
  assert.equal(s.ingest(event({ sequence: 0 })).reason, 'invalid-sequence');
  assert.equal(s.ingest(event({ action: 'deleted' })).reason, 'unknown-action');
  assert.equal(s.ingest(event({ providerId: '' })).reason, 'missing-providerId');
  assert.equal(s.dailyTotal(), 0);
});

test('接口可看到完整事件链与每个事件的处置', () => {
  const s = newService();
  s.ingest(event({ eventId: 'E1', sequence: 1, action: 'created', grossKg: 12800, tareKg: 5400 }));
  s.ingest(event({ eventId: 'E2', sequence: 2, action: 'corrected', grossKg: 12000, tareKg: 5400, supersedes: 'E1' }));
  s.ingest(event({ eventId: 'E3', sequence: 3, action: 'revoked', supersedes: 'E2' }));
  s.ingest(event({ eventId: 'E4', sequence: 4, action: 'restored', grossKg: undefined, tareKg: undefined, supersedes: 'E3' }));
  const view = s.ticket('P1', 'T1');
  assert.equal(view.status, 'active');
  assert.equal(view.tipEventId, 'E4');
  assert.deepEqual(view.chain.map(c => [c.sequence, c.action, c.disposition]), [
    [1, 'created', 'confirmed'],
    [2, 'corrected', 'confirmed'],
    [3, 'revoked', 'confirmed'],
    [4, 'restored', 'confirmed'],
  ]);
});

test('重放任意批次、任意顺序、重复重放，日报不变', () => {
  const mk = () => [
    event({ eventId: 'E1', ticketId: 'A', sequence: 1, grossKg: 10000, tareKg: 4000 }),
    event({ eventId: 'E2', ticketId: 'A', sequence: 2, action: 'corrected', grossKg: 9000, tareKg: 3000, supersedes: 'E1' }),
    event({ eventId: 'E3', ticketId: 'B', sequence: 1, grossKg: 8000, tareKg: 2000 }),
    event({ eventId: 'E4', ticketId: 'B', sequence: 2, action: 'revoked', supersedes: 'E3' }),
  ];
  const run = batch => {
    const s = newService();
    s.replay(batch);
    return s.dailyReport();
  };
  const batch = mk();
  const r1 = run(batch);
  const r2 = run([...batch].reverse());
  const r3 = run([...batch, ...batch]); // 重复重放
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, r3);
  assert.equal(r1.totalNetKg, 6000);
  assert.equal(r1.ticketCount, 1, '撤销票不计入');
});
