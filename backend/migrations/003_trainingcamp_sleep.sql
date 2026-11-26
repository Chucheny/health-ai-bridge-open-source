-- Additive and operator-reviewed; never run by deployment. No source version is invented.
BEGIN;
CREATE TABLE health_bridge.trainingcamp_sleep_snapshots (
  snapshot_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES health_bridge.accounts(id),
  source_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  requested_start_ns numeric(30,0) NOT NULL,
  requested_end_ns numeric(30,0) NOT NULL CHECK (requested_end_ns > requested_start_ns),
  first_collected_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,source_id,content_hash),
  UNIQUE (snapshot_id,owner_id,source_id)
);
CREATE TABLE health_bridge.trainingcamp_sleep_records (
  record_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  source_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  start_ns numeric(30,0) NOT NULL,
  end_ns numeric(30,0) NOT NULL CHECK (end_ns > start_ns),
  payload jsonb NOT NULL,
  FOREIGN KEY (snapshot_id,owner_id,source_id)
    REFERENCES health_bridge.trainingcamp_sleep_snapshots(snapshot_id,owner_id,source_id) ON DELETE CASCADE,
  UNIQUE (snapshot_id,ordinal)
);
CREATE INDEX trainingcamp_sleep_range
  ON health_bridge.trainingcamp_sleep_records(owner_id,snapshot_id,start_ns,end_ns);
REVOKE ALL ON health_bridge.trainingcamp_sleep_snapshots,health_bridge.trainingcamp_sleep_records FROM PUBLIC;
REVOKE ALL ON SEQUENCE health_bridge.trainingcamp_sleep_records_record_key_seq FROM PUBLIC;
ALTER TABLE health_bridge.trainingcamp_sleep_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.trainingcamp_sleep_records ENABLE ROW LEVEL SECURITY;
COMMIT;
