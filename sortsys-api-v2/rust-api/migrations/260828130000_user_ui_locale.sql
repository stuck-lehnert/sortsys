ALTER TABLE users
  ADD COLUMN ui_locale VARCHAR(2) NOT NULL DEFAULT 'de'
    CHECK (ui_locale IN ('de', 'en'));
