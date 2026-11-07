-- Native commercial documents belong to a contractor workflow, independently
-- of project attachments. An accepted main offer can create exactly one project.
CREATE SEQUENCE commercial_case_number_seq;
CREATE TABLE commercial_cases (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  reference TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('offer','variation','subcontract','measurement')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','cancelled','requested','awarded','confirmed','submitted','approved')),
  title VARCHAR(127) NOT NULL,
  existing_contract BOOLEAN NOT NULL DEFAULT FALSE,
  project_id BIGINT REFERENCES projects(id) ON DELETE RESTRICT,
  parent_case_id BIGINT REFERENCES commercial_cases(id) ON DELETE RESTRICT,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  counterparty_name VARCHAR(127),
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  net_amount NUMERIC(15,2),
  valid_until DATE,
  notes TEXT,
  scope_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_offer_document_id BIGINT,
  accepted_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'offer' OR project_id IS NOT NULL),
  CHECK (net_amount IS NULL OR net_amount >= 0 OR kind = 'variation')
);
CREATE UNIQUE INDEX commercial_cases_one_main_offer_per_project ON commercial_cases(project_id) WHERE kind = 'offer';
CREATE INDEX commercial_cases_project_kind ON commercial_cases(project_id,kind,created_at DESC);
CREATE INDEX commercial_cases_pipeline ON commercial_cases(kind,status,created_at DESC);
CREATE TRIGGER commercial_cases_modified_at BEFORE UPDATE ON commercial_cases FOR EACH ROW EXECUTE FUNCTION trigger_modified_at();

CREATE TABLE commercial_documents (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  case_id BIGINT NOT NULL REFERENCES commercial_cases(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('inquiry','offer','order','confirmation','measurement')),
  phase TEXT NOT NULL CHECK (phase IN ('83','84','86','87','31')),
  file_name VARCHAR(255) NOT NULL,
  object_key TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  read_only BOOLEAN NOT NULL DEFAULT FALSE,
  source_document_id BIGINT REFERENCES commercial_documents(id) ON DELETE RESTRICT,
  source_version BIGINT,
  partner_name VARCHAR(127),
  net_amount NUMERIC(15,2),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((purpose='inquiry' AND phase='83') OR (purpose='offer' AND phase='84') OR (purpose='order' AND phase='86') OR (purpose='confirmation' AND phase='87') OR (purpose='measurement' AND phase='31')),
  CHECK ((source_document_id IS NULL) = (source_version IS NULL))
);
CREATE UNIQUE INDEX commercial_documents_single_purpose ON commercial_documents(case_id,purpose) WHERE purpose <> 'offer';
CREATE INDEX commercial_documents_case ON commercial_documents(case_id,created_at);
ALTER TABLE commercial_cases ADD CONSTRAINT commercial_selected_offer_fk FOREIGN KEY (selected_offer_document_id) REFERENCES commercial_documents(id) ON DELETE RESTRICT;
CREATE TABLE commercial_document_snapshots (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  document_id BIGINT NOT NULL REFERENCES commercial_documents(id) ON DELETE RESTRICT,
  version BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id,version)
);
CREATE TABLE commercial_case_events (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  case_id BIGINT NOT NULL REFERENCES commercial_cases(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  previous_status TEXT,
  status TEXT NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX commercial_case_events_case ON commercial_case_events(case_id,created_at);
ALTER TABLE project_financial_entries ADD COLUMN commercial_case_id BIGINT UNIQUE REFERENCES commercial_cases(id) ON DELETE RESTRICT;
ALTER TABLE project_financial_entries DROP CONSTRAINT project_financial_entries_amount_check;
ALTER TABLE project_financial_entries ADD CONSTRAINT project_financial_entries_amount_check CHECK(amount >= 0 OR commercial_case_id IS NOT NULL);
