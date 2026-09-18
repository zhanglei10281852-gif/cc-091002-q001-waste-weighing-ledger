import { validateShape, sameBusinessPayload, allowedTransitions } from './domain.js';

// 结算账本。所有结论都由设备侧因果字段推导：
//   (providerId, eventId) 决定“是不是同一个事件”（幂等）；
//   票据内 sequence 决定先后，supersedes 决定前序；
//   receivedAt 只是平台接收时间，乱序到达不影响结论。
// 每次入库都把相关票据从头重算，因此任意批次重放、进程重启后重放结果一致。
export class LedgerService {
  constructor(store) {
    this.store = store;
  }

  // 接收一个称重事件。返回：
  //   {status:'confirmed'|'deferred', reason?}  事件已入库并得到处置
  //   {status:'duplicate'}                       同机构同号重试，业务载荷一致，不产生新重量
  //   {status:'rejected', reason}                结构非法或载荷冲突，均不覆盖已存原始事件
  ingest(event) {
    const reason = validateShape(event);
    if (reason) return { status: 'rejected', reason };

    const existing = this.store.get(event.providerId, event.eventId);
    if (existing) {
      // 同机构重试：设备侧身份字段完全一致即视为同一次上传。
      // receivedAt 不参与比较——离线补传时接收时间必然不同。
      if (sameBusinessPayload(existing, event)) return { status: 'duplicate' };
      return { status: 'rejected', reason: 'conflict-event-id' };
    }

    this.store.append(event);
    const result = this.#dispositionOf(event.providerId, event.ticketId, event.eventId);
    return { status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
  }

  // 批量重放：逐个幂等接收，返回汇总。顺序无关、可重复执行。
  replay(events) {
    const summary = { received: 0, confirmed: 0, deferred: 0, duplicate: 0, rejected: 0 };
    for (const event of events) {
      const result = this.ingest(event);
      summary.received++;
      summary[result.status]++;
      if (result.status === 'rejected') {
        summary.lastRejection = { eventId: event?.eventId, reason: result.reason };
      }
    }
    return summary;
  }

  #providerEvents(providerId) {
    const byId = new Map();
    for (const e of this.store.all()) {
      if (e.providerId === providerId) byId.set(e.eventId, e);
    }
    return byId;
  }

  // 票据链路解析：对票据内全部原始事件求处置（confirmed/deferred/rejected），
  // 纯函数式重算，只依赖当前事件库内容。
  #resolveTicket(providerId, ticketId) {
    const events = this.store.ticketEvents(providerId, ticketId);
    const byTicketId = new Map(events.map(e => [e.eventId, e]));
    const byProviderId = this.#providerEvents(providerId);
    const state = new Map(); // eventId -> {status, reason}
    // 结构性终判：链分叉、多重链头。一旦认定不可被后续传播翻案
    const forced = new Map(); // eventId -> reason

    const evaluate = (e) => {
      if (forced.has(e.eventId)) return { status: 'rejected', reason: forced.get(e.eventId) };
      if (e.supersedes == null) {
        // 链头：必须是 sequence=1 的 created
        if (e.action !== 'created') return { status: 'rejected', reason: 'invalid-origin' };
        if (e.sequence !== 1) return { status: 'rejected', reason: 'root-sequence' };
        return { status: 'confirmed' };
      }

      // 前序在同一机构内按 eventId 解析：跨票据引用是设备侧错误，不能挂到本票
      const pred = byProviderId.get(e.supersedes);
      if (!pred) return { status: 'deferred', reason: 'missing-predecessor' };
      if (pred.ticketId !== ticketId) return { status: 'rejected', reason: 'predecessor-ticket-mismatch' };

      const ps = state.get(pred.eventId);
      if (!ps) return null; // 前序尚未定论（成环时会出现），下一轮再议
      if (ps.status === 'rejected') return { status: 'rejected', reason: 'predecessor-rejected' };
      if (ps.status === 'deferred') return { status: 'deferred', reason: ps.reason };

      if (e.sequence !== pred.sequence + 1) return { status: 'rejected', reason: 'sequence-gap' };
      if (!allowedTransitions[pred.action].includes(e.action)) {
        return { status: 'rejected', reason: 'illegal-transition' };
      }
      return { status: 'confirmed' };
    };

