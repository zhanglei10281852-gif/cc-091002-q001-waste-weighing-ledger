import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/event-store.js';
import { LedgerService } from '../src/ledger-service.js';

const setup=()=>new LedgerService(new EventStore());
const created=(over={})=>({providerId:'PLANT-1',eventId:'E-1',ticketId:'T-1',sequence:1,action:'created',grossKg:12800,tareKg:5400,occurredAt:'2026-09-10T08:00:00+08:00',receivedAt:'2026-09-10T08:00:02+08:00',...over});
const follow=(over={})=>({providerId:'PLANT-1',eventId:'E-2',ticketId:'T-1',sequence:2,action:'corrected',supersedes:'E-1',grossKg:13000,tareKg:5400,occurredAt:'2026-09-10T08:10:00+08:00',receivedAt:'2026-09-10T08:10:02+08:00',...over});

test('乱序的撤销与补传按票据序列收敛，被撤销票据不入日报',()=>{
  const service=setup();
  // 撤销先到（接收时间早），离线补传的创建后到（接收时间晚）
  const revoked=follow({action:'revoked',receivedAt:'2026-09-10T08:05:00+08:00'});
  delete revoked.grossKg; delete revoked.tareKg;
  const lateCreated=created({receivedAt:'2026-09-10T08:06:00+08:00'});
  assert.deepEqual(service.ingest(revoked),{status:'deferred',reason:'awaiting-predecessor'});
  assert.equal(service.dailyTotal(),0,'未知前序不能提前入账');
  assert.equal(service.current('T-1').state,'pending');
  assert.deepEqual(service.ingest(lateCreated),{status:'confirmed'});
  const view=service.current('T-1');
  assert.equal(view.state,'revoked');
  assert.equal(view.netKg,null);
  assert.deepEqual(view.chain.map(e=>e.eventId),['E-1','E-2'],'完整事件链保留更正来龙去脉');
  assert.equal(service.dailyTotal(),0,'被撤销的票据不得计入日报');
});

test('乱序的更正在创建到达后收敛为唯一有效净重',()=>{
  const service=setup();
  assert.deepEqual(service.ingest(follow()),{status:'deferred',reason:'awaiting-predecessor'});
  assert.equal(service.dailyTotal(),0);
  assert.deepEqual(service.ingest(created()),{status:'confirmed'});
  const view=service.current('T-1');
  assert.equal(view.state,'active');
  assert.equal(view.netKg,7600);
  assert.equal(view.headEventId,'E-2');
  assert.deepEqual(view.chain.map(e=>e.action),['created','corrected']);
  assert.equal(service.dailyTotal(),7600);
});

test('撤销后恢复按序列重新生效',()=>{
  const service=setup();
  service.ingest(created());
  const revoked=follow({action:'revoked'}); delete revoked.grossKg; delete revoked.tareKg;
  service.ingest(revoked);
  assert.equal(service.current('T-1').state,'revoked');
  assert.equal(service.dailyTotal(),0);
  const restored=follow({eventId:'E-3',sequence:3,action:'restored',supersedes:'E-2',grossKg:12800,tareKg:5400});
  assert.deepEqual(service.ingest(restored),{status:'confirmed'});
  const view=service.current('T-1');
  assert.equal(view.state,'active');
  assert.equal(view.netKg,7400);
  assert.deepEqual(view.chain.map(e=>e.action),['created','revoked','restored']);
  assert.equal(service.dailyTotal(),7400);
});

test('同机构重复回调与整批重放不产生新重量',()=>{
  const service=setup();
  const batch=[created(),follow()];
  for(const e of batch) service.ingest(e);
  assert.equal(service.dailyTotal(),7600);
  // 重复回调：平台接收时间不同，设备侧内容相同
  assert.deepEqual(service.ingest(created({receivedAt:'2026-09-10T09:00:00+08:00'})),{status:'duplicate'});
  assert.deepEqual(service.ingest(follow({receivedAt:'2026-09-10T09:00:01+08:00'})),{status:'duplicate'});
  assert.equal(service.dailyTotal(),7600,'重复回调不得重复累计净重');
  // 整批重放
  for(const e of batch) assert.equal(service.ingest(e).status,'duplicate');
  assert.equal(service.dailyTotal(),7600);
});

