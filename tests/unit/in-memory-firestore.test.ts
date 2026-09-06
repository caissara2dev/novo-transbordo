import { expect, it } from "vitest";
import { InMemoryFirestore } from "../coverage/in-memory-firestore";

it("restores document contents and snapshot versions after an aborted transaction", async () => {
  const db = new InMemoryFirestore();
  const original = db.seed("events", "original", { value: "before" });
  const created = db.collection("events").doc("created");
  const before = await original.get();
  await expect(db.runTransaction(async (transaction) => {
    transaction.update(original, { value: "changed" });
    transaction.create(created, { value: "new" });
    throw new Error("abort");
  })).rejects.toThrow("abort");
  const after = await original.get();
  expect(after.data()).toEqual(before.data());
  expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
  expect((await created.get()).exists).toBe(false);
  expect(db.version(created.path)).toBe(0);
});
