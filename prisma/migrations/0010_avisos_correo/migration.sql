-- AlterTable
ALTER TABLE "ClientUser" ADD COLUMN "avisosComerciales" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CorreoEnviado" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "email" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorreoEnviado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CorreoEnviado_email_tipo_clave_key" ON "CorreoEnviado"("email", "tipo", "clave");

-- CreateIndex
CREATE INDEX "CorreoEnviado_tenantId_tipo_idx" ON "CorreoEnviado"("tenantId", "tipo");

-- AddForeignKey
ALTER TABLE "CorreoEnviado" ADD CONSTRAINT "CorreoEnviado_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
