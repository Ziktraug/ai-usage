import { defineHandler } from 'nitro';
import { createSourceControlEventStream } from '../../../src/server/source-control-api.server';

export default defineHandler((event) => createSourceControlEventStream(event.req));
