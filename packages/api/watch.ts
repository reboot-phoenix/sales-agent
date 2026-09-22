import buildServer from './src/server';
import { connectDB, closeDB } from './src/utils/db';
import { connectRedis, closeRedis } from './src/utils/redis';

async function main() {
  await connectDB();
  await connectRedis();

  const app = await buildServer();

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  app.log.info(`Server starting on ${host}:${port}`);

  await app.listen({ port, host });

  // Graceful shutdown (master-prompt §9): stop accepting, finish in-flight,
  // then close dependencies in reverse order of creation. app.close() stops
  // the listener and lets in-flight handlers settle; closing the connections
  // afterwards prevents dangling-pool errors during exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // second signal = the operator's impatience, not a bug
    shuttingDown = true;
    app.log.info(`${signal} received, closing gracefully`);
    try {
      await app.close();
      await Promise.all([closeDB(), closeRedis()]);
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };
  // SIGINT must be handled alongside SIGTERM: `docker stop` sends SIGTERM, but
  // Ctrl-C in a VM terminal (and some init systems) delivers SIGINT — without
  // this handler the process dies on the default handler and skips DB/Redis
  // cleanup, leaving connection warnings and in-flight requests aborted.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
