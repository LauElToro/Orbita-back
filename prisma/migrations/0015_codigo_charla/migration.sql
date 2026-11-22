-- Cada charla tiene un UUID público para abrirla y para reportar un fallo con su enlace.
ALTER TABLE "Conversation" ADD COLUMN "codigo" TEXT;
UPDATE "Conversation" SET "codigo" = gen_random_uuid()::text WHERE "codigo" IS NULL;
ALTER TABLE "Conversation" ALTER COLUMN "codigo" SET NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "codigo" SET DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX "Conversation_codigo_key" ON "Conversation"("codigo");
