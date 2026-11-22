-- El único medio de pago del abono pasa a ser Mercado Pago.
UPDATE "Subscription" SET medio = 'mercadopago' WHERE medio::text = 'transferencia';
UPDATE "Payment" SET medio = 'mercadopago' WHERE medio::text = 'transferencia';

CREATE TYPE "MedioPago_new" AS ENUM ('mercadopago');
ALTER TABLE "Subscription" ALTER COLUMN "medio" TYPE "MedioPago_new" USING ("medio"::text::"MedioPago_new");
ALTER TABLE "Payment" ALTER COLUMN "medio" TYPE "MedioPago_new" USING ("medio"::text::"MedioPago_new");
DROP TYPE "MedioPago";
ALTER TYPE "MedioPago_new" RENAME TO "MedioPago";

ALTER TYPE "PausaMotivo" ADD VALUE 'baja';

CREATE TYPE "VerificacionWhatsapp" AS ENUM ('pendiente', 'en_revision', 'verificado', 'rechazado');

ALTER TABLE "Plan" ADD COLUMN "precioMensajeExtra" INTEGER NOT NULL DEFAULT 45;
UPDATE "Plan" SET "precioMensajeExtra" = 45 WHERE id = 'mensajes';
UPDATE "Plan" SET "precioMensajeExtra" = 40 WHERE id = 'turnos';
UPDATE "Plan" SET "precioMensajeExtra" = 30 WHERE id = 'completo';
UPDATE "Plan" SET "precioMensajeExtra" = 25 WHERE id = 'personalizado';

ALTER TABLE "Channel" ADD COLUMN "wabaId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "verificacion" "VerificacionWhatsapp";
ALTER TABLE "Channel" ADD COLUMN "verificacionDetalle" TEXT;
ALTER TABLE "Channel" ADD COLUMN "displayPhone" TEXT;

ALTER TABLE "Conversation" ADD COLUMN "ultimoClienteAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "ventanaDesde" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "respuestasVentana" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Subscription" ADD COLUMN "canceladaEn" TIMESTAMP(3);

ALTER TABLE "Turno" ADD COLUMN "eventoExternoId" TEXT;

CREATE TABLE "Calendario" (
    "tenantId" TEXT NOT NULL,
    "refreshEnc" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Calendario_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "CargoExtra" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 0,
    "precioUnitario" INTEGER NOT NULL,
    "importeCobrado" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CargoExtra_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PagoExtra" (
    "id" TEXT NOT NULL,
    "cargoId" TEXT NOT NULL,
    "importe" INTEGER NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PagoExtra_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CargoExtra_tenantId_periodo_key" ON "CargoExtra"("tenantId", "periodo");
CREATE UNIQUE INDEX "PagoExtra_externalId_key" ON "PagoExtra"("externalId");

ALTER TABLE "Calendario" ADD CONSTRAINT "Calendario_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CargoExtra" ADD CONSTRAINT "CargoExtra_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PagoExtra" ADD CONSTRAINT "PagoExtra_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "CargoExtra"("id") ON DELETE CASCADE ON UPDATE CASCADE;
