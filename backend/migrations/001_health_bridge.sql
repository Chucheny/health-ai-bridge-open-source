-- Reviewed migration only. Never automatically applied by a Netlify deploy.
BEGIN;
CREATE SCHEMA IF NOT EXISTS health_bridge;
REVOKE ALL ON SCHEMA health_bridge FROM PUBLIC;

CREATE TABLE health_bridge.accounts (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE health_bridge.device_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid NOT NULL REFERENCES health_bridge.accounts(id),
  source_id uuid NOT NULL,
  scopes text[] NOT NULL,
  allowed_types text[] NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE health_bridge.sync_streams (
  owner_id uuid NOT NULL REFERENCES health_bridge.accounts(id),
  source_id uuid NOT NULL,
  record_type text NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  committed_at timestamptz,
  PRIMARY KEY (owner_id, source_id, record_type)
);
CREATE TABLE health_bridge.sync_batches (
  owner_id uuid NOT NULL REFERENCES health_bridge.accounts(id),
  source_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  request_hash text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (owner_id, source_id, batch_id)
);
CREATE TABLE health_bridge.health_records (
  record_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES health_bridge.accounts(id),
  source_id uuid NOT NULL,
  record_type text NOT NULL,
  hc_id text NOT NULL,
  origin text,
  modified_ns numeric(30,0),
  start_ns numeric(30,0),
  end_ns numeric(30,0),
  start_at timestamptz,
  payload jsonb,
  deleted boolean NOT NULL DEFAULT false,
  UNIQUE (owner_id, source_id, record_type, hc_id)
);
CREATE INDEX records_range ON health_bridge.health_records(owner_id, record_type, start_ns, end_ns) WHERE NOT deleted;
CREATE INDEX records_origin ON health_bridge.health_records(owner_id, origin, record_type) WHERE NOT deleted;
CREATE TABLE health_bridge.samples (
  record_key bigint NOT NULL REFERENCES health_bridge.health_records(record_key) ON DELETE CASCADE,
  sample_index integer NOT NULL,
  time_ns numeric(30,0) NOT NULL,
  time_text text NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  PRIMARY KEY (record_key, sample_index)
);
CREATE INDEX samples_time ON health_bridge.samples(time_ns);
CREATE TABLE health_bridge.sleep_stages (
  record_key bigint NOT NULL REFERENCES health_bridge.health_records(record_key) ON DELETE CASCADE,
  stage_index integer NOT NULL,
  start_ns numeric(30,0) NOT NULL,
  end_ns numeric(30,0) NOT NULL,
  stage integer NOT NULL,
  PRIMARY KEY (record_key, stage_index)
);
CREATE INDEX stages_time ON health_bridge.sleep_stages(start_ns, end_ns);
REVOKE ALL ON ALL TABLES IN SCHEMA health_bridge FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA health_bridge FROM PUBLIC;
-- Defense in depth: no client role can read rows, even if table grants drift.
-- Only the migration owner can access data until a dedicated backend policy is provisioned.
ALTER TABLE health_bridge.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.sync_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.sync_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.health_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_bridge.sleep_stages ENABLE ROW LEVEL SECURITY;
COMMIT;
