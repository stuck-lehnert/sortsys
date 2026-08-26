ALTER TABLE regie_report_work_hours
ADD COLUMN DAY DATE;

UPDATE regie_report_work_hours AS rrwh
SET
  DAY = rr.day
FROM
  regie_reports AS rr
WHERE
  rr.id = rrwh.report_id;

ALTER TABLE regie_report_work_hours
ALTER COLUMN DAY
SET NOT NULL;

UPDATE regie_reports
SET
  DAY = (
    DAY - (
      (
        EXTRACT(
          ISODOW
          FROM
            DAY
        )::INT - 1
      ) * INTERVAL '1 day'
    )
  )::date;

CREATE INDEX ON regie_report_work_hours (DAY);

CREATE INDEX ON regie_report_work_hours (report_id, DAY);
