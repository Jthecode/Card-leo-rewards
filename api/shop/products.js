// ============================================================================
// CARD LEO REWARDS
// CARD LEO SHOP
// FILE #7
//
// api/shop/products.js
//
// PURPOSE:
// - Return active Card Leo Shop products.
// - Read products securely from Supabase on the server.
// - Never expose the Supabase service-role key to the browser.
// - Support shop.html and cart.html.
// - Allow optional category / featured / new-product filtering.
// - Return only fields that are safe for the public storefront.
// ============================================================================

import { supabaseAdmin } from "../../lib/supabase-admin.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const PRODUCTS_TABLE = "products";

const DEFAULT_LIMIT = 100;

const MAX_LIMIT = 100;

// ============================================================================
// PUBLIC PRODUCT FIELDS
//
// IMPORTANT:
// Only fields that are safe for the public Card Leo storefront should be
// returned from this endpoint.
//
// Do NOT return:
// - Stripe secrets
// - internal notes
// - supplier costs
// - profit margins
// - admin-only information
// - Supabase credentials
// ============================================================================

const PUBLIC_PRODUCT_FIELDS = `
  id,
  name,
  slug,
  description,
  short_description,
  category,
  product_type,
  price_cents,
  member_price_cents,
  compare_at_price_cents,
  currency,
  sku,
  inventory_quantity,
  image_url,
  secondary_image_url,
  gallery_images,
  available_sizes,
  available_colors,
  material,
  fit,
  fragrance_size_ml,
  fragrance_concentration,
  fragrance_top_notes,
  fragrance_middle_notes,
  fragrance_base_notes,
  is_active,
  is_featured,
  is_new,
  created_at,
  updated_at
`;

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function setCorsHeaders(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://www.cardleorewards.com"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept"
  );
}

function setSecurityHeaders(res) {
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "X-Frame-Options",
    "DENY"
  );

  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );
}

function sendJson(
  res,
  statusCode,
  payload
) {
  return res
    .status(statusCode)
    .json(payload);
}

// ============================================================================
// STRING HELPERS
// ============================================================================

function normalizeText(value) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeLower(value) {
  return normalizeText(
    value
  ).toLowerCase();
}

// ============================================================================
// BOOLEAN HELPER
// ============================================================================

function parseBoolean(value) {
  const normalized =
    normalizeLower(value);

  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes"
  ) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no"
  ) {
    return false;
  }

  return null;
}

// ============================================================================
// INTEGER HELPER
// ============================================================================

function parseLimit(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return DEFAULT_LIMIT;
  }

  const parsed =
    Number.parseInt(
      String(value),
      10
    );

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return DEFAULT_LIMIT;
  }

  return Math.min(
    parsed,
    MAX_LIMIT
  );
}

// ============================================================================
// ARRAY NORMALIZER
// ============================================================================

function normalizeStringArray(value) {
  if (
    !Array.isArray(value)
  ) {
    return [];
  }

  return value
    .map((item) =>
      normalizeText(item)
    )
    .filter(Boolean);
}

// ============================================================================
// NUMBER NORMALIZER
// ============================================================================

function normalizeInteger(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return fallback;
  }

  return Math.trunc(
    number
  );
}

// ============================================================================
// PRODUCT NORMALIZER
//
// This provides a consistent object to shop.html, product.html and cart.html.
// ============================================================================

function normalizeProduct(row) {
  if (
    !row ||
    typeof row !== "object"
  ) {
    return null;
  }

  return {
    id:
      row.id,

    name:
      normalizeText(
        row.name
      ),

    slug:
      normalizeText(
        row.slug
      ),

    description:
      normalizeText(
        row.description
      ),

    short_description:
      normalizeText(
        row.short_description
      ),

    category:
      normalizeLower(
        row.category ||
        "merchandise"
      ),

    product_type:
      normalizeLower(
        row.product_type ||
        "physical"
      ),

    price_cents:
      Math.max(
        0,
        normalizeInteger(
          row.price_cents
        )
      ),

    member_price_cents:
      row.member_price_cents === null ||
      row.member_price_cents === undefined
        ? null
        : Math.max(
            0,
            normalizeInteger(
              row.member_price_cents
            )
          ),

    compare_at_price_cents:
      row.compare_at_price_cents === null ||
      row.compare_at_price_cents === undefined
        ? null
        : Math.max(
            0,
            normalizeInteger(
              row.compare_at_price_cents
            )
          ),

    currency:
      normalizeText(
        row.currency ||
        "USD"
      ).toUpperCase(),

    sku:
      normalizeText(
        row.sku
      ),

    inventory_quantity:
      Math.max(
        0,
        normalizeInteger(
          row.inventory_quantity
        )
      ),

    image_url:
      normalizeText(
        row.image_url
      ),

    secondary_image_url:
      normalizeText(
        row.secondary_image_url
      ),

    gallery_images:
      normalizeStringArray(
        row.gallery_images
      ),

    available_sizes:
      normalizeStringArray(
        row.available_sizes
      ),

    available_colors:
      normalizeStringArray(
        row.available_colors
      ),

    material:
      normalizeText(
        row.material
      ),

    fit:
      normalizeText(
        row.fit
      ),

    fragrance_size_ml:
      row.fragrance_size_ml === null ||
      row.fragrance_size_ml === undefined
        ? null
        : Math.max(
            0,
            normalizeInteger(
              row.fragrance_size_ml
            )
          ),

    fragrance_concentration:
      normalizeText(
        row.fragrance_concentration
      ),

    fragrance_top_notes:
      normalizeStringArray(
        row.fragrance_top_notes
      ),

    fragrance_middle_notes:
      normalizeStringArray(
        row.fragrance_middle_notes
      ),

    fragrance_base_notes:
      normalizeStringArray(
        row.fragrance_base_notes
      ),

    is_active:
      row.is_active === true,

    is_featured:
      row.is_featured === true,

    is_new:
      row.is_new === true,

    created_at:
      row.created_at ||
      null,

    updated_at:
      row.updated_at ||
      null,
  };
}

