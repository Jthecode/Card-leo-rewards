-- supabase/migrations/001_init.sql

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.signups (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(trim(first_name)) between 1 and 100),
  last_name text not null check (char_length(trim(last_name)) between 1 and 100),
  email citext not null,
  phone text,
  city text,
  state text,
  referral_name text,
  interest text,
  goals text,
  agreed boolean not null default false,
  status text not null default 'new'
    check (status in ('new', 'reviewing', 'approved', 'rejected', 'invited', 'active')),
  source text not null default 'website',
  signup_page text,
  portal_user_id uuid,
  portal_login_url text,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint signups_email_unique unique (email)
);

create index if not exists idx_signups_status
  on public.signups (status);

create index if not exists idx_signups_created_at
  on public.signups (created_at desc);

create index if not exists idx_signups_source
  on public.signups (source);

create index if not exists idx_signups_portal_user_id
  on public.signups (portal_user_id);

drop trigger if exists trg_signups_set_updated_at on public.signups;

create trigger trg_signups_set_updated_at
before update on public.signups
for each row
execute function public.set_updated_at();

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 150),
  email citext not null,
  phone text,
  topic text not null default 'general',
  message text not null check (char_length(trim(message)) between 1 and 5000),
  source text not null default 'website',
  contact_page text,
  status text not null default 'new'
    check (status in ('new', 'open', 'in_progress', 'resolved', 'closed', 'spam')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_contact_messages_email
  on public.contact_messages (email);

create index if not exists idx_contact_messages_status
  on public.contact_messages (status);

create index if not exists idx_contact_messages_created_at
  on public.contact_messages (created_at desc);

create index if not exists idx_contact_messages_topic
  on public.contact_messages (topic);

drop trigger if exists trg_contact_messages_set_updated_at on public.contact_messages;

create trigger trg_contact_messages_set_updated_at
before update on public.contact_messages
for each row
execute function public.set_updated_at();

alter table public.signups enable row level security;
alter table public.contact_messages enable row level security;

comment on table public.signups is 'Lead/member intake submissions from the Card Leo Rewards public signup flow.';
comment on table public.contact_messages is 'Inbound messages from the Card Leo Rewards contact form.';

commit;