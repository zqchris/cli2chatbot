type TelegramApiResult<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

export type TelegramTextOptions = {
  parseMode?: "HTML";
  replyMarkup?: Record<string, unknown>;
};

export type TelegramBotCommand = {
  command: string;
  description: string;
};

export class TelegramApi {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = (await response.json()) as TelegramApiResult<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description ?? `Telegram ${method} failed`);
    }
    return payload.result;
  }

  getMe(): Promise<{ id: number; username?: string }> {
    return this.call("getMe");
  }

  getUpdates(offset?: number): Promise<Array<Record<string, unknown>>> {
    return this.call("getUpdates", { offset, timeout: 20, allowed_updates: ["message"] });
  }

  setMyCommands(commands: TelegramBotCommand[]): Promise<true> {
    return this.call("setMyCommands", { commands });
  }

  sendMessage(chatId: string, text: string, options?: TelegramTextOptions): Promise<{ message_id: number }> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      disable_web_page_preview: true
    });
  }

  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options?: TelegramTextOptions
  ): Promise<{ message_id: number }> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      disable_web_page_preview: true
    });
  }

  sendTyping(chatId: string): Promise<true> {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }
}
