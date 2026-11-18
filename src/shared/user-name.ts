/** Longest name Settings accepts for the user. */
export const MAX_USER_NAME_LENGTH = 80;

/** The prompt line that tells a model the user's name, or undefined when none is set. */
export function userNameLine(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed ? `The user's name is ${trimmed}.` : undefined;
}
