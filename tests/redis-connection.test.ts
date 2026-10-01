import { describe, it, expect } from "vitest";
import { parseRedisUrl } from "../src/queues/connection.js";

describe("parseRedisUrl", () => {
  it("keeps the db index so an isolated worker never consumes db 0", () => {
    expect(parseRedisUrl("redis://localhost:6379/1")).toMatchObject({ host: "localhost", port: 6379, db: 1 });
  });
  it("defaults to db 0 (no db key)", () => {
    expect(parseRedisUrl("redis://localhost:6379")).not.toHaveProperty("db");
    expect(parseRedisUrl("redis://localhost:6379/0")).not.toHaveProperty("db");
  });
});
