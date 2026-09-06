export interface FocusSubjectTarget {
  objectId: string;
  activationId?: string;
}

export function readFocusSubjectLink(search: string): { target: FocusSubjectTarget | null; error: string | null } {
  const params = new URLSearchParams(search);
  if (!params.has("focus") && !params.has("episode")) return { target: null, error: null };
  const objectId = params.get("focus")?.trim();
  const activationId = params.get("episode")?.trim();
  if (!objectId || (params.has("episode") && !activationId) || params.getAll("focus").length > 1 || params.getAll("episode").length > 1) {
    return { target: null, error: "This Focus link does not identify one object and episode unambiguously. No record was changed." };
  }
  return { target: { objectId, ...(activationId ? { activationId } : {}) }, error: null };
}

export function setFocusSubjectLink(search: string | URLSearchParams, target: FocusSubjectTarget | null): URLSearchParams {
  const params = new URLSearchParams(search);
  params.delete("focus");
  params.delete("episode");
  if (target) {
    params.set("focus", target.objectId);
    if (target.activationId) params.set("episode", target.activationId);
  }
  return params;
}
