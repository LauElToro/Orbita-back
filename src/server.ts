import { loadConfig } from './config';
import { createDeps, closeDeps } from './deps';
import { buildApp } from './app';
import { ensurePlans } from './billing/plans';
import { rebuildIndex } from './tenants/repo';

async function main() {
  const config = loadConfig();
  const deps = createDeps(config);
  await ensurePlans(deps.prisma);
  await rebuildIndex(deps.prisma, deps.redis);

  const app = await buildApp(deps, { logger: true });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  const shutdown = async () => {
    await app.close();
    await closeDeps(deps);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
