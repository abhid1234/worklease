// worklease — claim + registry schema and validators.
//
// Pure, zero-dependency validators for the open `claim` shape and a registry
// (array of claims). Neither function throws on bad input; both return
// `{ valid, errors }` and collect *every* violation (no short-circuit) so a
// harness or human can fix everything in one pass.
//
// Error = { path: string, code: string, message: string }
//   path — dot/bracket path to the offending value ("globs[0]", "[2].ttl_seconds",
//          or "" for the whole object).
//   code — a stable machine-readable code from ERROR_CODES.
//   message — one-line human explanation.

export const STATUSES = ["active", "released", "expired"];

// The exact set of allowed top-level claim fields, in canonical order.
export const CLAIM_FIELDS = [
  "id",
  "agent",
  "globs",
  "intent",
  "ttl_seconds",
  "created",
  "expires",
  "status",
];

export const ERROR_CODES = {
  MISSING_FIELD: "MISSING_FIELD",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  WRONG_TYPE: "WRONG_TYPE",
  NOT_OBJECT: "NOT_OBJECT",
  NOT_ARRAY: "NOT_ARRAY",
  EMPTY_STRING: "EMPTY_STRING",
  EMPTY_ARRAY: "EMPTY_ARRAY",
  INVALID_ENUM: "INVALID_ENUM",
  NOT_POSITIVE_INT: "NOT_POSITIVE_INT",
  INVALID_ISO8601: "INVALID_ISO8601",
  EXPIRES_MISMATCH: "EXPIRES_MISMATCH",
  INVALID_GLOB: "INVALID_GLOB",
  DUPLICATE_ID: "DUPLICATE_ID",
};

// Strict ISO-8601 UTC: YYYY-MM-DDTHH:MM:SS(.sss)?Z. The regex gates the format
// (UTC `Z` only, no offsets); Date.parse gates real-calendar validity so
// impossible dates like 2026-13-40T00:00:00Z are rejected.
const ISO8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Unsupported glob metacharacters for the documented v0.1 subset. Supported
// tokens are `**`, `*`, `/`, and literal path characters; `? [ ] { }` are
// rejected so a malformed glob is caught at claim time rather than silently
// mis-matching later in `check`.
const UNSUPPORTED_GLOB_CHARS = /[?[\]{}]/;

export function isIso8601Utc(s) {
  return typeof s === "string" && ISO8601_UTC.test(s) && !Number.isNaN(Date.parse(s));
}

export function isAllowedGlob(s) {
  return typeof s === "string" && s.length > 0 && !UNSUPPORTED_GLOB_CHARS.test(s);
}

