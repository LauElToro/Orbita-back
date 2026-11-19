-- AlterTable: el plan nuevo que eligió el cliente y se aplica cuando se acredita el pago
ALTER TABLE "Tenant" ADD COLUMN "planPendienteId" TEXT;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_planPendienteId_fkey" FOREIGN KEY ("planPendienteId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
