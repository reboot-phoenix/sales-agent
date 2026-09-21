import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { logAuditEvent } from '../utils/audit';
import { callWorker } from '../utils/worker';

const runSchema = z.object({
  sources: z.array(z.string()).optional(),
  run_type: z.enum(['manual', 'scheduled']).default('manual'),
});

const DOMAINS = ['jobs', 'hackathons', 'colleges'] as const;

export const armiesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  async function startArmy(domain: string, req: any, reply: any) {
    const parsed = runSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const userId = (req.user as { id: string }).id;
    const result = await callWorker(`/armies/${domain}/run`, {
      method: 'POST',
      body: { ...parsed.data, triggered_by: userId },
    });
    await logAuditEvent({
      user_id: userId,
      action: 'trigger_army',
      resource_type: 'army_run',
      resource_id: result.data?.run_id || domain,
      details: { domain, sources: parsed.data.sources || null, ok: result.ok },
    });
    return reply.status(result.ok ? 202 : 502).send(result.data);
  }

  fastify.post('/jobs/run', { preValidation: [authorize(['admin'])] }, (req, reply) =>
    startArmy('jobs', req, reply));
  fastify.post('/hackathons/run', { preValidation: [authorize(['admin'])] }, (req, reply) =>
    startArmy('hackathons', req, reply));
  fastify.post('/colleges/run', { preValidation: [authorize(['admin'])] }, (req, reply) =>
    startArmy('colleges', req, reply));

  // Run all three concurrently. Admin-gated because it can spend vendor credits
  // and hammer many sources at once.
  fastify.post('/run-all', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const parsed = runSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body' });
    const userId = (req.user as { id: string }).id;
    const result = await callWorker('/armies/run-all', {
      method: 'POST',
      body: { ...parsed.data, triggered_by: userId },
    });
    await logAuditEvent({
      user_id: userId, action: 'trigger_all_armies', resource_type: 'army_run',
      resource_id: 'all', details: { ok: result.ok, run_ids: result.data?.run_ids },
    });
    return reply.status(result.ok ? 202 : 502).send(result.data);
  });

  // Run history + progress. Available to reps too: it is operational status, not
  // business data, and hiding it made the UI look frozen during a run.
  fastify.get('/runs', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = z.object({
      domain: z.enum(DOMAINS).optional(),
      limit: z.coerce.number().min(1).max(100).default(25),
    }).safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query' });
    const qs = new URLSearchParams();
    if (parsed.data.domain) qs.set('domain', parsed.data.domain);
    qs.set('limit', String(parsed.data.limit));
    const result = await callWorker(`/armies/runs?${qs.toString()}`);
    return reply.status(result.ok ? 200 : 502).send(result.data);
  });

  fastify.get<{ Params: { id: string } }>(
    '/runs/:id',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const parsed = z.string().uuid().safeParse(req.params.id);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid run id' });
      const result = await callWorker(`/armies/runs/${parsed.data}`);
      return reply.status(result.ok ? 200 : result.status).send(result.data);
    },
  );

  fastify.get('/sources', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = z.object({ domain: z.enum(DOMAINS).optional() }).safeParse(req.query || {});
    const qs = new URLSearchParams();
    if (parsed.success && parsed.data.domain) qs.set('domain', parsed.data.domain);
    const result = await callWorker(`/armies/sources${qs.toString() ? `?${qs}` : ''}`);
    return reply.status(result.ok ? 200 : 502).send(result.data);
  });
};
