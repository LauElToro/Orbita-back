-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantEstado" AS ENUM ('activo', 'pausado');

-- CreateEnum
CREATE TYPE "PausaMotivo" AS ENUM ('manual', 'impago');

-- CreateEnum
CREATE TYPE "CanalTipo" AS ENUM ('whatsapp', 'instagram', 'telegram');

-- CreateEnum
CREATE TYPE "MedioPago" AS ENUM ('mercadopago', 'transferencia');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('al_dia', 'pendiente', 'impago');

-- CreateEnum
CREATE TYPE "TicketEstado" AS ENUM ('nuevo', 'en_gestion', 'cotizado', 'contratado', 'descartado');

-- CreateEnum
CREATE TYPE "TurnoEstado" AS ENUM ('reservado', 'confirmado', 'cancelado');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "precioTransferencia" INTEGER NOT NULL,
    "precioMercadoPago" INTEGER NOT NULL,
    "topeDia" INTEGER NOT NULL,
    "topeSemana" INTEGER NOT NULL,
    "topeMes" INTEGER NOT NULL,
    "modulos" TEXT[],
    "maxCanales" INTEGER NOT NULL,
    "modeloCapaz" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "estado" "TenantEstado" NOT NULL DEFAULT 'activo',
    "pausaMotivo" "PausaMotivo",
    "planId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    "pageId" TEXT NOT NULL,
    "appTokenEnc" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "modelo" TEXT NOT NULL DEFAULT 'barato',
    "prompt" TEXT NOT NULL DEFAULT '',
    "mensajes" JSONB NOT NULL,
    "modulos" TEXT[],
    "topeDia" INTEGER NOT NULL,
    "topeSemana" INTEGER NOT NULL,
    "topeMes" INTEGER NOT NULL,
    "precioPersonalizado" INTEGER,
    "emailContacto" TEXT,
    "publicToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tipo" "CanalTipo" NOT NULL,
    "endpointId" TEXT NOT NULL,
    "etiqueta" TEXT NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Usage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "historial" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "tenantId" TEXT NOT NULL,
    "medio" "MedioPago" NOT NULL,
    "estadoPago" "EstadoPago" NOT NULL DEFAULT 'pendiente',
    "diaAbono" INTEGER NOT NULL,
    "vencimiento" TIMESTAMP(3) NOT NULL,
    "mpPreapprovalId" TEXT,
    "mpInitPoint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "medio" "MedioPago" NOT NULL,
    "importe" INTEGER NOT NULL,
    "periodo" TEXT NOT NULL,
    "externalId" TEXT,
    "acreditaEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "telefono" TEXT,
    "empresa" TEXT NOT NULL,
    "rubro" TEXT NOT NULL,
    "necesidad" TEXT NOT NULL,
    "estado" "TicketEstado" NOT NULL DEFAULT 'nuevo',
    "importeMensual" INTEGER,
    "notas" TEXT,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Turno" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "estado" "TurnoEstado" NOT NULL DEFAULT 'reservado',
    "recordatorioEnviado" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Turno_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_apiKey_key" ON "Tenant"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_publicToken_key" ON "Tenant"("publicToken");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_endpointId_key" ON "Channel"("endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "Usage_tenantId_periodo_key" ON "Usage"("tenantId", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenantId_subscriberId_key" ON "Conversation"("tenantId", "subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_mpPreapprovalId_key" ON "Subscription"("mpPreapprovalId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_externalId_key" ON "Payment"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_tenantId_key" ON "Ticket"("tenantId");

-- CreateIndex
CREATE INDEX "Turno_tenantId_fecha_idx" ON "Turno"("tenantId", "fecha");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Usage" ADD CONSTRAINT "Usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turno" ADD CONSTRAINT "Turno_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
