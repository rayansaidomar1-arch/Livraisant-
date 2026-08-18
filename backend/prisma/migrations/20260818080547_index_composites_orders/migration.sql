-- DropIndex
DROP INDEX "orders_driver_id_idx";

-- DropIndex
DROP INDEX "orders_patient_id_idx";

-- DropIndex
DROP INDEX "orders_pharmacy_id_idx";

-- DropIndex
DROP INDEX "orders_status_idx";

-- CreateIndex
CREATE INDEX "orders_patient_id_created_at_idx" ON "orders"("patient_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_pharmacy_id_created_at_idx" ON "orders"("pharmacy_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_driver_id_status_created_at_idx" ON "orders"("driver_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

