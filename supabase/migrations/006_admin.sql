-- supabase/migrations/006_admin.sql

begin;

create table if not exists public.admin_roles (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  is_super_admin boolean not null default false,
  can_manage_members boolean not null default true,
  can_manage_rewards boolean not null default true,
  can_manage_support boolean not null default true,
  can_manage_referrals boolean not null default true,
  can_view_audit_logs boolean not null default true,
  can_manage_settings boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_admin_roles_set_updated_at on public.admin_roles;

create trigger trg_admin_roles_set_updated_at
before update on public.admin_roles
for each row
execute function public.set_updated_at();

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles (id) on delete set null,
  target_profile_id uuid references public.profiles (id) on delete set null,
  entity_type text not null check (
    entity_type in (
      'signup',
      'profile',
      'reward_account',
      'reward_transaction',
      'reward_payout',
      'membership_cycle',
      'membership_payment',
      'support_ticket',
      'support_message',
      'referral',
      'setting',
      'admin_role',
      'system'
    )
  ),
  entity_id uuid,
  action text not null,
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_admin_audit_logs_actor_profile_id
  on public.admin_audit_logs (actor_profile_id);

create index if not exists idx_admin_audit_logs_target_profile_id
  on public.admin_audit_logs (target_profile_id);

create index if not exists idx_admin_audit_logs_entity_type
  on public.admin_audit_logs (entity_type);

create index if not exists idx_admin_audit_logs_entity_id
  on public.admin_audit_logs (entity_id);

create index if not exists idx_admin_audit_logs_created_at
  on public.admin_audit_logs (created_at desc);

create table if not exists public.admin_notes (
  id uuid primary key default gen_random_uuid(),
  author_profile_id uuid references public.profiles (id) on delete set null,
  target_profile_id uuid references public.profiles (id) on delete cascade,
  entity_type text not null check (
    entity_type in (
      'signup',
      'profile',
      'reward_account',
      'membership_payment',
      'membership_cycle',
      'support_ticket',
      'referral',
      'system'
    )
  ),
  entity_id uuid,
  title text,
  note text not null check (char_length(trim(note)) between 1 and 10000),
  is_internal boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_admin_notes_author_profile_id
  on public.admin_notes (author_profile_id);

create index if not exists idx_admin_notes_target_profile_id
  on public.admin_notes (target_profile_id);

create index if not exists idx_admin_notes_entity_type
  on public.admin_notes (entity_type);

create index if not exists idx_admin_notes_entity_id
  on public.admin_notes (entity_id);

create index if not exists idx_admin_notes_created_at
  on public.admin_notes (created_at desc);

drop trigger if exists trg_admin_notes_set_updated_at on public.admin_notes;

create trigger trg_admin_notes_set_updated_at
before update on public.admin_notes
for each row
execute function public.set_updated_at();

create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text,
  is_public boolean not null default false,
  updated_by_profile_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_system_settings_is_public
  on public.system_settings (is_public);

drop trigger if exists trg_system_settings_set_updated_at on public.system_settings;

create trigger trg_system_settings_set_updated_at
before update on public.system_settings
for each row
execute function public.set_updated_at();

create or replace function public.is_admin(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_roles ar
    where ar.profile_id = p_profile_id
  );
$$;

create or replace function public.log_admin_audit(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_ip_address inet default null,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_audit_logs (
    actor_profile_id,
    target_profile_id,
    entity_type,
    entity_id,
    action,
    title,
    description,
    metadata,
    ip_address,
    user_agent
  )
  values (
    p_actor_profile_id,
    p_target_profile_id,
    p_entity_type,
    p_entity_id,
    p_action,
    p_title,
    p_description,
    coalesce(p_metadata, '{}'::jsonb),
    p_ip_address,
    p_user_agent
  );
end;
$$;

insert into public.system_settings (key, value, description, is_public)
values
  (
    'rewards.program',
    jsonb_build_object(
      'enabled', true,
      'membership_monthly_amount', 20.00,
      'cardleo_amount', 10.00,
      'direct_referral_amount', 7.00,
      'override_referral_amount', 1.00,
      'company_building_amount', 2.00,
      'company_building_cycle_months', 4,
      'currency_code', 'USD'
    ),
    'Global cash-based rewards program settings for Card Leo Rewards.',
    false
  ),
  (
    'support.defaults',
    jsonb_build_object(
      'default_priority', 'normal',
      'default_category', 'general'
    ),
    'Default support ticket configuration values.',
    false
  ),
  (
    'portal.features',
    jsonb_build_object(
      'rewards_enabled', true,
      'referrals_enabled', true,
      'support_enabled', true,
      'benefits_enabled', true,
      'admin_enabled', true
    ),
    'Feature toggles used by the member portal and admin operations.',
    true
  )
on conflict (key) do nothing;

alter table public.admin_roles enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.admin_notes enable row level security;
alter table public.system_settings enable row level security;

comment on table public.admin_roles is 'Permission map for Card Leo Rewards admin and support operators.';
comment on table public.admin_audit_logs is 'Immutable-style admin activity log for sensitive operational actions.';
comment on table public.admin_notes is 'Internal notes used by staff for members, signups, rewards, referrals, and support workflows.';
comment on table public.system_settings is 'Centralized operational and feature settings for the platform.';

commit;