-- Additive, operator-reviewed migration. Never run automatically during deploy.
-- Web records have their own source IDs and type codes, not Health Connect metadata.
BEGIN;
CREATE TABLE health_bridge.trainingcamp_activities (
  record_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES health_bridge.accounts(id),
  source_id uuid NOT NULL,
  source_record_id text NOT NULL,
  modified_ms bigint NOT NULL CHECK (modified_ms >= 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  start_ns numeric(30,0) NOT NULL,
  end_ns numeric(30,0) NOT NULL CHECK (end_ns > start_ns),
  payload jsonb NOT NULL,
  UNIQUE (owner_id, source_id, source_record_id)
);
CREATE INDEX trainingcamp_activities_range
  ON health_bridge.trainingcamp_activities(owner_id, start_ns, end_ns);
REVOKE ALL ON health_bridge.trainingcamp_activities FROM PUBLIC;
REVOKE ALL ON SEQUENCE health_bridge.trainingcamp_activities_record_key_seq FROM PUBLIC;
ALTER TABLE health_bridge.trainingcamp_activities ENABLE ROW LEVEL SECURITY;
COMMIT;
