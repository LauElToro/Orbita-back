-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "mpEstado" TEXT;

-- AlterTable: las comisiones se pagan entre 30 y 60 días después del primer pago del referido
ALTER TABLE "Commission" ADD COLUMN "pagableDesde" TIMESTAMP(3),
ADD COLUMN "pagarAntes" TIMESTAMP(3);

UPDATE "Commission" c
SET "pagableDesde" = p."createdAt" + INTERVAL '30 days',
    "pagarAntes" = p."createdAt" + INTERVAL '60 days'
FROM "Payment" p
WHERE p."id" = c."paymentId";

ALTER TABLE "Commission" ALTER COLUMN "pagableDesde" SET NOT NULL,
ALTER COLUMN "pagarAntes" SET NOT NULL;
