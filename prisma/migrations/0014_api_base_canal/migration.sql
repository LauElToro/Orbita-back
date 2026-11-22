-- El token de una página de Facebook se usa contra graph.facebook.com; el de Instagram Login, contra graph.instagram.com.
ALTER TABLE "Channel" ADD COLUMN "apiBase" TEXT;
