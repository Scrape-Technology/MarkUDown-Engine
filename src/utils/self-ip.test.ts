import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { getSelfIp, forbiddenEgressList, RETRY_MS } from "./self-ip.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("self-ip", () => {
  it("failed detection is retried at most once a minute, then cached on success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSelfIp()).toBeUndefined();
    expect(await getSelfIp()).toBeUndefined();
    expect(await forbiddenEgressList("203.0.113.1")).toBe("203.0.113.1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue({ text: async () => "198.51.100.7\n" });
    await vi.advanceTimersByTimeAsync(RETRY_MS + 1);
    expect(await getSelfIp()).toBe("198.51.100.7");
    expect(await getSelfIp()).toBe("198.51.100.7");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await forbiddenEgressList("203.0.113.1")).toBe("203.0.113.1,198.51.100.7");
  });
});
