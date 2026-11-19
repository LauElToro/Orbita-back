-- AlterTable: un cliente puede tener su propio link de referidos
ALTER TABLE "Affiliate" ADD COLUMN "clientUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Affiliate_clientUserId_key" ON "Affiliate"("clientUserId");

-- AddForeignKey
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "ClientUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
