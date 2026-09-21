import { FastifyPluginAsync } from 'fastify';
import { leadsRoutes } from './leads';
import { authRoutes } from './auth';
import { adminRoutes } from './admin';
import { webhookRoutes } from './webhooks';
import { dashboardRoutes } from './dashboard';
import { wsRoutes } from './ws';
import { companiesRoutes } from './companies';
import { contactsRoutes } from './contacts';
import { complianceRoutes } from './compliance';
import { hackathonsRoutes } from './hackathons';
import { collegesRoutes } from './colleges';
import { myLeadsRoutes } from './myLeads';
import { armiesRoutes } from './armies';
import { analyticsRoutes } from './analytics';
import { searchRoutes } from './search';
import { outreachRoutes } from './outreach';
import { savedFiltersRoutes } from './savedFilters';

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.register(authRoutes, { prefix: '/auth' });
  fastify.register(leadsRoutes, { prefix: '/leads' });
  fastify.register(adminRoutes, { prefix: '' });
  fastify.register(webhookRoutes, { prefix: '/webhooks' });
  fastify.register(dashboardRoutes, { prefix: '/dashboard' });
  fastify.register(wsRoutes, { prefix: '' });
  fastify.register(companiesRoutes, { prefix: '/companies' });
  fastify.register(contactsRoutes, { prefix: '/contacts' });
  // Intelligence domains: hackathons and colleges are their own schemas/UI, never
  // merged into the job-lead tables.
  fastify.register(hackathonsRoutes, { prefix: '/hackathons' });
  fastify.register(collegesRoutes, { prefix: '/colleges' });
  fastify.register(myLeadsRoutes, { prefix: '/my-leads' });
  fastify.register(armiesRoutes, { prefix: '/armies' });
  fastify.register(analyticsRoutes, { prefix: '/analytics' });
  fastify.register(searchRoutes, { prefix: '/search' });
  // The sendable worklist across all three domains, plus reusable saved views.
  fastify.register(outreachRoutes, { prefix: '/outreach' });
  fastify.register(savedFiltersRoutes, { prefix: '/saved-filters' });
  // Public self-service opt-out + admin right-to-erasure (compliance).
  fastify.register(complianceRoutes, { prefix: '' });
};

export default routes;
