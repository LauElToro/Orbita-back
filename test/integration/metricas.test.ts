import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revisarVencimientos } from '../../src/billing/service';
import { alta, createTestEnv, registrarCliente, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('métricas del negocio', () => {
  it('calcula clientes, MRR, cobranza, mensajes, embudo y alertas', async () => {
    await alta(env);
    await alta(env, {
      clientId: 'bar-sur',
      nombre: 'Bar Sur',
      planId: 'mensajes',
      medio: 'mercadopago',
      canales: [{ tipo: 'instagram', endpointId: 'ig-bar', etiqueta: 'IG' }],
    });
    await registrarCliente(env);
    await env.app.inject({ method: 'POST', url: '/clientes/pizzeria-norte/transferencia', headers: env.auth() });
    await env.app.inject({
      method: 'POST',
      url: '/publico/contacto',
      payload: {
        nombre: 'Laura',
        email: 'l@f.com',
        empresa: 'Ferre',
        rubro: 'Ferretería',
        necesidad: 'Necesito un bot de stock',
        aceptaPrivacidad: true,
      },
    });

    await env.deps.prisma.usage.createMany({
      data: [
        { tenantId: 'pizzeria-norte', periodo: 'dia:2026-11-14', count: 30 },
        { tenantId: 'pizzeria-norte', periodo: 'dia:2026-11-10', count: 5 },
        { tenantId: 'bar-sur', periodo: 'dia:2026-11-14', count: 12 },
        { tenantId: 'pizzeria-norte', periodo: 'mes:2026-11-14', count: 3_500 },
        { tenantId: 'bar-sur', periodo: 'mes:2026-11-14', count: 100 },
      ],
    });

    const res = await env.app.inject({ method: 'GET', url: '/admin/metricas', headers: env.auth() });
    expect(res.statusCode).toBe(200);
    const m = res.json();

    expect(m.clientes).toMatchObject({ total: 3, activos: 2, enOnboarding: 1, porPlan: { turnos: 1, mensajes: 1 } });
    expect(m.ingresos).toMatchObject({ mrr: 80_000, arpu: 80_000, mrrEnRiesgo: 42_000, cobrado30d: 80_000, porAcreditar: 0 });
    expect(m.ingresos.porMes).toHaveLength(6);
    expect(m.ingresos.porMes.at(-1)).toEqual({ mes: '2026-11', total: 80_000 });
    expect(m.cobranza).toEqual({ al_dia: 1, pendiente: 1 });
    expect(m.mensajes).toMatchObject({ hoy: 42, ultimos30: 47 });
    expect(m.mensajes.serie).toHaveLength(30);
    expect(m.embudo).toMatchObject({ registros30d: 1, enOnboarding: 1, onboardingSinPago: 1, activados30d: 0 });
    expect(m.tickets).toMatchObject({ porEstado: { nuevo: 1 }, conversion: 0, arrepentimientosAbiertos: 0 });
    expect(m.alertas.cercaDelTope).toEqual([
      { id: 'pizzeria-norte', nombre: 'Pizzería Norte', usado: 3_500, tope: 4_000, pct: 88 },
    ]);
    expect(m.alertas.proximosVencimientos).toEqual([expect.objectContaining({ id: 'bar-sur', nombre: 'Bar Sur' })]);

    env.clock.now = new Date('2026-11-23T15:00:00Z');
    await revisarVencimientos(env.deps);
    const despues = (await env.app.inject({ method: 'GET', url: '/admin/metricas', headers: env.auth() })).json();
    expect(despues.clientes.pausadosImpago).toBe(1);
  });

  it('funciona sin clientes', async () => {
    const m = (await env.app.inject({ method: 'GET', url: '/admin/metricas', headers: env.auth() })).json();
    expect(m.clientes.total).toBe(0);
    expect(m.ingresos.mrr).toBe(0);
  });
});
