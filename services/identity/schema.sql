CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username=lower(btrim(username)) AND username<>''),
  email text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('QUAN_TRI','GIANG_VIEN','SINH_VIEN')),
  status text NOT NULL DEFAULT 'HOAT_DONG',
  must_change_password boolean NOT NULL DEFAULT true,
  display_name text NOT NULL,
  profile_code text,
  department_id uuid,
  class_id uuid,
  phone text,
  academic_title text,
  degree text,
  specialization text,
  class_name text,
  attributes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.totp_factors (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  encrypted_secret bytea NOT NULL,
  encryption_version text NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK(sign_count>=0),
  transports text[] NOT NULL DEFAULT '{}',
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE TABLE identity.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX identity_users_role_idx ON identity.users(role, created_at DESC);
CREATE INDEX identity_recovery_user_idx ON identity.recovery_codes(user_id) WHERE used_at IS NULL;
