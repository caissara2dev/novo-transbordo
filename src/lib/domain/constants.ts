import { Category } from "@/types/domain";

export const TZ = "America/Sao_Paulo";

export const categoryRules: Record<
  Category,
  {
    requiresClient: boolean;
    requiresPlate: boolean;
    requiresContainer: boolean;
    requiresNotes: boolean;
  }
> = {
  PRODUTIVO: {
    requiresClient: true,
    requiresPlate: true,
    requiresContainer: true,
    requiresNotes: false
  },
  INTERVALO_OPERACIONAL: {
    requiresClient: false,
    requiresPlate: false,
    requiresContainer: false,
    requiresNotes: false
  },
  EM_TRANSITO: {
    requiresClient: true,
    requiresPlate: true,
    requiresContainer: false,
    requiresNotes: true
  },
  AGUARDANDO_LABORATORIO: {
    requiresClient: true,
    requiresPlate: true,
    requiresContainer: false,
    requiresNotes: true
  },
  SEM_CAMINHAO: {
    requiresClient: true,
    requiresPlate: false,
    requiresContainer: false,
    requiresNotes: true
  },
  SEM_CONTAINER: {
    requiresClient: false,
    requiresPlate: false,
    requiresContainer: false,
    requiresNotes: true
  },
  MANUTENCAO: {
    requiresClient: false,
    requiresPlate: false,
    requiresContainer: false,
    requiresNotes: true
  },
  OUTROS: {
    requiresClient: false,
    requiresPlate: false,
    requiresContainer: false,
    requiresNotes: true
  }
};

export const SHIFT_WINDOWS = {
  MANHA: {
    start: "06:00",
    end: "15:00"
  },
  NOITE: {
    start: "15:01",
    end: "00:48"
  }
} as const;
