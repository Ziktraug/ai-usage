import { Context, Layer } from 'effect';

export interface CliRuntime {
  readonly argv: string[];
  readonly stdoutIsTTY: boolean;
}

export const CliRuntime = Context.GenericTag<CliRuntime>('@ai-usage/CliRuntime');

export const CliRuntimeLive = Layer.succeed(CliRuntime, {
  argv: process.argv.slice(2),
  stdoutIsTTY: !!process.stdout.isTTY,
});
