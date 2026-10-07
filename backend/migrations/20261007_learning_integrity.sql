-- Applied automatically by backend/lib/schema.js on server start.
-- session_version lets password changes revoke outstanding JWTs.
-- retired_media holds replaced uploads until the retention window ends.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS retired_media (
    id BIGSERIAL PRIMARY KEY,
    bucket TEXT NOT NULL,
    object_path TEXT NOT NULL,
    delete_after TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS retired_media_due_idx
    ON retired_media (delete_after)
    WHERE deleted_at IS NULL;
