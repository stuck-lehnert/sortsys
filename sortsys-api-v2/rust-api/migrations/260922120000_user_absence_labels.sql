ALTER TABLE users
  ADD COLUMN vacation_days_per_year SMALLINT;

ALTER TABLE users
  ADD CONSTRAINT users_vacation_days_per_year_valid
  CHECK (vacation_days_per_year IS NULL OR vacation_days_per_year BETWEEN 0 AND 366);

ALTER TABLE user_vacations
  ADD COLUMN absence_type TEXT NOT NULL DEFAULT 'vacation',
  ADD COLUMN label VARCHAR(63);

ALTER TABLE user_vacations
  ADD CONSTRAINT user_vacations_absence_type_valid
  CHECK (absence_type IN ('vacation', 'other'));

ALTER TABLE user_vacations
  ADD CONSTRAINT user_vacations_label_valid
  CHECK (
    (absence_type = 'vacation' AND label IS NULL)
    OR (absence_type = 'other' AND label = BTRIM(label) AND label <> '')
  );
