import { Timestamp } from "firebase-admin/firestore";

type StoredDocument = Record<string, unknown>;

type QueryFilter = {
  field: string;
  operator: string;
  value: unknown;
};

type QueryOrder = {
  field: string;
  direction: "asc" | "desc";
};

function getField(data: StoredDocument, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return Reflect.get(value, segment);
  }, data);
}

function toComparable(value: unknown): unknown {
  if (value && typeof value === "object" && "toMillis" in value) {
    return (value as { toMillis(): number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  return value;
}

function matchesFilter(data: StoredDocument, filter: QueryFilter): boolean {
  const actual = toComparable(getField(data, filter.field));
  const expected = toComparable(filter.value);

  switch (filter.operator) {
    case "==":
      return actual === expected;
    case ">":
      return (actual as never) > (expected as never);
    case ">=":
      return (actual as never) >= (expected as never);
    case "<":
      return (actual as never) < (expected as never);
    case "<=":
      return (actual as never) <= (expected as never);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    default:
      throw new Error(`Unsupported fake Firestore operator: ${filter.operator}`);
  }
}

class FakeDocumentSnapshot {
  constructor(
    readonly ref: FakeDocumentReference,
    private readonly stored: StoredDocument | undefined,
    readonly updateTime: Timestamp = ref.updateTime
  ) {}

  get id(): string {
    return this.ref.id;
  }

  get exists(): boolean {
    return this.stored !== undefined;
  }

  data(): StoredDocument | undefined {
    return this.stored ? { ...this.stored } : undefined;
  }
}

class FakeQuerySnapshot {
  constructor(readonly docs: FakeDocumentSnapshot[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }
}

class FakeQuery {
  constructor(
    protected readonly db: InMemoryFirestore,
    readonly collectionPath: string,
    private readonly filters: QueryFilter[] = [],
    private readonly orders: QueryOrder[] = [],
    private readonly maximum: number | null = null,
    private readonly afterValues: unknown[] | null = null
  ) {}

  where(field: string, operator: string, value: unknown): FakeQuery {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      [...this.filters, { field, operator, value }],
      this.orders,
      this.maximum,
      this.afterValues
    );
  }

  orderBy(field: unknown, direction: "asc" | "desc" = "asc"): FakeQuery {
    const normalizedField = typeof field === "string" ? field : "__name__";
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.filters,
      [...this.orders, { field: normalizedField, direction }],
      this.maximum,
      this.afterValues
    );
  }

  startAfter(...values: unknown[]): FakeQuery {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.filters,
      this.orders,
      this.maximum,
      values
    );
  }

  limit(maximum: number): FakeQuery {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.filters,
      this.orders,
      maximum,
      this.afterValues
    );
  }

  async get(): Promise<FakeQuerySnapshot> {
    const entries = this.db.entries(this.collectionPath)
      .filter(([, data]) =>
        this.filters.every((filter) => matchesFilter(data, filter))
      )
      .sort((left, right) => {
        for (const order of this.orders) {
          const leftValue =
            order.field === "__name__"
              ? left[0]
              : toComparable(getField(left[1], order.field));
          const rightValue =
            order.field === "__name__"
              ? right[0]
              : toComparable(getField(right[1], order.field));
          if (leftValue === rightValue) continue;
          const result = (leftValue as never) < (rightValue as never) ? -1 : 1;
          return order.direction === "desc" ? -result : result;
        }
        return left[0].localeCompare(right[0]);
      });
    const pageEntries = this.afterValues ? entries.filter(([id, data]) => {
      for (const [index, order] of this.orders.entries()) {
        const actual = order.field === "__name__" ? id : toComparable(getField(data, order.field));
        const boundary = toComparable(this.afterValues![index]);
        if (actual === boundary) continue;
        return order.direction === "desc" ? (actual as never) < (boundary as never) : (actual as never) > (boundary as never);
      }
      return false;
    }) : entries;
    const limited =
      this.maximum === null
        ? pageEntries
        : pageEntries.slice(0, this.maximum);

    return new FakeQuerySnapshot(
      limited.map(([id, data]) => {
        const suppliedRef = data.__fakeRef;
        const ref =
          suppliedRef instanceof FakeDocumentReference
            ? suppliedRef
            : new FakeDocumentReference(this.db, this.collectionPath, id);
        const { __fakeRef: _ref, ...stored } = data;
        void _ref;
        return new FakeDocumentSnapshot(ref, stored);
      })
    );
  }
}

class FakeCollectionReference extends FakeQuery {
  doc(id = this.db.nextId()): FakeDocumentReference {
    return new FakeDocumentReference(this.db, this.collectionPath, id);
  }
}

class FakeDocumentReference {
  constructor(
    private readonly db: InMemoryFirestore,
    readonly collectionPath: string,
    readonly id: string
  ) {}

  get path(): string {
    return `${this.collectionPath}/${this.id}`;
  }

  get updateTime(): Timestamp {
    return Timestamp.fromMillis(this.db.version(this.path));
  }

