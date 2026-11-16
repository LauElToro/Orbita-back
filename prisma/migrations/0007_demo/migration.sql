ALTER TABLE "Tenant" ADD COLUMN "demo" JSONB;

CREATE TABLE "DemoFuente" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "tipo" TEXT NOT NULL,
  "nombre" TEXT NOT NULL,
  "contenido" TEXT NOT NULL,
  "filas" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DemoFuente_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DemoFuente_tenantId_idx" ON "DemoFuente"("tenantId");

ALTER TABLE "DemoFuente" ADD CONSTRAINT "DemoFuente_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
