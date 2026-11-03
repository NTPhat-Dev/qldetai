// Additive upgrades for existing named volumes; no migration deletes user data.
export async function migrate(pool, service) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`qldetai-migrate-${service}`])
    if (service === 'identity') {
      await client.query('ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0')
      await client.query(`CREATE TABLE IF NOT EXISTS identity.auth_rate_limits (
        bucket text PRIMARY KEY, attempts integer NOT NULL, window_started_at timestamptz NOT NULL)`)
      await client.query('CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON identity.auth_rate_limits(window_started_at)')
      await client.query(`CREATE TABLE IF NOT EXISTS identity.security_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid, actor_id uuid,
        action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`)
    }
    if (service === 'registration') {
      await client.query('ALTER TABLE registration.registrations ADD COLUMN IF NOT EXISTS lecturer_id uuid')
      await client.query('ALTER TABLE registration.registrations ADD COLUMN IF NOT EXISTS decision_note text')
      await client.query(`CREATE TABLE IF NOT EXISTS registration.admission_blocks (
        scope text NOT NULL CHECK(scope IN ('topics','rounds')), entity_id uuid NOT NULL,
        closed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,entity_id))`)
      await client.query(`CREATE OR REPLACE FUNCTION registration.record_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' THEN
          INSERT INTO registration.history(registration_id,new_status,changed_by,note) VALUES(NEW.id,NEW.status,NEW.student_id,NEW.reason);
        ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
          INSERT INTO registration.history(registration_id,old_status,new_status,changed_by,note)
          VALUES(NEW.id,OLD.status,NEW.status,NEW.decided_by,NEW.decision_note);
        END IF;
        RETURN NEW;
      END $$`)
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
