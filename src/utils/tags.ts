/**
 * Utility function to create default tags for all Pulumi-managed resources.
 * All resources should have:
 * - ManagedBy: Pulumi
 * - Environment: {prefix}
 */
export function getDefaultTags(prefix: string, additionalTags?: Record<string, string>): Record<string, string> {
  return {
    ManagedBy: "Pulumi",
    Environment: prefix,
    ...additionalTags,
  };
}
