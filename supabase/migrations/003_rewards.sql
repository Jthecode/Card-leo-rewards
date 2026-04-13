-- supabase/migrations/003_rewards.sql

begin;

create table if not exists public.reward_accounts (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  account_status text not null default 'active' check (
    account_status in ('active', 'paused', 'suspended', 'closed')
  ),

  total_cardleo_allocated numeric(12,2) not null default 0.00 check (total_cardleo_allocated >= 0),
  total_direct_referral_earned numeric(12,2) not null default 0.00 check (total_direct_referral_earned >= 0),
  total_override_earned numeric(12,2) not null default 0.00 check (total_override_earned >= 0),

  company_building_pending numeric(12,2) not null default 0.00 check (company_building_pending >= 0),
  company_building_released numeric(12,2) not null default 0.00 check (company_building_released >= 0),
  company_building_forfeited numeric(12,2) not null default 0.00 check (company_building_forfeited >= 0),

  total_member_revenue_processed numeric(12,2) not null default 0.00 check (total_member_revenue_processed >= 0),
  total_rewards_earned numeric(12,2) not null default 0.00 check (total_rewards_earned >= 0),
  total_rewards_paid numeric(12,2) not null default 0.00 check (total_rewards_paid >= 0),

  last_membership_paid_at timestamptz,
  last_direct_referral_at timestamptz,
  last_override_at timestamptz,
  last_company_building_release_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_reward_accounts_set_updated_at on public.reward_accounts;

create trigger trg_reward_accounts_set_updated_at
before update on public.reward_accounts
for each row
execute function public.set_updated_at();

create table if not exists public.membership_cycles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,

  cycle_number integer not null check (cycle_number > 0),
  cycle_start_date date not null,
  cycle_end_date date not null,

  required_paid_months integer not null default 4 check (required_paid_months = 4),
  paid_months_count integer not null default 0 check (paid_months_count between 0 and 4),

  company_building_accrued numeric(12,2) not null default 0.00 check (company_building_accrued >= 0),
  company_building_released numeric(12,2) not null default 0.00 check (company_building_released >= 0),

  cycle_status text not null default 'open' check (
    cycle_status in ('open', 'completed', 'released', 'forfeited')
  ),

  completed_at timestamptz,
  released_at timestamptz,
  forfeited_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint membership_cycles_unique_profile_cycle unique (profile_id, cycle_number),
  constraint membership_cycles_valid_dates check (cycle_end_date >= cycle_start_date)
);

create index if not exists idx_membership_cycles_profile_id
  on public.membership_cycles (profile_id);

create index if not exists idx_membership_cycles_status
  on public.membership_cycles (cycle_status);

create index if not exists idx_membership_cycles_dates
  on public.membership_cycles (cycle_start_date, cycle_end_date);

drop trigger if exists trg_membership_cycles_set_updated_at on public.membership_cycles;

create trigger trg_membership_cycles_set_updated_at
before update on public.membership_cycles
for each row
execute function public.set_updated_at();

create table if not exists public.membership_payments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  membership_cycle_id uuid references public.membership_cycles (id) on delete set null,

  payment_month integer not null check (payment_month between 1 and 4),
  billing_period_start date,
  billing_period_end date,

  amount_charged numeric(12,2) not null default 20.00 check (amount_charged = 20.00),
  cardleo_amount numeric(12,2) not null default 10.00 check (cardleo_amount = 10.00),
  direct_referral_amount numeric(12,2) not null default 7.00 check (direct_referral_amount = 7.00),
  override_amount numeric(12,2) not null default 1.00 check (override_amount = 1.00),
  company_building_amount numeric(12,2) not null default 2.00 check (company_building_amount = 2.00),

  payment_status text not null default 'paid' check (
    payment_status in ('pending', 'paid', 'failed', 'refunded', 'voided')
  ),

  external_payment_id text,
  paid_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint membership_payments_unique_profile_cycle_month
    unique (profile_id, membership_cycle_id, payment_month)
);

create index if not exists idx_membership_payments_profile_id
  on public.membership_payments (profile_id);

create index if not exists idx_membership_payments_cycle_id
  on public.membership_payments (membership_cycle_id);

create index if not exists idx_membership_payments_status
  on public.membership_payments (payment_status);

create index if not exists idx_membership_payments_paid_at
  on public.membership_payments (paid_at desc);

drop trigger if exists trg_membership_payments_set_updated_at on public.membership_payments;

create trigger trg_membership_payments_set_updated_at
before update on public.membership_payments
for each row
execute function public.set_updated_at();

