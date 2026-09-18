import { actions, weightBearingActions, validWeight, netKgOf } from './domain.js';

const weightBearing=new Set(weightBearingActions);
const nonEmpty=value=>typeof value==='string'&&value.length>0;

// 重试比对只认设备侧字段；receivedAt 是平台接收时间，每次投递都会变，不参与比对
const payloadOf=e=>JSON.stringify({providerId:e.providerId,eventId:e.eventId,ticketId:e.ticketId,sequence:e.sequence,action:e.action,supersedes:e.supersedes??null,grossKg:e.grossKg??null,tareKg:e.tareKg??null,occurredAt:e.occurredAt??null});

const validate=event=>{
  if(!event||typeof event!=='object') return 'invalid-event';
  if(!nonEmpty(event.providerId)||!nonEmpty(event.eventId)||!nonEmpty(event.ticketId)) return 'invalid-identity';
  if(!actions.includes(event.action)) return 'invalid-action';
  if(!Number.isInteger(event.sequence)||event.sequence<1) return 'invalid-sequence';
  if(event.action==='created'){
    if(event.sequence!==1) return 'invalid-sequence';
    if(event.supersedes!=null) return 'unexpected-supersedes';
  }else{
    if(event.sequence===1) return 'invalid-sequence';
    if(!nonEmpty(event.supersedes)) return 'missing-supersedes';
  }
  if(weightBearing.has(event.action)&&!validWeight(event)) return 'invalid-weight';
  return null;
};

// 解析单个机构内全部事件的状态。只依赖 providerId/eventId/ticketId/sequence/supersedes，
// 与到达顺序和 receivedAt 无关，因此任意批次重放、进程重启后重放都收敛到同一结果。
const resolve=events=>{
  const byId=new Map(events.map(e=>[e.eventId,e]));
  const roots=new Map();
  for(const e of events) if(e.action==='created') roots.set(e.ticketId,[...(roots.get(e.ticketId)??[]),e]);

  const status=new Map();
  // 第一阶段：每张票据从唯一根沿 sequence 正向确认链；同序号分叉全部拒绝，链停在分叉前
  for(const [ticketId,ticketRoots] of roots){
    if(ticketRoots.length!==1) continue;
    let cur=ticketRoots[0];
    status.set(cur.eventId,{status:'confirmed'});
    for(;;){
      const next=events.filter(e=>e.ticketId===ticketId&&e.supersedes===cur.eventId&&e.sequence===cur.sequence+1);
      if(next.length===0) break;
      if(next.length>1){ for(const c of next) status.set(c.eventId,{status:'rejected',reason:'sequence-conflict'}); break; }
      cur=next[0];
      status.set(cur.eventId,{status:'confirmed'});
    }
  }

  // 沿 supersedes 链回溯，若回到自身即为循环引用；visited 集合保证遍历必然终止
  const reaches=(fromId,targetId)=>{ const seen=new Set(); let cur=fromId; while(cur!=null){ if(cur===targetId) return true; if(seen.has(cur)) return false; seen.add(cur); cur=byId.get(cur)?.supersedes; } return false; };

  // 第二阶段：为链外事件给出明确去向——未知前序等待，其余异常给出具体拒绝原因
  const visiting=new Set();
  const classify=e=>{
    const known=status.get(e.eventId);
    if(known) return known;
    if(visiting.has(e.eventId)) return {status:'rejected',reason:'circular-reference'};
    visiting.add(e.eventId);
    let result;
    if(e.action==='created'){
      result=roots.get(e.ticketId).length>1?{status:'rejected',reason:'duplicate-root'}:{status:'confirmed'};
    }else{
      const parent=byId.get(e.supersedes);
      if(!parent) result={status:'deferred',reason:'awaiting-predecessor'};
      else if(parent.ticketId!==e.ticketId) result={status:'rejected',reason:'cross-ticket-supersedes'};
      else if(reaches(e.supersedes,e.eventId)) result={status:'rejected',reason:'circular-reference'};
      else if(e.sequence!==parent.sequence+1) result={status:'rejected',reason:'sequence-gap'};
      else{
        const ps=classify(parent);
        result=ps.status==='confirmed'?{status:'confirmed'}:ps.status==='deferred'?{status:'deferred',reason:ps.reason}:{status:'rejected',reason:'predecessor-rejected'};
      }
    }
    visiting.delete(e.eventId);
    status.set(e.eventId,result);
    return result;
  };
  for(const e of events) classify(e);
  return status;
};

