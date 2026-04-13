// lib/rewards.js

import { supabaseAdmin } from "./supabase-admin.js";

export const MEMBERSHIP_AMOUNT = 20.0;
export const CARDLEO_AMOUNT = 10.0;
export const DIRECT_REFERRAL_AMOUNT = 7.0;
export const OVERRIDE_REFERRAL_AMOUNT = 1.0;
export const COMPANY_BUILDING_AMOUNT = 2.0;
export const COMPANY_BUILDING_CYCLE_MONTHS = 4;

export const REWARD_TRANSACTION_TYPES = {
  MEMBERSHIP_PAYMENT_RECORDED: "membership_payment_recorded",
  CARDLEO_ALLOCATION: "cardleo_allocation",
  DIRECT_REFERRAL_BONUS: "direct_referral_bonus",
  OVERRIDE_REFERRAL_BONUS: "override_referral_bonus",
  COMPANY_BUILDING_ACCRUAL: "company_building_accrual",
  COMPANY_BUILDING_RELEASE: "company_building_release",
  COMPANY_BUILDING_FORFEIT: "company_building_forfeit",
  MANUAL_ADJUSTMENT: "manual_adjustment",
  REVERSAL: "reversal",
  PAYOUT: "payout",
};

export const REWARD_TRANSACTION_STATUSES = {
  PENDING: "pending",
  POSTED: "posted",
  VOIDED: "voided",
};

export const REWARD_REFERENCE_TYPES = {
  MEMBERSHIP: "membership",
  REFERRAL: "referral",
  CYCLE: "cycle",
  MANUAL: "manual",
  SYSTEM: "system",
  PAYOUT: "payout",
  OTHER: "other",
};

