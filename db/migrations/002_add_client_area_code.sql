ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS area_code TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_area_code ON clients (area_code);
