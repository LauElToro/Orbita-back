import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config';
import { elegirPagina, RedesClient, redirectRedes, tokenInstagram, tokenTiktok } from '../../src/messaging/redes';

const cfg = {
  PUBLIC_URL: 'https://orbita.test/',
  META_APP_ID: 'app-1',
  META_APP_SECRET: 'sec',
  META_API_VERSION: 'v26.0',
  META_GRAPH_URL: 'https://graph.facebook.com',
  INSTAGRAM_GRAPH_URL: 'https://graph.instagram.com',
  TIKTOK_APP_ID: 'tt-1',
  TIKTOK_APP_SECRET: '',
} as Config;

describe('autorización de redes', () => {
  const redes = new RedesClient(cfg);

  it('abre cada red con el mismo retorno', () => {
    expect(redes.listo('facebook')).toBe(true);
    expect(redes.listo('instagram')).toBe(true);
    expect(redes.listo('tiktok')).toBe(false);
    const instagram = new URL(redes.url('instagram', 'st'));
    expect(`${instagram.origin}${instagram.pathname}`).toBe('https://www.instagram.com/oauth/authorize');
    expect(instagram.searchParams.get('redirect_uri')).toBe('https://orbita.test/redes/vuelta');
    expect(instagram.searchParams.get('enable_fb_login')).toBe('0');
    expect(instagram.searchParams.get('client_id')).toBe('app-1');
    const facebook = new URL(redes.url('facebook', 'st'));
    expect(facebook.searchParams.get('redirect_uri')).toBe(redirectRedes(cfg));
    expect(facebook.searchParams.get('scope')).toContain('instagram_manage_messages');
    const tiktok = new URL(redes.url('tiktok', 'st'));
    expect(tiktok.searchParams.get('client_key')).toBe('tt-1');
    expect(tiktok.searchParams.get('redirect_uri')).toBe('https://orbita.test/redes/vuelta');
    expect(tiktok.searchParams.get('scope')).toContain('message.list.manage');
  });

  it('elige el Instagram de la página y lee los tokens', () => {
    expect(
      elegirPagina({
        data: [
          { id: 'p1', name: 'Sin red', access_token: 't1' },
          { id: 'p2', name: 'Pelu', access_token: 'page-token', instagram_business_account: { id: '1784', username: 'luna' } },
        ],
      }),
    ).toEqual({ pageId: 'p2', igId: '1784', token: 'page-token', etiqueta: '@luna' });
    expect(elegirPagina({ data: [] })).toBeNull();
    expect(tokenInstagram({ access_token: 'corto', user_id: '99' })).toEqual({ token: 'corto', userId: '99' });
    expect(tokenInstagram({ data: [{ access_token: 'otro', user_id: 7 }] })).toEqual({ token: 'otro', userId: '7' });
    expect(tokenTiktok({ access_token: 'tt', open_id: 'open-1' })).toEqual({ token: 'tt', openId: 'open-1' });
  });
});
