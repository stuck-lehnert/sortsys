ALTER TABLE project_files
    ADD COLUMN text_extraction_status VARCHAR(16) NOT NULL DEFAULT 'not_applicable',
    ADD COLUMN extracted_text TEXT,
    ADD COLUMN text_extraction_method VARCHAR(64),
    ADD COLUMN text_extraction_confidence DOUBLE PRECISION,
    ADD COLUMN text_extraction_page_count INTEGER,
    ADD COLUMN text_extraction_error TEXT,
    ADD COLUMN text_extraction_version BIGINT,
    ADD COLUMN text_extracted_at TIMESTAMPTZ,
    ADD CONSTRAINT project_files_text_extraction_status_check CHECK (
        text_extraction_status IN (
            'not_applicable',
            'pending',
            'queued',
            'processing',
            'ready',
            'failed'
        )
    ),
    ADD CONSTRAINT project_files_text_extraction_confidence_check CHECK (
        text_extraction_confidence IS NULL
        OR text_extraction_confidence BETWEEN 0 AND 1
    ),
    ADD CONSTRAINT project_files_text_extraction_page_count_check CHECK (
        text_extraction_page_count IS NULL
        OR text_extraction_page_count >= 0
    );

UPDATE project_files
SET text_extraction_status = 'pending'
WHERE status = 'uploaded'
    AND (
        LOWER(mime_type) = 'application/pdf'
        OR LOWER(file_name) LIKE '%.pdf'
    );

ALTER TABLE project_files
    ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
        SETWEIGHT(TO_TSVECTOR('simple', COALESCE(file_name, '')), 'A')
        || SETWEIGHT(TO_TSVECTOR('german', COALESCE(extracted_text, '')), 'B')
        || SETWEIGHT(TO_TSVECTOR('english', COALESCE(extracted_text, '')), 'B')
    ) STORED;

CREATE INDEX project_files_search_vector_idx
    ON project_files USING GIN (search_vector)
    WHERE status = 'uploaded';

CREATE INDEX project_files_pending_text_extraction_idx
    ON project_files (text_extraction_status, id)
    WHERE status = 'uploaded'
      AND text_extraction_status IN ('pending', 'queued', 'processing');