test('任意顺序重放与进程重启后重建收敛到同一日报',()=>{
  const batch=[
    created(),
    follow(),
    follow({eventId:'E-3',sequence:3,action:'revoked',supersedes:'E-2',grossKg:undefined,tareKg:undefined}),
    created({eventId:'F-1',ticketId:'T-2',grossKg:9000,tareKg:4000}),
    follow({eventId:'F-2',ticketId:'T-2',supersedes:'F-1',grossKg:9500,tareKg:4000}),
  ].map(({grossKg,tareKg,...e})=>grossKg===undefined?e:{...e,grossKg,tareKg});
  const forward=setup();
  for(const e of batch) forward.ingest(e);
  // 模拟重启：全新空库，按打乱的批次重放
  const shuffled=setup();
  for(const e of [...batch].reverse()) shuffled.ingest(e);
  assert.equal(shuffled.dailyTotal(),forward.dailyTotal());
  assert.equal(forward.dailyTotal(),5500,'T-1 已撤销，仅 T-2 的 5500 入账');
  assert.deepEqual(shuffled.current('T-1'),forward.current('T-1'));
  assert.deepEqual(shuffled.current('T-2'),forward.current('T-2'));
  assert.deepEqual(shuffled.dailyReport(),forward.dailyReport());
});

test('同机构同事件号但内容冲突被拒绝且不产生新重量',()=>{
  const service=setup();
  service.ingest(created());
  assert.deepEqual(service.ingest(created({grossKg:13000})),{status:'rejected',reason:'event-conflict'});
  assert.equal(service.dailyTotal(),7400);
  assert.deepEqual(service.current('T-1').chain.map(e=>e.eventId),['E-1']);
});

test('不同机构的同名事件与票据互不干扰',()=>{
  const service=setup();
  service.ingest(created());
  const other=created({providerId:'PLANT-2',grossKg:10000,tareKg:4000});
  assert.deepEqual(service.ingest(other),{status:'confirmed'},'同名 E-1 不应被误判为重复');
  assert.equal(service.dailyTotal(),13400);
  const ambiguous=service.current('T-1');
  assert.equal(ambiguous.state,'conflict');
  assert.equal(ambiguous.reason,'ambiguous-provider');
  assert.deepEqual(ambiguous.providers,['PLANT-1','PLANT-2']);
  assert.equal(service.current('T-1','PLANT-2').netKg,6000);
  // 机构 2 的撤销只影响本机构票据
  const revoked=follow({providerId:'PLANT-2',action:'revoked'}); delete revoked.grossKg; delete revoked.tareKg;
  service.ingest(revoked);
  assert.equal(service.current('T-1','PLANT-2').state,'revoked');
  assert.equal(service.current('T-1','PLANT-1').netKg,7400);
  assert.equal(service.dailyTotal(),7400);
});

test('跳号被拒绝并给出明确原因，已确认数据不受污染',()=>{
  const service=setup();
  service.ingest(created());
  const gap=follow({eventId:'E-3',sequence:3});
  assert.deepEqual(service.ingest(gap),{status:'rejected',reason:'sequence-gap'});
  assert.equal(service.dailyTotal(),7400,'跳号事件不得入账');
  const view=service.current('T-1');
  assert.deepEqual(view.chain.map(e=>e.eventId),['E-1']);
  assert.deepEqual(view.rejected,[{eventId:'E-3',sequence:3,action:'corrected',supersedes:'E-1',reason:'sequence-gap'}]);
  // 补齐正确序号后链继续延伸，跳号事件保持拒绝
  assert.deepEqual(service.ingest(follow()),{status:'confirmed'});
  assert.equal(service.dailyTotal(),7600);
  assert.deepEqual(service.current('T-1').rejected.map(e=>e.reason),['sequence-gap']);
});

