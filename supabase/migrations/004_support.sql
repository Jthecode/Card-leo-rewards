-- supabase/migrations/004_support.sql

begin;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles (id) on delete set null,
  contact_message_id uuid references public.contact_messages (id) on delete set null,
  ticket_number text not null unique,
  subject text not null,
  category text not null default 'general' check (
    category in (
      'general',
      'account',
      'rewards',
      'billing',
      'technical',
      'verification',
      'referral',
      'other'
    )
  ),
  priority text not null default 'normal' check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  status text not null default 'open' check (
    status in ('open', 'in_progress', 'waiting_on_member', 'resolved', 'closed')
  ),
  source text not null default 'portal' check (
    source in ('portal', 'contact_form', 'email', 'admin')
  ),
  assigned_to_profile_id uuid references public.profiles (id) on delete set null,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  last_message_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_support_tickets_profile_id
  on public.support_tickets (profile_id);

create index if not exists idx_support_tickets_contact_message_id
  on public.support_tickets (contact_message_id);

create index if not exists idx_support_tickets_status
  on public.support_tickets (status);

create index if not exists idx_support_tickets_priority
  on public.support_tickets (priority);

create index if not exists idx_support_tickets_category
  on public.support_tickets (category);

create index if not exists idx_support_tickets_assigned_to_profile_id
  on public.support_tickets (assigned_to_profile_id);

create index if not exists idx_support_tickets_last_message_at
  on public.support_tickets (last_message_at desc);

create index if not exists idx_support_tickets_created_at
  on public.support_tickets (created_at desc);

drop trigger if exists trg_support_tickets_set_updated_at on public.support_tickets;

create trigger trg_support_tickets_set_updated_at
before update on public.support_tickets
for each row
execute function public.set_updated_at();

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete set null,
  sender_type text not null check (
    sender_type in ('member', 'support', 'admin', 'system', 'guest')
  ),
  sender_name text,
  sender_email citext,
  body text not null check (char_length(trim(body)) between 1 and 10000),
  is_internal boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_support_messages_ticket_id
  on public.support_messages (ticket_id);

create index if not exists idx_support_messages_profile_id
  on public.support_messages (profile_id);

create index if not exists idx_support_messages_created_at
  on public.support_messages (created_at asc);

create index if not exists idx_support_messages_sender_type
  on public.support_messages (sender_type);

drop trigger if exists trg_support_messages_set_updated_at on public.support_messages;

create trigger trg_support_messages_set_updated_at
before update on public.support_messages
for each row
execute function public.set_updated_at();

create or replace function public.generate_ticket_number()
returns text
language plpgsql
as $$
declare
  candidate text;
begin
  loop
    candidate := 'CLR-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 8));
    exit when not exists (
      select 1
      from public.support_tickets
      where ticket_number = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function public.handle_support_ticket_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.ticket_number is null or trim(new.ticket_number) = '' then
    new.ticket_number := public.generate_ticket_number();
  end if;

  if new.last_message_at is null then
    new.last_message_at := timezone('utc', now());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_support_tickets_defaults on public.support_tickets;

create trigger trg_support_tickets_defaults
before insert on public.support_tickets
for each row
execute function public.handle_support_ticket_defaults();

create or replace function public.handle_support_message_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_tickets
  set
    last_message_at = new.created_at,
    first_response_at = case
      when first_response_at is null and new.sender_type in ('support', 'admin')
        then new.created_at
      else first_response_at
    end,
    status = case
      when new.sender_type in ('support', 'admin') and status = 'open'
        then 'in_progress'
      when new.sender_type in ('member', 'guest') and status = 'resolved'
        then 'waiting_on_member'
      else status
    end,
    updated_at = timezone('utc', now())
  where id = new.ticket_id;

  return new;
end;
$$;

drop trigger if exists trg_support_messages_sync_ticket on public.support_messages;

create trigger trg_support_messages_sync_ticket
after insert on public.support_messages
for each row
execute function public.handle_support_message_sync();

create or replace function public.handle_support_resolution_timestamps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    new.resolved_at := timezone('utc', now());
  end if;

  if new.status = 'closed' and old.status is distinct from 'closed' then
    new.closed_at := timezone('utc', now());
  end if;

  if new.status <> 'resolved' and old.status = 'resolved' then
    new.resolved_at := null;
  end if;

  if new.status <> 'closed' and old.status = 'closed' then
    new.closed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_support_tickets_resolution_timestamps on public.support_tickets;

create trigger trg_support_tickets_resolution_timestamps
before update on public.support_tickets
for each row
execute function public.handle_support_resolution_timestamps();

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;

comment on table public.support_tickets is 'Member and public support cases for Card Leo Rewards.';
comment on table public.support_messages is 'Threaded messages attached to support tickets.';

commit;