-- supabase/migrations/005_referrals.sql

begin;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),

  referrer_profile_id uuid not null references public.profiles (id) on delete cascade,
  referred_signup_id uuid references public.signups (id) on delete set null,
  referred_profile_id uuid references public.profiles (id) on delete set null,

  parent_referral_id uuid references public.referrals (id) on delete set null,
  level_depth integer not null default 1 check (level_depth in (1, 2)),

  direct_reward_transaction_id uuid references public.reward_transactions (id) on delete set null,
  override_reward_transaction_id uuid references public.reward_transactions (id) on delete set null,

  referral_code text not null,
  invite_code text not null unique,

  referred_email citext not null,
  referred_first_name text,
  referred_last_name text,

  status text not null default 'invited' check (
    status in (
      'invited',
      'opened',
      'registered',
      'activated',
      'qualified',
      'reward_pending',
      'rewarded',
      'expired',
      'cancelled'
    )
  ),

  source text not null default 'portal' check (
    source in ('portal', 'admin', 'campaign', 'manual', 'other')
  ),

  channel text not null default 'link' check (
    channel in ('link', 'email', 'sms', 'qr', 'manual', 'other')
  ),

  qualifies_for_direct_bonus boolean not null default false,
  qualifies_for_override_bonus boolean not null default false,

  direct_bonus_amount numeric(12,2) not null default 7.00 check (direct_bonus_amount = 7.00),
  override_bonus_amount numeric(12,2) not null default 1.00 check (override_bonus_amount = 1.00),

  opened_at timestamptz,
  registered_at timestamptz,
  activated_at timestamptz,
  qualified_at timestamptz,
  rewarded_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  invited_at timestamptz not null default timezone('utc', now()),

  notes text,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint referrals_referrer_email_unique unique (referrer_profile_id, referred_email)
);

create index if not exists idx_referrals_referrer_profile_id
  on public.referrals (referrer_profile_id);

create index if not exists idx_referrals_referred_signup_id
  on public.referrals (referred_signup_id);

create index if not exists idx_referrals_referred_profile_id
  on public.referrals (referred_profile_id);

create index if not exists idx_referrals_parent_referral_id
  on public.referrals (parent_referral_id);

create index if not exists idx_referrals_direct_reward_tx_id
  on public.referrals (direct_reward_transaction_id);

create index if not exists idx_referrals_override_reward_tx_id
  on public.referrals (override_reward_transaction_id);

create index if not exists idx_referrals_referral_code
  on public.referrals (referral_code);

create index if not exists idx_referrals_status
  on public.referrals (status);

create index if not exists idx_referrals_referred_email
  on public.referrals (referred_email);

create index if not exists idx_referrals_invited_at
  on public.referrals (invited_at desc);

drop trigger if exists trg_referrals_set_updated_at on public.referrals;

create trigger trg_referrals_set_updated_at
before update on public.referrals
for each row
execute function public.set_updated_at();

