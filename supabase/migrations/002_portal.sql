-- supabase/migrations/002_portal.sql

begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  signup_id uuid references public.signups (id) on delete set null,
  email citext not null,
  first_name text not null check (char_length(trim(first_name)) between 1 and 100),
  last_name text not null check (char_length(trim(last_name)) between 1 and 100),
  full_name text generated always as (trim(first_name || ' ' || last_name)) stored,
  phone text,
  avatar_url text,
  city text,
  state text,
  member_status text not null default 'pending' check (
    member_status in ('pending', 'active', 'paused', 'suspended', 'closed')
  ),
  role text not null default 'member' check (
    role in ('member', 'admin', 'support')
  ),
  tier text not null default 'core' check (
    tier in ('core', 'silver', 'gold', 'platinum', 'vip')
  ),
  referral_code text unique,
  referred_by_profile_id uuid references public.profiles (id) on delete set null,
  portal_login_url text,
  last_login_at timestamptz,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_email_unique unique (email)
);

create index if not exists idx_profiles_signup_id
  on public.profiles (signup_id);

create index if not exists idx_profiles_member_status
  on public.profiles (member_status);

create index if not exists idx_profiles_role
  on public.profiles (role);

create index if not exists idx_profiles_tier
  on public.profiles (tier);

create index if not exists idx_profiles_created_at
  on public.profiles (created_at desc);

create index if not exists idx_profiles_referral_code
  on public.profiles (referral_code);

drop trigger if exists trg_profiles_set_updated_at on public.profiles;

create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create table if not exists public.member_settings (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  marketing_email_opt_in boolean not null default true,
  sms_opt_in boolean not null default false,
  dark_mode boolean not null default false,
  reward_reminders boolean not null default true,
  security_alerts boolean not null default true,
  support_notifications boolean not null default true,
  preferred_contact_method text not null default 'email' check (
    preferred_contact_method in ('email', 'sms', 'phone')
  ),
  timezone text not null default 'America/New_York',
  locale text not null default 'en-US',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_member_settings_set_updated_at on public.member_settings;

create trigger trg_member_settings_set_updated_at
before update on public.member_settings
for each row
execute function public.set_updated_at();

create table if not exists public.member_onboarding (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  accepted_terms boolean not null default false,
  accepted_terms_at timestamptz,
  accepted_privacy boolean not null default false,
  accepted_privacy_at timestamptz,
  profile_completed boolean not null default false,
  profile_completed_at timestamptz,
  email_verified boolean not null default false,
  email_verified_at timestamptz,
  first_login_completed boolean not null default false,
  first_login_completed_at timestamptz,
  rewards_activated boolean not null default false,
  rewards_activated_at timestamptz,
  onboarding_percent integer not null default 0 check (onboarding_percent between 0 and 100),
  onboarding_status text not null default 'not_started' check (
    onboarding_status in ('not_started', 'in_progress', 'completed')
  ),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_member_onboarding_set_updated_at on public.member_onboarding;

create trigger trg_member_onboarding_set_updated_at
before update on public.member_onboarding
for each row
execute function public.set_updated_at();

create table if not exists public.member_activity (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  activity_type text not null check (
    activity_type in (
      'signup_submitted',
      'account_created',
      'login',
      'logout',
      'profile_updated',
      'password_changed',
      'settings_updated',
      'support_ticket_created',
      'support_ticket_replied',
      'reward_earned',
      'reward_redeemed',
      'admin_note'
    )
  ),
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_member_activity_profile_id
  on public.member_activity (profile_id);

create index if not exists idx_member_activity_type
  on public.member_activity (activity_type);

create index if not exists idx_member_activity_occurred_at
  on public.member_activity (occurred_at desc);

create or replace function public.generate_referral_code()
returns text
language plpgsql
as $$
declare
  candidate text;
begin
  loop
    candidate := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));
    exit when not exists (
      select 1
      from public.profiles
      where referral_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function public.handle_new_profile_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.referral_code is null or trim(new.referral_code) = '' then
    new.referral_code := public.generate_referral_code();
  end if;

  insert into public.member_settings (profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;

  insert into public.member_onboarding (profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_profiles_defaults on public.profiles;

create trigger trg_profiles_defaults
before insert on public.profiles
for each row
execute function public.handle_new_profile_defaults();

alter table public.profiles enable row level security;
alter table public.member_settings enable row level security;
alter table public.member_onboarding enable row level security;
alter table public.member_activity enable row level security;

comment on table public.profiles is 'Primary member profile records mapped to Supabase auth users.';
comment on table public.member_settings is 'Portal preferences and notification settings for each member.';
comment on table public.member_onboarding is 'Tracks onboarding milestones and completion progress.';
comment on table public.member_activity is 'Member-facing activity history for portal timelines and audit-style events.';

commit;