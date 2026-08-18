-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('en_attente', 'validee', 'prete', 'en_livraison', 'livree', 'refusee');

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "pro_id" TEXT NOT NULL,
    "club_id" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "motif" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_professionals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "club_id" TEXT,
    "profession" TEXT,
    "rpps" TEXT,
    "partner_clubs" JSONB,
    "validated_by_club" BOOLEAN NOT NULL DEFAULT false,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_professionals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_profiles" (
    "user_id" TEXT NOT NULL,
    "age_range" TEXT,
    "pregnancy" TEXT,
    "sex" TEXT,
    "meds" JSONB,
    "weight" DECIMAL(5,2),
    "height" DECIMAL(5,2),
    "bmi" DECIMAL(5,2),
    "address" TEXT,
    "sport_license" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "pharmacy_id" TEXT,
    "driver_id" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'en_attente',
    "items" JSONB,
    "patient_snapshot" JSONB,
    "total_price" DECIMAL(10,2),
    "delivery_fee" DECIMAL(10,2),
    "track_id" TEXT,
    "kind" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacies" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nom" TEXT,
    "adresse" TEXT,
    "ville" TEXT,
    "code_postal" TEXT,
    "telephone" TEXT,
    "siret" TEXT,
    "rpps" TEXT,
    "rpps_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_patient_id_idx" ON "appointments"("patient_id" ASC);

-- CreateIndex
CREATE INDEX "appointments_pro_id_idx" ON "appointments"("pro_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "health_professionals_user_id_key" ON "health_professionals"("user_id" ASC);

-- CreateIndex
CREATE INDEX "orders_driver_id_idx" ON "orders"("driver_id" ASC);

-- CreateIndex
CREATE INDEX "orders_patient_id_idx" ON "orders"("patient_id" ASC);

-- CreateIndex
CREATE INDEX "orders_pharmacy_id_idx" ON "orders"("pharmacy_id" ASC);

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "pharmacies_user_id_key" ON "pharmacies"("user_id" ASC);

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_pro_id_fkey" FOREIGN KEY ("pro_id") REFERENCES "health_professionals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_pharmacy_id_fkey" FOREIGN KEY ("pharmacy_id") REFERENCES "pharmacies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

