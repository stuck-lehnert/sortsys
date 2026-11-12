-- Sales numbering is independent of invoices and other commercial workflows.
-- One global high-water mark survives scheme changes and lower start numbers.
CREATE TABLE commercial_offer_counters (
    scope TEXT PRIMARY KEY CHECK (scope = 'global'),
    next_number NUMERIC(20,0) NOT NULL CHECK (next_number > 0)
);

-- Deliberately no case FK: deleting an offer must never release its number.
-- A permanent registry also prevents cross-format collisions after a switch
-- between dateCompact and sequential (both can produce digit-only references).
CREATE TABLE commercial_offer_number_reservations (
    number TEXT PRIMARY KEY
);

INSERT INTO commercial_offer_number_reservations (number)
SELECT reference FROM commercial_cases WHERE kind IN ('offer', 'alternative');
