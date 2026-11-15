import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}
