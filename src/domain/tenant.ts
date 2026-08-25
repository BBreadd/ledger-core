// tenant.ts -- who an account belongs to. Depends on: nothing.

/**
 * An account belongs to exactly one tenant, and a transaction never leaves one. That rule
 * is not enforced here: the schema makes a cross-tenant entry unwritable through composite
 * foreign keys, in the same way an entry in the wrong currency is unwritable. What lives
 * here is the vocabulary, so that a tenant id is not just another string in a signature.
 */
export type TenantId = string;

/**
 * The tenant a migrated database ships with, seeded by migration 0007.
 *
 * Written once here and nowhere else. It has to match a row in a versioned file, and a
 * constant that must agree with something in another language is exactly the kind that
 * ends up copied into four places and corrected in three.
 *
 * The value is legible as a sentinel on purpose. A random UUIDv7 would be indistinguishable
 * from a real tenant six months from now.
 */
export const DEFAULT_TENANT_ID: TenantId = "00000000-0000-0000-0000-000000000001";
