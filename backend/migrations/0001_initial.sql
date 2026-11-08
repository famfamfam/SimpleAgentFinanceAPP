CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  nickname text NOT NULL,
  recovery_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  name text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  book_id text NOT NULL REFERENCES books(id),
  user_id text NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(book_id,user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  code_hash text PRIMARY KEY,
  book_id text NOT NULL REFERENCES books(id),
  expires_at timestamptz NOT NULL,
  used_by text REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS mutations (
  book_id text NOT NULL REFERENCES books(id),
  id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(book_id,id)
);
CREATE TABLE IF NOT EXISTS integrations (
  id text PRIMARY KEY,
  book_id text NOT NULL REFERENCES books(id),
  user_id text NOT NULL REFERENCES users(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  can_write boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days'
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS members_user_idx ON members(user_id);
CREATE TABLE IF NOT EXISTS imports (
  id text PRIMARY KEY,
  book_id text NOT NULL REFERENCES books(id),
  user_id text NOT NULL REFERENCES users(id),
  file_hash text NOT NULL,
  proposal jsonb NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(book_id,file_hash)
);
CREATE TABLE IF NOT EXISTS assistant_requests (
 book_id text NOT NULL REFERENCES books(id),
 id text NOT NULL,
 user_id text NOT NULL REFERENCES users(id),
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(book_id,id)
);
