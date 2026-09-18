// 原始事件库：幂等键为 (providerId, eventId) —— 同一机构的同号事件只可能是重试，
// 不同机构各自编号、同名事件互不干扰。原始事件只追加、不修改、不删除，
// 更正/撤销/恢复的完整来龙去脉因此永久可查。
export class EventStore {
  #events = new Map(); // providerId -> Map<eventId, event>
  #byTicket = new Map(); // providerId -> Map<ticketId, Set<eventId>>

  append(event) {
    const provider = event.providerId;
    if (!this.#events.has(provider)) {
      this.#events.set(provider, new Map());
      this.#byTicket.set(provider, new Map());
    }
    const events = this.#events.get(provider);
    if (events.has(event.eventId)) return false; // 同机构同号：重试或冲突，由调用方判定
    events.set(event.eventId, structuredClone(event));

    const tickets = this.#byTicket.get(provider);
    if (!tickets.has(event.ticketId)) tickets.set(event.ticketId, new Set());
    tickets.get(event.ticketId).add(event.eventId);
    return true;
  }

  get(providerId, eventId) {
    const e = this.#events.get(providerId)?.get(eventId);
    return e ? structuredClone(e) : null;
  }

  all() {
    return [...this.#events.values()].flatMap(m => [...m.values()]).map(e => structuredClone(e));
  }

  ticketEvents(providerId, ticketId) {
    const ids = this.#byTicket.get(providerId)?.get(ticketId);
    const events = this.#events.get(providerId);
    return ids ? [...ids].map(id => structuredClone(events.get(id))) : [];
  }
}
