// Raw Telegram Bot API helpers used by the bridge's background streams
// (follow tail, stale-marker notice, etc.). Direct fetch — daemon-side
// `NODE_OPTIONS=--use-env-proxy` (injected by scripts/openclaw-start.sh)
// makes native fetch honor https_proxy.
//
// Why not route through the telegram extension's channel runtime: that
// path is bound to request scope, account resolution, and full chunker /
// keyboard pipeline. The bridge's tail streams need a thinner seam — just
// "send text to chat (+ optional forum topic thread)" — and must never
// throw, since the follow loop has to keep ticking even when Telegram is
// briefly unreachable.
//
// All exports are best-effort: errors return a structured result instead
// of throwing.

const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_CREATE_TOPIC_TIMEOUT_MS = 10_000;
const DEFAULT_EDIT_TIMEOUT_MS = 10_000;
const DEFAULT_DELETE_TIMEOUT_MS = 5_000;

type Ok<T> = { ok: true } & T;
type Err = { ok: false; status?: number; description?: string };

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type SendBotMessageOpts = {
  botToken: string;
  chatId: string | number;
  text: string;
  /** Forum supergroup topic thread id. Omit for non-topic chats. */
  messageThreadId?: number;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
  /** Inline keyboard attached as reply_markup. */
  replyMarkup?: InlineKeyboardMarkup;
  /** Defaults to 10s. */
  timeoutMs?: number;
};

export type SendBotMessageResult = Ok<{ messageId: number; chatId: string }> | Err;

export type EditMessageTextOpts = {
  botToken: string;
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
  replyMarkup?: InlineKeyboardMarkup;
  timeoutMs?: number;
};

export type EditMessageTextResult = Ok<{ messageId: number; chatId: string }> | Err;

export type DeleteMessageOpts = {
  botToken: string;
  chatId: string | number;
  messageId: number;
  timeoutMs?: number;
};

export type DeleteMessageResult = Ok<{}> | Err;

export type SendTypingActionOpts = {
  botToken: string;
  chatId: string | number;
  messageThreadId?: number;
  timeoutMs?: number;
};

export type CreateForumTopicOpts = {
  botToken: string;
  chatId: string | number;
  name: string;
  /** Telegram-supported palette: 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F. */
  iconColor?: number;
  iconCustomEmojiId?: string;
  timeoutMs?: number;
};

export type CreateForumTopicResult = Ok<{ messageThreadId: number; name: string }> | Err;

type RawResponse<R> = {
  ok: boolean;
  result?: R;
  description?: string;
  error_code?: number;
};

async function callBotApi<R>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; body: RawResponse<R> } | { status: number; error: string }> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const status = res.status;
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as RawResponse<R>;
    return { status, body: parsed };
  } catch {
    return { status, error: text.slice(0, 200) };
  }
}

export async function sendBotMessage(opts: SendBotMessageOpts): Promise<SendBotMessageResult> {
  if (!opts.botToken) {
    return { ok: false, description: "missing bot token" };
  }
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  };
  if (typeof opts.messageThreadId === "number") {
    payload.message_thread_id = opts.messageThreadId;
  }
  if (opts.parseMode) {
    payload.parse_mode = opts.parseMode;
  }
  if (opts.replyMarkup) {
    payload.reply_markup = opts.replyMarkup;
  }
  try {
    const result = await callBotApi<{ message_id: number; chat: { id: number | string } }>(
      opts.botToken,
      "sendMessage",
      payload,
      opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    );
    if ("error" in result) {
      return { ok: false, status: result.status, description: result.error };
    }
    if (!result.body.ok || !result.body.result) {
      return { ok: false, status: result.status, description: result.body.description };
    }
    return {
      ok: true,
      messageId: result.body.result.message_id,
      chatId: String(result.body.result.chat.id),
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, description: `${e?.name ?? "Error"}: ${e?.message ?? ""}` };
  }
}

export async function editMessageText(opts: EditMessageTextOpts): Promise<EditMessageTextResult> {
  if (!opts.botToken) {
    return { ok: false, description: "missing bot token" };
  }
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    text: opts.text,
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  };
  if (opts.parseMode) {
    payload.parse_mode = opts.parseMode;
  }
  if (opts.replyMarkup) {
    payload.reply_markup = opts.replyMarkup;
  }
  try {
    const result = await callBotApi<{ message_id: number; chat: { id: number | string } }>(
      opts.botToken,
      "editMessageText",
      payload,
      opts.timeoutMs ?? DEFAULT_EDIT_TIMEOUT_MS,
    );
    if ("error" in result) {
      return { ok: false, status: result.status, description: result.error };
    }
    if (!result.body.ok || !result.body.result) {
      return { ok: false, status: result.status, description: result.body.description };
    }
    return {
      ok: true,
      messageId: result.body.result.message_id,
      chatId: String(result.body.result.chat.id),
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, description: `${e?.name ?? "Error"}: ${e?.message ?? ""}` };
  }
}

export async function deleteMessage(opts: DeleteMessageOpts): Promise<DeleteMessageResult> {
  if (!opts.botToken) {
    return { ok: false, description: "missing bot token" };
  }
  const payload = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
  };
  try {
    const result = await callBotApi<boolean>(
      opts.botToken,
      "deleteMessage",
      payload,
      opts.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS,
    );
    if ("error" in result) {
      return { ok: false, status: result.status, description: result.error };
    }
    if (!result.body.ok) {
      return { ok: false, status: result.status, description: result.body.description };
    }
    return { ok: true };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, description: `${e?.name ?? "Error"}: ${e?.message ?? ""}` };
  }
}

export async function sendTypingAction(opts: SendTypingActionOpts): Promise<void> {
  if (!opts.botToken) return;
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    action: "typing",
  };
  if (typeof opts.messageThreadId === "number") {
    payload.message_thread_id = opts.messageThreadId;
  }
  try {
    await callBotApi(
      opts.botToken,
      "sendChatAction",
      payload,
      opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    );
  } catch {
    // Cosmetic; never propagate.
  }
}

export async function createForumTopic(
  opts: CreateForumTopicOpts,
): Promise<CreateForumTopicResult> {
  if (!opts.botToken) {
    return { ok: false, description: "missing bot token" };
  }
  if (!opts.name.trim()) {
    return { ok: false, description: "empty topic name" };
  }
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    name: opts.name,
  };
  if (typeof opts.iconColor === "number") {
    payload.icon_color = opts.iconColor;
  }
  if (opts.iconCustomEmojiId) {
    payload.icon_custom_emoji_id = opts.iconCustomEmojiId;
  }
  try {
    const result = await callBotApi<{
      message_thread_id: number;
      name: string;
    }>(
      opts.botToken,
      "createForumTopic",
      payload,
      opts.timeoutMs ?? DEFAULT_CREATE_TOPIC_TIMEOUT_MS,
    );
    if ("error" in result) {
      return { ok: false, status: result.status, description: result.error };
    }
    if (!result.body.ok || !result.body.result) {
      return { ok: false, status: result.status, description: result.body.description };
    }
    return {
      ok: true,
      messageThreadId: result.body.result.message_thread_id,
      name: result.body.result.name,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, description: `${e?.name ?? "Error"}: ${e?.message ?? ""}` };
  }
}