create table if not exists public.reward_transactions (
  id uuid primary key default gen_random_uuid(),

  profile_id uuid not null references public.profiles (id) on delete cascade,
  source_profile_id uuid references public.profiles (id) on delete set null,
  related_profile_id uuid references public.profiles (id) on delete set null,

  membership_payment_id uuid references public.membership_payments (id) on delete set null,
  membership_cycle_id uuid references public.membership_cycles (id) on delete set null,

  transaction_type text not null check (
    transaction_type in (
      'membership_payment_recorded',
      'cardleo_allocation',
      'direct_referral_bonus',
      'override_referral_bonus',
      'company_building_accrual',
      'company_building_release',
      'company_building_forfeit',
      'manual_adjustment',
      'reversal',
      'payout'
    )
  ),

  transaction_status text not null default 'posted' check (
    transaction_status in ('pending', 'posted', 'voided')
  ),

  amount numeric(12,2) not null check (amount >= 0),
  currency_code text not null default 'USD' check (currency_code = 'USD'),

  title text not null,
  description text,

  reference_type text check (
    reference_type in (
      'membership',
      'referral',
      'cycle',
      'manual',
      'system',
      'payout',
      'other'
    )
  ),
  reference_id uuid,

  metadata jsonb not null default '{}'::jsonb,
  posted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_reward_transactions_profile_id
  on public.reward_transactions (profile_id);

create index if not exists idx_reward_transactions_source_profile_id
  on public.reward_transactions (source_profile_id);

create index if not exists idx_reward_transactions_related_profile_id
  on public.reward_transactions (related_profile_id);

create index if not exists idx_reward_transactions_payment_id
  on public.reward_transactions (membership_payment_id);

create index if not exists idx_reward_transactions_cycle_id
  on public.reward_transactions (membership_cycle_id);

create index if not exists idx_reward_transactions_type
  on public.reward_transactions (transaction_type);

create index if not exists idx_reward_transactions_status
  on public.reward_transactions (transaction_status);

create index if not exists idx_reward_transactions_posted_at
  on public.reward_transactions (posted_at desc);

drop trigger if exists trg_reward_transactions_set_updated_at on public.reward_transactions;

create trigger trg_reward_transactions_set_updated_at
before update on public.reward_transactions
for each row
execute function public.set_updated_at();

create table if not exists public.reward_payouts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,

  payout_type text not null check (
    payout_type in (
      'direct_referral',
      'override_referral',
      'company_building',
      'manual'
    )
  ),

  payout_status text not null default 'pending' check (
    payout_status in ('pending', 'approved', 'paid', 'cancelled', 'failed')
  ),

  amount numeric(12,2) not null check (amount >= 0),
  currency_code text not null default 'USD' check (currency_code = 'USD'),

  period_start date,
  period_end date,
  paid_at timestamptz,

  external_payout_id text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_reward_payouts_profile_id
  on public.reward_payouts (profile_id);

create index if not exists idx_reward_payouts_type
  on public.reward_payouts (payout_type);

create index if not exists idx_reward_payouts_status
  on public.reward_payouts (payout_status);

create index if not exists idx_reward_payouts_created_at
  on public.reward_payouts (created_at desc);

drop trigger if exists trg_reward_payouts_set_updated_at on public.reward_payouts;

create trigger trg_reward_payouts_set_updated_at
before update on public.reward_payouts
for each row
execute function public.set_updated_at();

create or replace function public.ensure_reward_account(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.reward_accounts (profile_id)
  values (p_profile_id)
  on conflict (profile_id) do nothing;
end;
$$;

create or replace function public.handle_profile_reward_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_reward_account(new.id);
  return new;
end;
$$;

drop trigger if exists trg_profiles_create_reward_account on public.profiles;

create trigger trg_profiles_create_reward_account
after insert on public.profiles
for each row
execute function public.handle_profile_reward_account();

create or replace function public.sync_reward_account(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_cardleo_allocated numeric(12,2) := 0.00;
  v_total_direct_referral_earned numeric(12,2) := 0.00;
  v_total_override_earned numeric(12,2) := 0.00;
  v_company_building_pending numeric(12,2) := 0.00;
  v_company_building_released numeric(12,2) := 0.00;
  v_company_building_forfeited numeric(12,2) := 0.00;
  v_total_member_revenue_processed numeric(12,2) := 0.00;
  v_total_rewards_earned numeric(12,2) := 0.00;
  v_total_rewards_paid numeric(12,2) := 0.00;
  v_last_membership_paid_at timestamptz;
  v_last_direct_referral_at timestamptz;
  v_last_override_at timestamptz;
  v_last_company_building_release_at timestamptz;
begin
  perform public.ensure_reward_account(p_profile_id);

  select
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'cardleo_allocation'
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'direct_referral_bonus'
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'override_referral_bonus'
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status in ('pending', 'posted') and transaction_type = 'company_building_accrual'
        then amount else 0 end), 0.00)
      -
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type in ('company_building_release', 'company_building_forfeit')
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'company_building_release'
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'company_building_forfeit'
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'membership_payment_recorded'
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type in (
        'direct_referral_bonus',
        'override_referral_bonus',
        'company_building_release',
        'manual_adjustment'
      )
        then amount else 0 end), 0.00),
    coalesce(sum(case
      when transaction_status = 'posted' and transaction_type = 'payout'
        then amount else 0 end), 0.00),
    max(case
      when transaction_status = 'posted' and transaction_type = 'membership_payment_recorded'
        then posted_at end),
    max(case
      when transaction_status = 'posted' and transaction_type = 'direct_referral_bonus'
        then posted_at end),
    max(case
      when transaction_status = 'posted' and transaction_type = 'override_referral_bonus'
        then posted_at end),
    max(case
      when transaction_status = 'posted' and transaction_type = 'company_building_release'
        then posted_at end)
  into
    v_total_cardleo_allocated,
    v_total_direct_referral_earned,
    v_total_override_earned,
    v_company_building_pending,
    v_company_building_released,
    v_company_building_forfeited,
    v_total_member_revenue_processed,
    v_total_rewards_earned,
    v_total_rewards_paid,
    v_last_membership_paid_at,
    v_last_direct_referral_at,
    v_last_override_at,
    v_last_company_building_release_at
  from public.reward_transactions
  where profile_id = p_profile_id;

  update public.reward_accounts
  set
    total_cardleo_allocated = greatest(v_total_cardleo_allocated, 0.00),
    total_direct_referral_earned = greatest(v_total_direct_referral_earned, 0.00),
    total_override_earned = greatest(v_total_override_earned, 0.00),
    company_building_pending = greatest(v_company_building_pending, 0.00),
    company_building_released = greatest(v_company_building_released, 0.00),
    company_building_forfeited = greatest(v_company_building_forfeited, 0.00),
    total_member_revenue_processed = greatest(v_total_member_revenue_processed, 0.00),
    total_rewards_earned = greatest(v_total_rewards_earned, 0.00),
    total_rewards_paid = greatest(v_total_rewards_paid, 0.00),
    last_membership_paid_at = v_last_membership_paid_at,
    last_direct_referral_at = v_last_direct_referral_at,
    last_override_at = v_last_override_at,
    last_company_building_release_at = v_last_company_building_release_at,
    updated_at = timezone('utc', now())
  where profile_id = p_profile_id;
