import { NEXUS_BASE_URL, SSO_APPLICATION } from "../constants";

export function getPageURL(loginId: string) {
  return `${NEXUS_BASE_URL}/sso?application=${encodeURIComponent(SSO_APPLICATION)}&id=${encodeURIComponent(loginId)}`;
}
