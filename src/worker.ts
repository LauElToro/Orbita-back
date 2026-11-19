import { Worker } from 'bullmq';
import { loadConfig } from './config';
import { bullConnection, closeDeps, createDeps } from './deps';
import { QUEUE_GENERACION, QUEUE_TAREAS } from './lib/keys';
import type { JobGeneracion } from './messaging/entrada';
import { enviarRecordatorios } from './modules/recordatorios';
import { conciliarMercadoPago, revisarVencimientos } from './billing/service';
import { enviarAvisosProgramados } from './correo/campanas';
import { procesarMensaje } from './worker/procesar';

async function main() {
  const config = loadConfig();
  const deps = createDeps(config);

  const generacion = new Worker<JobGeneracion>(QUEUE_GENERACION, (job) => procesarMensaje(deps, job.data), {
    connection: bullConnection(config),
    concurrency: 10,
  });

  const tareas = new Worker(
    QUEUE_TAREAS,
    async (job) => {
      if (job.name === 'recordatorios') return { enviados: await enviarRecordatorios(deps) };
      if (job.name === 'cobros') {
        const cobros = await revisarVencimientos(deps);
        const avisos = await enviarAvisosProgramados(deps);
        return { ...cobros, avisos: avisos.enviados };
      }
      if (job.name === 'conciliar-mp') return conciliarMercadoPago(deps);
      return null;
    },
    { connection: bullConnection(config), concurrency: 1 },
  );

  await deps.colaTareas.upsertJobScheduler('recordatorios', { every: 15 * 60_000 }, { name: 'recordatorios' });
  await deps.colaTareas.upsertJobScheduler('cobros', { every: 60 * 60_000 }, { name: 'cobros' });
  await deps.colaTareas.upsertJobScheduler('conciliar-mp', { every: 15 * 60_000 }, { name: 'conciliar-mp' });

  for (const w of [generacion, tareas]) {
    w.on('failed', (job, err) => console.error(`[${w.name}] job ${job?.id} falló:`, err.message));
  }
  console.log('worker listo');

  const shutdown = async () => {
    await generacion.close();
    await tareas.close();
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
