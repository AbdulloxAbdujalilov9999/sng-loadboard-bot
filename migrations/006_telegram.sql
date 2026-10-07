-- Telegram bot: account linking + the groups/channels the bot has been added to.
-- The bot process is a separate trusted service (bot/); it shares this database but never shares a
-- login with the browser app. Refresh tokens are stored encrypted (see bot/src/crypto.js); this
-- table never holds a plaintext password.

CREATE TABLE telegram_links (
    id                 bigserial PRIMARY KEY,
    member_id          bigint      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    telegram_user_id   bigint      NOT NULL,
    telegram_username  text        NOT NULL DEFAULT '',
    refresh_token_enc  text        NOT NULL,
    linked_at          timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_links_username_len CHECK (char_length(telegram_username) <= 64),
    CONSTRAINT telegram_links_token_len    CHECK (char_length(refresh_token_enc) <= 4000)
);
-- One Telegram account links to one member, and vice versa (re-linking replaces the row).
CREATE UNIQUE INDEX telegram_links_tgid_key   ON telegram_links (telegram_user_id);
CREATE UNIQUE INDEX telegram_links_member_key ON telegram_links (member_id);

CREATE TABLE telegram_chats (
    id          bigserial PRIMARY KEY,
    chat_id     bigint      NOT NULL,
    chat_type   text        NOT NULL,
    title       text        NOT NULL DEFAULT '',
    status      text        NOT NULL DEFAULT 'active',
    added_by    bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_chats_status_valid CHECK (status IN ('active', 'removed')),
    CONSTRAINT telegram_chats_type_valid   CHECK (chat_type IN ('group', 'supergroup', 'channel')),
    CONSTRAINT telegram_chats_title_len    CHECK (char_length(title) <= 255)
);
CREATE UNIQUE INDEX telegram_chats_chatid_key ON telegram_chats (chat_id);
-- The broadcaster's hot path: "every chat the bot should currently post to".
CREATE INDEX telegram_chats_active_idx ON telegram_chats (id) WHERE status = 'active';

-- One row per Telegram user who has ever messaged the bot, independent of whether they are linked
-- to a member yet (so /start, /link itself, etc. can already be in their language). Auto-detected
-- from Telegram's own language_code on first contact, overridable with /language.
CREATE TABLE telegram_users (
    telegram_user_id bigint      PRIMARY KEY,
    language         text        NOT NULL DEFAULT 'en',
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_users_language_valid CHECK (language IN ('en', 'ru', 'uz'))
);
