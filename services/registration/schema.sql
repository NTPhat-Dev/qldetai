CREATE SCHEMA IF NOT EXISTS registration;
CREATE TYPE registration.status AS ENUM ('CHO_DUYET','DA_DUYET','TU_CHOI','DA_HUY');
CREATE TABLE registration.registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL,
  topic_id uuid NOT NULL,
  round_id uuid NOT NULL,
  topic_code text NOT NULL,
  topic_title text NOT NULL,
  student_code text NOT NULL,
  student_name text NOT NULL,
  round_code text NOT NULL,
  reason text,
  status registration.status NOT NULL DEFAULT 'CHO_DUYET',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid
);
CREATE UNIQUE INDEX registration_one_active_per_student_round
  ON registration.registrations(student_id,round_id)
  WHERE status IN ('CHO_DUYET','DA_DUYET');
CREATE INDEX registration_topic_status_idx ON registration.registrations(topic_id,status);
CREATE INDEX registration_student_created_idx ON registration.registrations(student_id,submitted_at DESC);
CREATE TABLE registration.history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES registration.registrations(id) ON DELETE CASCADE,
  old_status registration.status,
  new_status registration.status NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE FUNCTION registration.record_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO registration.history(registration_id,new_status) VALUES(NEW.id,NEW.status);
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO registration.history(registration_id,old_status,new_status,changed_by)
    VALUES(NEW.id,OLD.status,NEW.status,NEW.decided_by);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registrations_history AFTER INSERT OR UPDATE OF status ON registration.registrations
FOR EACH ROW EXECUTE FUNCTION registration.record_history();
