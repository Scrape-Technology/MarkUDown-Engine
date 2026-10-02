import { describe, it, expect } from "vitest";
import { parseRedisUrl } from "../src/queues/connection.js";

describe("parseRedisUrl (conexão BullMQ)", () => {
  it("lê o índice do db do path; padrão 0", () => {
    expect(parseRedisUrl("redis://h:6380/2")).toMatchObject({ host: "h", port: 6380, db: 2 });
    expect(parseRedisUrl("redis://h:6379").db).toBe(0);
    expect(parseRedisUrl("redis://:p%40ss@h/").db).toBe(0);
    expect(parseRedisUrl("redis://:p%40ss@h/").password).toBe("p@ss");
  });
});
