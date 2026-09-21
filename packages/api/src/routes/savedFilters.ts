import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { authenticate } from '../middleware/auth';

/**
 * Saved views per domain.
 *
 * A saved filter is a named, replayable query object for one domain. It is
 * validated as a JSON *object* (the DB enforces that too) but deliberately not
 * over-validated: the shape of a domain filter belongs to that domain's list
 * endpoint, and re-validating it here would mean two schemas to keep in sync.
 * The list endpoint is the authority on whether a filter is usable.
 *
 * Visibility: your own filters, plus any shared one in the same domain. Only the
 * owner may rename, re-share or delete.
 */

const DOMAINS = ['jobs', 'hackathons', 'colleges'] as const;

const createSchema = z.object({
  domain: z.enum(DOMAINS),
  name: z.string().trim().min(1).max(80),
  filters: z.record(z.string(), z.unknown()).default({}),
  is_shared: z.boolean().default(false),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  is_shared: z.boolean().optional(),
});

const listQuery = z.object({
  domain: z.enum(DOMAINS).optional(),
  include_shared: z.enum(['true', 'false']).default('true'),
});

export const savedFiltersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }
    const user = req.user as { id: string };
    const sql = getDB();
    const conditions = ['(f.user_id = $1' + (parsed.data.include_shared === 'true' ? ' OR f.is_shared' : '') + ')'];
    const values: unknown[] = [user.id];
    if (parsed.data.domain) {
      values.push(parsed.data.domain);
      conditions.push(`f.domain = $${values.length}`);
    }
    const rows = await sql.unsafe(
      `SELECT f.*, u.email AS owner_email, (f.user_id = $1) AS is_mine
         FROM saved_filters f LEFT JOIN users u ON u.id = f.user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY f.domain, f.updated_at DESC`,
      values as any,
    );
    return { data: rows };
  });

  fastify.post('/', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    }
    const user = req.user as { id: string };
    const sql = getDB();
    const { domain, name, filters, is_shared } = parsed.data;
    // Saving the same name twice updates it: a rep who refines a view and saves
    // again expects that view, not a duplicate with a numbered suffix.
    const rows = await sql.unsafe(
      `INSERT INTO saved_filters (user_id, domain, name, filters, is_shared)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (user_id, domain, name)
       DO UPDATE SET filters = EXCLUDED.filters, is_shared = EXCLUDED.is_shared, updated_at = NOW()
       RETURNING *`,
      [user.id, domain, name, JSON.stringify(filters), is_shared],
    );
    return reply.status(201).send({ filter: rows[0] });
  });

  /** Record that a view was used, so the list can show recently used first. */
  fastify.post<{ Params: { id: string } }>('/:id/use', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid filter id' });
    const user = req.user as { id: string };
    const sql = getDB();
    const rows = await sql.unsafe(
      `UPDATE saved_filters f SET use_count = f.use_count + 1, last_used_at = NOW()
        WHERE f.id = $1 AND (f.user_id = $2 OR f.is_shared)
        RETURNING f.*`,
      [idParse.data, user.id],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Filter not found' });
    return { filter: rows[0] };
  });

  fastify.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    const parsed = updateSchema.safeParse(req.body || {});
    if (!idParse.success || !parsed.success) {
      return reply.status(400).send({ error: 'Invalid request' });
    }
    const user = req.user as { id: string };
    const sql = getDB();
    const { name, filters, is_shared } = parsed.data;
    const rows = await sql.unsafe(
      `UPDATE saved_filters SET
         name = COALESCE($3, name),
         filters = COALESCE($4::jsonb, filters),
         is_shared = COALESCE($5, is_shared),
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        idParse.data, user.id, name ?? null,
        filters === undefined ? null : JSON.stringify(filters),
        is_shared ?? null,
      ],
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Filter not found, or not yours to change' });
    }
    return { filter: rows[0] };
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid filter id' });
    const user = req.user as { id: string; role?: string };
    const sql = getDB();
    // An admin may clear a shared filter someone left behind.
    const rows = await sql.unsafe(
      `DELETE FROM saved_filters WHERE id = $1 AND (user_id = $2 OR $3 = 'admin') RETURNING id`,
      [idParse.data, user.id, user.role ?? 'sales_rep'],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Filter not found' });
    return { deleted: true };
  });
};
