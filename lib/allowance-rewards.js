// lib/allowance-rewards.js

import { supabaseAdmin } from "./supabase-admin.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #14
   REWARD → ALLOWANCE BRIDGE

   PURPOSE
   -------
   Converts qualified Card Leo rewards into PERSONAL member allowance records.

   PERSONAL MEMBER ALLOWANCE
   -------------------------
   Direct Referral:
     +$7.00

   Team / Override Referral:
     +$1.00

   COMPANY GROWTH POOL
   -------------------
   +$2.00 per applicable activated member

   IMPORTANT
   ---------
   The $2 Growth Pool does NOT become personal member allowance.

   This helper creates records in:

     allowance_transactions

   It DOES NOT:
   - create Lithic cards
   - move actual money
   - perform book transfers
   - add Growth Pool money to member cards

   Actual card funding later happens through:

     /api/cards/fund-allowance

============================================================================ */

/* ==========================================================================
   CONSTANTS
============================================================================ */

const DIRECT_REFERRAL_REWARD_CENTS =
  700;

const TEAM_REFERRAL_REWARD_CENTS =
  100;

const GROWTH_POOL_CONTRIBUTION_CENTS =
  200;

const DEFAULT_CURRENCY =
  "USD";

const DEFAULT_ALLOWANCE_STATUS =
  "approved";

const ALLOWANCE_TRANSACTIONS_TABLE =
  "allowance_transactions";

const MEMBER_CARDS_TABLE =
  "member_cards";

/* ==========================================================================
   ACTIVE MEMBER STATUS
============================================================================ */

const ACTIVE_MEMBER_STATUSES =
  new Set([
    "active",
    "approved",
    "paid",
    "current",
    "complete",
    "completed",
    "succeeded",
    "auto_approved",
  ]);

const ACTIVE_PAYMENT_STATUSES =
  new Set([
    "paid",
    "active",
    "current",
    "complete",
    "completed",
    "succeeded",
  ]);

const ACTIVE_MEMBERSHIP_STATUSES =
  new Set([
    "active",
    "activated",
    "approved",
    "paid",
    "current",
  ]);

