import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";

export const DEFAULT_IDLE_TOLERANCE_MINUTES = 10;
const settingsRef = () => adminDb.collection("settings").doc("operations");

export type OperationalSettings = {
  idleToleranceMinutes: number;
};

export async function getOperationalSettings(): Promise<OperationalSettings> {
  const snap = await settingsRef().get();
  const value = Number(snap.data()?.idleToleranceMinutes);
  return {
    idleToleranceMinutes:
      Number.isInteger(value) && value >= 0 && value <= 60
        ? value
        : DEFAULT_IDLE_TOLERANCE_MINUTES
  };
}

export async function updateOperationalSettings(
  raw: unknown,
  actor: { uid: string; email: string }
): Promise<OperationalSettings> {
  const parsed = z
    .object({ idleToleranceMinutes: z.number().int().min(0).max(60) })
    .parse(raw);
  await settingsRef().set(
    {
      ...parsed,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actor.uid,
      updatedByEmail: actor.email
    },
    { merge: true }
  );
  return parsed;
}
