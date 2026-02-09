import { EventDoc, UserDoc } from "@/types/domain";

export type EventApiItem = Omit<EventDoc, "createdAt" | "updatedAt" | "startAt" | "endAt"> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  startAt: string;
  endAt: string;
  warnings?: string[];
};

export type ClientApiItem = {
  id: string;
  name: string;
  nameUpper: string;
  active: boolean;
};

export type UserApiItem = UserDoc & { id: string };