    const propagate = () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const e of events) {
          const next = evaluate(e);
          if (!next) continue;
          const prev = state.get(e.eventId);
          if (!prev || prev.status !== next.status || prev.reason !== next.reason) {
            state.set(e.eventId, next);
            changed = true;
          }
        }
      }
    };

    // 第一轮：处置沿 supersedes 链传播至不动点
    propagate();

    // 仍无定论的事件，其前序必然成环（否则沿链回溯应已收敛）。
    // 环上节点全部 rejected/circular-chain，再传播使环的下游得到 predecessor-rejected。
    const markCycles = () => {
      let found = false;
      for (const e of events) {
        if (state.has(e.eventId) || e.supersedes == null) continue;
        const path = [];
        const seen = new Map();
        let cur = e;
        while (cur && !state.has(cur.eventId) && !seen.has(cur.eventId)) {
          seen.set(cur.eventId, path.length);
          path.push(cur);
          cur = cur.supersedes == null ? null : byTicketId.get(cur.supersedes);
        }
        if (cur && !state.has(cur.eventId) && seen.has(cur.eventId)) {
          for (const node of path.slice(seen.get(cur.eventId))) {
            forced.set(node.eventId, 'circular-chain');
            state.set(node.eventId, { status: 'rejected', reason: 'circular-chain' });
            found = true;
          }
        }
      }
      return found;
    };
    if (markCycles()) propagate();

    // 同一前序下并存两个已确认后继即链路分叉（设备侧同时发了两个 seq+1），
    // 不猜测、不按接收时间挑一个：两个后继全部 rejected/ambiguous-sequence，
    // 其下游由传播得到 predecessor-rejected。
    const children = new Map();
    for (const e of events) {
      if (e.supersedes == null || state.get(e.eventId)?.status !== 'confirmed') continue;
      const pred = byTicketId.get(e.supersedes);
      if (!pred || state.get(pred.eventId)?.status !== 'confirmed') continue;
      if (!children.has(e.supersedes)) children.set(e.supersedes, []);
      children.get(e.supersedes).push(e);
    }
    for (const group of children.values()) {
      if (group.length > 1) {
        for (const e of group) forced.set(e.eventId, 'ambiguous-sequence');
      }
    }
    if (forced.size) propagate();

    // 一张票只能有一个合法链头；多个 sequence=1/created 时确定性地保留 eventId 最小者
    const roots = events
      .filter(e => e.supersedes == null && state.get(e.eventId)?.status === 'confirmed')
      .sort((a, b) => a.eventId.localeCompare(b.eventId));
    for (const extra of roots.slice(1)) forced.set(extra.eventId, 'duplicate-origin');
    if (roots.length > 1) propagate();

    return this.#buildSettlement(providerId, ticketId, events, state);
  }

  #buildSettlement(providerId, ticketId, events, state) {
    const chain = events
      .map(e => ({ event: e, state: state.get(e.eventId) }))
      .sort((a, b) => a.event.sequence - b.event.sequence || a.event.eventId.localeCompare(b.event.eventId));

    // 沿唯一确认链推导当前有效重量。
    // revoked 保留撤销前重量供 restored 使用；restored 未带重量时恢复原重量。
    let carried = null;
    let active = false;
    let tip = null;
    for (const { event: e, state: s } of chain) {
      if (s?.status !== 'confirmed') continue;
      tip = e;
      if (e.action === 'created' || e.action === 'corrected') {
        carried = { grossKg: e.grossKg, tareKg: e.tareKg };
        active = true;
      } else if (e.action === 'revoked') {
        active = false;
      } else if (e.action === 'restored') {
        if (Number.isFinite(e.grossKg) && Number.isFinite(e.tareKg)) {
          carried = { grossKg: e.grossKg, tareKg: e.tareKg };
        }
        active = true;
      }
    }

    const hasDeferred = chain.some(({ state: s }) => s?.status === 'deferred');
    let status;
    if (!tip) status = hasDeferred ? 'pending' : 'rejected';
    else status = active ? 'active' : 'revoked';

    return {
      providerId,
      ticketId,
      status,
      netKg: status === 'active' ? carried.grossKg - carried.tareKg : null,
      grossKg: status === 'active' ? carried.grossKg : null,
      tareKg: status === 'active' ? carried.tareKg : null,
      tipEventId: tip?.eventId ?? null,
      chain: chain.map(({ event: e, state: s }) => ({
        eventId: e.eventId,
        sequence: e.sequence,
        action: e.action,
        supersedes: e.supersedes ?? null,
        grossKg: Number.isFinite(e.grossKg) ? e.grossKg : null,
        tareKg: Number.isFinite(e.tareKg) ? e.tareKg : null,
        occurredAt: e.occurredAt,
        receivedAt: e.receivedAt,
        disposition: s?.status ?? 'rejected',
        ...(s?.reason ? { reason: s.reason } : {}),
      })),
    };
  }

  #dispositionOf(providerId, ticketId, eventId) {
    const settlement = this.#resolveTicket(providerId, ticketId);
    const item = settlement.chain.find(c => c.eventId === eventId);
    if (!item) return { status: 'rejected' };
    return { status: item.disposition, ...(item.reason ? { reason: item.reason } : {}) };
  }

  #resolveProvider(providerId) {
    const ticketIds = new Set(
      this.store.all().filter(e => e.providerId === providerId).map(e => e.ticketId),
    );
    return [...ticketIds].sort().map(id => this.#resolveTicket(providerId, id));
  }

  // 票据完整视图：唯一有效净重 + 完整事件链（含更正、撤销、恢复及每个事件的处置原因）。
  ticket(providerId, ticketId) {
    if (!this.store.ticketEvents(providerId, ticketId).length) return null;
    return this.#resolveTicket(providerId, ticketId);
  }

  // 兼容旧签名：只给 ticketId 时在所有机构间解析；重名票据分属不同机构时必须指明 providerId。
  current(ticketId, providerId) {
    let provider = providerId;
    if (!provider) {
      const owners = new Set(
        this.store.all().filter(e => e.ticketId === ticketId).map(e => e.providerId),
      );
      if (owners.size !== 1) return null;
      provider = [...owners][0];
    }
    const settlement = this.ticket(provider, ticketId);
    if (!settlement || settlement.status !== 'active') return null;
    return {
      ticketId,
      providerId: provider,
      netKg: settlement.netKg,
      grossKg: settlement.grossKg,
      tareKg: settlement.tareKg,
      eventId: settlement.tipEventId,
    };
  }

  tickets(providerId) {
    if (providerId) return this.#resolveProvider(providerId);
    const providers = new Set(this.store.all().map(e => e.providerId));
    return [...providers].sort().flatMap(p => this.#resolveProvider(p));
  }

  // 日报：每张票据恰好计一次当前唯一有效净重；撤销票计 0，等待票不计入。
  dailyReport(providerId) {
    const tickets = this.tickets(providerId);
    const lines = tickets
      .filter(t => t.status === 'active')
      .map(t => ({
        providerId: t.providerId,
        ticketId: t.ticketId,
        netKg: t.netKg,
        eventId: t.tipEventId,
      }));
    const totalNetKg = lines.reduce((sum, t) => sum + t.netKg, 0);
    return { totalNetKg, ticketCount: lines.length, tickets: lines };
  }

  dailyTotal(providerId) {
    return this.dailyReport(providerId).totalNetKg;
  }
}
