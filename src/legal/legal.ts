import type { PrismaClient } from '@prisma/client';

/** Cambiar la versión obliga a cada cliente a volver a aceptar el documento en su próximo ingreso. */
export const LEGAL = {
  terminos: '2026-11-22',
  privacidad: '2026-11-22',
} as const;

export type DocumentoLegal = keyof typeof LEGAL;

export interface Evidencia {
  ip?: string;
  userAgent?: string;
}

export async function registrarAceptacion(
  prisma: PrismaClient,
  userId: string,
  documentos: DocumentoLegal[],
  evidencia: Evidencia,
): Promise<void> {
  await prisma.legalAcceptance.createMany({
    data: documentos.map((documento) => ({
      userId,
      documento,
      version: LEGAL[documento],
      ip: evidencia.ip ?? null,
      userAgent: evidencia.userAgent?.slice(0, 300) ?? null,
    })),
  });
}

export async function documentosPendientes(prisma: PrismaClient, userId: string): Promise<DocumentoLegal[]> {
  const aceptados = await prisma.legalAcceptance.findMany({
    where: { userId },
    select: { documento: true, version: true },
  });
  return (Object.keys(LEGAL) as DocumentoLegal[]).filter(
    (doc) => !aceptados.some((a) => a.documento === doc && a.version === LEGAL[doc]),
  );
}
