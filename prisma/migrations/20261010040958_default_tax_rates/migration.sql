-- Cincinnati-area sales tax defaults (Ohio Dept. of Taxation, Q4 2026). Editable in Settings.
INSERT INTO "TaxRate" ("id", "state", "county", "rateBps", "updatedAt") VALUES
  ('taxdefault_oh_hamilton', 'OH', 'Hamilton', 780, CURRENT_TIMESTAMP),
  ('taxdefault_oh_butler', 'OH', 'Butler', 650, CURRENT_TIMESTAMP),
  ('taxdefault_oh_clermont', 'OH', 'Clermont', 675, CURRENT_TIMESTAMP),
  ('taxdefault_oh_warren', 'OH', 'Warren', 725, CURRENT_TIMESTAMP),
  ('taxdefault_oh_brown', 'OH', 'Brown', 700, CURRENT_TIMESTAMP),
  ('taxdefault_oh_clinton', 'OH', 'Clinton', 725, CURRENT_TIMESTAMP),
  ('taxdefault_oh_highland', 'OH', 'Highland', 725, CURRENT_TIMESTAMP),
  ('taxdefault_oh_montgomery', 'OH', 'Montgomery', 750, CURRENT_TIMESTAMP),
  ('taxdefault_oh_greene', 'OH', 'Greene', 675, CURRENT_TIMESTAMP),
  ('taxdefault_oh_preble', 'OH', 'Preble', 725, CURRENT_TIMESTAMP),
  ('taxdefault_oh_adams', 'OH', 'Adams', 725, CURRENT_TIMESTAMP),
  ('taxdefault_oh_state', 'OH', '', 575, CURRENT_TIMESTAMP),
  ('taxdefault_ky_state', 'KY', '', 600, CURRENT_TIMESTAMP),
  ('taxdefault_in_state', 'IN', '', 700, CURRENT_TIMESTAMP)
ON CONFLICT ("state", "county") DO NOTHING;
