import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  preRegistration: vi.fn(),
  confirmation: vi.fn(),
  walkIn: vi.fn(),
  recovery: vi.fn(),
  status: vi.fn(),
  expiration: vi.fn()
}));

vi.mock("@/lib/server/checkins/integration-handler", () => ({
  handleCheckinPreRegistration: handlers.preRegistration,
  handleCheckinConfirmation: handlers.confirmation,
  handleCheckinWalkIn: handlers.walkIn,
  handleCheckinRecovery: handlers.recovery,
  handleCheckinStatus: handlers.status,
  handleCheckinExpiration: handlers.expiration
}));

import { POST as postPreRegistration } from "@/app/api/integrations/checkins/v1/pre-registrations/route";
import { POST as postConfirmation } from "@/app/api/integrations/checkins/v1/confirmations/route";
import { POST as postWalkIn } from "@/app/api/integrations/checkins/v1/walk-ins/route";
import { POST as postRecovery } from "@/app/api/integrations/checkins/v1/recoveries/route";
import { POST as postStatus } from "@/app/api/integrations/checkins/v1/status/route";
import { POST as postExpiration } from "@/app/api/integrations/checkins/v1/maintenance/expire/route";

describe("check-in v1 integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const handler of Object.values(handlers)) {
      handler.mockResolvedValue(new Response(null, { status: 204 }));
    }
  });

  it.each([
    ["pre-registrations", postPreRegistration, handlers.preRegistration],
    ["confirmations", postConfirmation, handlers.confirmation],
    ["walk-ins", postWalkIn, handlers.walkIn],
    ["recoveries", postRecovery, handlers.recovery],
    ["status", postStatus, handlers.status]
  ])("delegates POST /%s to the protected integration handler", async (segment, post, handler) => {
    const request = new Request(
      `http://localhost/api/integrations/checkins/v1/${segment}`,
      { method: "POST" }
    );

    const response = await post(request);

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(request);
  });

  it("keeps expiration behind the same signed server-to-server boundary", async () => {
    const request = new Request(
      "http://localhost/api/integrations/checkins/v1/maintenance/expire",
      { method: "POST" }
    );

    const response = await postExpiration(request);

    expect(response.status).toBe(204);
    expect(handlers.expiration).toHaveBeenCalledWith(request);
  });
});