export const PAYOUT_TYPES = {
  DIRECT_REFERRAL: "direct_referral",
  OVERRIDE_REFERRAL: "override_referral",
  COMPANY_BUILDING: "company_building",
  MANUAL: "manual",
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLower(value, fallback = "") {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || fallback;
}

function toPositiveMoney(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Number(num.toFixed(2));
}

function toPositiveInteger(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ensureProfileId(profileId) {
  const normalized = normalizeText(profileId);
  if (!normalized) {
    throw new Error("profileId is required.");
  }
  return normalized;
}

function ensureMoneyAmount(amount, label = "amount") {
  const normalized = toPositiveMoney(amount, -1);
  if (normalized < 0) {
    throw new Error(`${label} must be a valid positive amount.`);
  }
  return normalized;
}

function normalizeTransactionType(value) {
  const normalized = normalizeLower(
    value,
    REWARD_TRANSACTION_TYPES.MANUAL_ADJUSTMENT
  );

  if (Object.values(REWARD_TRANSACTION_TYPES).includes(normalized)) {
    return normalized;
  }

  return REWARD_TRANSACTION_TYPES.MANUAL_ADJUSTMENT;
}

function normalizeTransactionStatus(value) {
  const normalized = normalizeLower(
    value,
    REWARD_TRANSACTION_STATUSES.POSTED
  );

  if (Object.values(REWARD_TRANSACTION_STATUSES).includes(normalized)) {
    return normalized;
  }

  return REWARD_TRANSACTION_STATUSES.POSTED;
}

function normalizeReferenceType(value) {
  const normalized = normalizeLower(
    value,
    REWARD_REFERENCE_TYPES.MANUAL
  );

  if (Object.values(REWARD_REFERENCE_TYPES).includes(normalized)) {
    return normalized;
  }

  return REWARD_REFERENCE_TYPES.MANUAL;
}

function normalizePayoutType(value) {
  const normalized = normalizeLower(value, PAYOUT_TYPES.MANUAL);

  if (Object.values(PAYOUT_TYPES).includes(normalized)) {
    return normalized;
  }

  return PAYOUT_TYPES.MANUAL;
}

function parseIsoDate(value, fieldName = "date") {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date.`);
  }

  return date.toISOString();
}

function normalizeRewardAccount(row) {
  if (!row) return null;

  return {
    profileId: row.profile_id,
    accountStatus: row.account_status || "active",
    totalCardleoAllocated: Number(row.total_cardleo_allocated || 0),
    totalDirectReferralEarned: Number(row.total_direct_referral_earned || 0),
    totalOverrideEarned: Number(row.total_override_earned || 0),
    companyBuildingPending: Number(row.company_building_pending || 0),
    companyBuildingReleased: Number(row.company_building_released || 0),
    companyBuildingForfeited: Number(row.company_building_forfeited || 0),
    totalMemberRevenueProcessed: Number(row.total_member_revenue_processed || 0),
    totalRewardsEarned: Number(row.total_rewards_earned || 0),
    totalRewardsPaid: Number(row.total_rewards_paid || 0),
    lastMembershipPaidAt: safeDate(row.last_membership_paid_at),
    lastDirectReferralAt: safeDate(row.last_direct_referral_at),
    lastOverrideAt: safeDate(row.last_override_at),
    lastCompanyBuildingReleaseAt: safeDate(row.last_company_building_release_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function normalizeMembershipCycle(row) {
  if (!row) return null;

  return {
    id: row.id,
    profileId: row.profile_id,
    cycleNumber: Number(row.cycle_number || 0),
    cycleStartDate: row.cycle_start_date || null,
    cycleEndDate: row.cycle_end_date || null,
    requiredPaidMonths: Number(row.required_paid_months || COMPANY_BUILDING_CYCLE_MONTHS),
    paidMonthsCount: Number(row.paid_months_count || 0),
    companyBuildingAccrued: Number(row.company_building_accrued || 0),
    companyBuildingReleased: Number(row.company_building_released || 0),
    cycleStatus: row.cycle_status || "open",
    completedAt: safeDate(row.completed_at),
    releasedAt: safeDate(row.released_at),
    forfeitedAt: safeDate(row.forfeited_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function normalizeMembershipPayment(row) {
  if (!row) return null;

  return {
    id: row.id,
    profileId: row.profile_id,
    membershipCycleId: row.membership_cycle_id || null,
    paymentMonth: Number(row.payment_month || 0),
    billingPeriodStart: row.billing_period_start || null,
    billingPeriodEnd: row.billing_period_end || null,
    amountCharged: Number(row.amount_charged || 0),
    cardleoAmount: Number(row.cardleo_amount || 0),
    directReferralAmount: Number(row.direct_referral_amount || 0),
    overrideAmount: Number(row.override_amount || 0),
    companyBuildingAmount: Number(row.company_building_amount || 0),
    paymentStatus: row.payment_status || "paid",
    externalPaymentId: row.external_payment_id || null,
    paidAt: safeDate(row.paid_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function normalizeRewardTransaction(row) {
  if (!row) return null;

  return {
    id: row.id,
    profileId: row.profile_id,
    sourceProfileId: row.source_profile_id || null,
    relatedProfileId: row.related_profile_id || null,
    membershipPaymentId: row.membership_payment_id || null,
    membershipCycleId: row.membership_cycle_id || null,
    transactionType: row.transaction_type || REWARD_TRANSACTION_TYPES.MANUAL_ADJUSTMENT,
    transactionStatus: row.transaction_status || REWARD_TRANSACTION_STATUSES.POSTED,
    amount: Number(row.amount || 0),
    currencyCode: row.currency_code || "USD",
    title: row.title || null,
    description: row.description || null,
    referenceType: row.reference_type || null,
    referenceId: row.reference_id || null,
    metadata: row.metadata || {},
    postedAt: safeDate(row.posted_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function normalizeRewardPayout(row) {
  if (!row) return null;

  return {
    id: row.id,
    profileId: row.profile_id,
    payoutType: row.payout_type || PAYOUT_TYPES.MANUAL,
    payoutStatus: row.payout_status || "pending",
    amount: Number(row.amount || 0),
    currencyCode: row.currency_code || "USD",
    periodStart: row.period_start || null,
    periodEnd: row.period_end || null,
    paidAt: safeDate(row.paid_at),
    externalPayoutId: row.external_payout_id || null,
    notes: row.notes || null,
    metadata: row.metadata || {},
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

async function ensureRewardAccount(profileId) {
  const normalizedProfileId = ensureProfileId(profileId);

  const result = await supabaseAdmin.rpc("ensure_reward_account", {
    p_profile_id: normalizedProfileId,
  });

  if (result.error) {
    throw new Error(`Unable to ensure reward account: ${result.error.message}`);
  }

  return true;
}

async function syncRewardAccount(profileId) {
  const normalizedProfileId = ensureProfileId(profileId);

  const result = await supabaseAdmin.rpc("sync_reward_account", {
    p_profile_id: normalizedProfileId,
  });

  if (result.error) {
    throw new Error(`Unable to sync reward account: ${result.error.message}`);
  }

  return true;
}

async function ensureOpenMembershipCycle(profileId) {
  const normalizedProfileId = ensureProfileId(profileId);

  const result = await supabaseAdmin.rpc("ensure_open_membership_cycle", {
    p_profile_id: normalizedProfileId,
  });

  if (result.error) {
    throw new Error(`Unable to ensure membership cycle: ${result.error.message}`);
  }

  return result.data;
}

async function getRewardAccount(profileId) {
  const normalizedProfileId = ensureProfileId(profileId);

  const result = await supabaseAdmin
    .from("reward_accounts")
    .select(`
      profile_id,
      account_status,
      total_cardleo_allocated,
      total_direct_referral_earned,
      total_override_earned,
      company_building_pending,
      company_building_released,
      company_building_forfeited,
      total_member_revenue_processed,
      total_rewards_earned,
      total_rewards_paid,
      last_membership_paid_at,
      last_direct_referral_at,
      last_override_at,
      last_company_building_release_at,
      created_at,
      updated_at
    `)
    .eq("profile_id", normalizedProfileId)
    .maybeSingle();

  if (result.error) {
    throw new Error(`Unable to load reward account: ${result.error.message}`);
  }

  return normalizeRewardAccount(result.data);
}

async function getOpenMembershipCycle(profileId) {
  const normalizedProfileId = ensureProfileId(profileId);

  const result = await supabaseAdmin
    .from("membership_cycles")
    .select(`
      id,
      profile_id,
      cycle_number,
      cycle_start_date,
      cycle_end_date,
      required_paid_months,
      paid_months_count,
      company_building_accrued,
      company_building_released,
      cycle_status,
      completed_at,
      released_at,
      forfeited_at,
      created_at,
      updated_at
    `)
    .eq("profile_id", normalizedProfileId)
    .eq("cycle_status", "open")
    .order("cycle_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    throw new Error(`Unable to load open membership cycle: ${result.error.message}`);
  }

  return normalizeMembershipCycle(result.data);
}

async function getMembershipCycles(profileId, { limit = 12 } = {}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 100));

  const result = await supabaseAdmin
    .from("membership_cycles")
    .select(`
      id,
      profile_id,
      cycle_number,
      cycle_start_date,
      cycle_end_date,
      required_paid_months,
      paid_months_count,
      company_building_accrued,
      company_building_released,
      cycle_status,
      completed_at,
      released_at,
      forfeited_at,
      created_at,
      updated_at
    `)
    .eq("profile_id", normalizedProfileId)
    .order("cycle_number", { ascending: false })
    .limit(safeLimit);

  if (result.error) {
    throw new Error(`Unable to load membership cycles: ${result.error.message}`);
  }

  return (result.data || []).map(normalizeMembershipCycle);
}

async function getMembershipPayments(profileId, { limit = 24 } = {}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 24, 200));

  const result = await supabaseAdmin
    .from("membership_payments")
    .select(`
      id,
      profile_id,
      membership_cycle_id,
      payment_month,
      billing_period_start,
      billing_period_end,
      amount_charged,
      cardleo_amount,
      direct_referral_amount,
      override_amount,
      company_building_amount,
      payment_status,
      external_payment_id,
      paid_at,
      created_at,
      updated_at
    `)
    .eq("profile_id", normalizedProfileId)
    .order("paid_at", { ascending: false })
    .limit(safeLimit);

  if (result.error) {
    throw new Error(`Unable to load membership payments: ${result.error.message}`);
  }

  return (result.data || []).map(normalizeMembershipPayment);
}

async function getRewardHistory(
  profileId,
  {
    limit = 20,
    transactionType = "",
    transactionStatus = "",
    referenceType = "",
  } = {}
) {
  const normalizedProfileId = ensureProfileId(profileId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));

  let query = supabaseAdmin
    .from("reward_transactions")
    .select(`
      id,
      profile_id,
      source_profile_id,
      related_profile_id,
      membership_payment_id,
      membership_cycle_id,
      transaction_type,
      transaction_status,
      amount,
      currency_code,
      title,
      description,
      reference_type,
      reference_id,
      metadata,
      posted_at,
      created_at,
      updated_at
    `)
    .eq("profile_id", normalizedProfileId)
    .order("posted_at", { ascending: false })
    .limit(safeLimit);

  if (normalizeText(transactionType)) {
    query = query.eq("transaction_type", normalizeLower(transactionType));
  }

  if (normalizeText(transactionStatus)) {
    query = query.eq("transaction_status", normalizeLower(transactionStatus));
  }

  if (normalizeText(referenceType)) {
    query = query.eq("reference_type", normalizeLower(referenceType));
  }

  const result = await query;

  if (result.error) {
    throw new Error(`Unable to load reward history: ${result.error.message}`);
  }

  return (result.data || []).map(normalizeRewardTransaction);
}

async function getRewardPayouts(profileId, { limit = 20, payoutType = "" } = {}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));

  let query = supabaseAdmin
    .from("reward_payouts")
    .select(`
      id,
      profile_id,
      payout_type,
      payout_status,
      amount,
      currency_code,
      period_start,
      period_end,
      paid_at,
      external_payout_id,
      notes,
      metadata,
      created_at,
      updated_at
    `)
    .eq("profile_id", normalizedProfileId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (normalizeText(payoutType)) {
    query = query.eq("payout_type", normalizePayoutType(payoutType));
  }

  const result = await query;

  if (result.error) {
    throw new Error(`Unable to load reward payouts: ${result.error.message}`);
  }

  return (result.data || []).map(normalizeRewardPayout);
}

async function createRewardTransaction({
  profileId,
  sourceProfileId = null,
  relatedProfileId = null,
  membershipPaymentId = null,
  membershipCycleId = null,
  transactionType,
  transactionStatus = REWARD_TRANSACTION_STATUSES.POSTED,
  amount,
  title,
  description = "",
  referenceType = REWARD_REFERENCE_TYPES.MANUAL,
  referenceId = null,
  metadata = {},
}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const normalizedAmount = ensureMoneyAmount(amount);
  const normalizedTransactionType = normalizeTransactionType(transactionType);
  const normalizedStatus = normalizeTransactionStatus(transactionStatus);
  const normalizedReferenceType = normalizeReferenceType(referenceType);

  const result = await supabaseAdmin
    .from("reward_transactions")
    .insert({
      profile_id: normalizedProfileId,
      source_profile_id: normalizeText(sourceProfileId) || null,
      related_profile_id: normalizeText(relatedProfileId) || null,
      membership_payment_id: normalizeText(membershipPaymentId) || null,
      membership_cycle_id: normalizeText(membershipCycleId) || null,
      transaction_type: normalizedTransactionType,
      transaction_status: normalizedStatus,
      amount: normalizedAmount,
      currency_code: "USD",
      title: normalizeText(title) || normalizedTransactionType,
      description: normalizeText(description) || null,
      reference_type: normalizedReferenceType,
      reference_id: normalizeText(referenceId) || null,
      metadata: metadata || {},
    })
    .select(`
      id,
      profile_id,
      source_profile_id,
      related_profile_id,
      membership_payment_id,
      membership_cycle_id,
      transaction_type,
      transaction_status,
      amount,
      currency_code,
      title,
      description,
      reference_type,
      reference_id,
      metadata,
      posted_at,
      created_at,
      updated_at
    `)
    .maybeSingle();

  if (result.error) {
    throw new Error(`Unable to create reward transaction: ${result.error.message}`);
  }

  await syncRewardAccount(normalizedProfileId);

  return normalizeRewardTransaction(result.data);
}

async function createRewardPayout({
  profileId,
  payoutType,
  amount,
  payoutStatus = "pending",
  periodStart = null,
  periodEnd = null,
  paidAt = null,
  externalPayoutId = null,
  notes = "",
  metadata = {},
}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const normalizedAmount = ensureMoneyAmount(amount);
  const normalizedPayoutType = normalizePayoutType(payoutType);

  const result = await supabaseAdmin
    .from("reward_payouts")
    .insert({
      profile_id: normalizedProfileId,
      payout_type: normalizedPayoutType,
      payout_status: normalizeLower(payoutStatus, "pending"),
      amount: normalizedAmount,
      currency_code: "USD",
      period_start: periodStart || null,
      period_end: periodEnd || null,
      paid_at: parseIsoDate(paidAt, "paidAt"),
      external_payout_id: normalizeText(externalPayoutId) || null,
      notes: normalizeText(notes) || null,
      metadata: metadata || {},
    })
    .select(`
      id,
      profile_id,
      payout_type,
      payout_status,
      amount,
      currency_code,
      period_start,
      period_end,
      paid_at,
      external_payout_id,
      notes,
      metadata,
      created_at,
      updated_at
    `)
    .maybeSingle();

  if (result.error) {
    throw new Error(`Unable to create reward payout: ${result.error.message}`);
  }

  return normalizeRewardPayout(result.data);
}

async function recordMembershipPayment({
  profileId,
  paidAt = null,
  billingPeriodStart = null,
  billingPeriodEnd = null,
  externalPaymentId = null,
  metadata = {},
}) {
  const normalizedProfileId = ensureProfileId(profileId);

  await ensureRewardAccount(normalizedProfileId);

  let cycle = await getOpenMembershipCycle(normalizedProfileId);

  if (!cycle) {
    const cycleId = await ensureOpenMembershipCycle(normalizedProfileId);

    const cycleResult = await supabaseAdmin
      .from("membership_cycles")
      .select(`
        id,
        profile_id,
        cycle_number,
        cycle_start_date,
        cycle_end_date,
        required_paid_months,
        paid_months_count,
        company_building_accrued,
        company_building_released,
        cycle_status,
        completed_at,
        released_at,
        forfeited_at,
        created_at,
        updated_at
      `)
      .eq("id", cycleId)
      .maybeSingle();

    if (cycleResult.error) {
      throw new Error(`Unable to load new membership cycle: ${cycleResult.error.message}`);
    }

    cycle = normalizeMembershipCycle(cycleResult.data);
  }

  const paymentMonth = Math.min((Number(cycle?.paidMonthsCount || 0) + 1), 4);

  const paymentInsert = await supabaseAdmin
    .from("membership_payments")
    .insert({
      profile_id: normalizedProfileId,
      membership_cycle_id: cycle.id,
      payment_month: paymentMonth,
      billing_period_start: billingPeriodStart || null,
      billing_period_end: billingPeriodEnd || null,
      amount_charged: MEMBERSHIP_AMOUNT,
      cardleo_amount: CARDLEO_AMOUNT,
      direct_referral_amount: DIRECT_REFERRAL_AMOUNT,
      override_amount: OVERRIDE_REFERRAL_AMOUNT,
      company_building_amount: COMPANY_BUILDING_AMOUNT,
      payment_status: "paid",
      external_payment_id: normalizeText(externalPaymentId) || null,
      paid_at: parseIsoDate(paidAt, "paidAt") || new Date().toISOString(),
    })
    .select(`
      id,
      profile_id,
      membership_cycle_id,
      payment_month,
      billing_period_start,
      billing_period_end,
      amount_charged,
      cardleo_amount,
      direct_referral_amount,
      override_amount,
      company_building_amount,
      payment_status,
      external_payment_id,
      paid_at,
      created_at,
      updated_at
    `)
    .maybeSingle();

  if (paymentInsert.error) {
    throw new Error(`Unable to record membership payment: ${paymentInsert.error.message}`);
  }

  const payment = normalizeMembershipPayment(paymentInsert.data);

  const txMembership = await createRewardTransaction({
    profileId: normalizedProfileId,
    membershipPaymentId: payment.id,
    membershipCycleId: payment.membershipCycleId,
    transactionType: REWARD_TRANSACTION_TYPES.MEMBERSHIP_PAYMENT_RECORDED,
    amount: MEMBERSHIP_AMOUNT,
    title: "Membership payment recorded",
    description: "Monthly membership payment was successfully recorded.",
    referenceType: REWARD_REFERENCE_TYPES.MEMBERSHIP,
    referenceId: payment.id,
    metadata: {
      paymentMonth: payment.paymentMonth,
      externalPaymentId: payment.externalPaymentId,
      ...metadata,
    },
  });

  const txCardleo = await createRewardTransaction({
    profileId: normalizedProfileId,
    membershipPaymentId: payment.id,
    membershipCycleId: payment.membershipCycleId,
    transactionType: REWARD_TRANSACTION_TYPES.CARDLEO_ALLOCATION,
    amount: CARDLEO_AMOUNT,
    title: "Card Leo allocation",
    description: "Card Leo share allocated from membership payment.",
    referenceType: REWARD_REFERENCE_TYPES.MEMBERSHIP,
    referenceId: payment.id,
    metadata: {
      paymentMonth: payment.paymentMonth,
    },
  });

  const txCompanyAccrual = await createRewardTransaction({
    profileId: normalizedProfileId,
    membershipPaymentId: payment.id,
    membershipCycleId: payment.membershipCycleId,
    transactionType: REWARD_TRANSACTION_TYPES.COMPANY_BUILDING_ACCRUAL,
    amount: COMPANY_BUILDING_AMOUNT,
    title: "Company-building accrual",
    description: "Company-building amount accrued for this paid membership month.",
    referenceType: REWARD_REFERENCE_TYPES.CYCLE,
    referenceId: payment.membershipCycleId,
    metadata: {
      paymentMonth: payment.paymentMonth,
      cycleNumber: cycle.cycleNumber,
    },
  });

  const cycleUpdate = await supabaseAdmin
    .from("membership_cycles")
    .update({
      paid_months_count: paymentMonth,
      company_building_accrued: Number(
        (Number(cycle.companyBuildingAccrued || 0) + COMPANY_BUILDING_AMOUNT).toFixed(2)
      ),
      cycle_status: paymentMonth >= COMPANY_BUILDING_CYCLE_MONTHS ? "completed" : "open",
      completed_at:
        paymentMonth >= COMPANY_BUILDING_CYCLE_MONTHS
          ? new Date().toISOString()
          : null,
    })
    .eq("id", cycle.id)
    .select(`
      id,
      profile_id,
      cycle_number,
      cycle_start_date,
      cycle_end_date,
      required_paid_months,
      paid_months_count,
      company_building_accrued,
      company_building_released,
      cycle_status,
      completed_at,
      released_at,
      forfeited_at,
      created_at,
      updated_at
    `)
    .maybeSingle();

  if (cycleUpdate.error) {
    throw new Error(`Unable to update membership cycle: ${cycleUpdate.error.message}`);
  }

  const updatedCycle = normalizeMembershipCycle(cycleUpdate.data);

  let companyBuildingRelease = null;

  if (
    updatedCycle &&
    updatedCycle.paidMonthsCount >= COMPANY_BUILDING_CYCLE_MONTHS &&
    updatedCycle.cycleStatus === "completed" &&
    Number(updatedCycle.companyBuildingReleased || 0) === 0
  ) {
    companyBuildingRelease = await releaseCompanyBuildingCycle({
      profileId: normalizedProfileId,
      membershipCycleId: updatedCycle.id,
      amount: updatedCycle.companyBuildingAccrued,
    });
  }

  return {
    payment,
    cycle: updatedCycle,
    transactions: {
      membership: txMembership,
      cardleo: txCardleo,
      companyBuildingAccrual: txCompanyAccrual,
      companyBuildingRelease,
    },
    account: await getRewardAccount(normalizedProfileId),
  };
}

async function releaseCompanyBuildingCycle({
  profileId,
  membershipCycleId,
  amount,
}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const normalizedCycleId = normalizeText(membershipCycleId);

  if (!normalizedCycleId) {
    throw new Error("membershipCycleId is required.");
  }

  const normalizedAmount = ensureMoneyAmount(amount, "companyBuildingRelease amount");

  const transaction = await createRewardTransaction({
    profileId: normalizedProfileId,
    membershipCycleId: normalizedCycleId,
    transactionType: REWARD_TRANSACTION_TYPES.COMPANY_BUILDING_RELEASE,
    amount: normalizedAmount,
    title: "Company-building release",
    description: "Company-building earnings released after 4 fully paid months.",
    referenceType: REWARD_REFERENCE_TYPES.CYCLE,
    referenceId: normalizedCycleId,
    metadata: {
      releaseMonthsRequired: COMPANY_BUILDING_CYCLE_MONTHS,
    },
  });

  const cycleUpdate = await supabaseAdmin
    .from("membership_cycles")
    .update({
      company_building_released: normalizedAmount,
      cycle_status: "released",
      released_at: new Date().toISOString(),
    })
    .eq("id", normalizedCycleId)
    .select(`
      id,
      profile_id,
      cycle_number,
      cycle_start_date,
      cycle_end_date,
      required_paid_months,
      paid_months_count,
      company_building_accrued,
      company_building_released,
      cycle_status,
      completed_at,
      released_at,
      forfeited_at,
      created_at,
      updated_at
    `)
    .maybeSingle();

  if (cycleUpdate.error) {
    throw new Error(`Unable to release company-building cycle: ${cycleUpdate.error.message}`);
  }

  return {
    transaction,
    cycle: normalizeMembershipCycle(cycleUpdate.data),
  };
}

async function forfeitCompanyBuildingCycle({
  profileId,
  membershipCycleId,
  amount,
  reason = "Cycle forfeited before completing all required paid months.",
}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const normalizedCycleId = normalizeText(membershipCycleId);

  if (!normalizedCycleId) {
    throw new Error("membershipCycleId is required.");
  }

  const normalizedAmount = ensureMoneyAmount(amount, "companyBuildingForfeit amount");

  const transaction = await createRewardTransaction({
    profileId: normalizedProfileId,
    membershipCycleId: normalizedCycleId,
    transactionType: REWARD_TRANSACTION_TYPES.COMPANY_BUILDING_FORFEIT,
    amount: normalizedAmount,
    title: "Company-building forfeited",
    description: normalizeText(reason),
    referenceType: REWARD_REFERENCE_TYPES.CYCLE,
    referenceId: normalizedCycleId,
    metadata: {
      forfeited: true,
    },
  });

  const cycleUpdate = await supabaseAdmin
    .from("membership_cycles")
    .update({
      cycle_status: "forfeited",
      forfeited_at: new Date().toISOString(),
    })
    .eq("id", normalizedCycleId)
    .select(`
      id,
      profile_id,
      cycle_number,
      cycle_start_date,
      cycle_end_date,
      required_paid_months,
      paid_months_count,
      company_building_accrued,
      company_building_released,
      cycle_status,
      completed_at,
      released_at,
      forfeited_at,
      created_at,
      updated_at
    `)
    .maybeSingle();

  if (cycleUpdate.error) {
    throw new Error(`Unable to forfeit company-building cycle: ${cycleUpdate.error.message}`);
  }

  return {
    transaction,
    cycle: normalizeMembershipCycle(cycleUpdate.data),
  };
}

async function createManualRewardTransaction({
  profileId,
  transactionType = REWARD_TRANSACTION_TYPES.MANUAL_ADJUSTMENT,
  amount,
  title,
  description = "",
  referenceType = REWARD_REFERENCE_TYPES.MANUAL,
  referenceId = null,
  transactionStatus = REWARD_TRANSACTION_STATUSES.POSTED,
  metadata = {},
  sourceProfileId = null,
  relatedProfileId = null,
}) {
  const transaction = await createRewardTransaction({
    profileId,
    sourceProfileId,
    relatedProfileId,
    transactionType,
    transactionStatus,
    amount,
    title,
    description,
    referenceType,
    referenceId,
    metadata: {
      manual: true,
      ...metadata,
    },
  });

  return {
    transaction,
    account: await getRewardAccount(profileId),
  };
}

async function markPayoutPaid({
  profileId,
  payoutType,
  amount,
  periodStart = null,
  periodEnd = null,
  paidAt = null,
  externalPayoutId = null,
  notes = "",
  metadata = {},
}) {
  const normalizedProfileId = ensureProfileId(profileId);
  const normalizedAmount = ensureMoneyAmount(amount);

  const payout = await createRewardPayout({
    profileId: normalizedProfileId,
    payoutType,
    amount: normalizedAmount,
    payoutStatus: "paid",
    periodStart,
    periodEnd,
    paidAt: paidAt || new Date().toISOString(),
    externalPayoutId,
    notes,
    metadata,
  });

  const payoutTransaction = await createRewardTransaction({
    profileId: normalizedProfileId,
    transactionType: REWARD_TRANSACTION_TYPES.PAYOUT,
    amount: normalizedAmount,
    title: "Reward payout recorded",
    description: "A payout has been recorded against reward earnings.",
    referenceType: REWARD_REFERENCE_TYPES.PAYOUT,
    referenceId: payout.id,
    metadata: {
      payoutType: payout.payoutType,
      periodStart: payout.periodStart,
      periodEnd: payout.periodEnd,
      ...metadata,
    },
  });

  return {
    payout,
    transaction: payoutTransaction,
    account: await getRewardAccount(normalizedProfileId),
  };
}

async function getRewardDashboard(profileId, { recentLimit = 10 } = {}) {
  const normalizedProfileId = ensureProfileId(profileId);

  await ensureRewardAccount(normalizedProfileId);

  const [
    account,
    recentTransactions,
    recentPayouts,
    recentPayments,
    cycles,
  ] = await Promise.all([
    getRewardAccount(normalizedProfileId),
    getRewardHistory(normalizedProfileId, { limit: recentLimit }),
    getRewardPayouts(normalizedProfileId, { limit: recentLimit }),
    getMembershipPayments(normalizedProfileId, { limit: recentLimit }),
    getMembershipCycles(normalizedProfileId, { limit: 6 }),
  ]);

  return {
    account,
    recentTransactions,
    recentPayouts,
    recentPayments,
    cycles,
    summary: {
      membershipMonthlyAmount: MEMBERSHIP_AMOUNT,
      cardleoAmount: CARDLEO_AMOUNT,
      directReferralAmount: DIRECT_REFERRAL_AMOUNT,
      overrideReferralAmount: OVERRIDE_REFERRAL_AMOUNT,
      companyBuildingAmount: COMPANY_BUILDING_AMOUNT,
      companyBuildingCycleMonths: COMPANY_BUILDING_CYCLE_MONTHS,
      totalCardleoAllocated: Number(account?.totalCardleoAllocated || 0),
      totalDirectReferralEarned: Number(account?.totalDirectReferralEarned || 0),
      totalOverrideEarned: Number(account?.totalOverrideEarned || 0),
      companyBuildingPending: Number(account?.companyBuildingPending || 0),
      companyBuildingReleased: Number(account?.companyBuildingReleased || 0),
      companyBuildingForfeited: Number(account?.companyBuildingForfeited || 0),
      totalRewardsEarned: Number(account?.totalRewardsEarned || 0),
      totalRewardsPaid: Number(account?.totalRewardsPaid || 0),
      recentTransactionCount: Number(recentTransactions.length || 0),
      recentPayoutCount: Number(recentPayouts.length || 0),
      recentPaymentCount: Number(recentPayments.length || 0),
    },
  };
}

const rewards = {
  ensureRewardAccount,
  syncRewardAccount,
  ensureOpenMembershipCycle,
  getRewardAccount,
  getOpenMembershipCycle,
  getMembershipCycles,
  getMembershipPayments,
  getRewardHistory,
  getRewardPayouts,
  getRewardDashboard,
  createRewardTransaction,
  createRewardPayout,
  createManualRewardTransaction,
  recordMembershipPayment,
  releaseCompanyBuildingCycle,
  forfeitCompanyBuildingCycle,
  markPayoutPaid,
};

export default rewards;

export {
  ensureRewardAccount,
  syncRewardAccount,
  ensureOpenMembershipCycle,
  getRewardAccount,
  getOpenMembershipCycle,
  getMembershipCycles,
  getMembershipPayments,
  getRewardHistory,
  getRewardPayouts,
  getRewardDashboard,
  createRewardTransaction,
  createRewardPayout,
  createManualRewardTransaction,
  recordMembershipPayment,
  releaseCompanyBuildingCycle,
  forfeitCompanyBuildingCycle,
  markPayoutPaid,
};