import { DateTime } from "luxon";
import { ShiftType } from "@/types/domain";
import { TZ } from "@/lib/domain/constants";

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidHHMM(input: string): boolean {
  return HH_MM.test(input);
}

export function parseTimeToMinutes(input: string): number {
  const [h, m] = input.split(":").map(Number);
  return h * 60 + m;
}

export function normalizeUpper(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed.toUpperCase() : null;
}

export function resolveTimelineDate(
  shiftDate: string,
  shiftType: ShiftType,
  hhmm: string
): DateTime {
  const [year, month, day] = shiftDate.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);

  let dt = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour,
      minute,
      second: 0,
      millisecond: 0
    },
    { zone: TZ }
  );

  if (shiftType === "NOITE" && parseTimeToMinutes(hhmm) <= 48) {
    dt = dt.plus({ days: 1 });
  }

  return dt;
}

export function computeWindowCheck(shiftType: ShiftType, hhmm: string): boolean {
  const minutes = parseTimeToMinutes(hhmm);

  if (shiftType === "MANHA") {
    return minutes >= 360 && minutes <= 900;
  }

  return minutes >= 901 || minutes <= 48;
}

export function calculateDurationMinutes(startIso: string, endIso: string): number {
  const start = DateTime.fromISO(startIso, { zone: TZ });
  const end = DateTime.fromISO(endIso, { zone: TZ });

  return Math.floor(end.diff(start, "minutes").minutes);
}

export function currentShiftFromNow(now: DateTime = DateTime.now().setZone(TZ)): {
  shiftDate: string;
  shiftType: ShiftType;
} {
  const minutes = now.hour * 60 + now.minute;

  if (minutes >= 901) {
    return { shiftDate: now.toISODate() ?? "", shiftType: "NOITE" };
  }

  if (minutes <= 48) {
    return {
      shiftDate: now.minus({ days: 1 }).toISODate() ?? "",
      shiftType: "NOITE"
    };
  }

  return { shiftDate: now.toISODate() ?? "", shiftType: "MANHA" };
}