const chainEntry=e=>({eventId:e.eventId,sequence:e.sequence,action:e.action,supersedes:e.supersedes??null,grossKg:e.grossKg??null,tareKg:e.tareKg??null,netKg:weightBearing.has(e.action)?netKgOf(e):null,occurredAt:e.occurredAt??null,receivedAt:e.receivedAt??null});
const issueEntry=(e,reason)=>({eventId:e.eventId,sequence:e.sequence,action:e.action,supersedes:e.supersedes??null,reason});
const bySequenceThenId=(a,b)=>a.sequence-b.sequence||a.eventId.localeCompare(b.eventId);

const ticketView=(ticketId,providerId,events,status)=>{
  const group=events.filter(e=>e.ticketId===ticketId);
  const chain=group.filter(e=>status.get(e.eventId).status==='confirmed').sort(bySequenceThenId);
  const head=chain.at(-1);
  let state,netKg=null;
  if(!head) state=group.some(e=>status.get(e.eventId).status==='deferred')?'pending':'conflict';
  else if(head.action==='revoked') state='revoked';
  else{ state='active'; netKg=netKgOf(head); }
  return {
    ticketId,providerId,state,netKg,headEventId:head?.eventId??null,
    chain:chain.map(chainEntry),
    pending:group.filter(e=>status.get(e.eventId).status==='deferred').sort(bySequenceThenId).map(e=>issueEntry(e,status.get(e.eventId).reason)),
    rejected:group.filter(e=>status.get(e.eventId).status==='rejected').sort(bySequenceThenId).map(e=>issueEntry(e,status.get(e.eventId).reason)),
  };
};

export class LedgerService {
  constructor(store){ this.store=store; }

  ingest(event){
    const invalid=validate(event);
    if(invalid) return {status:'rejected',reason:invalid};
    const prior=this.store.get(event.providerId,event.eventId);
    if(prior) return payloadOf(prior)===payloadOf(event)?{status:'duplicate'}:{status:'rejected',reason:'event-conflict'};
    this.store.append(event);
    const own=resolve(this.store.all().filter(e=>e.providerId===event.providerId)).get(event.eventId);
    return own.status==='confirmed'?{status:'confirmed'}:{status:own.status,reason:own.reason};
  }

  current(ticketId,providerId){
    const all=this.store.all();
    const providers=[...new Set(all.filter(e=>e.ticketId===ticketId).map(e=>e.providerId))].sort();
    const candidates=providerId==null?providers:providers.filter(p=>p===providerId);
    if(candidates.length===0) return null;
    if(candidates.length>1) return {ticketId,state:'conflict',reason:'ambiguous-provider',providers:candidates,netKg:null,headEventId:null,chain:[],pending:[],rejected:[]};
    const provider=candidates[0];
    const events=all.filter(e=>e.providerId===provider);
    return ticketView(ticketId,provider,events,resolve(events));
  }

  dailyReport(){
    const all=this.store.all();
    const tickets=[];
    for(const provider of [...new Set(all.map(e=>e.providerId))].sort()){
      const events=all.filter(e=>e.providerId===provider);
      const status=resolve(events);
      for(const ticketId of [...new Set(events.map(e=>e.ticketId))].sort()){
        const view=ticketView(ticketId,provider,events,status);
        tickets.push({providerId:provider,ticketId,state:view.state,netKg:view.netKg,headEventId:view.headEventId});
      }
    }
    const totalNetKg=tickets.reduce((sum,t)=>sum+(t.state==='active'?t.netKg:0),0);
    return {totalNetKg,tickets};
  }

  dailyTotal(){ return this.dailyReport().totalNetKg; }
}
