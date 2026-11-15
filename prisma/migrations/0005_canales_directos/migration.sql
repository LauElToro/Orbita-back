DROP INDEX IF EXISTS "Tenant_apiKey_key";
ALTER TABLE "Tenant" DROP COLUMN "pageId", DROP COLUMN "appTokenEnc", DROP COLUMN "apiKey";

ALTER TABLE "Channel" ADD COLUMN "tokenEnc" TEXT;

ALTER TABLE "Conversation"
  ADD COLUMN "canal" "CanalTipo",
  ADD COLUMN "endpointId" TEXT,
  ADD COLUMN "destino" TEXT,
  ADD COLUMN "nombre" TEXT,
  ADD COLUMN "handoffHasta" TIMESTAMP(3);
