-- Password reset tokens for email-based recovery (cloud accounts).
create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  request_ip text
);
create index if not exists password_reset_user_idx on password_reset_tokens (user_id);
create index if not exists password_reset_expires_idx on password_reset_tokens (expires_at);

grant select, insert, update on password_reset_tokens to marginpilot_app;
