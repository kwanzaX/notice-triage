// Impact assessment for exchange / venue notices.
// Deterministic rules first: they are cheap, testable and explainable. An LLM can refine
// the result (see llm.mjs), but the rules are the floor the system never drops below.

const RULES = [
  {
    category: 'trading_hours',
    pattern: /\b(trading hours|session (times?|hours)|opening auction|closing auction|market (open|close)s? at|early close|half[- ]day)\b/i,
    systems: ['order-routing', 'scheduler', 'market-data'],
    action: 'Update session calendars and order-routing schedules before the effective date.',
    impact: 'high',
  },
  {
    category: 'holiday',
    pattern: /\b(holiday|market (will be )?closed|no trading)\b/i,
    systems: ['scheduler', 'settlement'],
    action: 'Add the closure to the trading calendar and shift settlement dates.',
    impact: 'medium',
  },
  {
    category: 'symbol_change',
    pattern: /\b(symbol|ticker|isin)\b.{0,40}\b(change|rename|new|replac)/i,
    systems: ['reference-data', 'order-routing', 'risk'],
    action: 'Map the old identifier to the new one in reference data and open positions.',
    impact: 'high',
  },
  {
    category: 'fee_change',
    pattern: /\b(fee|fees|tariff|pricing|rebate|commission)s?\b.{0,40}\b(change|increase|decrease|new|update|revis)/i,
    systems: ['billing', 'reconciliation'],
    action: 'Update fee schedules and re-run reconciliation for the period after the effective date.',
    impact: 'medium',
  },
  {
    category: 'connectivity',
    pattern: /\b(api|fix (protocol|session)|endpoint|gateway|certificate|ip (address|range)|connectivity|deprecat|tls)\b/i,
    systems: ['connectivity', 'order-routing'],
    action: 'Test the new endpoint or protocol version in UAT and plan the cut-over.',
    impact: 'high',
  },
  {
    category: 'risk_parameters',
    pattern: /\b(margin|collateral|haircut|price band|circuit breaker|tick size|lot size|position limit)s?\b/i,
    systems: ['risk', 'order-validation'],
    action: 'Update risk parameters and pre-trade validation limits.',
    impact: 'high',
  },
];

const RANK = { low: 0, medium: 1, high: 2 };

/**
 * @param {{ title: string, body: string, effectiveDate?: string }} notice
 * @param {{ now?: Date }} [opts]
 * @returns {{ impact: 'low'|'medium'|'high', categories: string[], affectedSystems: string[], actions: string[], urgent: boolean, source: 'rules' }}
 */
export function assess(notice, { now = new Date() } = {}) {
  const text = `${notice.title}\n${notice.body}`;
  const hits = RULES.filter((r) => r.pattern.test(text));

  let impact = hits.reduce((max, r) => (RANK[r.impact] > RANK[max] ? r.impact : max), 'low');
  const days = daysUntil(notice.effectiveDate, now);
  // Anything that takes effect within 3 days is urgent; a medium change that close is treated as high.
  const urgent = days !== null && days <= 3;
  if (urgent && impact === 'medium') impact = 'high';

  return {
    impact,
    categories: hits.map((r) => r.category),
    affectedSystems: [...new Set(hits.flatMap((r) => r.systems))].sort(),
    actions: hits.map((r) => r.action),
    urgent,
    daysUntilEffective: days,
    source: 'rules',
  };
}

function daysUntil(dateStr, now) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

/** Validates an incoming notice; returns a list of problems (empty when valid). */
export function validateNotice(n) {
  const errors = [];
  if (!n || typeof n !== 'object') return ['body must be a JSON object'];
  if (typeof n.id !== 'string' || !/^[\w.:-]{1,128}$/.test(n.id)) errors.push('id: 1-128 chars of letters, digits, . : _ -');
  if (typeof n.venue !== 'string' || !n.venue.trim()) errors.push('venue: required');
  if (typeof n.title !== 'string' || !n.title.trim()) errors.push('title: required');
  if (typeof n.body !== 'string' || !n.body.trim()) errors.push('body: required');
  if (n.body && n.body.length > 100_000) errors.push('body: at most 100,000 characters');
  if (n.effectiveDate !== undefined && Number.isNaN(Date.parse(n.effectiveDate))) errors.push('effectiveDate: must be an ISO date');
  return errors;
}
