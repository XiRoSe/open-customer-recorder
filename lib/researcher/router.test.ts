import { describe, it, expect } from 'vitest';
import { validatePlan, heuristicPlan, PLAN_SCHEMA } from './router';
import { titleFromQuestion } from './threads';
import { templateAnswer, followupsFor } from './composer';
import type { ResearchPlan } from './types';

describe('researcher router', () => {
  describe('validatePlan', () => {
    it('accepts a well-formed plan', () => {
      const plan = validatePlan({
        intent: 'sessions', from_history: false,
        steps: [{ tool: 'query_sessions', args: { range: '24h', device: 'mobile' } }],
        tag_draft: null,
      });
      expect(plan).not.toBeNull();
      expect(plan!.steps).toHaveLength(1);
      expect(plan!.steps[0].tool).toBe('query_sessions');
    });

    it('drops unknown tools and clamps to 3 steps', () => {
      const plan = validatePlan({
        intent: 'overview', from_history: false,
        steps: [
          { tool: 'drop_all_tables', args: {} },
          { tool: 'get_timeline', args: {} },
          { tool: 'query_sessions', args: {} },
          { tool: 'query_visitors', args: {} },
          { tool: 'get_clusters', args: {} },
        ],
        tag_draft: null,
      });
      expect(plan!.steps.map((s) => s.tool)).toEqual(['get_timeline', 'query_sessions']);
    });

    it('never-dead-end: an empty plan gets the overview floor', () => {
      const plan = validatePlan({ intent: 'overview', from_history: false, steps: [], tag_draft: null });
      expect(plan!.steps).toHaveLength(1);
      expect(plan!.steps[0].tool).toBe('overview_snapshot');
    });

    it('a from_history plan may run zero tools', () => {
      const plan = validatePlan({ intent: 'followup', from_history: true, steps: [], tag_draft: null });
      expect(plan!.fromHistory).toBe(true);
      expect(plan!.steps).toHaveLength(0);
    });

    it('validates tag drafts and rejects malformed ones', () => {
      const good = validatePlan({
        intent: 'tag', from_history: false,
        steps: [{ tool: 'preview_tag_rule', args: { kind: 'url_contains', value: 'pricing' } }],
        tag_draft: { name: 'Pricing visitors', kind: 'url_contains', value: 'pricing', color: 'blue' },
      });
      expect(good!.tagDraft?.name).toBe('Pricing visitors');
      const bad = validatePlan({
        intent: 'tag', from_history: false, steps: [],
        tag_draft: { name: '', kind: 'delete_everything', value: '' },
      });
      expect(bad!.tagDraft).toBeNull();
    });

    it('rejects non-object garbage', () => {
      expect(validatePlan(null)).toBeNull();
      expect(validatePlan('overview')).toBeNull();
    });
  });

  describe('heuristicPlan (no-LLM fallback)', () => {
    const cases: [string, string, string][] = [
      ['how are we doing this week?', 'overview', 'overview_snapshot'],
      ['show me frustrated mobile sessions from today', 'sessions', 'query_sessions'],
      ['where does our traffic come from?', 'timeline', 'get_timeline'],
      ['who are our most engaged users?', 'visitors', 'query_visitors'],
      ['what segments do we have?', 'clusters', 'get_clusters'],
      ['tag everyone who visited "pricing"', 'tag', 'preview_tag_rule'],
    ];
    it.each(cases)('%s → %s/%s', (q, intent, tool) => {
      const plan = heuristicPlan(q);
      expect(plan.intent).toBe(intent);
      expect(plan.steps[0]?.tool).toBe(tool);
    });

    it('parses ranges and filters from wording', () => {
      const plan = heuristicPlan('show me frustrated mobile sessions from today');
      expect(plan.steps[0].args).toMatchObject({ range: '24h', device: 'mobile', frustratedOnly: true });
    });

    it('always produces at least one step (never dead-ends)', () => {
      for (const q of ['what is the meaning of life?', 'revenue last quarter?', 'asdfgh']) {
        expect(heuristicPlan(q).steps.length).toBeGreaterThan(0);
      }
    });
  });

  it('PLAN_SCHEMA stays grammar-friendly (no patterns/refs)', () => {
    const s = JSON.stringify(PLAN_SCHEMA);
    expect(s).not.toContain('$ref');
    expect(s).not.toContain('pattern');
  });

  describe('thread titles', () => {
    it('trims to a few words', () => {
      expect(titleFromQuestion('Why did mobile friction double on /login this week??')).toBe('Why did mobile friction double on');
      expect(titleFromQuestion('   ')).toBe('New research');
    });
  });

  describe('composer floors', () => {
    const plan: ResearchPlan = { intent: 'overview', fromHistory: false, steps: [], tagDraft: null };
    it('templateAnswer surfaces key numbers without an LLM', () => {
      const text = templateAnswer(plan, [{
        facts: { sessions: 42, engaged: 7, frustrated: 3 },
        blocks: [], citation: { label: 'Overview', detail: 'x', href: null }, caveat: null,
      }]);
      expect(text).toContain('42 sessions');
      expect(text).toContain('7 engaged');
    });
    it('followups always offers up to 3 grounded chips', () => {
      const chips = followupsFor(plan, []);
      expect(chips.length).toBeGreaterThan(0);
      expect(chips.length).toBeLessThanOrEqual(3);
    });
  });
});
