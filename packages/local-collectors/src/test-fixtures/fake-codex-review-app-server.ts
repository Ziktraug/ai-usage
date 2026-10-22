import { appendFileSync } from 'node:fs';

const log = process.argv[2];
const mode = process.argv[3] ?? 'success';
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const threadId = 'native-thread-1';
const turnId = 'native-turn-1';
const features = Object.fromEntries(
  [
    'apps',
    'plugins',
    'hooks',
    'multi_agent',
    'shell_tool',
    'browser_use',
    'computer_use',
    'image_generation',
    'goals',
    'memories',
  ].map((key) => [key, false]),
);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let end = buffer.indexOf('\n');
  while (end >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (log) {
      appendFileSync(log, `${JSON.stringify(request)}\n`);
    }
    const reply = (result: unknown) => send({ id: request.id, result });
    switch (request.method) {
      case 'initialize':
        if (mode === 'malformed') {
          process.stdout.write('invalid json\n');
          break;
        }
        if (mode === 'oversized') {
          process.stdout.write('x'.repeat(8192));
          break;
        }
        reply({ userAgent: 'fixture' });
        break;
      case 'account/read':
        reply({
          account:
            mode === 'api'
              ? { type: 'apiKey' }
              : {
                  type: 'chatgpt',
                  email: mode === 'account-change' ? 'other@example.test' : 'review@example.test',
                  planType: 'pro',
                },
          requiresOpenaiAuth: true,
        });
        break;
      case 'account/rateLimits/read':
        reply({
          accountId: 'fixture-account',
          ordinaryUsageAllowed: mode !== 'capacity-denied',
          rateLimits: {
            limitId: 'codex',
            planType: 'pro',
            credits:
              mode === 'credits-unknown'
                ? null
                : { hasCredits: mode === 'credits-enabled', unlimited: false, balance: null },
            primary: {
              usedPercent: mode === 'exhausted' ? 100 : 20,
              windowDurationMins: 300,
              resetsAt: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary: {
              usedPercent: 25,
              windowDurationMins: 10_080,
              resetsAt: Math.floor(Date.now() / 1000) + 86_400,
            },
          },
          rateLimitsByLimitId: null,
        });
        break;
      case 'config/read':
        reply({
          config: {
            model_provider: 'openai',
            features,
            web_search: 'disabled',
            mcp_servers: { fixture: { enabled: true } },
          },
        });
        break;
      case 'thread/start':
        reply({
          thread: { id: threadId },
          model: mode === 'wrong-model' ? 'other' : request.params.model,
          modelProvider: 'openai',
          approvalPolicy: 'never',
          reasoningEffort: request.params.config.model_reasoning_effort ?? null,
          sandbox: { type: 'readOnly', networkAccess: mode === 'network' },
        });
        break;
      case 'mcpServerStatus/list':
        reply({ data: mode === 'mcp-active' ? [{ name: 'dangerous' }] : [], nextCursor: null });
        break;
      case 'turn/start': {
        if (mode !== 'lost-ack') {
          reply({ turn: { id: turnId, status: 'inProgress' } });
        }
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: 'Partial review' } });
        if (mode === 'reroute') {
          send({ method: 'model/rerouted', params: { threadId, turnId, fromModel: 'gpt-6-astra', toModel: 'other' } });
        }
        if (mode === 'exit' || mode === 'lost-ack') {
          process.exit(0);
        }
        if (mode === 'success') {
          setTimeout(() => {
            send({
              method: 'item/completed',
              params: {
                threadId,
                turnId,
                item: { type: 'agentMessage', text: 'No findings in supplied patch. Coverage: supplied commit only.' },
              },
            });
            send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
          }, 25);
        }
        if (mode === 'failed') {
          send({
            method: 'turn/completed',
            params: { threadId, turn: { id: turnId, status: 'failed', error: { message: 'secret provider detail' } } },
          });
        }
        break;
      }
      case 'turn/interrupt':
        reply({});
        if (mode !== 'stop-unconfirmed') {
          send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
        }
        break;
      default:
        break;
    }
    end = buffer.indexOf('\n');
  }
});
