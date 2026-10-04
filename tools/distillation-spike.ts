import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCodexDistillationEvidence } from '@ai-usage/local-machine/distillation-evidence';
import { redactDistillationText } from '@ai-usage/memory-service/distillation-redaction';
import { parseDistillationEvidencePacket } from '@ai-usage/platform-core/distillation-evidence';
import { parseSessionAnalysisContent, validateAnalysisEvidence } from '@ai-usage/platform-core/session-distillation';

interface Corpus {
  cases: { id: string; file: string; sessionId: string }[];
  project: { id: string; path: string; machineId: string };
}

export const prepareSyntheticDistillationSpike = async (outputDirectory: string): Promise<string[]> => {
  const corpusRoot = path.join(import.meta.dir, 'fixtures/distillation');
  const corpus: Corpus = JSON.parse(await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'));
  const syntheticHome = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-distillation-spike-'));
  const nativeDirectory = path.join(syntheticHome, '.codex/sessions/2026/10/04');
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputs: string[] = [];
  try {
    for (const entry of corpus.cases) {
      await writeFile(
        path.join(nativeDirectory, `rollout-2026-10-04T12-00-00-${entry.sessionId}.jsonl`),
        await readFile(path.join(corpusRoot, entry.file)),
        { mode: 0o600 },
      );
      const result = await prepareCodexDistillationEvidence(
        {
          localMachineId: corpus.project.machineId,
          selection: {
            checkoutPath: corpus.project.path,
            machineId: corpus.project.machineId,
            projectId: corpus.project.id,
            sourceAuthority: 'local-observed',
            sourceSessionId: entry.sessionId,
          },
        },
        { homePath: syntheticHome, redactText: redactDistillationText, redactionVersion: 1 },
      );
      if (result.status !== 'available') {
        throw new Error(`Synthetic case ${entry.id}: ${result.reason}`);
      }
      const output = path.join(outputDirectory, `${entry.id}.packet.json`);
      await writeFile(output, JSON.stringify(result.packet, null, 2), { mode: 0o600 });
      outputs.push(output);
    }
    return outputs;
  } finally {
    await rm(syntheticHome, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const [command, directory] = process.argv.slice(2);
  if (!directory) {
    throw new Error('Usage: bun tools/distillation-spike.ts prepare|validate <isolated-directory>');
  }
  if (command === 'prepare') {
    const outputs = await prepareSyntheticDistillationSpike(directory);
    process.stdout.write(`${outputs.join('\n')}\n`);
  } else if (command === 'validate') {
    const corpus: Corpus = JSON.parse(
      await readFile(path.join(import.meta.dir, 'fixtures/distillation/corpus.json'), 'utf8'),
    );
    for (const entry of corpus.cases) {
      const packet = parseDistillationEvidencePacket(
        JSON.parse(await readFile(path.join(directory, `${entry.id}.packet.json`), 'utf8')),
      );
      const content = parseSessionAnalysisContent(
        JSON.parse(await readFile(path.join(directory, `${entry.id}.analysis.json`), 'utf8')),
      );
      validateAnalysisEvidence(content, packet.events);
      process.stdout.write(`${entry.id}: schema and references valid (semantic support requires review)\n`);
    }
  } else {
    throw new Error('Unknown spike operation');
  }
}
