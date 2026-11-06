-- Native document chains for contractor alternatives, procurement and billing.
ALTER TABLE commercial_cases DROP CONSTRAINT commercial_cases_kind_check;
ALTER TABLE commercial_cases ADD CONSTRAINT commercial_cases_kind_check CHECK
 (kind IN ('offer','variation','alternative','subcontract','measurement','procurement','calculation','invoice','progress_invoice','final_invoice'));
ALTER TABLE commercial_cases DROP CONSTRAINT commercial_cases_status_check;
ALTER TABLE commercial_cases ADD CONSTRAINT commercial_cases_status_check CHECK
 (status IN ('draft','sent','accepted','rejected','cancelled','requested','awarded','confirmed','submitted','approved','partially_paid','paid'));
ALTER TABLE commercial_cases DROP CONSTRAINT commercial_cases_check;
ALTER TABLE commercial_cases ADD CONSTRAINT commercial_cases_project_required CHECK
 (kind IN ('offer','alternative') OR project_id IS NOT NULL);
ALTER TABLE commercial_documents DROP CONSTRAINT commercial_documents_purpose_check;
ALTER TABLE commercial_documents ADD CONSTRAINT commercial_documents_purpose_check CHECK
 (purpose IN ('inquiry','offer','alternative','order','confirmation','measurement','calculation','invoice','price_inquiry','supplier_offer','purchase_order','supplier_confirmation'));
ALTER TABLE commercial_documents DROP CONSTRAINT commercial_documents_phase_check;
ALTER TABLE commercial_documents ADD CONSTRAINT commercial_documents_phase_check CHECK
 (phase IN ('31','52','80','81','82','83','84','85','86','87','89','93','94','96','97'));
ALTER TABLE commercial_documents DROP CONSTRAINT commercial_documents_check;
ALTER TABLE commercial_documents ADD CONSTRAINT commercial_documents_native_phase CHECK
 ((purpose='inquiry' AND phase='83') OR (purpose='offer' AND phase='84') OR (purpose='alternative' AND phase='85')
 OR (purpose='order' AND phase='86') OR (purpose='confirmation' AND phase='87') OR (purpose='measurement' AND phase='31')
 OR (purpose='calculation' AND phase='52') OR (purpose='invoice' AND phase='89') OR (purpose='price_inquiry' AND phase='93')
 OR (purpose='supplier_offer' AND phase='94') OR (purpose='purchase_order' AND phase='96') OR (purpose='supplier_confirmation' AND phase='97'));
DROP INDEX commercial_documents_single_purpose;
CREATE UNIQUE INDEX commercial_documents_single_purpose ON commercial_documents(case_id,purpose)
 WHERE purpose NOT IN ('offer','supplier_offer');

CREATE TABLE commercial_invoice_details (
 case_id BIGINT PRIMARY KEY REFERENCES commercial_cases(id) ON DELETE RESTRICT,
 basis TEXT NOT NULL CHECK(basis IN ('work','lump_sum')),
 vat_rate NUMERIC(5,2) NOT NULL DEFAULT 19 CHECK(vat_rate >= 0 AND vat_rate <= 100),
 invoice_number TEXT UNIQUE,
 invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
 due_date DATE NOT NULL DEFAULT (CURRENT_DATE + 14),
 service_start DATE NOT NULL DEFAULT CURRENT_DATE,
 service_end DATE NOT NULL DEFAULT CURRENT_DATE,
 total_net NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(total_net >= 0),
 deducted_net NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(deducted_net >= 0),
 gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(gross_amount >= 0),
 CHECK(service_end >= service_start), CHECK(due_date >= invoice_date)
);
CREATE TABLE commercial_invoice_payments (
 id BIGINT PRIMARY KEY DEFAULT id64(),
 case_id BIGINT NOT NULL REFERENCES commercial_invoice_details(case_id) ON DELETE RESTRICT,
 amount NUMERIC(15,2) NOT NULL CHECK(amount > 0),
 paid_on DATE NOT NULL,
 reference VARCHAR(255) NOT NULL DEFAULT '',
 created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX commercial_invoice_payments_case ON commercial_invoice_payments(case_id,paid_on);
CREATE TABLE commercial_invoice_counters (
 scope TEXT PRIMARY KEY,
 next_number NUMERIC(20,0) NOT NULL CHECK(next_number > 0)
);
-- An interrupted seed can resume safely; completed manifests are immutable.
CREATE TABLE development_seed_manifests (
 name TEXT PRIMARY KEY,
 seed TEXT NOT NULL,
 completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