// ============================================================================
// QUERY VALUE HELPER
//
// Vercel / Node query parameters can theoretically arrive as arrays.
// We only use the first value.
// ============================================================================

function getQueryValue(value) {
  if (
    Array.isArray(value)
  ) {
    return value[0];
  }

  return value;
}

// ============================================================================
// MAIN API HANDLER
// ============================================================================

export default async function handler(
  req,
  res
) {
  // --------------------------------------------------------------------------
  // HEADERS
  // --------------------------------------------------------------------------

  setCorsHeaders(res);

  setSecurityHeaders(res);

  // --------------------------------------------------------------------------
  // OPTIONS
  // --------------------------------------------------------------------------

  if (
    req.method === "OPTIONS"
  ) {
    return res
      .status(204)
      .end();
  }

  // --------------------------------------------------------------------------
  // METHOD CHECK
  // --------------------------------------------------------------------------

  if (
    req.method !== "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET, OPTIONS"
    );

    return sendJson(
      res,
      405,
      {
        success: false,
        ok: false,

        message:
          "Method Not Allowed",
      }
    );
  }

  try {
    // ========================================================================
    // READ QUERY PARAMETERS
    // ========================================================================

    const category =
      normalizeLower(
        getQueryValue(
          req.query?.category
        )
      );

    const featured =
      parseBoolean(
        getQueryValue(
          req.query?.featured
        )
      );

    const isNew =
      parseBoolean(
        getQueryValue(
          req.query?.new
        )
      );

    const search =
      normalizeText(
        getQueryValue(
          req.query?.search
        )
      );

    const limit =
      parseLimit(
        getQueryValue(
          req.query?.limit
        )
      );

    // ========================================================================
    // START SUPABASE QUERY
    // ========================================================================

    let query =
      supabaseAdmin
        .from(
          PRODUCTS_TABLE
        )
        .select(
          PUBLIC_PRODUCT_FIELDS
        )
        .eq(
          "is_active",
          true
        );

    // ========================================================================
    // CATEGORY FILTER
    // ========================================================================

    if (
      category &&
      category !== "all"
    ) {
      query =
        query.eq(
          "category",
          category
        );
    }

    // ========================================================================
    // FEATURED FILTER
    // ========================================================================

    if (
      featured !== null
    ) {
      query =
        query.eq(
          "is_featured",
          featured
        );
    }

    // ========================================================================
    // NEW PRODUCT FILTER
    // ========================================================================

    if (
      isNew !== null
    ) {
      query =
        query.eq(
          "is_new",
          isNew
        );
    }

    // ========================================================================
    // SEARCH FILTER
    //
    // Search name, description, short description and SKU.
    //
    // Remove characters that can interfere with PostgREST filter syntax.
    // ========================================================================

    if (
      search
    ) {
      const safeSearch =
        search
          .replace(
            /[%(),]/g,
            " "
          )
          .replace(
            /\s+/g,
            " "
          )
          .trim()
          .slice(
            0,
            100
          );

      if (
        safeSearch
      ) {
        query =
          query.or(
            [
              `name.ilike.%${safeSearch}%`,
              `description.ilike.%${safeSearch}%`,
              `short_description.ilike.%${safeSearch}%`,
              `sku.ilike.%${safeSearch}%`,
            ].join(",")
          );
      }
    }

    // ========================================================================
    // SORT
    //
    // Featured products first.
    // New products second.
    // Newest products after that.
    // ========================================================================

    query =
      query
        .order(
          "is_featured",
          {
            ascending: false,
          }
        )
        .order(
          "is_new",
          {
            ascending: false,
          }
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(
          limit
        );

    // ========================================================================
    // EXECUTE QUERY
    // ========================================================================

    const {
      data,
      error,
    } =
      await query;

    // ========================================================================
    // SUPABASE ERROR
    // ========================================================================

    if (
      error
    ) {
      console.error(
        "[CARD LEO SHOP] Products query failed:",
        {
          code:
            error.code,

          message:
            error.message,

          details:
            error.details,

          hint:
            error.hint,
        }
      );

      return sendJson(
        res,
        500,
        {
          success: false,
          ok: false,

          message:
            "Unable to load Card Leo Shop products.",
        }
      );
    }

    // ========================================================================
    // NORMALIZE PRODUCTS
    // ========================================================================

    const products =
      Array.isArray(data)
        ? data
            .map(
              normalizeProduct
            )
            .filter(Boolean)
            .filter(
              (product) =>
                product.is_active &&
                product.id &&
                product.name &&
                product.slug
            )
        : [];

    // ========================================================================
    // RESPONSE
    // ========================================================================

    return sendJson(
      res,
      200,
      {
        success: true,
        ok: true,

        count:
          products.length,

        products,

        filters: {
          category:
            category ||
            null,

          featured,

          new:
            isNew,

          search:
            search ||
            null,

          limit,
        },
      }
    );
  } catch (
    error
  ) {
    // ========================================================================
    // UNEXPECTED ERROR
    // ========================================================================

    console.error(
      "[CARD LEO SHOP] Unexpected products API error:",
      error
    );

    return sendJson(
      res,
      500,
      {
        success: false,
        ok: false,

        message:
          "An unexpected error occurred while loading Card Leo Shop products.",
      }
    );
  }
}