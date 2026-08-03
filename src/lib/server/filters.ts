import { z } from "zod";
import { HttpError } from "@/lib/domain/errors";
import {
  categories,
  Category,
  containerStatuses,
  ContainerStatus,
  Pump,
  ShiftType
} from "@/types/domain";

export type EventFilters = {
  dateFrom?: string;
  dateTo?: string;
  pump?: Pump;
  shiftType?: ShiftType;
  category?: Category;
  clientId?: string;
  containerStatus?: ContainerStatus;
  includeDeleted?: boolean;
};

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato AAAA-MM-DD.")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    },
    "Data inválida."
  );

const eventFiltersSchema = z
  .object({
    dateFrom: isoDateSchema.optional(),
    dateTo: isoDateSchema.optional(),
    pump: z.enum(["BOMBA_1", "BOMBA_2", "BOMBA_3"]).optional(),
    shiftType: z.enum(["MANHA", "NOITE"]).optional(),
    category: z.enum(categories).optional(),
    clientId: z.string().trim().min(1).max(128).optional(),
    containerStatus: z.enum(containerStatuses).optional(),
    includeDeleted: z.enum(["true", "false"]).default("false")
  })
  .superRefine((filters, context) => {
    if (
      filters.dateFrom &&
      filters.dateTo &&
      filters.dateFrom > filters.dateTo
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateTo"],
        message: "A data final deve ser igual ou posterior à data inicial."
      });
    }
  });

function optionalSearchParam(
  searchParams: URLSearchParams,
  key: string
): string | undefined {
  return searchParams.get(key) ?? undefined;
}

export function parseEventFilters(searchParams: URLSearchParams): EventFilters {
  const parsed = eventFiltersSchema.safeParse({
    dateFrom: optionalSearchParam(searchParams, "dateFrom"),
    dateTo: optionalSearchParam(searchParams, "dateTo"),
    pump: optionalSearchParam(searchParams, "pump"),
    shiftType: optionalSearchParam(searchParams, "shiftType"),
    category: optionalSearchParam(searchParams, "category"),
    clientId: optionalSearchParam(searchParams, "clientId"),
    containerStatus: optionalSearchParam(searchParams, "containerStatus"),
    includeDeleted:
      optionalSearchParam(searchParams, "includeDeleted") ?? "false"
  });

  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message || "Filtros de eventos inválidos."
    );
  }

  return {
    ...parsed.data,
    includeDeleted: parsed.data.includeDeleted === "true"
  };
}
