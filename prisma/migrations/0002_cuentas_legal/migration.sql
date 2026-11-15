-- CreateEnum
CREATE TYPE "TicketTipo" AS ENUM ('ia_personalizada', 'arrepentimiento');

-- AlterEnum
ALTER TYPE "PausaMotivo" ADD VALUE 'onboarding';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "onboardingCompletado" TIMESTAMP(3),
ADD COLUMN     "onboardingPaso" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "perfil" JSONB,
ADD COLUMN     "rubro" TEXT,
ALTER COLUMN "pageId" DROP NOT NULL,
ALTER COLUMN "appTokenEnc" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "privacidadVersion" TEXT,
ADD COLUMN     "tipo" "TicketTipo" NOT NULL DEFAULT 'ia_personalizada';

-- CreateTable
CREATE TABLE "ClientUser" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "resetTokenHash" TEXT,
    "resetExpira" TIMESTAMP(3),
    "ultimoLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientUser_tenantId_key" ON "ClientUser"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientUser_email_key" ON "ClientUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientUser_resetTokenHash_key" ON "ClientUser"("resetTokenHash");

-- CreateIndex
CREATE INDEX "LegalAcceptance_userId_documento_idx" ON "LegalAcceptance"("userId", "documento");

-- AddForeignKey
ALTER TABLE "ClientUser" ADD CONSTRAINT "ClientUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalAcceptance" ADD CONSTRAINT "LegalAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ClientUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
