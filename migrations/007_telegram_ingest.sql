-- Telegram group ingestion: a second bot (bot/src/ingestIndex.js) joins SOURCE groups - the big
-- public freight-posting chats, not the user's own broadcast chats from 006_telegram.sql - reads
-- every message, and turns the ones that look like loads into real board listings automatically,
-- via the same AI parser + the same real HTTP API the "paste from Telegram" web feature already
-- uses (server/src/routes/ai.js, server/src/routes/loads.js). No new "AI import path": it is the
-- existing one, just triggered by a bot instead of a person pasting text.
--
-- Three tables:
--   telegram_ingest_chats        - which chats to listen to, and simple counters per chat.
--   telegram_ingest_messages     - one row per Telegram message decided on, so a redelivered
--                                   update or a process restart can never process (and therefore
--                                   never post) the same message twice.
--   telegram_ingest_fingerprints - short-lived "already posted this load" index, so the same load
--                                   cross-posted to several groups (or reposted later in the same
--                                   one, which happens constantly) becomes one load, not several.

CREATE TABLE telegram_ingest_chats (
    id               bigserial PRIMARY KEY,
    chat_id          bigint      NOT NULL,
    chat_type        text        NOT NULL,
    title            text        NOT NULL DEFAULT '',
    status           text        NOT NULL DEFAULT 'active',
    added_by         bigint,
    messages_seen    bigint      NOT NULL DEFAULT 0,
    loads_posted     bigint      NOT NULL DEFAULT 0,
    last_message_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_ingest_chats_status_valid CHECK (status IN ('active', 'paused', 'removed')),
    CONSTRAINT telegram_ingest_chats_type_valid   CHECK (chat_type IN ('group', 'supergroup', 'channel')),
    CONSTRAINT telegram_ingest_chats_title_len    CHECK (char_length(title) <= 255)
);
CREATE UNIQUE INDEX telegram_ingest_chats_chatid_key ON telegram_ingest_chats (chat_id);

CREATE TABLE telegram_ingest_messages (
    id                 bigserial PRIMARY KEY,
    source_chat_id     bigint      NOT NULL,
    source_message_id  bigint      NOT NULL,
    status             text        NOT NULL,
    load_ids           bigint[]    NOT NULL DEFAULT '{}',
    detail             text        NOT NULL DEFAULT '',
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_ingest_messages_status_valid CHECK (
      status IN ('posted', 'partial', 'skipped_filter', 'skipped_duplicate', 'skipped_no_load', 'skipped_unresolved', 'error')
    ),
    CONSTRAINT telegram_ingest_messages_detail_len CHECK (char_length(detail) <= 2000)
);
-- The hot-path guard: INSERT ... ON CONFLICT DO NOTHING on this key is how a message gets "claimed"
-- exactly once, before any AI call or post is made for it.
CREATE UNIQUE INDEX telegram_ingest_messages_key ON telegram_ingest_messages (source_chat_id, source_message_id);

CREATE TABLE telegram_ingest_fingerprints (
    fingerprint  text        PRIMARY KEY,
    load_id      bigint,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_ingest_fingerprints_seen_idx ON telegram_ingest_fingerprints (last_seen_at);
