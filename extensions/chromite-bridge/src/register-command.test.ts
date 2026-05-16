import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createRegisterCommand } from "./register-command.js";

function makeCtx(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return {
    senderId: overrides.senderId ?? "8797479017",
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: "/register 张三",
    args: "张三",
    config: {} as PluginCommandContext["config"],
    requestConversationBinding: async () =>
      ({
        granted: false,
      }) as Awaited<ReturnType<PluginCommandContext["requestConversationBinding"]>>,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRegisterCommand", () => {
  it("returns error when senderId is missing", async () => {
    const cmd = createRegisterCommand({ fetchImpl: vi.fn() });
    const ctx = makeCtx();
    delete ctx.senderId;
    const result = (await cmd.handler(ctx)) as PluginCommandResult;
    expect(result.reply).toContain("无法识别");
  });

  it("returns usage when args missing", async () => {
    const cmd = createRegisterCommand({ fetchImpl: vi.fn() });
    const result = (await cmd.handler(makeCtx({ args: "" }))) as PluginCommandResult;
    expect(result.reply).toContain("用法");
    expect(result.reply).toContain("/register");
  });

  it("returns usage when args is whitespace only", async () => {
    const cmd = createRegisterCommand({ fetchImpl: vi.fn() });
    const result = (await cmd.handler(makeCtx({ args: "   " }))) as PluginCommandResult;
    expect(result.reply).toContain("用法");
  });

  it("posts to chromite identity/register with telegram channel + senderId + trimmed name", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        user_id: "8f3e1234-aaaa-bbbb-cccc-1234567890ab",
        display_name: "张三",
        created: true,
      }),
    );
    const cmd = createRegisterCommand({
      pluginConfig: { chromiteUrl: "http://test:8080" },
      fetchImpl,
    });
    const result = (await cmd.handler(
      makeCtx({ senderId: "8797479017", args: "  张三  " }),
    )) as PluginCommandResult;

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test:8080/v1/identity/register");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.channel).toBe("telegram");
    expect(body.channel_user_id).toBe("8797479017");
    expect(body.display_name).toBe("张三");

    expect(result.reply).toContain("✅");
    expect(result.reply).toContain("注册成功");
    expect(result.reply).toContain("张三");
    expect(result.reply).toContain("8f3e1234-aaaa-bbbb-cccc-1234567890ab");
  });

  it("renders 'already registered' reply when chromite returns created=false", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        user_id: "existing-uuid",
        display_name: "原昵称",
        created: false,
      }),
    );
    const cmd = createRegisterCommand({
      pluginConfig: { chromiteUrl: "http://test:8080" },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "新昵称" }))) as PluginCommandResult;

    expect(result.reply).toContain("ℹ️");
    expect(result.reply).toContain("已经注册过");
    expect(result.reply).toContain("原昵称");
    expect(result.reply).toContain("existing-uuid");
    // 关键：第二次 register 提交的"新昵称"被忽略，回执显示既有 display_name (spec 决策 #C)
    expect(result.reply).not.toContain("新昵称");
  });

  it("renders 4xx error reply on invalid input (chromite-side validation)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "InvalidArgument", message: "display_name 超过 64 字符上限" }, 400),
    );
    const cmd = createRegisterCommand({
      pluginConfig: { chromiteUrl: "http://test:8080" },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "x" }))) as PluginCommandResult;
    expect(result.reply).toContain("❌");
    expect(result.reply).toContain("输入有问题");
    expect(result.reply).toContain("display_name");
  });

  it("renders 5xx error reply on chromite internal error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "Internal", message: "PG connection lost" }, 500),
    );
    const cmd = createRegisterCommand({
      pluginConfig: { chromiteUrl: "http://test:8080" },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "x" }))) as PluginCommandResult;
    expect(result.reply).toContain("❌");
    expect(result.reply).toContain("暂时不可用");
  });

  it("renders network failure reply when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const cmd = createRegisterCommand({
      pluginConfig: { chromiteUrl: "http://test:8080" },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "x" }))) as PluginCommandResult;
    expect(result.reply).toContain("❌");
    expect(result.reply).toContain("ECONNREFUSED");
  });

  it("renders non-JSON response gracefully", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>nginx 502</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const cmd = createRegisterCommand({
      pluginConfig: { chromiteUrl: "http://test:8080" },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "x" }))) as PluginCommandResult;
    expect(result.reply).toContain("非 JSON");
  });

  it("name and description fields are stable", () => {
    const cmd = createRegisterCommand({ fetchImpl: vi.fn() });
    expect(cmd.name).toBe("register");
    expect(cmd.description).toContain("Register");
  });
});
