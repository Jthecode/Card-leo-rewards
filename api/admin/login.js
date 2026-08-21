// api/admin/login.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  ok,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   ADMIN LOGIN API

   ROUTE
   -----
   POST /api/admin/login

   REQUEST
   -------
   {
     "email": "admin@example.com",
     "password": "..."
   }

   PURPOSE
   -------
   1. Authenticate the supplied email/password with Supabase Auth.
   2. Resolve the corresponding Card Leo account.
   3. Verify the account is explicitly authorized as an administrator.
   4. Return the authenticated Supabase session to the browser.

   SECURITY
   --------
   Normal members are rejected even when their email/password are valid.

   Admin authorization can come from:
   - public.admin_roles
   - admin role fields on profiles/signups
   - ADMIN_EMAILS
   - SUPER_ADMIN_EMAILS
   - CARDLEO_ADMIN_EMAILS
   - CARD_LEO_ADMIN_EMAILS

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const ADMIN_DASHBOARD_URL =
  "/admin/dashboard.html";

const ADMIN_LOGIN_URL =
  "/admin/";

const MEMBER_PORTAL_URL =
  "/portal/index.html";

/* ==========================================================================
   HELPERS
============================================================================ */

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeEmail(value) {
  return normalizeLower(value);
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized =
    normalizeLower(value);

  if (
    [
      "true",
      "1",
      "yes",
      "y",
      "on",
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "n",
      "off",
    ].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function getClientIp(req) {
  const forwardedFor =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"];

  if (
    typeof forwardedFor === "string" &&
    forwardedFor.trim()
  ) {
    return forwardedFor
      .split(",")[0]
      .trim();
  }

  return (
    req.socket?.remoteAddress ||
    null
  );
}

/* ==========================================================================
   REQUEST BODY
============================================================================ */

function getRequestBody(req) {
  if (isObject(req.body)) {
    return req.body;
  }

  if (
    typeof req.body === "string"
  ) {
    try {
      const parsed =
        JSON.parse(req.body);

      return isObject(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

/* ==========================================================================
   OPTIONAL SCHEMA ERROR
============================================================================ */

function isMissingOptionalTableOrColumn(
  error
) {
  const code =
    normalizeString(
      error?.code
    );

  const message =
    normalizeLower(
      error?.message
    );

  const details =
    normalizeLower(
      error?.details
    );

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
    ) ||
    details.includes(
      "schema cache"
    )
  );
}

/* ==========================================================================
   ADMIN EMAIL ENVIRONMENT
============================================================================ */

function parseAdminEmails(value) {
  return normalizeString(value)
    .split(/[,\n;]/)
    .map(
      normalizeEmail
    )
    .filter(Boolean);
}

function getConfiguredAdminEmails() {
  return new Set([
    ...parseAdminEmails(
      process.env.ADMIN_EMAILS
    ),

    ...parseAdminEmails(
      process.env.SUPER_ADMIN_EMAILS
    ),

    ...parseAdminEmails(
      process.env.CARDLEO_ADMIN_EMAILS
    ),

    ...parseAdminEmails(
      process.env.CARD_LEO_ADMIN_EMAILS
    ),
  ]);
}

/* ==========================================================================
   SIGNUP LOOKUP
============================================================================ */

async function getSignupByEmail(email) {
  const safeEmail =
    normalizeEmail(email);

  if (!safeEmail) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike(
        "email",
        safeEmail
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

/* ==========================================================================
   PROFILE LOOKUP
============================================================================ */

async function getProfileByUserId(
  userId
) {
  if (!userId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq(
        "id",
        userId
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

async function getProfileByEmail(
  email
) {
  const safeEmail =
    normalizeEmail(email);

  if (!safeEmail) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("profiles")
      .select("*")
      .ilike(
        "email",
        safeEmail
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

/* ==========================================================================
   ADMIN ROLE LOOKUP
============================================================================ */

async function getAdminRole(
  profileId
) {
  if (!profileId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("admin_roles")
      .select("*")
      .eq(
        "profile_id",
        profileId
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

/* ==========================================================================
   ROLE DETECTION
============================================================================ */

function getRoleValues(
  ...records
) {
  const roles = [];

  for (
    const record
    of records
  ) {
    if (!record) {
      continue;
    }

    [
      record.role,
      record.user_role,
      record.account_role,
      record.portal_role,
      record.admin_role,
    ].forEach(
      (value) => {
        const role =
          normalizeLower(
            value
          );

        if (role) {
          roles.push(role);
        }
      }
    );
  }

  return roles;
}

function hasAdminRole(
  signup,
  profile
) {
  const roles =
    getRoleValues(
      signup,
      profile
    );

  if (
    roles.some(
      (role) =>
        [
          "admin",
          "administrator",
          "super_admin",
          "superadmin",
          "owner",
        ].includes(role)
    )
  ) {
    return true;
  }

  const flags = [
    signup?.is_admin,
    signup?.admin,
    signup?.is_super_admin,
    signup?.super_admin,

    profile?.is_admin,
    profile?.admin,
    profile?.is_super_admin,
    profile?.super_admin,
  ];

  return flags.some(
    (value) =>
      normalizeBoolean(
        value,
        false
      )
  );
}

function isSuperAdmin(
  signup,
  profile,
  adminRole,
  email
) {
  const roles =
    getRoleValues(
      signup,
      profile
    );

  if (
    roles.some(
      (role) =>
        [
          "super_admin",
          "superadmin",
          "owner",
        ].includes(role)
    )
  ) {
    return true;
  }

  if (
    normalizeBoolean(
      signup?.is_super_admin,
      false
    ) ||
    normalizeBoolean(
      profile?.is_super_admin,
      false
    ) ||
    normalizeBoolean(
      adminRole?.is_super_admin,
      false
    )
  ) {
    return true;
  }

  const superAdmins =
    new Set(
      parseAdminEmails(
        process.env.SUPER_ADMIN_EMAILS
      )
    );

  return superAdmins.has(
    normalizeEmail(email)
  );
}

/* ==========================================================================
   ADMIN AUTHORIZATION
============================================================================ */

function buildAdminAuthorization({
  email,
  signup,
  profile,
  adminRole,
}) {
  const configuredAdmins =
    getConfiguredAdminEmails();

  const safeEmail =
    normalizeEmail(email);

  const emailAuthorized =
    configuredAdmins.has(
      safeEmail
    );

  const databaseRoleAuthorized =
    Boolean(
      adminRole &&
      (
        normalizeBoolean(
          adminRole.is_super_admin,
          false
        ) ||
        normalizeBoolean(
          adminRole.can_manage_members,
          false
        ) ||
        normalizeBoolean(
          adminRole.can_manage_support,
          false
        ) ||
        normalizeBoolean(
          adminRole.can_manage_rewards,
          false
        )
      )
    );

  const profileRoleAuthorized =
    hasAdminRole(
      signup,
      profile
    );

  const authorized =
    emailAuthorized ||
    databaseRoleAuthorized ||
    profileRoleAuthorized;

  const superAdmin =
    isSuperAdmin(
      signup,
      profile,
      adminRole,
      safeEmail
    );

  return {
    authorized,

    superAdmin,

    source:
      databaseRoleAuthorized
        ? "admin_roles"
        : profileRoleAuthorized
          ? "account_role"
          : emailAuthorized
            ? "environment"
            : "none",

    permissions: {
      canManageMembers:
        superAdmin ||
        normalizeBoolean(
          adminRole?.can_manage_members,
          emailAuthorized
        ),

      canManageSupport:
        superAdmin ||
        normalizeBoolean(
          adminRole?.can_manage_support,
          emailAuthorized
        ),

      canManageRewards:
        superAdmin ||
        normalizeBoolean(
          adminRole?.can_manage_rewards,
          emailAuthorized
        ),

      canManageCards:
        superAdmin ||
        normalizeBoolean(
          adminRole?.can_manage_cards,
          emailAuthorized
        ),

      canManageGrowthPool:
        superAdmin ||
        normalizeBoolean(
          adminRole?.can_manage_growth_pool,
          emailAuthorized
        ),

      canManageAccessPerks:
        superAdmin ||
        normalizeBoolean(
          adminRole?.can_manage_access_perks,
          emailAuthorized
        ),
    },
  };
}

/* ==========================================================================
   DISPLAY NAME
============================================================================ */

function getDisplayName(
  signup,
  profile,
  user
) {
  const direct =
    normalizeString(
      signup?.full_name ||
      profile?.full_name ||
      profile?.display_name ||
      user?.user_metadata?.full_name
    );

  if (direct) {
    return direct;
  }

  const firstName =
    normalizeString(
      signup?.first_name ||
      profile?.first_name ||
      user?.user_metadata?.first_name
    );

  const lastName =
    normalizeString(
      signup?.last_name ||
      profile?.last_name ||
      user?.user_metadata?.last_name
    );

  const joined =
    [
      firstName,
      lastName,
    ]
      .filter(Boolean)
      .join(" ");

  if (joined) {
    return joined;
  }

  return (
    normalizeEmail(
      user?.email
    ) ||
    "Card Leo Administrator"
  );
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  setNoStore(res);

  logRequestStart(
    req,
    {
      scope:
        "admin_login",
    }
  );

  /* ------------------------------------------------------------------------
     METHOD
  ------------------------------------------------------------------------ */

  if (
    req.method !== "POST"
  ) {
    return methodNotAllowed(
      res,
      ["POST"],
      "Method not allowed. Use POST."
    );
  }

  try {
    /* ======================================================================
       INPUT
    ====================================================================== */

    const body =
      getRequestBody(req);

    const email =
      normalizeEmail(
        body.email
      );

    const password =
      normalizeString(
        body.password
      );

    if (
      !email ||
      !password
    ) {
      return unauthorized(
        res,
        "Email and password are required."
      );
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
      )
    ) {
      return unauthorized(
        res,
        "Enter a valid email address."
      );
    }

    /* ======================================================================
       AUTHENTICATE WITH SUPABASE
    ====================================================================== */

    const {
      data:
        signInData,

      error:
        signInError,
    } =
      await supabaseAdmin
        .auth
        .signInWithPassword({
          email,
          password,
        });

    if (
      signInError ||
      !signInData?.user ||
      !signInData?.session
    ) {
      logAuthEvent(
        "Admin login failed.",
        {
          email,

          reason:
            signInError?.message ||
            "invalid_credentials",

          ip:
            getClientIp(req),
        }
      );

      return unauthorized(
        res,
        "Invalid email or password."
      );
    }

    const user =
      signInData.user;

    const session =
      signInData.session;

    /* ======================================================================
       LOAD CARD LEO ACCOUNT
    ====================================================================== */

    const [
      signup,
      profileById,
    ] =
      await Promise.all([
        getSignupByEmail(
          email
        ),

        getProfileByUserId(
          user.id
        ),
      ]);

    const profile =
      profileById ||
      (
        await getProfileByEmail(
          email
        )
      );

    /* ======================================================================
       ADMIN ROLE
    ====================================================================== */

    const adminRole =
      profile?.id
        ? await getAdminRole(
            profile.id
          )
        : null;

    /* ======================================================================
       AUTHORIZE
    ====================================================================== */

    const authorization =
      buildAdminAuthorization({
        email,

        signup,

        profile,

        adminRole,
      });

    if (
      !authorization.authorized
    ) {
      /*
       * Valid Card Leo credentials do not automatically make someone
       * an administrator.
       */

      try {
        await supabaseAdmin
          .auth
          .admin
          .signOut(
            user.id
          );
      } catch {
        // Best-effort revocation only.
      }

      logAuthEvent(
        "Admin login denied.",
        {
          email,

          userId:
            user.id,

          reason:
            "not_admin",

          ip:
            getClientIp(req),
        }
      );

      return forbidden(
        res,
        "This Card Leo account is not authorized for administrator access."
      );
    }

    /* ======================================================================
       ADMIN PAYLOAD
    ====================================================================== */

    const displayName =
      getDisplayName(
        signup,
        profile,
        user
      );

    const admin = {
      id:
        profile?.id ||
        signup?.id ||
        user.id,

      userId:
        user.id,

      signupId:
        signup?.id ||
        null,

      profileId:
        profile?.id ||
        null,

      email,

      fullName:
        displayName,

      role:
        authorization.superAdmin
          ? "super_admin"
          : "admin",

      isSuperAdmin:
        authorization.superAdmin,

      authorizationSource:
        authorization.source,

      permissions:
        authorization.permissions,
    };

    /* ======================================================================
       RESPONSE SESSION

       The browser can use this Supabase access token for the existing
       admin API architecture that already accepts Authorization: Bearer.
    ====================================================================== */

    const sessionPayload = {
      accessToken:
        session.access_token,

      access_token:
        session.access_token,

      refreshToken:
        session.refresh_token,

      refresh_token:
        session.refresh_token,

      tokenType:
        session.token_type ||
        "bearer",

      token_type:
        session.token_type ||
        "bearer",

      expiresIn:
        session.expires_in ||
        null,

      expires_in:
        session.expires_in ||
        null,

      expiresAt:
        session.expires_at ||
        null,

      expires_at:
        session.expires_at ||
        null,
    };

    /* ======================================================================
       LOG SUCCESS
    ====================================================================== */

    logAuthEvent(
      "Admin login successful.",
      {
        email,

        userId:
          user.id,

        signupId:
          signup?.id ||
          null,

        profileId:
          profile?.id ||
          null,

        role:
          admin.role,

        authorizationSource:
          authorization.source,

        ip:
          getClientIp(req),
      }
    );

    logRequestSuccess(
      req,
      {
        scope:
          "admin_login",

        adminId:
          admin.id,

        adminEmail:
          email,

        role:
          admin.role,

        ip:
          getClientIp(req),
      }
    );

    /* ======================================================================
       FINAL RESPONSE
    ====================================================================== */

    return ok(
      res,
      {
        authenticated:
          true,

        admin,

        user: {
          id:
            user.id,

          email:
            normalizeEmail(
              user.email
            ),

          emailConfirmedAt:
            safeDate(
              user.email_confirmed_at
            ),

          lastSignInAt:
            safeDate(
              user.last_sign_in_at
            ),
        },

        session:
          sessionPayload,

        permissions:
          authorization.permissions,

        links: {
          dashboard:
            ADMIN_DASHBOARD_URL,

          adminLogin:
            ADMIN_LOGIN_URL,

          memberPortal:
            MEMBER_PORTAL_URL,
        },

        redirectTo:
          ADMIN_DASHBOARD_URL,

        loggedInAt:
          new Date()
            .toISOString(),
      },

      "Administrator login successful."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "admin_login_unexpected",
      }
    );

    console.error(
      "Card Leo admin login error:",
      error
    );

    return serverError(
      res,

      "Unable to sign in to the Card Leo administration portal.",

      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,

            details:
              error?.details ||
              null,
          }
        : null
    );
  }
}