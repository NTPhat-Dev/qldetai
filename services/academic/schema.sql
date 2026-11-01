CREATE SCHEMA IF NOT EXISTS academic;
CREATE TABLE academic.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE academic.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES academic.departments(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE academic.semesters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  CHECK(starts_on<ends_on)
);
CREATE TABLE academic.rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id uuid NOT NULL REFERENCES academic.semesters(id),
  code text NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  is_open boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(opens_at<closes_at),
  UNIQUE(semester_id,code)
);
CREATE TABLE academic.topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  lecturer_id uuid NOT NULL,
  department_id uuid NOT NULL REFERENCES academic.departments(id),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  capacity integer CHECK(capacity IS NULL OR capacity>0),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(opens_at<closes_at)
);
CREATE TABLE academic.topic_round_windows (
  topic_id uuid NOT NULL REFERENCES academic.topics(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES academic.rounds(id) ON DELETE CASCADE,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  CHECK(opens_at<closes_at),
  PRIMARY KEY(topic_id,round_id)
);
CREATE INDEX academic_topics_lecturer_idx ON academic.topics(lecturer_id,created_at DESC);
