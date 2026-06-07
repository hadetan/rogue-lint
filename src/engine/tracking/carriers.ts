import type { InternalNamespaceMethodCarrier, ProjectContext } from "../../types.js";
import { propertySegment, serializePath } from "../../shared/path-utils.js";
import type { PathSegment } from "../../types.js";

/**
 * Lookup helpers for project-configured `internalNamespaceMethodCarriers`.
 *
 * A carrier declares that a call of the shape `<receiver>.<namespace>.<method>(payload)` is value-preserving:
 * the call propagates the payload through unchanged. The tracking engine consults these rules when resolving
 * carrier-preserving return bindings, recognizing closure-captured callable assignments, and treating sibling
 * carrier methods as interchangeable.
 *
 * Engine code MUST NOT bake in any specific namespace or method name; all carrier semantics flow through here.
 */

interface CarrierLookups {
  /**
   * Returns true when the supplied path segment names a carrier method on the given namespace.
   */
  isCarrierMethodFor(namespace: string, methodName: string): boolean;

  /**
   * Returns the carrier rule that owns the supplied namespace, or undefined when not configured.
   */
  getCarrier(namespace: string): InternalNamespaceMethodCarrier | undefined;

  /**
   * Returns true when `expected` and `actual` are interchangeable carrier methods on the same namespace.
   *
   * The two method names are interchangeable when both belong to the same configured carrier's
   * `carrierMethods` set. Useful for recognizing closure-captured callable assignments where the
   * receiver-side name differs from the call-site name.
   */
  areInterchangeableMethodsFor(namespace: string, expected: string, actual: string): boolean;

  /**
   * Returns the set of serialized `<namespace>/<method>` suffix keys for every configured carrier method,
   * for fast suffix matching against access paths.
   */
  getCarrierMemberSuffixKeys(): readonly string[];

  /**
   * Returns the configured definition path segments for the supplied namespace, or undefined when none.
   */
  getDefinitionPathSegments(namespace: string): PathSegment[] | undefined;

  /**
   * Returns true when the supplied serialized access-path ends with any configured carrier `<namespace>/<method>` suffix.
   */
  pathEndsWithCarrierSuffix(pathKey: string): boolean;
}

function normalizeCarriers(
  raw: readonly InternalNamespaceMethodCarrier[] | undefined,
): readonly InternalNamespaceMethodCarrier[] {
  if (!raw || raw.length === 0) {
    return [];
  }

  return raw
    .filter((carrier) => carrier && typeof carrier.namespace === "string" && carrier.namespace.length > 0)
    .map((carrier) => ({
      namespace: carrier.namespace,
      carrierMethods: (carrier.carrierMethods ?? []).filter((name) => typeof name === "string" && name.length > 0),
      definitionPath: carrier.definitionPath?.filter((name) => typeof name === "string" && name.length > 0),
    }));
}

function createCarrierLookups(
  rawCarriers: readonly InternalNamespaceMethodCarrier[] | undefined,
): CarrierLookups {
  const carriers = normalizeCarriers(rawCarriers);
  const carriersByNamespace = new Map<string, InternalNamespaceMethodCarrier>();
  const suffixKeys: string[] = [];

  for (const carrier of carriers) {
    carriersByNamespace.set(carrier.namespace, carrier);
    for (const method of carrier.carrierMethods) {
      suffixKeys.push(serializePath([propertySegment(carrier.namespace), propertySegment(method)]));
    }
  }

  return {
    isCarrierMethodFor(namespace, methodName) {
      const carrier = carriersByNamespace.get(namespace);
      return Boolean(carrier?.carrierMethods.includes(methodName));
    },
    getCarrier(namespace) {
      return carriersByNamespace.get(namespace);
    },
    areInterchangeableMethodsFor(namespace, expected, actual) {
      if (expected === actual) {
        return true;
      }
      const carrier = carriersByNamespace.get(namespace);
      return Boolean(
        carrier
        && carrier.carrierMethods.includes(expected)
        && carrier.carrierMethods.includes(actual),
      );
    },
    getCarrierMemberSuffixKeys() {
      return suffixKeys;
    },
    getDefinitionPathSegments(namespace) {
      const carrier = carriersByNamespace.get(namespace);
      if (!carrier?.definitionPath || carrier.definitionPath.length === 0) {
        return undefined;
      }
      return carrier.definitionPath.map((name) => propertySegment(name));
    },
    pathEndsWithCarrierSuffix(pathKey) {
      for (const suffix of suffixKeys) {
        if (pathKey === suffix || pathKey.endsWith(`/${suffix}`)) {
          return true;
        }
      }
      return false;
    },
  };
}

const carrierLookupsByProject = new WeakMap<ProjectContext, CarrierLookups>();

export function getCarrierLookupsForProject(project: ProjectContext): CarrierLookups {
  const cached = carrierLookupsByProject.get(project);
  if (cached) {
    return cached;
  }

  const lookups = createCarrierLookups(project.config.value.internalNamespaceMethodCarriers);
  carrierLookupsByProject.set(project, lookups);
  return lookups;
}
