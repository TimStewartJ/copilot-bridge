// Shell text must be constant (sh and cmd.exe quote differently); pass values via CommandLine.

declare const shellCommandBrand: unique symbol;

/** Constant text run by the shell. Made only by `sh`. */
export type ShellCommand = string & { readonly [shellCommandBrand]: true };

/** A program and its arguments, started without a shell. */
export interface CommandLine {
  command: string;
  args: readonly string[];
  displayCommand: string;
}

export type Command = ShellCommand | CommandLine;

/** Tags constant shell text: sh`git status`. A `${}` does not compile; use commandLine(). */
export function sh(strings: TemplateStringsArray, ...values: never[]): ShellCommand {
  if (values.length > 0 || strings.length !== 1) {
    throw new TypeError("A shell command must be constant text. Pass values as arguments with commandLine().");
  }
  return strings[0] as ShellCommand;
}

function formatDisplayArg(arg: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function commandLine(command: string, args: readonly string[]): CommandLine {
  const commandArgs = [...args];
  return {
    command,
    args: commandArgs,
    displayCommand: [command, ...commandArgs].map(formatDisplayArg).join(" "),
  };
}

export function isShellCommand(command: Command): command is ShellCommand {
  return typeof command === "string";
}

export function commandText(command: Command): string {
  return isShellCommand(command) ? command : command.displayCommand;
}

/** The fields the process runners take: shell text without arguments, or a program with them. */
export type CommandSpec =
  | { command: ShellCommand; args?: undefined; displayCommand?: string }
  | { command: string; args: readonly string[]; displayCommand?: string };

export function commandSpec(command: Command): CommandSpec {
  return isShellCommand(command)
    ? { command }
    : { command: command.command, args: command.args, displayCommand: command.displayCommand };
}
