import { describe, expect, it } from 'vitest';
import { coincideBusqueda, numeroDe } from '../../src/messaging/ventanas';

const ana = {
  nombre: 'Ana',
  ultimo: 'Dale, espero',
  numero: '+5491111110001',
  codigo: '11111111-1111-4111-8111-111111111111',
  id: 'cuid-ana',
};

describe('búsqueda de charlas', () => {
  it('muestra el teléfono de WhatsApp y deja el id de Instagram', () => {
    expect(numeroDe({ canal: 'whatsapp', destino: '5491111110001', subscriberId: '5491111110001' })).toBe('+5491111110001');
    expect(numeroDe({ canal: 'whatsapp', destino: '+54 9 11 1111-0001', subscriberId: 'otro' })).toBe('+5491111110001');
    expect(numeroDe({ canal: 'instagram', destino: '17890011', subscriberId: '17890011' })).toBe('+17890011');
    expect(numeroDe({ canal: 'tiktok', destino: 'conv-1', subscriberId: 'tt-leo' })).toBe('tt-leo');
    expect(numeroDe({ canal: 'whatsapp', destino: '', subscriberId: '5491100000000' })).toBe('+5491100000000');
  });

  it('acepta nombre, mensaje, número con símbolos y el uuid', () => {
    expect(coincideBusqueda(ana, '')).toBe(true);
    expect(coincideBusqueda(ana, '  ana ')).toBe(true);
    expect(coincideBusqueda({ ...ana, nombre: 'José' }, 'jose')).toBe(true);
    expect(coincideBusqueda(ana, 'espero')).toBe(true);
    expect(coincideBusqueda({ ...ana, ultimo: 'Dale', corpus: 'Quiero reservar para un evento' }, 'evento')).toBe(true);
    expect(coincideBusqueda(ana, '+54 9 11 1111-0001')).toBe(true);
    expect(coincideBusqueda(ana, '0001')).toBe(true);
    expect(coincideBusqueda(ana, '11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(coincideBusqueda(ana, '11111111')).toBe(true);
    expect(coincideBusqueda(ana, 'cuid-ana')).toBe(true);
    expect(coincideBusqueda(ana, '5491999')).toBe(false);
    expect(coincideBusqueda(ana, 'zzz')).toBe(false);
  });
});