test('循环引用被拒绝并给出明确原因',()=>{
  const service=setup();
  service.ingest(created());
  // 自引用
  const self=follow({supersedes:'E-2'});
  assert.deepEqual(service.ingest(self),{status:'rejected',reason:'circular-reference'});
  // 互相引用：先到者等待，成环者被拒
  const x=follow({eventId:'E-4',sequence:4,supersedes:'E-5'});
  const y=follow({eventId:'E-5',sequence:5,supersedes:'E-4'});
  assert.deepEqual(service.ingest(x),{status:'deferred',reason:'awaiting-predecessor'});
  assert.deepEqual(service.ingest(y),{status:'rejected',reason:'circular-reference'});
  const view=service.current('T-1');
  assert.equal(view.netKg,7400,'循环引用不得污染已确认数据');
  assert.deepEqual(view.rejected.map(e=>[e.eventId,e.reason]),[['E-2','circular-reference'],['E-4','circular-reference'],['E-5','circular-reference']]);
  assert.equal(service.dailyTotal(),7400);
});

test('同序号分叉被拒绝，链收敛到分叉前的唯一有效净重',()=>{
  const service=setup();
  service.ingest(created());
  service.ingest(follow());
  const fork=follow({eventId:'E-3',action:'revoked'}); delete fork.grossKg; delete fork.tareKg;
  assert.deepEqual(service.ingest(fork),{status:'rejected',reason:'sequence-conflict'});
  const view=service.current('T-1');
  assert.equal(view.state,'active');
  assert.equal(view.netKg,7400,'分叉后只有分叉前的链头有效');
  assert.equal(view.headEventId,'E-1');
  assert.deepEqual(view.rejected.map(e=>e.reason),['sequence-conflict','sequence-conflict']);
  assert.equal(service.dailyTotal(),7400);
});

test('同一票据的重复创建被拒绝，票据标记为冲突且不入账',()=>{
  const service=setup();
  service.ingest(created());
  assert.deepEqual(service.ingest(created({eventId:'E-9',grossKg:13000})),{status:'rejected',reason:'duplicate-root'});
  const view=service.current('T-1');
  assert.equal(view.state,'conflict');
  assert.equal(view.netKg,null);
  assert.equal(service.dailyTotal(),0,'冲突票据不得计入日报');
});

test('非法重量被拒绝，撤销类事件不强制携带重量',()=>{
  const service=setup();
  assert.deepEqual(service.ingest(created({grossKg:5000,tareKg:5400})),{status:'rejected',reason:'invalid-weight'});
  assert.deepEqual(service.ingest(created({grossKg:Number.NaN})),{status:'rejected',reason:'invalid-weight'});
  assert.equal(service.current('T-1'),null);
  assert.equal(service.dailyTotal(),0);
  service.ingest(created());
  const revoked=follow({action:'revoked'}); delete revoked.grossKg; delete revoked.tareKg;
  assert.deepEqual(service.ingest(revoked),{status:'confirmed'});
  assert.equal(service.current('T-1').state,'revoked');
});

test('缺失前序的票据保持等待，日报只汇总有效票据',()=>{
  const service=setup();
  service.ingest(created());
  const orphan=follow({eventId:'G-2',ticketId:'T-9',supersedes:'G-1'});
  assert.deepEqual(service.ingest(orphan),{status:'deferred',reason:'awaiting-predecessor'});
  const report=service.dailyReport();
  assert.equal(report.totalNetKg,7400);
  assert.deepEqual(report.tickets.map(t=>[t.ticketId,t.state]),[['T-1','active'],['T-9','pending']]);
  assert.equal(service.current('T-9').pending[0].reason,'awaiting-predecessor');
});
