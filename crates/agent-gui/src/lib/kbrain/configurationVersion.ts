export const KBRAIN_CONFIGURATION_PROTOCOL = "zeroagent.configuration.v1";

export type KBrainConfigurationMetadata = {
  readonly configurationVersion?: string;
  readonly configurationProtocol?: typeof KBRAIN_CONFIGURATION_PROTOCOL;
};

/** The version belongs to this returned document, never to a global "latest" cache. */
export async function readKBrainConfiguration<T>(response: Response): Promise<T> {
  const document = (await response.json()) as T;
  if (
    document &&
    typeof document === "object" &&
    response.headers.get("x-zeroagent-configuration") === KBRAIN_CONFIGURATION_PROTOCOL
  ) {
    const version = response.headers.get("etag");
    if (version) Object.defineProperty(document, "configurationVersion", { value: version });
    Object.defineProperty(document, "configurationProtocol", {
      value: KBRAIN_CONFIGURATION_PROTOCOL,
    });
  }
  return document;
}

export function configurationVersionHeaders(version: string | undefined): HeadersInit {
  return version ? { "If-Match": version } : {};
}