/* ==========================================================================
   BASIC HELPERS
============================================================================ */

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeEmail(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeStatus(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeUuid(
  value
) {
  const clean =
    normalizeString(
      value
    );

  if (!clean) {
    return "";
  }

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return uuidRegex.test(
    clean
  )
    ? clean
    : "";
}

function normalizePositiveInteger(
  value,
  fallback = 0
) {
  const parsed =
    Number.parseInt(
      String(
        value ?? ""
      ),
      10
    );

  if (
    !Number.isFinite(
      parsed
    ) ||
    parsed <= 0
  ) {
    return fallback;
  }

  return parsed;
}

function centsToDollars(
  cents
) {
  const amount =
    Number(
      cents || 0
    );

  if (
    !Number.isFinite(
      amount
    )
  ) {
    return 0;
  }

  return Number(
    (
      amount / 100
    ).toFixed(2)
  );
}

function nowIso() {
  return new Date()
    .toISOString();
}

function isObject(
  value
) {
  return (
    Boolean(value) &&
    typeof value ===
      "object" &&
    !Array.isArray(
      value
    )
  );
}

/* ==========================================================================
   DATABASE COMPATIBILITY
============================================================================ */

function isMissingTableOrColumn(
  error
) {
  const code =
    String(
      error?.code ||
      ""
    );

  const message =
    String(
      error?.message ||
      ""
    ).toLowerCase();

  const details =
    String(
      error?.details ||
      ""
    ).toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||

    message.includes(
      "does not exist"
    ) ||

    message.includes(
      "could not find"
    ) ||

    message.includes(
      "schema cache"
    ) ||

    details.includes(
      "does not exist"
    ) ||

    details.includes(
      "could not find"
    )
  );
}

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

function isMemberActive(
  member = {}
) {
  const status =
    normalizeStatus(
      member.status
    );

  const paymentStatus =
    normalizeStatus(
      member.payment_status
    );

  const membershipStatus =
    normalizeStatus(
      member.membership_status
    );

  const approvalStatus =
    normalizeStatus(
      member.approval_status
    );

  const paid =
    ACTIVE_PAYMENT_STATUSES.has(
      paymentStatus
    ) ||
    paymentStatus === "";

  const active =
    ACTIVE_MEMBER_STATUSES.has(
      status
    ) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    ) ||
    ACTIVE_MEMBER_STATUSES.has(
      approvalStatus
    );

  return (
    paid &&
    active
  );
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function getMemberById(
  memberId
) {
  const id =
    normalizeUuid(
      memberId
    );

  if (!id) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "signups"
      )
      .select(
        [
          "id",
          "email",
          "first_name",
          "last_name",
          "full_name",
          "status",
          "payment_status",
          "membership_status",
          "approval_status",
          "referral_code",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq(
        "id",
        id
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      const fallback =
        await supabaseAdmin
          .from(
            "signups"
          )
          .select(
            [
              "id",
              "email",
              "first_name",
              "last_name",
              "full_name",
              "status",
              "created_at",
              "updated_at",
            ].join(", ")
          )
          .eq(
            "id",
            id
          )
          .maybeSingle();

      if (
        fallback.error
      ) {
        throw fallback.error;
      }

      return (
        fallback.data ||
        null
      );
    }

    throw error;
  }

  return (
    data ||
    null
  );
}

async function getMemberByEmail(
  email
) {
  const cleanEmail =
    normalizeEmail(
      email
    );

  if (!cleanEmail) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "signups"
      )
      .select(
        [
          "id",
          "email",
          "first_name",
          "last_name",
          "full_name",
          "status",
          "payment_status",
          "membership_status",
          "approval_status",
          "referral_code",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .ilike(
        "email",
        cleanEmail
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      const fallback =
        await supabaseAdmin
          .from(
            "signups"
          )
          .select(
            [
              "id",
              "email",
              "first_name",
              "last_name",
              "full_name",
              "status",
              "created_at",
              "updated_at",
            ].join(", ")
          )
          .ilike(
            "email",
            cleanEmail
          )
          .maybeSingle();

      if (
        fallback.error
      ) {
        throw fallback.error;
      }

      return (
        fallback.data ||
        null
      );
    }

    throw error;
  }

  return (
    data ||
    null
  );
}

/* ==========================================================================
   MEMBER CARD LOOKUP
============================================================================ */

async function getMemberCard(
  memberId
) {
  const id =
    normalizeUuid(
      memberId
    );

  if (!id) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        MEMBER_CARDS_TABLE
      )
      .select(
        [
          "id",
          "member_id",
          "provider",
          "card_status",
          "card_type",
          "last_four",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq(
        "member_id",
        id
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return (
    data ||
    null
  );
}

/* ==========================================================================
   SOURCE REWARD ID
============================================================================ */

function normalizeSourceRewardId(
  value
) {
  return normalizeUuid(
    value
  );
}

/* ==========================================================================
   ALLOWANCE TYPE
============================================================================ */

function getAllowanceDefinition(
  rewardType
) {
  const type =
    normalizeStatus(
      rewardType
    );

  if (
    [
      "direct",
      "direct_referral",
      "direct-referral",
      "direct referral",
      "referral",
    ].includes(
      type
    )
  ) {
    return {
      transactionType:
        "direct_referral",

      source:
        "direct_referral",

      amountCents:
        DIRECT_REFERRAL_REWARD_CENTS,

      description:
        "Card Leo direct referral allowance",
    };
  }

  if (
    [
      "team",
      "override",
      "team_referral",
      "team-referral",
      "team referral",
      "indirect",
    ].includes(
      type
    )
  ) {
    return {
      transactionType:
        "team_referral",

      source:
        "team_referral",

      amountCents:
        TEAM_REFERRAL_REWARD_CENTS,

      description:
        "Card Leo team referral allowance",
    };
  }

  return null;
}

/* ==========================================================================
   EXISTING ALLOWANCE LOOKUP
============================================================================ */

async function getExistingAllowanceByReward({
  memberId,
  sourceRewardId,
}) {
  const cleanMemberId =
    normalizeUuid(
      memberId
    );

  const cleanRewardId =
    normalizeSourceRewardId(
      sourceRewardId
    );

  if (
    !cleanMemberId ||
    !cleanRewardId
  ) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "member_id",
        cleanMemberId
      )
      .eq(
        "source_reward_id",
        cleanRewardId
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return (
    data ||
    null
  );
}

/* ==========================================================================
   EXISTING ALLOWANCE BY EXTERNAL REFERENCE
============================================================================ */

async function getExistingAllowanceByReference({
  memberId,
  externalReference,
}) {
  const cleanMemberId =
    normalizeUuid(
      memberId
    );

  const reference =
    normalizeString(
      externalReference
    );

  if (
    !cleanMemberId ||
    !reference
  ) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "member_id",
        cleanMemberId
      )
      .eq(
        "external_reference",
        reference
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return (
    data ||
    null
  );
}

/* ==========================================================================
   DUPLICATE ERROR
============================================================================ */

function isDuplicateError(
  error
) {
  const code =
    String(
      error?.code ||
      ""
    );

  const message =
    String(
      error?.message ||
      ""
    ).toLowerCase();

  const details =
    String(
      error?.details ||
      ""
    ).toLowerCase();

  return (
    code === "23505" ||
    message.includes(
      "duplicate"
    ) ||
    message.includes(
      "unique"
    ) ||
    details.includes(
      "duplicate"
    ) ||
    details.includes(
      "unique"
    )
  );
}

/* ==========================================================================
   SANITIZE ALLOWANCE
============================================================================ */

function sanitizeAllowanceTransaction(
  row
) {
  if (!row) {
    return null;
  }

  const amountCents =
    normalizePositiveInteger(
      row.amount_cents,
      0
    );

  return {
    id:
      row.id ||
      null,

    memberId:
      row.member_id ||
      null,

    memberCardId:
      row.member_card_id ||
      null,

    direction:
      normalizeString(
        row.direction
      ),

    transactionType:
      normalizeString(
        row.transaction_type
      ),

    amountCents,

    amount:
      centsToDollars(
        amountCents
      ),

    currency:
      normalizeString(
        row.currency
      ) ||
      DEFAULT_CURRENCY,

    status:
      normalizeString(
        row.status
      ),

    source:
      normalizeString(
        row.source
      ),

    sourceRewardId:
      row.source_reward_id ||
      null,

    sourceMemberId:
      row.source_member_id ||
      null,

    description:
      normalizeString(
        row.description
      ),

    provider:
      normalizeString(
        row.provider
      ),

    providerStatus:
      normalizeString(
        row.provider_status
      ),

    fundedAt:
      row.funded_at ||
      null,

    createdAt:
      row.created_at ||
      null,

    updatedAt:
      row.updated_at ||
      null,
  };
}

/* ==========================================================================
   CREATE PERSONAL ALLOWANCE
============================================================================ */

async function createAllowanceFromReward({
  memberId,
  rewardType,
  sourceRewardId = "",
  sourceMemberId = "",
  externalReference = "",
  status = DEFAULT_ALLOWANCE_STATUS,
  metadata = {},
} = {}) {
  const cleanMemberId =
    normalizeUuid(
      memberId
    );

  if (!cleanMemberId) {
    const error =
      new Error(
        "A valid member ID is required to create a Card Leo allowance."
      );

    error.code =
      "ALLOWANCE_MEMBER_ID_REQUIRED";

    throw error;
  }

  const definition =
    getAllowanceDefinition(
      rewardType
    );

  if (!definition) {
    const error =
      new Error(
        `Unsupported Card Leo allowance reward type: ${normalizeString(
          rewardType
        ) || "unknown"}`
      );

    error.code =
      "UNSUPPORTED_ALLOWANCE_REWARD_TYPE";

    throw error;
  }

  /* ========================================================================
     MEMBER
  ======================================================================== */

  const member =
    await getMemberById(
      cleanMemberId
    );

  if (!member?.id) {
    const error =
      new Error(
        "Card Leo member could not be found."
      );

    error.code =
      "ALLOWANCE_MEMBER_NOT_FOUND";

    throw error;
  }

  if (
    !isMemberActive(
      member
    )
  ) {
    return {
      success:
        false,

      created:
        false,

      skipped:
        true,

      reason:
        "member_not_active",

      message:
        "Allowance was not created because the Card Leo member is not active and paid.",

      memberId:
        member.id,
    };
  }

  /* ========================================================================
     MEMBER CARD
  ======================================================================== */

  const memberCard =
    await getMemberCard(
      member.id
    );

  /*
   * A member card is NOT required for allowance creation.
   *
   * Rewards may accrue before a Lithic card exists.
   */

  const memberCardId =
    memberCard?.id ||
    null;

  /* ========================================================================
     SOURCE IDs
  ======================================================================== */

  const cleanSourceRewardId =
    normalizeSourceRewardId(
      sourceRewardId
    );

  const cleanSourceMemberId =
    normalizeUuid(
      sourceMemberId
    ) ||
    null;

  const cleanExternalReference =
    normalizeString(
      externalReference
    );

  /* ========================================================================
     IDEMPOTENCY #1
     REWARD ID
  ======================================================================== */

  if (
    cleanSourceRewardId
  ) {
    const existingByReward =
      await getExistingAllowanceByReward({
        memberId:
          member.id,

        sourceRewardId:
          cleanSourceRewardId,
      });

    if (
      existingByReward
    ) {
      return {
        success:
          true,

        created:
          false,

        alreadyExists:
          true,

        allowance:
          sanitizeAllowanceTransaction(
            existingByReward
          ),

        message:
          "This reward already has a Card Leo allowance transaction.",
      };
    }
  }

  /* ========================================================================
     IDEMPOTENCY #2
     EXTERNAL REFERENCE
  ======================================================================== */

  if (
    cleanExternalReference
  ) {
    const existingByReference =
      await getExistingAllowanceByReference({
        memberId:
          member.id,

        externalReference:
          cleanExternalReference,
      });

    if (
      existingByReference
    ) {
      return {
        success:
          true,

        created:
          false,

        alreadyExists:
          true,

        allowance:
          sanitizeAllowanceTransaction(
            existingByReference
          ),

        message:
          "This referral event already has a Card Leo allowance transaction.",
      };
    }
  }

  /* ========================================================================
     INSERT
  ======================================================================== */

  const payload = {
    member_id:
      member.id,

    member_card_id:
      memberCardId,

    direction:
      "credit",

    transaction_type:
      definition
        .transactionType,

    amount_cents:
      definition
        .amountCents,

    currency:
      DEFAULT_CURRENCY,

    status:
      normalizeStatus(
        status
      ) ||
      DEFAULT_ALLOWANCE_STATUS,

    source:
      definition.source,

    source_reward_id:
      cleanSourceRewardId ||
      null,

    source_member_id:
      cleanSourceMemberId,

    description:
      definition.description,

    provider:
      "cardleo",

    provider_status:
      "not_submitted",

    external_reference:
      cleanExternalReference ||
      null,

    metadata: {
      ...(isObject(
        metadata
      )
        ? metadata
        : {}),

      reward_type:
        definition
          .transactionType,

      amount_cents:
        definition
          .amountCents,

      amount_dollars:
        centsToDollars(
          definition
            .amountCents
        ),

      member_email:
        normalizeEmail(
          member.email
        ),

      created_by:
        "lib/allowance-rewards.js",
    },

    created_at:
      nowIso(),

    updated_at:
      nowIso(),
  };

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .insert(
        payload
      )
      .select()
      .single();

  if (error) {
    /*
     * Race-condition protection.
     *
     * If two webhooks/functions attempt the exact same reward at once,
     * Step #13 unique indexes stop the duplicate.
     */

    if (
      isDuplicateError(
        error
      )
    ) {
      if (
        cleanSourceRewardId
      ) {
        const existing =
          await getExistingAllowanceByReward({
            memberId:
              member.id,

            sourceRewardId:
              cleanSourceRewardId,
          });

        if (
          existing
        ) {
          return {
            success:
              true,

            created:
              false,

            alreadyExists:
              true,

            allowance:
              sanitizeAllowanceTransaction(
                existing
              ),

            message:
              "Allowance already existed. Duplicate creation was prevented.",
          };
        }
      }

      if (
        cleanExternalReference
      ) {
        const existing =
          await getExistingAllowanceByReference({
            memberId:
              member.id,

            externalReference:
              cleanExternalReference,
          });

        if (
          existing
        ) {
          return {
            success:
              true,

            created:
              false,

            alreadyExists:
              true,

            allowance:
              sanitizeAllowanceTransaction(
                existing
              ),

            message:
              "Allowance already existed. Duplicate creation was prevented.",
          };
        }
      }
    }

    throw error;
  }

  return {
    success:
      true,

    created:
      true,

    alreadyExists:
      false,

    allowance:
      sanitizeAllowanceTransaction(
        data
      ),

    message:
      `${definition.description} created successfully.`,
  };
}

/* ==========================================================================
   DIRECT REFERRAL
============================================================================ */

async function createDirectReferralAllowance({
  memberId,
  sourceRewardId = "",
  referredMemberId = "",
  externalReference = "",
  metadata = {},
} = {}) {
  return createAllowanceFromReward({
    memberId,

    rewardType:
      "direct_referral",

    sourceRewardId,

    sourceMemberId:
      referredMemberId,

    externalReference,

    status:
      DEFAULT_ALLOWANCE_STATUS,

    metadata: {
      ...metadata,

      referral_level:
        1,

      reward_amount:
        7,

      reward_amount_cents:
        DIRECT_REFERRAL_REWARD_CENTS,
    },
  });
}

/* ==========================================================================
   TEAM REFERRAL
============================================================================ */

async function createTeamReferralAllowance({
  memberId,
  sourceRewardId = "",
  sourceMemberId = "",
  externalReference = "",
  metadata = {},
} = {}) {
  return createAllowanceFromReward({
    memberId,

    rewardType:
      "team_referral",

    sourceRewardId,

    sourceMemberId,

    externalReference,

    status:
      DEFAULT_ALLOWANCE_STATUS,

    metadata: {
      ...metadata,

      referral_level:
        2,

      reward_amount:
        1,

      reward_amount_cents:
        TEAM_REFERRAL_REWARD_CENTS,
    },
  });
}

/* ==========================================================================
   CREATE FROM REWARD TRANSACTION
============================================================================ */

async function createAllowanceFromRewardTransaction(
  rewardTransaction = {},
  options = {}
) {
  if (
    !rewardTransaction ||
    typeof rewardTransaction !==
      "object"
  ) {
    const error =
      new Error(
        "A reward transaction is required."
      );

    error.code =
      "REWARD_TRANSACTION_REQUIRED";

    throw error;
  }

  const memberId =
    normalizeUuid(
      rewardTransaction.member_id ||
      rewardTransaction.signup_id ||
      rewardTransaction.profile_id ||
      options.memberId
    );

  if (!memberId) {
    const error =
      new Error(
        "Reward transaction does not contain a valid member ID."
      );

    error.code =
      "REWARD_MEMBER_ID_REQUIRED";

    throw error;
  }

  const rewardTransactionId =
    normalizeUuid(
      rewardTransaction.id
    );

  const type =
    normalizeStatus(
      rewardTransaction
        .transaction_type ||
      rewardTransaction.type ||
      rewardTransaction.reward_type
    );

  const amount =
    Number(
      rewardTransaction.amount ||
      0
    );

  /* ========================================================================
     DIRECT REFERRAL
  ======================================================================== */

  if (
    type.includes(
      "direct"
    ) ||
    (
      amount === 7 &&
      !type.includes(
        "override"
      )
    )
  ) {
    return createDirectReferralAllowance({
      memberId,

      sourceRewardId:
        rewardTransactionId,

      referredMemberId:
        normalizeUuid(
          rewardTransaction
            .source_profile_id ||
          rewardTransaction
            .related_profile_id ||
          rewardTransaction
            .source_member_id ||
          options
            .sourceMemberId
        ),

      externalReference:
        normalizeString(
          options.externalReference
        ) ||
        (
          rewardTransactionId
            ? `reward:${rewardTransactionId}`
            : ""
        ),

      metadata: {
        reward_transaction_type:
          type,

        reward_transaction_amount:
          amount,

        original_metadata:
          isObject(
            rewardTransaction
              .metadata
          )
            ? rewardTransaction
                .metadata
            : {},
      },
    });
  }

  /* ========================================================================
     TEAM / OVERRIDE REFERRAL
  ======================================================================== */

  if (
    type.includes(
      "override"
    ) ||
    type.includes(
      "team"
    ) ||
    amount === 1
  ) {
    return createTeamReferralAllowance({
      memberId,

      sourceRewardId:
        rewardTransactionId,

      sourceMemberId:
        normalizeUuid(
          rewardTransaction
            .source_profile_id ||
          rewardTransaction
            .related_profile_id ||
          rewardTransaction
            .source_member_id ||
          options
            .sourceMemberId
        ),

      externalReference:
        normalizeString(
          options.externalReference
        ) ||
        (
          rewardTransactionId
            ? `reward:${rewardTransactionId}`
            : ""
        ),

      metadata: {
        reward_transaction_type:
          type,

        reward_transaction_amount:
          amount,

        original_metadata:
          isObject(
            rewardTransaction
              .metadata
          )
            ? rewardTransaction
                .metadata
            : {},
      },
    });
  }

  /* ========================================================================
     GROWTH POOL
  ======================================================================== */

  if (
    type.includes(
      "company"
    ) ||
    type.includes(
      "growth"
    ) ||
    amount === 2
  ) {
    return {
      success:
        true,

      created:
        false,

      skipped:
        true,

      reason:
        "growth_pool_not_personal_allowance",

      amountCents:
        GROWTH_POOL_CONTRIBUTION_CENTS,

      amount:
        centsToDollars(
          GROWTH_POOL_CONTRIBUTION_CENTS
        ),

      message:
        "Growth Pool contribution correctly skipped. Growth Pool funds do not become personal member allowance.",
    };
  }

  return {
    success:
      true,

    created:
      false,

    skipped:
      true,

    reason:
      "unsupported_reward_type",

    message:
      "Reward transaction is not a Card Leo personal allowance reward.",
  };
}

/* ==========================================================================
   BATCH CONVERT REWARD TRANSACTIONS
============================================================================ */

async function createAllowancesFromRewardTransactions(
  rewardTransactions = [],
  options = {}
) {
  if (
    !Array.isArray(
      rewardTransactions
    )
  ) {
    throw new Error(
      "rewardTransactions must be an array."
    );
  }

  const results =
    [];

  for (
    const rewardTransaction
    of rewardTransactions
  ) {
    try {
      const result =
        await createAllowanceFromRewardTransaction(
          rewardTransaction,
          options
        );

      results.push({
        rewardTransactionId:
          rewardTransaction
            ?.id ||
          null,

        ...result,
      });
    } catch (
      error
    ) {
      results.push({
        rewardTransactionId:
          rewardTransaction
            ?.id ||
          null,

        success:
          false,

        created:
          false,

        error:
          error?.message ||
          "Unable to create allowance.",

        code:
          error?.code ||
          null,
      });
    }
  }

  const created =
    results.filter(
      (result) =>
        result.created ===
        true
    );

  const existing =
    results.filter(
      (result) =>
        result.alreadyExists ===
        true
    );

  const skipped =
    results.filter(
      (result) =>
        result.skipped ===
        true
    );

  const failed =
    results.filter(
      (result) =>
        result.success ===
        false
    );

  return {
    success:
      failed.length ===
      0,

    total:
      results.length,

    created:
      created.length,

    alreadyExists:
      existing.length,

    skipped:
      skipped.length,

    failed:
      failed.length,

    results,
  };
}

/* ==========================================================================
   APPROVE ALLOWANCE FOR FUNDING
============================================================================ */

async function markAllowanceReadyToFund(
  allowanceTransactionId
) {
  const id =
    normalizeUuid(
      allowanceTransactionId
    );

  if (!id) {
    throw new Error(
      "A valid allowance transaction ID is required."
    );
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .update({
        status:
          "ready_to_fund",

        updated_at:
          nowIso(),
      })
      .eq(
        "id",
        id
      )
      .in(
        "status",
        [
          "pending",
          "approved",
          "ready",
          "queued",
        ]
      )
      .select()
      .maybeSingle();

  if (error) {
    throw error;
  }

  return {
    success:
      true,

    allowance:
      sanitizeAllowanceTransaction(
        data
      ),
  };
}

/* ==========================================================================
   GET MEMBER ALLOWANCE TOTALS
============================================================================ */

async function getMemberAllowanceTotals(
  memberId
) {
  const cleanMemberId =
    normalizeUuid(
      memberId
    );

  if (!cleanMemberId) {
    throw new Error(
      "A valid member ID is required."
    );
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "member_allowance_balances"
      )
      .select("*")
      .eq(
        "member_id",
        cleanMemberId
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return {
        availableBalanceCents:
          0,

        availableBalance:
          0,

        approvedWaitingCents:
          0,

        approvedWaiting:
          0,

        processingCents:
          0,

        processing:
          0,

        lifetimeLoadedCents:
          0,

        lifetimeLoaded:
          0,

        lifetimeSpentCents:
          0,

        lifetimeSpent:
          0,
      };
    }

    throw error;
  }

  return {
    availableBalanceCents:
      Number(
        data
          ?.available_balance_cents ||
        0
      ),

    availableBalance:
      centsToDollars(
        data
          ?.available_balance_cents ||
        0
      ),

    approvedWaitingCents:
      Number(
        data
          ?.approved_waiting_cents ||
        0
      ),

    approvedWaiting:
      centsToDollars(
        data
          ?.approved_waiting_cents ||
        0
      ),

    processingCents:
      Number(
        data
          ?.processing_cents ||
        0
      ),

    processing:
      centsToDollars(
        data
          ?.processing_cents ||
        0
      ),

    lifetimeLoadedCents:
      Number(
        data
          ?.lifetime_loaded_cents ||
        0
      ),

    lifetimeLoaded:
      centsToDollars(
        data
          ?.lifetime_loaded_cents ||
        0
      ),

    lifetimeSpentCents:
      Number(
        data
          ?.lifetime_spent_cents ||
        0
      ),

    lifetimeSpent:
      centsToDollars(
        data
          ?.lifetime_spent_cents ||
        0
      ),
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  /* Constants */

  DIRECT_REFERRAL_REWARD_CENTS,

  TEAM_REFERRAL_REWARD_CENTS,

  GROWTH_POOL_CONTRIBUTION_CENTS,

  /* Member */

  getMemberById,

  getMemberByEmail,

  isMemberActive,

  /* Allowance */

  createAllowanceFromReward,

  createDirectReferralAllowance,

  createTeamReferralAllowance,

  createAllowanceFromRewardTransaction,

  createAllowancesFromRewardTransactions,

  markAllowanceReadyToFund,

  getMemberAllowanceTotals,

  sanitizeAllowanceTransaction,

  /* Utilities */

  normalizeString,

  normalizeEmail,

  normalizeStatus,

  centsToDollars,
};