-- Which Telegram message (in which chat) carries each broadcast load, so the bot can delete/edit
-- those messages when the load itself is closed/removed (see bot/src/broadcaster.js). One row per
-- (load, chat) the load was actually sent to - a group chat, or the poster's own linked DM.
CREATE TABLE telegram_load_messages (
    load_id    bigint      NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
    chat_id    bigint      NOT NULL,
    message_id bigint      NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (load_id, chat_id)
);