create table if not exists public.referral_events (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references public.referrals (id) on delete cascade,
  event_type text not null check (
    event_type in (
      'invite_created',
      'invite_opened',
      'signup_registered',
      'member_activated',
      'qualified',
      'direct_bonus_pending',
      'direct_bonus_posted',
      'override_bonus_posted',
      'expired',
      'cancelled',
      'note_added',
      'admin_updated'
    )
  ),
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_referral_events_referral_id
  on public.referral_events (referral_id);

create index if not exists idx_referral_events_event_type
  on public.referral_events (event_type);

create index if not exists idx_referral_events_occurred_at
  on public.referral_events (occurred_at desc);

create or replace function public.generate_invite_code()
returns text
language plpgsql
as $$
declare
  candidate text;
begin
  loop
    candidate := 'INV-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 10));
    exit when not exists (
      select 1
      from public.referrals
      where invite_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function public.handle_referral_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral_code text;
begin
  if new.invite_code is null or trim(new.invite_code) = '' then
    new.invite_code := public.generate_invite_code();
  end if;

  if new.referral_code is null or trim(new.referral_code) = '' then
    select referral_code
    into v_referral_code
    from public.profiles
    where id = new.referrer_profile_id;

    new.referral_code := v_referral_code;
  end if;

  if new.invited_at is null then
    new.invited_at := timezone('utc', now());
  end if;

  if new.level_depth is null then
    new.level_depth := 1;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_referrals_defaults on public.referrals;

create trigger trg_referrals_defaults
before insert on public.referrals
for each row
execute function public.handle_referral_defaults();

create or replace function public.handle_referral_status_timestamps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'opened' and old.status is distinct from 'opened' and new.opened_at is null then
    new.opened_at := timezone('utc', now());
  end if;

  if new.status = 'registered' and old.status is distinct from 'registered' and new.registered_at is null then
    new.registered_at := timezone('utc', now());
  end if;

  if new.status = 'activated' and old.status is distinct from 'activated' and new.activated_at is null then
    new.activated_at := timezone('utc', now());
  end if;

  if new.status = 'qualified' and old.status is distinct from 'qualified' and new.qualified_at is null then
    new.qualified_at := timezone('utc', now());
  end if;

  if new.status = 'rewarded' and old.status is distinct from 'rewarded' and new.rewarded_at is null then
    new.rewarded_at := timezone('utc', now());
  end if;

  if new.status = 'expired' and old.status is distinct from 'expired' and new.expired_at is null then
    new.expired_at := timezone('utc', now());
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.cancelled_at is null then
    new.cancelled_at := timezone('utc', now());
  end if;

  if new.referred_profile_id is not null and new.status = 'invited' then
    new.status := 'activated';
    if new.activated_at is null then
      new.activated_at := timezone('utc', now());
    end if;
  elsif new.referred_signup_id is not null and new.status = 'invited' then
    new.status := 'registered';
    if new.registered_at is null then
      new.registered_at := timezone('utc', now());
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_referrals_status_timestamps on public.referrals;

create trigger trg_referrals_status_timestamps
before update on public.referrals
for each row
execute function public.handle_referral_status_timestamps();

create or replace function public.log_referral_event(
  p_referral_id uuid,
  p_event_type text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.referral_events (
    referral_id,
    event_type,
    title,
    description,
    metadata
  )
  values (
    p_referral_id,
    p_event_type,
    p_title,
    p_description,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function public.handle_referral_event_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_referral_event(
      new.id,
      'invite_created',
      'Referral invite created',
      'A new referral invite was created for this member.',
      jsonb_build_object(
        'status', new.status,
        'channel', new.channel,
        'source', new.source,
        'referred_email', new.referred_email,
        'level_depth', new.level_depth
      )
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    perform public.log_referral_event(
      new.id,
      case new.status
        when 'opened' then 'invite_opened'
        when 'registered' then 'signup_registered'
        when 'activated' then 'member_activated'
        when 'qualified' then 'qualified'
        when 'reward_pending' then 'direct_bonus_pending'
        when 'rewarded' then 'direct_bonus_posted'
        when 'expired' then 'expired'
        when 'cancelled' then 'cancelled'
        else 'admin_updated'
      end,
      case new.status
        when 'opened' then 'Referral opened'
        when 'registered' then 'Referral registered'
        when 'activated' then 'Referral activated'
        when 'qualified' then 'Referral qualified'
        when 'reward_pending' then 'Referral reward pending'
        when 'rewarded' then 'Referral reward posted'
        when 'expired' then 'Referral expired'
        when 'cancelled' then 'Referral cancelled'
        else 'Referral updated'
      end,
      null,
      jsonb_build_object(
        'previous_status', old.status,
        'new_status', new.status
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_referrals_event_sync on public.referrals;

create trigger trg_referrals_event_sync
after insert or update on public.referrals
for each row
execute function public.handle_referral_event_sync();

create or replace function public.find_upline_referrer(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_upline_profile_id uuid;
begin
  select r.referrer_profile_id
  into v_upline_profile_id
  from public.referrals r
  where r.referred_profile_id = p_profile_id
    and r.status in ('activated', 'qualified', 'reward_pending', 'rewarded')
  order by r.created_at asc
  limit 1;

  return v_upline_profile_id;
end;
$$;

create or replace function public.qualify_referral(
  p_referral_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral record;
  v_upline_profile_id uuid;
  v_direct_tx_id uuid;
  v_override_tx_id uuid;
begin
  select *
  into v_referral
  from public.referrals
  where id = p_referral_id;

  if not found then
    raise exception 'Referral not found: %', p_referral_id;
  end if;

  if v_referral.status in ('rewarded', 'cancelled', 'expired') then
    return;
  end if;

  update public.referrals
  set
    status = 'qualified',
    qualifies_for_direct_bonus = true,
    qualified_at = coalesce(qualified_at, timezone('utc', now())),
    updated_at = timezone('utc', now())
  where id = p_referral_id;

  insert into public.reward_transactions (
    profile_id,
    source_profile_id,
    related_profile_id,
    transaction_type,
    transaction_status,
    amount,
    currency_code,
    title,
    description,
    reference_type,
    reference_id,
    metadata
  )
  values (
    v_referral.referrer_profile_id,
    v_referral.referrer_profile_id,
    v_referral.referred_profile_id,
    'direct_referral_bonus',
    'posted',
    7.00,
    'USD',
    'Direct referral bonus',
    'Direct referrer earned $7.00 from a qualified referral.',
    'referral',
    v_referral.id,
    jsonb_build_object(
      'referral_id', v_referral.id,
      'bonus_type', 'direct',
      'amount', 7.00
    )
  )
  returning id into v_direct_tx_id;

  v_upline_profile_id := public.find_upline_referrer(v_referral.referrer_profile_id);

  if v_upline_profile_id is not null then
    insert into public.reward_transactions (
      profile_id,
      source_profile_id,
      related_profile_id,
      transaction_type,
      transaction_status,
      amount,
      currency_code,
      title,
      description,
      reference_type,
      reference_id,
      metadata
    )
    values (
      v_upline_profile_id,
      v_referral.referrer_profile_id,
      v_referral.referred_profile_id,
      'override_referral_bonus',
      'posted',
      1.00,
      'USD',
      'Override referral bonus',
      'Upline referrer earned $1.00 override from second-level referral activity.',
      'referral',
      v_referral.id,
      jsonb_build_object(
        'referral_id', v_referral.id,
        'bonus_type', 'override',
        'amount', 1.00,
        'paid_to_profile_id', v_upline_profile_id
      )
    )
    returning id into v_override_tx_id;

    perform public.log_referral_event(
      v_referral.id,
      'override_bonus_posted',
      'Override referral bonus posted',
      'A $1.00 override bonus was posted to the upline referrer.',
      jsonb_build_object(
        'referral_id', v_referral.id,
        'override_transaction_id', v_override_tx_id,
        'upline_profile_id', v_upline_profile_id
      )
    );
  end if;

  update public.referrals
  set
    status = 'rewarded',
    qualifies_for_override_bonus = (v_upline_profile_id is not null),
    direct_reward_transaction_id = v_direct_tx_id,
    override_reward_transaction_id = v_override_tx_id,
    rewarded_at = timezone('utc', now()),
    updated_at = timezone('utc', now())
  where id = p_referral_id;

  perform public.log_referral_event(
    v_referral.id,
    'direct_bonus_posted',
    'Direct referral bonus posted',
    'A $7.00 direct referral bonus was posted.',
    jsonb_build_object(
      'referral_id', v_referral.id,
      'direct_transaction_id', v_direct_tx_id
    )
  );
end;
$$;

alter table public.referrals enable row level security;
alter table public.referral_events enable row level security;

comment on table public.referrals is 'Tracks referral invitations, conversions, and direct/upline reward linkage for Card Leo Rewards.';
comment on table public.referral_events is 'Timeline/history records for referral lifecycle activity and payout events.';

commit;