  get parent(): { parent: FakeDocumentReference | null } {
    const segments = this.collectionPath.split("/");
    if (segments.length < 3) return { parent: null };
    return {
      parent: new FakeDocumentReference(
        this.db,
        segments.slice(0, -2).join("/"),
        segments.at(-2) as string
      )
    };
  }

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }

  async get(): Promise<FakeDocumentSnapshot> {
    return new FakeDocumentSnapshot(
      this,
      this.db.read(this.collectionPath, this.id)
    );
  }

  async set(data: StoredDocument, options?: { merge?: boolean }): Promise<void> {
    this.db.write(this.collectionPath, this.id, data, Boolean(options?.merge));
  }

  async update(data: StoredDocument): Promise<void> {
    if (!this.db.read(this.collectionPath, this.id)) {
      throw new Error(`Document does not exist: ${this.path}`);
    }
    this.db.write(this.collectionPath, this.id, data, true);
  }

  async delete(): Promise<void> {
    this.db.remove(this.collectionPath, this.id);
  }
}

class FakeTransaction {
  constructor(private readonly db: InMemoryFirestore) {}

  async get(
    target: FakeDocumentReference | FakeQuery
  ): Promise<FakeDocumentSnapshot | FakeQuerySnapshot> {
    return target.get();
  }

  create(ref: FakeDocumentReference, data: StoredDocument): this {
    if (this.db.read(ref.collectionPath, ref.id)) {
      throw new Error(`Document already exists: ${ref.path}`);
    }
    this.db.write(ref.collectionPath, ref.id, data, false);
    return this;
  }

  set(
    ref: FakeDocumentReference,
    data: StoredDocument,
    options?: { merge?: boolean }
  ): this {
    this.db.write(ref.collectionPath, ref.id, data, Boolean(options?.merge));
    return this;
  }

  update(ref: FakeDocumentReference, data: StoredDocument): this {
    if (!this.db.read(ref.collectionPath, ref.id)) {
      throw new Error(`Document does not exist: ${ref.path}`);
    }
    this.db.write(ref.collectionPath, ref.id, data, true);
    return this;
  }

  delete(ref: FakeDocumentReference): this {
    this.db.remove(ref.collectionPath, ref.id);
    return this;
  }
}

export class InMemoryFirestore {
  private readonly collections = new Map<
    string,
    Map<string, StoredDocument>
  >();
  private idSequence = 0;
  private readonly versions = new Map<string, number>();

  version(path: string): number {
    return this.versions.get(path) || 0;
  }

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this, name);
  }

  collectionGroup(name: string): FakeQuery {
    const groupPath = `__group__/${name}`;
    const group = new Map<string, StoredDocument>();

    for (const [collectionPath, documents] of this.collections) {
      if (collectionPath.split("/").at(-1) !== name) continue;
      for (const [id, data] of documents) {
        group.set(`${collectionPath}/${id}`, {
          ...data,
          __collectionPath: collectionPath,
          __documentId: id
        });
      }
    }
    this.collections.set(groupPath, group);

    return new FakeQuery(this, groupPath);
  }

  async runTransaction<T>(
    callback: (transaction: FakeTransaction) => Promise<T>
  ): Promise<T> {
    const before = this.cloneCollections();
    const versionsBefore = new Map(this.versions);
    try {
      return await callback(new FakeTransaction(this));
    } catch (error) {
      this.restoreCollections(before);
      this.versions.clear();
      versionsBefore.forEach((version, path) => this.versions.set(path, version));
      throw error;
    }
  }

  reset(): void {
    this.collections.clear();
    this.idSequence = 0;
    this.versions.clear();
  }

  seed(
    collectionPath: string,
    id: string,
    data: StoredDocument
  ): FakeDocumentReference {
    this.write(collectionPath, id, data, false);
    return new FakeDocumentReference(this, collectionPath, id);
  }

  read(collectionPath: string, id: string): StoredDocument | undefined {
    const stored = this.collections.get(collectionPath)?.get(id);
    return stored ? { ...stored } : undefined;
  }

  entries(collectionPath: string): Array<[string, StoredDocument]> {
    const entries = this.collections.get(collectionPath)?.entries() ?? [];

    if (collectionPath.startsWith("__group__/")) {
      return Array.from(entries, ([key, data]) => {
        const actualPath = String(data.__collectionPath);
        const actualId = String(data.__documentId);
        const { __collectionPath: _path, __documentId: _id, ...stored } = data;
        void _path;
        void _id;
        const snapshotData = {
          ...stored,
          __fakeRef: new FakeDocumentReference(this, actualPath, actualId)
        };
        return [key, snapshotData];
      });
    }

    return Array.from(entries, ([id, data]) => [id, { ...data }]);
  }

  nextId(): string {
    this.idSequence += 1;
    return `generated-${this.idSequence}`;
  }

  write(
    collectionPath: string,
    id: string,
    data: StoredDocument,
    merge: boolean
  ): void {
    const collection = this.collections.get(collectionPath) ?? new Map();
    const previous = collection.get(id);
    collection.set(id, merge ? { ...previous, ...data } : { ...data });
    this.collections.set(collectionPath, collection);
    const path = `${collectionPath}/${id}`;
    this.versions.set(path, this.version(path) + 1);
  }

  remove(collectionPath: string, id: string): void {
    this.collections.get(collectionPath)?.delete(id);
  }

  private cloneCollections(): Map<string, Map<string, StoredDocument>> {
    return new Map(
      Array.from(this.collections, ([path, documents]) => [
        path,
        new Map(
          Array.from(documents, ([id, data]) => [id, { ...data }])
        )
      ])
    );
  }

  private restoreCollections(
    snapshot: Map<string, Map<string, StoredDocument>>
  ): void {
    this.collections.clear();
    for (const [path, documents] of snapshot) {
      this.collections.set(path, documents);
    }
  }
}

export const inMemoryAdminDb = new InMemoryFirestore();
