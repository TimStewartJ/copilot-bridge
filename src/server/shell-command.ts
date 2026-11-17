// A command reaches a program in one of two forms. A ShellCommand is text a shell reads, so it must
// be constant: a value inside it depends on that shell's quoting, which differs between /bin/sh and
// cmd.exe. A CommandLine starts the program directly and passes each value as its own argument.
// Every runner that can start a shell takes one of these, so a command built from values fails to
// compile instead of failing on a branch name with a space or a `^` that cmd.exe swallows.

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

/**
 * Tags constant shell text: sh`git status --porcelain`. A `${}` in the template does not compile;
 * build a CommandLine with commandLine() instead.
 */
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