end;
$$;

create or replace function public.handle_reward_transaction_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.sync_reward_account(old.profile_id);
    return old;
  end if;

  perform public.sync_reward_account(new.profile_id);

  if tg_op = 'UPDATE' and old.profile_id is distinct from new.profile_id then
    perform public.sync_reward_account(old.profile_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reward_transactions_sync_account on public.reward_transactions;

create trigger trg_reward_transactions_sync_account
after insert or update or delete on public.reward_transactions
for each row
execute function public.handle_reward_transaction_sync();

create or replace function public.ensure_open_membership_cycle(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_id uuid;
  v_next_cycle_number integer;
  v_cycle_start date;
  v_cycle_end date;
begin
  select id
  into v_cycle_id
  from public.membership_cycles
  where profile_id = p_profile_id
    and cycle_status = 'open'
  order by cycle_number desc
  limit 1;

  if v_cycle_id is not null then
    return v_cycle_id;
  end if;

  select coalesce(max(cycle_number), 0) + 1
  into v_next_cycle_number
  from public.membership_cycles
  where profile_id = p_profile_id;

  v_cycle_start := current_date;
  v_cycle_end := (v_cycle_start + interval '4 months' - interval '1 day')::date;

  insert into public.membership_cycles (
    profile_id,
    cycle_number,
    cycle_start_date,
    cycle_end_date
  )
  values (
    p_profile_id,
    v_next_cycle_number,
    v_cycle_start,
    v_cycle_end
  )
  returning id into v_cycle_id;

  return v_cycle_id;
end;
$$;

alter table public.reward_accounts enable row level security;
alter table public.membership_cycles enable row level security;
alter table public.membership_payments enable row level security;
alter table public.reward_transactions enable row level security;
alter table public.reward_payouts enable row level security;

comment on table public.reward_accounts is 'Per-member reward and payout summary account for Card Leo Rewards cash-based commissions.';
comment on table public.membership_cycles is 'Four-month reward qualification cycles used for company-building release logic.';
comment on table public.membership_payments is 'Monthly $20 membership payment records with fixed Card Leo / referral / override / company-building split.';
comment on table public.reward_transactions is 'Ledger of all cash-based membership allocations, referral payouts, company-building accruals, releases, and adjustments.';
comment on table public.reward_payouts is 'Actual payout records for referral and company-building earnings.';

commit;