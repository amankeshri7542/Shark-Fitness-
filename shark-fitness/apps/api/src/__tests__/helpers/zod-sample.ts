import { z, type ZodTypeAny } from 'zod';

/**
 * A small, valid-looking value for a Zod schema, so an enumeration test can get
 * a request *past* a route's validator and reach the code that loads the
 * record (which is the part under test). Not a fuzzer: it picks the first
 * enum value, the first union option and the shortest legal string, and gives
 * every required key and nothing optional. `idFor` supplies ids for keys that
 * name another record, so a body that refers to "this member" can refer to one
 * that exists.
 */
export function sampleFor(schema: ZodTypeAny, idFor: (key: string) => string | undefined = () => undefined, key = ''): unknown {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, ZodTypeAny>;
      const value: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(shape)) {
        if (field.isOptional()) continue;
        value[name] = sampleFor(field, idFor, name);
      }
      return value;
    }
    case z.ZodFirstPartyTypeKind.ZodString:
      return stringFor(schema as z.ZodString, idFor, key);
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return numberFor(schema as z.ZodNumber);
    case z.ZodFirstPartyTypeKind.ZodBigInt:
      return 1n;
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return true;
    case z.ZodFirstPartyTypeKind.ZodDate:
      return new Date();
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return def.value;
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return (def.values as string[])[0];
    case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      return Object.values(def.values as Record<string, unknown>)[0];
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const min = (def.minLength as { value: number } | null)?.value ?? (def.exactLength as { value: number } | null)?.value ?? 1;
      return Array.from({ length: Math.max(min, 1) }, () => sampleFor(def.type as ZodTypeAny, idFor, key));
    }
    case z.ZodFirstPartyTypeKind.ZodTuple:
      return (def.items as ZodTypeAny[]).map((item) => sampleFor(item, idFor, key));
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return {};
    case z.ZodFirstPartyTypeKind.ZodMap:
      return new Map();
    case z.ZodFirstPartyTypeKind.ZodSet:
      return new Set();
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = (def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>);
      const list = Array.isArray(options) ? options : [...options.values()];
      // Prefer an option the sample actually satisfies (refinements included).
      for (const option of list) {
        const candidate = sampleFor(option, idFor, key);
        if (option.safeParse(candidate).success) return candidate;
      }
      return sampleFor(list[0]!, idFor, key);
    }
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      return { ...(sampleFor(def.left as ZodTypeAny, idFor, key) as object), ...(sampleFor(def.right as ZodTypeAny, idFor, key) as object) };
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodReadonly:
    case z.ZodFirstPartyTypeKind.ZodCatch:
      return sampleFor(def.innerType as ZodTypeAny, idFor, key);
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return (def.defaultValue as () => unknown)();
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return sampleFor(def.type as ZodTypeAny, idFor, key);
    case z.ZodFirstPartyTypeKind.ZodEffects: {
      // A refinement ("10–15 digits") may refuse the inner sample: try the
      // usual shapes against the refined schema itself.
      const inner = sampleFor(def.schema as ZodTypeAny, idFor, key);
      if (schema.safeParse(inner).success) return inner;
      return STRING_CANDIDATES.find((candidate) => schema.safeParse(candidate).success) ?? inner;
    }
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      return sampleFor(def.in as ZodTypeAny, idFor, key);
    case z.ZodFirstPartyTypeKind.ZodLazy:
      return sampleFor((def.getter as () => ZodTypeAny)(), idFor, key);
    default:
      return 'x';
  }
}

/**
 * `sampleFor`, then — when a refinement such as `changing()` ("send at least
 * one field") refuses the bare required keys — optional keys are added one at
 * a time until the schema accepts the value.
 */
export function sampleValid(schema: ZodTypeAny, idFor: (key: string) => string | undefined = () => undefined): unknown {
  const value = sampleFor(schema, idFor);
  if (schema.safeParse(value).success) return value;
  const object = innermostObject(schema);
  if (!object || typeof value !== 'object' || value === null) return value;
  const candidate = { ...(value as Record<string, unknown>) };
  for (const [name, field] of Object.entries(object.shape as Record<string, ZodTypeAny>)) {
    if (name in candidate) continue;
    candidate[name] = sampleFor(field, idFor, name);
    if (schema.safeParse(candidate).success) return candidate;
  }
  return schema.safeParse(candidate).success ? candidate : value;
}

function innermostObject(schema: ZodTypeAny): z.AnyZodObject | undefined {
  let current: ZodTypeAny | undefined = schema;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const def = current._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
    if (def.typeName === z.ZodFirstPartyTypeKind.ZodObject) return current as z.AnyZodObject;
    current = (def.schema ?? def.innerType ?? def.in) as ZodTypeAny | undefined;
  }
  return undefined;
}

const STRING_CANDIDATES = [
  'Sample text',
  'sample',
  '2026-11-26',
  '2026-11-26T09:00:00.000Z',
  '09:00',
  '+919876543210',
  '9876543210',
  '#46c8dd',
  'SAMPLE1',
  'a1',
  '123456',
  'https://hooks.example.com/sample',
];

function stringFor(schema: z.ZodString, idFor: (key: string) => string | undefined, key: string): string {
  const fromKey = key ? idFor(key) : undefined;
  if (fromKey !== undefined && schema.safeParse(fromKey).success) return fromKey;
  const checks = schema._def.checks;
  const kinds = new Set(checks.map((check) => check.kind));
  if (kinds.has('email')) return 'sample@example.com';
  if (kinds.has('url')) return 'https://hooks.example.com/sample';
  if (kinds.has('uuid')) return '00000000-0000-4000-8000-000000000000';
  if (kinds.has('datetime')) return '2026-11-26T09:00:00.000Z';
  if (kinds.has('date')) return '2026-11-26';
  for (const candidate of STRING_CANDIDATES) if (schema.safeParse(candidate).success) return candidate;
  const min = checks.find((check) => check.kind === 'min' || check.kind === 'length') as { value: number } | undefined;
  return 'x'.repeat(Math.max(min?.value ?? 1, 1));
}

function numberFor(schema: z.ZodNumber): number {
  const min = schema.minValue;
  const max = schema.maxValue;
  for (const candidate of [1, min ?? 1, max ?? 1, 0]) {
    if (schema.safeParse(candidate).success) return candidate;
  }
  return min ?? 1;
}
