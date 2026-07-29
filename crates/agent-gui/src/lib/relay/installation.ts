import { createUuid } from "../shared/id";

const INSTALLATION_ID_KEY = "zeroagent.installation-id";

export function getInstallationID() {
  const current = localStorage.getItem(INSTALLATION_ID_KEY)?.trim();
  if (current) return current;
  const created = createUuid();
  localStorage.setItem(INSTALLATION_ID_KEY, created);
  return created;
}
