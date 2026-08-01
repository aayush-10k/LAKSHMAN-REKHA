import { randomBytes } from 'node:crypto';

// Descriptions are display-only. They must never be copied into a FactSheet.
const hex = () => randomBytes(3).toString('hex');
const categories = { procure: 'PACKAGING', ads: 'ADVERTISING', content: 'CONTENT', compute: 'COMPUTE', logistics: 'LOGISTICS', subscription: 'SOFTWARE' };
const vendors = { procure: 'ven_meridian', ads: 'ven_signalworks', content: 'ven_papertrail', compute: 'ven_cloudharbor', logistics: 'ven_northstar', subscription: 'ven_pixelvault' };

export class SimulationClock {
  constructor(speed = 40_000) { this.speed = speed; this.startedAt = Date.now(); }
  elapsed() { return Math.floor((Date.now() - this.startedAt) * this.speed); }
}

export const taskKindFor = (description) => {
  const text = description.toLowerCase();
  if (/advert|campaign|impression|audience/.test(text)) return 'ads';
  if (/image|copy|content|photo|design/.test(text)) return 'content';
  if (/api|token|compute|cloud|inference/.test(text)) return 'compute';
  if (/ship|deliver|freight|cities/.test(text)) return 'logistics';
  if (/renew|subscription|monthly|tooling/.test(text)) return 'subscription';
  return 'procure';
};

const quantity = (description, fallback) => Number(description.match(/\b(\d+)\b/)?.[1] ?? fallback);
const estimate = (kind, description) => {
  const qty = quantity(description, kind === 'subscription' ? 1 : 10);
  if (kind === 'procure') return qty * 9400 + 12000;
  if (kind === 'ads') return Math.floor(qty / 1000) * 42000 || 42000;
  if (kind === 'content') return qty * 16000;
  if (kind === 'compute') return qty * 390000;
  if (kind === 'logistics') return qty * 5200;
  return 899000;
};

export const createTask = ({ description, mode }, clock = new SimulationClock()) => {
  if (typeof description !== 'string' || !description.trim()) throw new Error('description is required');
  if (!['normal', 'hallucinating', 'injected', 'compromised', 'overreach', 'colluding'].includes(mode)) throw new Error('mode is invalid');
  const kind = taskKindFor(description);
  const taskId = `tsk_${hex()}`;
  const plan = [{ lineItemId: `li_${taskId.slice(4)}_01`, vendorId: vendors[kind], categoryCode: categories[kind], estimatedAmountMinor: estimate(kind, description), description }];
  return { taskId, plan, kind, simElapsedMs: clock.elapsed() };
};