function err(path, code, message) {
  return { path, code, message };
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Validate a single string field: present-ness is checked by the caller; here
// we type/emptiness-check a value that exists.
function checkStringField(errors, obj, field) {
  const v = obj[field];
  if (typeof v !== "string") {
    errors.push(err(field, ERROR_CODES.WRONG_TYPE, `${field} must be a string`));
  } else if (v.trim().length === 0) {
    errors.push(err(field, ERROR_CODES.EMPTY_STRING, `${field} must not be empty`));
  }
}

export function validateClaim(obj) {
  // 1. Must be a non-null plain object.
  if (!isPlainObject(obj)) {
    return {
      valid: false,
      errors: [err("", ERROR_CODES.NOT_OBJECT, "claim must be a JSON object")],
    };
  }

  const errors = [];

  // 2. Required fields present.
  for (const field of CLAIM_FIELDS) {
    if (!(field in obj)) {
      errors.push(err(field, ERROR_CODES.MISSING_FIELD, `${field} is required`));
    }
  }

  // 3. Unknown top-level fields.
  for (const key of Object.keys(obj)) {
    if (!CLAIM_FIELDS.includes(key)) {
      errors.push(err(key, ERROR_CODES.UNKNOWN_FIELD, `unknown field: ${key}`));
    }
  }

  // 4. Per-field type/shape (only for fields that are present).
  if ("id" in obj) checkStringField(errors, obj, "id");
  if ("agent" in obj) checkStringField(errors, obj, "agent");
  if ("intent" in obj) checkStringField(errors, obj, "intent");

  if ("globs" in obj) {
    const globs = obj.globs;
    if (!Array.isArray(globs)) {
      errors.push(err("globs", ERROR_CODES.WRONG_TYPE, "globs must be an array"));
    } else if (globs.length === 0) {
      errors.push(err("globs", ERROR_CODES.EMPTY_ARRAY, "globs must have at least one entry"));
    } else {
      globs.forEach((g, i) => {
        if (typeof g !== "string") {
          errors.push(err(`globs[${i}]`, ERROR_CODES.WRONG_TYPE, "glob must be a string"));
        } else if (g.length === 0) {
          errors.push(err(`globs[${i}]`, ERROR_CODES.EMPTY_STRING, "glob must not be empty"));
        } else if (!isAllowedGlob(g)) {
          errors.push(
            err(
              `globs[${i}]`,
              ERROR_CODES.INVALID_GLOB,
              "glob uses unsupported metacharacters (? [ ] { } are not allowed)"
            )
          );
        }
      });
    }
  }

  if ("ttl_seconds" in obj) {
    const t = obj.ttl_seconds;
    if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) {
      errors.push(
        err("ttl_seconds", ERROR_CODES.NOT_POSITIVE_INT, "ttl_seconds must be an integer > 0")
      );
    }
  }

  if ("created" in obj && !isIso8601Utc(obj.created)) {
    errors.push(err("created", ERROR_CODES.INVALID_ISO8601, "created must be ISO 8601 UTC (…Z)"));
  }
  if ("expires" in obj && !isIso8601Utc(obj.expires)) {
    errors.push(err("expires", ERROR_CODES.INVALID_ISO8601, "expires must be ISO 8601 UTC (…Z)"));
  }

  if ("status" in obj && !STATUSES.includes(obj.status)) {
    errors.push(
      err("status", ERROR_CODES.INVALID_ENUM, `status must be one of: ${STATUSES.join(", ")}`)
    );
  }

  // 5. Cross-field: expires === created + ttl_seconds (only when all three are
  // individually valid, so we don't pile a mismatch on top of a format error).
  if (
    isIso8601Utc(obj.created) &&
    isIso8601Utc(obj.expires) &&
    typeof obj.ttl_seconds === "number" &&
    Number.isInteger(obj.ttl_seconds) &&
    obj.ttl_seconds > 0
  ) {
    if (Date.parse(obj.expires) !== Date.parse(obj.created) + obj.ttl_seconds * 1000) {
      errors.push(
        err(
          "expires",
          ERROR_CODES.EXPIRES_MISMATCH,
          "expires must equal created + ttl_seconds"
        )
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateRegistry(arr) {
  // 1. Must be an array.
  if (!Array.isArray(arr)) {
    return {
      valid: false,
      errors: [err("", ERROR_CODES.NOT_ARRAY, "registry must be a JSON array")],
    };
  }

  const errors = [];

  // 2. Per-element validation, re-prefixing each error path with [i].
  arr.forEach((claim, i) => {
    const result = validateClaim(claim);
    for (const e of result.errors) {
      const path = e.path === "" ? `[${i}]` : `[${i}].${e.path}`;
      errors.push(err(path, e.code, e.message));
    }
  });

  // 3. Duplicate id detection among structurally-valid claims. A duplicate id
  // signals corruption or a double-append; flag every occurrence after the
  // first at [i].id.
  const seen = new Set();
  arr.forEach((claim, i) => {
    if (isPlainObject(claim) && isNonEmptyString(claim.id)) {
      if (seen.has(claim.id)) {
        errors.push(
          err(`[${i}].id`, ERROR_CODES.DUPLICATE_ID, `duplicate id: ${claim.id}`)
        );
      } else {
        seen.add(claim.id);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}
