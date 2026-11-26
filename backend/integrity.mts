import type { Sql } from './database.mts';
// Numeric epoch conversion retains all nine fractional digits; no measured values
// or timestamps leave PostgreSQL. Intended for private acceptance checks only.
const epochNs=(s:string)=>`(extract(epoch from regexp_replace((${s}),'[.][0-9]+','')::timestamptz)*1000000000
  +rpad(coalesce(substring((${s}) from '[.]([0-9]+)'),''),9,'0')::numeric)`;
export async function inspectIntegrity(sql:Sql,owner:string,source:string){
  return (await sql.query(`WITH r AS (
    SELECT * FROM health_bridge.health_records WHERE owner_id=$1 AND source_id=$2 AND NOT deleted
  ), expected_samples AS (
    SELECT r.record_key,r.record_type,e.item,e.ordinality-1 AS idx FROM r
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.payload->'samples','[]'::jsonb)) WITH ORDINALITY AS e(item,ordinality)
  ), expected_stages AS (
    SELECT r.record_key,e.item,e.ordinality-1 AS idx FROM r
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.payload->'stages','[]'::jsonb)) WITH ORDINALITY AS e(item,ordinality)
  ) SELECT EXISTS(SELECT 1 FROM r) AS "hasLiveRecords",
    NOT EXISTS(SELECT 1 FROM r WHERE origin IS DISTINCT FROM payload#>>'{metadata,dataOriginPackage}'
      OR hc_id IS DISTINCT FROM payload#>>'{metadata,id}'
      OR modified_ns IS DISTINCT FROM ${epochNs("payload#>>'{metadata,lastModifiedTime}'")}
      OR start_ns IS DISTINCT FROM ${epochNs("coalesce(payload->>'startTime',payload->>'time')")}
      OR end_ns IS DISTINCT FROM ${epochNs("coalesce(payload->>'endTime',payload->>'time')")}) AS "recordMetadataExact",
    (SELECT count(*) FROM health_bridge.samples s JOIN r USING(record_key))=(SELECT count(*) FROM expected_samples) AS "sampleCountExact",
    NOT EXISTS(SELECT 1 FROM expected_samples e LEFT JOIN health_bridge.samples s ON s.record_key=e.record_key AND s.sample_index=e.idx
      WHERE s.record_key IS NULL OR s.time_text IS DISTINCT FROM e.item->>'time'
      OR s.time_ns IS DISTINCT FROM ${epochNs("e.item->>'time'")}
      OR s.value IS DISTINCT FROM coalesce(e.item->>'beatsPerMinute',e.item->>'metersPerSecond')::double precision
      OR s.unit IS DISTINCT FROM CASE WHEN e.record_type='HeartRateRecord' THEN 'BPM' ELSE 'm/s' END) AS "samplesExact",
    (SELECT count(*) FROM health_bridge.sleep_stages s JOIN r USING(record_key))=(SELECT count(*) FROM expected_stages) AS "stageCountExact",
    NOT EXISTS(SELECT 1 FROM expected_stages e LEFT JOIN health_bridge.sleep_stages s ON s.record_key=e.record_key AND s.stage_index=e.idx
      WHERE s.record_key IS NULL OR s.stage IS DISTINCT FROM (e.item->>'stage')::int
      OR s.start_ns IS DISTINCT FROM ${epochNs("e.item->>'startTime'")}
      OR s.end_ns IS DISTINCT FROM ${epochNs("e.item->>'endTime'")}) AS "stagesExact"`,[owner,source])).rows[0];
}
