CREATE TABLE chat_heads (
  user_id text NOT NULL REFERENCES users(id),
  book_id text NOT NULL REFERENCES books(id),
  epoch bigint NOT NULL DEFAULT 0,
  seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,book_id)
);
CREATE TABLE assistant_tasks (
  user_id text NOT NULL REFERENCES users(id),
  book_id text NOT NULL REFERENCES books(id),
  id text NOT NULL,
  epoch bigint NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','applied','cancelled')),
  request_id text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  applied_ids jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,book_id,id)
);
CREATE TABLE chat_messages (
  user_id text NOT NULL REFERENCES users(id),
  book_id text NOT NULL REFERENCES books(id),
  id text NOT NULL,
  task_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('user','assistant')),
  text text NOT NULL DEFAULT '',
  transcript text NOT NULL DEFAULT '',
  body jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(user_id,book_id,id)
);
CREATE INDEX chat_messages_page ON chat_messages(user_id,book_id,created_at DESC,id DESC) WHERE NOT deleted;
CREATE INDEX chat_messages_changes ON chat_messages(user_id,book_id,seq);
CREATE TABLE chat_media (
  user_id text NOT NULL,
  book_id text NOT NULL,
  message_id text NOT NULL,
  mime text NOT NULL,
  data bytea NOT NULL CHECK(octet_length(data) <= 4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,book_id,message_id),
  FOREIGN KEY(user_id,book_id,message_id) REFERENCES chat_messages(user_id,book_id,id)
);
CREATE INDEX chat_media_retention ON chat_media(user_id,created_at);
