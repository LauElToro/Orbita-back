ALTER TABLE "Tenant"
  ADD COLUMN "webActiva" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "webClave" TEXT,
  ADD COLUMN "webOrigenes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "webColor" TEXT,
  ADD COLUMN "webBienvenida" TEXT;

CREATE UNIQUE INDEX "Tenant_webClave_key" ON "Tenant"("webClave");
