-- Estimate numbers start at #27819: shift existing ones (keeping their order and revision sharing), then
-- continue the sequence after the highest number.
UPDATE "Proposal" SET "number" = "number" + 26818 WHERE "number" < 27819;
SELECT setval(pg_get_serial_sequence('"Proposal"', 'number'), GREATEST(27818, (SELECT COALESCE(MAX("number"), 27818) FROM "Proposal")));
